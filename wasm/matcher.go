// 匹配引擎：规则定义 + 求值。这是 wasm 的核心，其他文件都是给它打辅助的。
package main

import (
	"fmt"
	"regexp"
	"strings"
)

type Rule struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// matcher 之间怎么组合，and / or，默认 or
	MatchersCondition string    `json:"matchers-condition"`
	Matchers          []Matcher `json:"matchers"`
}

type Matcher struct {
	Type string `json:"type"` // word / regex / status / icon_hash
	Part string `json:"part"` // body / title / url / header / raw / meta / script，默认 body
	// matcher 内部多个条件（比如多个 words）的组合方式，默认 or
	Condition string   `json:"condition"`
	Negative  bool     `json:"negative"`
	Words     []string `json:"words,omitempty"`
	Regex     []string `json:"regex,omitempty"`
	Status    []int    `json:"status,omitempty"`
	Hash      []int32  `json:"hash,omitempty"`
	Dsl       []string `json:"dsl,omitempty"` // contains(body,"x") && status==200 这种表达式
}

// 页面特征，JS 侧采集完传进来
type Features struct {
	URL         string            `json:"url"`
	Title       string            `json:"title"`
	Body        string            `json:"body"`
	Headers     map[string]string `json:"headers"` // 键都是小写
	Status      int               `json:"status"`
	FaviconHash int32             `json:"faviconHash"`
	Meta        map[string]string `json:"meta"`    // meta 标签 name/property -> content
	Scripts     []string          `json:"scripts"` // script src 列表
	Links       []string          `json:"links"`   // 页面链接，爬虫用，不参与匹配
	// 一个站点可能有好几个 icon（不同尺寸/路径），每个都算哈希来匹配
	FaviconHashes []int32 `json:"faviconHashes"`
}

// 命中证据：哪个类型、在哪个位置、命中了什么
type Evidence struct {
	Type   string `json:"type"`
	Part   string `json:"part,omitempty"`
	Detail string `json:"detail"`
}

type Hit struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Evidence []Evidence `json:"evidence"`
}

// headerString 拼 "k: v\n" 形式的响应头文本，partText 和 dsl 都用
func headerString(f *Features) string {
	var b strings.Builder
	for k, v := range f.Headers {
		fmt.Fprintf(&b, "%s: %s\n", k, v)
	}
	return b.String()
}

// 规则库一大，每次匹配现编译正则就是灾难，编译结果缓存起来
//（wasm 单实例常驻，JS 调用是串行的，不用加锁）
var regexCache = make(map[string]*regexp.Regexp)

// recover 兜底：RE2 遇到 {1,512} 这种大重复展开会栈溢出 panic，不能让整个 wasm 陪葬
func compileRegex(pattern string) (re *regexp.Regexp, err error) {
	if cached, ok := regexCache[pattern]; ok {
		return cached, nil
	}
	defer func() {
		if r := recover(); r != nil {
			re, err = nil, fmt.Errorf("编译崩溃: %v", r)
		}
	}()
	re, err = regexp.Compile(pattern)
	if err == nil {
		regexCache[pattern] = re
	}
	return re, err
}

func partText(m Matcher, f *Features) string {
	switch m.Part {
	case "title":
		return f.Title
	case "url":
		return f.URL
	case "header":
		return headerString(f)
	case "raw":
		return headerString(f) + f.Body
	case "meta":
		var b strings.Builder
		for k, v := range f.Meta {
			fmt.Fprintf(&b, "%s: %s\n", k, v)
		}
		return b.String()
	case "script":
		return strings.Join(f.Scripts, "\n")
	default:
		return f.Body
	}
}

func evalMatcher(m Matcher, f *Features) (bool, []Evidence) {
	var results []bool
	var ev []Evidence
	part := m.Part
	if part == "" {
		part = "body"
	}

	switch m.Type {
	case "word":
		text := partText(m, f)
		cmpText := strings.ToLower(text)
		for _, w := range m.Words {
			ok := strings.Contains(cmpText, strings.ToLower(w))
			results = append(results, ok)
			if ok {
				ev = append(ev, Evidence{Type: "word", Part: part, Detail: w})
			}
		}
	case "regex":
		text := partText(m, f)
		for _, r := range m.Regex {
			re, err := compileRegex("(?i)" + r)
			if err != nil {
				re, err = compileRegex(r)
			}
			if err != nil {
				results = append(results, false)
				continue
			}
			ok := re.MatchString(text)
			results = append(results, ok)
			if ok {
				detail := "/" + r + "/"
				if s := re.FindString(text); len(s) <= 120 {
					detail += " 命中: " + s
				}
				ev = append(ev, Evidence{Type: "regex", Part: part, Detail: detail})
			}
		}
	case "status":
		for _, s := range m.Status {
			ok := f.Status == s
			results = append(results, ok)
			if ok {
				ev = append(ev, Evidence{Type: "status", Detail: fmt.Sprintf("状态码 %d", s)})
			}
		}
	case "icon_hash":
		// 页面的所有 icon 哈希都参与比对，不知道哪个图案才是指纹库里那个
		all := append([]int32{f.FaviconHash}, f.FaviconHashes...)
		for _, h := range m.Hash {
			ok := false
			for _, fh := range all {
				if fh == h {
					ok = true
					break
				}
			}
			results = append(results, ok)
			if ok {
				ev = append(ev, Evidence{Type: "icon_hash", Detail: fmt.Sprintf("mmh3 %d", h)})
			}
		}
	case "dsl":
		for _, expr := range m.Dsl {
			ok, err := dslEval(expr, f)
			if err != nil {
				results = append(results, false)
				continue
			}
			results = append(results, ok)
			if ok {
				ev = append(ev, Evidence{Type: "dsl", Detail: expr})
			}
		}
	}

	matched := combine(results, m.Condition)
	if m.Negative {
		if matched {
			return false, nil
		}
		// negative 命中 = 东西确实不在，证据就是"没出现"
		terms := append(append(append([]string{}, m.Words...), m.Regex...), m.Dsl...)
		return true, []Evidence{{Type: m.Type, Part: part, Detail: "未出现（negative）: " + strings.Join(terms, ", ")}}
	}
	if !matched {
		return false, nil
	}
	return true, ev
}

// 按 and/or 聚合，默认 or；空列表算不匹配
func combine(results []bool, condition string) bool {
	if len(results) == 0 {
		return false
	}
	if condition == "and" {
		for _, r := range results {
			if !r {
				return false
			}
		}
		return true
	}
	for _, r := range results {
		if r {
			return true
		}
	}
	return false
}

func matchRule(r Rule, f *Features) (bool, []Evidence) {
	results := make([]bool, 0, len(r.Matchers))
	var ev []Evidence
	for _, m := range r.Matchers {
		ok, sub := evalMatcher(m, f)
		results = append(results, ok)
		ev = append(ev, sub...)
	}
	return combine(results, r.MatchersCondition), ev
}
