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
	// 命中后自动推导出的其他技术名（wappalyzer 的 implies）
	Implies []string `json:"implies,omitempty"`
	// 命中后要压制的技术名（wappalyzer 的 excludes），降噪用
	Excludes []string `json:"excludes,omitempty"`
	// 规则整体置信度 0-100，缺省 100。作为缩放系数乘在 matcher 合成值上
	Confidence int `json:"confidence,omitempty"`
}

// JsProbe 检测页面运行时全局变量：path 存在即算，pattern 非空则值也要匹配
type JsProbe struct {
	Path    string `json:"path"`    // window 上的路径，如 React.version
	Pattern string `json:"pattern"` // 对值的正则，可空
}

// DomProbe 检测页面结构：选择器命中元素后，还可选校验元素文本和属性
type DomProbe struct {
	Sel   string            `json:"sel"`
	Text  string            `json:"text,omitempty"`  // 元素 textContent 要过的正则
	Attrs map[string]string `json:"attrs,omitempty"` // 属性名 -> 值要过的正则
}

type Matcher struct {
	Type string `json:"type"` // word / regex / status / icon_hash / dsl / js / dom
	Part string `json:"part"` // body / title / url / header / raw / meta / script，默认 body
	// matcher 内部多个条件（比如多个 words）的组合方式，默认 or
	Condition string    `json:"condition"`
	Negative  bool      `json:"negative"`
	Words     []string  `json:"words,omitempty"`
	Regex     []string  `json:"regex,omitempty"`
	Status    []int     `json:"status,omitempty"`
	Hash      []int32   `json:"hash,omitempty"`
	Dsl       []string  `json:"dsl,omitempty"` // contains(body,"x") && status==200 这种表达式
	Js        []JsProbe `json:"js,omitempty"`  // type=js 时用
	// type=dom 时用；words 里的裸选择器也按"存在即命中"兼容
	Dom []DomProbe `json:"dom,omitempty"`
	// 这条 matcher 命中的可信度 0-100，缺省 100。弱信号（比如只是个 link 标签）可以给低点
	Confidence int `json:"confidence,omitempty"`
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
	FaviconHashes []int32           `json:"faviconHashes"`
	Js            map[string]string `json:"js"`  // 页面运行时全局变量路径 -> 值摘要（MAIN world 探测）
	Dom           []string          `json:"dom"` // 命中的 CSS 选择器列表（content script 探测）
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
	// 0-100，由规则里的 confidence 合成；没配置信度的规则恒为 100
	Confidence int `json:"confidence"`
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
// （wasm 单实例常驻，JS 调用是串行的，不用加锁）
var regexCache = make(map[string]*regexp.Regexp)

// recover 兜底接住普通 panic；栈溢出接不住，靠 safeCompile 里的驯化+深度检查事前拦
func compileRegex(pattern string) (re *regexp.Regexp, err error) {
	if cached, ok := regexCache[pattern]; ok {
		return cached, nil
	}
	re, err = safeCompile(tamePattern(pattern))
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
	case "js":
		for _, p := range m.Js {
			val, exists := f.Js[p.Path]
			ok := exists
			if ok && p.Pattern != "" {
				re, err := compileRegex(p.Pattern)
				ok = err == nil && re.MatchString(val)
			}
			results = append(results, ok)
			if ok {
				detail := "window." + p.Path
				if val != "" {
					detail += " = " + val
				}
				ev = append(ev, Evidence{Type: "js", Detail: detail})
			}
		}
	case "dom":
		// 探测结果 f.Dom 里存的是命中的选择器
		for _, sel := range m.Words {
			ok := false
			for _, hit := range f.Dom {
				if hit == sel {
					ok = true
					break
				}
			}
			results = append(results, ok)
			if ok {
				ev = append(ev, Evidence{Type: "dom", Detail: sel})
			}
		}
		for _, p := range m.Dom {
			ok := false
			for _, hit := range f.Dom {
				if hit == p.Sel {
					ok = true
					break
				}
			}
			results = append(results, ok)
			if ok {
				ev = append(ev, Evidence{Type: "dom", Detail: p.Sel})
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

func matchRule(r Rule, f *Features) (bool, []Evidence, int) {
	results := make([]bool, 0, len(r.Matchers))
	var ev []Evidence
	conf := 0
	and := r.MatchersCondition == "and"
	for _, m := range r.Matchers {
		ok, sub := evalMatcher(m, f)
		results = append(results, ok)
		ev = append(ev, sub...)
		if !ok {
			continue
		}
		// or 取最强信号，and 取最短板（整体可信度被最弱的那环拖累）
		c := m.Confidence
		if c <= 0 || c > 100 {
			c = 100
		}
		if conf == 0 || (and && c < conf) || (!and && c > conf) {
			conf = c
		}
	}
	if !combine(results, r.MatchersCondition) {
		return false, nil, 0
	}
	if conf == 0 {
		conf = 100
	}
	if r.Confidence > 0 && r.Confidence < 100 {
		conf = conf * r.Confidence / 100
	}
	return true, ev, conf
}

// implies 级联：命中 A 就补上 A 声明的技术，一轮轮推到没有新东西为止。
// 被推导的技术不需要有自己的规则，直接给一条裸命中
func applyImplies(hits []Hit, rules []Rule) []Hit {
	byName := make(map[string]*Rule, len(rules))
	for i := range rules {
		byName[strings.ToLower(rules[i].Name)] = &rules[i]
		byName[strings.ToLower(rules[i].ID)] = &rules[i]
	}
	have := make(map[string]bool, len(hits))
	for _, h := range hits {
		have[strings.ToLower(h.Name)] = true
	}
	queue := append([]Hit{}, hits...)
	for len(queue) > 0 {
		h := queue[0]
		queue = queue[1:]
		r, ok := byName[strings.ToLower(h.Name)]
		if !ok {
			continue
		}
		for _, imp := range r.Implies {
			key := strings.ToLower(imp)
			if have[key] {
				continue
			}
			have[key] = true
			nh := Hit{
				ID:         slugify(imp),
				Name:       imp,
				Evidence:   []Evidence{{Type: "implies", Detail: "由 " + h.Name + " 推导"}},
				Confidence: h.Confidence, // 推导链上的可信度跟着来源走
			}
			hits = append(hits, nh)
			queue = append(queue, nh) // 推导出来的还能再推导
		}
	}
	return hits
}

// excludes 排除：命中的规则声明了排除谁，就把谁从结果里踢掉。
// 在 implies 之后跑，推导出来的也能被排掉
func applyExcludes(hits []Hit, rules []Rule) []Hit {
	byName := make(map[string]*Rule, len(rules))
	for i := range rules {
		byName[strings.ToLower(rules[i].Name)] = &rules[i]
		byName[strings.ToLower(rules[i].ID)] = &rules[i]
	}
	banned := make(map[string]bool)
	for _, h := range hits {
		r, ok := byName[strings.ToLower(h.Name)]
		if !ok {
			continue
		}
		for _, ex := range r.Excludes {
			banned[strings.ToLower(ex)] = true
		}
	}
	if len(banned) == 0 {
		return hits
	}
	out := hits[:0]
	for _, h := range hits {
		if !banned[strings.ToLower(h.Name)] {
			out = append(out, h)
		}
	}
	return out
}
