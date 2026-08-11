// 匹配引擎：规则定义 + 求值。这是 wasm 的核心，其他文件都是给它打辅助的。
package engine

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
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
	// 规则整体置信度 0-100；没写就是未知，不自动伪造成 100
	Confidence *int `json:"confidence,omitempty"`
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
	// 这条 matcher 命中的可信度 0-100；没写就是未知，不自动伪造成 100
	Confidence *int `json:"confidence,omitempty"`
}

// 页面特征，JS 侧采集完传进来
type Features struct {
	URL     string            `json:"url"`
	Title   string            `json:"title"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"` // 键都是小写
	Status  int               `json:"status"`
	Meta    map[string]string `json:"meta"`    // meta 标签 name/property -> content
	Scripts []string          `json:"scripts"` // script src 列表
	Links   []string          `json:"links"`   // 页面链接，爬虫用，不参与匹配
	// 一个站点可能有好几个 icon（不同尺寸/路径），每个都算哈希来匹配。
	// 空数组 = 没有 favicon；[0] = 真实哈希就是 0，两者不混为一谈
	FaviconHashes []int32           `json:"faviconHashes"`
	Js            map[string]string `json:"js"`      // 页面运行时全局变量路径 -> 值摘要（MAIN world 探测）
	DomHits       map[string]bool   `json:"domHits"` // 命中的 dom probe id 集合（content script 探测）
}

// 命中证据：哪个类型、在哪个位置、命中了什么
type Evidence struct {
	Type    string `json:"type"`
	Part    string `json:"part,omitempty"`
	Detail  string `json:"detail"`
	Pattern string `json:"pattern,omitempty"`
}

type Hit struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Evidence []Evidence `json:"evidence"`
	// 0-100，由规则里的 confidence 合成；没配置信度则为 null
	Confidence *int `json:"confidence"`
}

// headerString 拼 "k: v\n" 形式的响应头文本，partText 和 dsl 都用。
// 键排序，保证同样一组头在任何时候拼出的字符串都一样
// （map 遍历顺序随机，不排序会导致 raw/header 拼出来的内容不稳定）
func headerString(f *Features) string {
	keys := make([]string, 0, len(f.Headers))
	for k := range f.Headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s: %s\n", k, f.Headers[k])
	}
	return b.String()
}

// 规则库一大，每次匹配现编译正则就是灾难，编译结果缓存起来
// （wasm 单实例常驻，JS 调用是串行的，不用加锁）
var regexCache = make(map[string]*regexp.Regexp)

// ClearRegexCache 清空正则编译缓存。规则集一变（rulesetFor 重建）就调一次，
// 旧规则的正则不再占用 WASM 内存；规则没变时缓存照常复用。
func ClearRegexCache() {
	regexCache = make(map[string]*regexp.Regexp)
}

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

// matchCtx 是一次 Match 的上下文：页面特征 + 各 part 预计算好的文本。
// word 匹配要小写比较，几千条规则每条都 ToLower 整个 body 是之前最大的坑
// （N 条规则 = N 次全量小写化 + 分配，WASM GC 扛不住）。这里每个 part 只
// 算一次，全部规则复用。
type matchCtx struct {
	f *Features

	// 原文（regex/raw/dsl 用），一次性拼好，省得每条 matcher 重拼
	header string
	meta   string
	script string
	// raw = header + body，nuclei 的 raw part 也是这个语义，单独拼一次
	raw string

	// 小写版（word 匹配用），每个 part 只小写一次
	lowerBody   string
	lowerTitle  string
	lowerURL    string
	lowerHeader string
	lowerMeta   string
	lowerScript string
	lowerRaw    string

	// body word 命中集合：attachBodyIndex 扫一次 lowerBody 得到，
	// 有索引时 body 的 word matcher 从 O(词数×body) 退化成 map 查询
	bodyWordHits map[string]bool
}

func newMatchCtx(f *Features) *matchCtx {
	c := &matchCtx{f: f}
	c.header = headerString(f)
	c.meta = metaString(f)
	c.script = strings.Join(f.Scripts, "\n")
	c.lowerBody = strings.ToLower(f.Body)
	c.lowerTitle = strings.ToLower(f.Title)
	c.lowerURL = strings.ToLower(f.URL)
	c.lowerHeader = strings.ToLower(c.header)
	c.lowerMeta = strings.ToLower(c.meta)
	c.lowerScript = strings.ToLower(c.script)
	c.raw = c.header + f.Body
	c.lowerRaw = c.lowerHeader + c.lowerBody
	return c
}

// attachBodyIndex 接入 body word 索引（可选）。有索引时 body 的 word matcher
// 走命中集合，避免每条规则都去扫描大 body。
func (c *matchCtx) attachBodyIndex(idx *bodyWordIndex) {
	if idx == nil {
		return
	}
	c.bodyWordHits = idx.scan(c.lowerBody)
}

func metaString(f *Features) string {
	keys := make([]string, 0, len(f.Meta))
	for k := range f.Meta {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s: %s\n", k, f.Meta[k])
	}
	return b.String()
}

// partText 取原文（regex 等大小写敏感场景用）
func (c *matchCtx) partText(m Matcher) string {
	switch m.Part {
	case "title":
		return c.f.Title
	case "url":
		return c.f.URL
	case "header":
		return c.header
	case "raw":
		return c.raw
	case "meta":
		return c.meta
	case "script":
		return c.script
	default:
		return c.f.Body
	}
}

// partTextLower 取小写版（word 匹配用），与逐次 strings.ToLower 语义一致
func (c *matchCtx) partTextLower(m Matcher) string {
	switch m.Part {
	case "title":
		return c.lowerTitle
	case "url":
		return c.lowerURL
	case "header":
		return c.lowerHeader
	case "raw":
		return c.lowerRaw
	case "meta":
		return c.lowerMeta
	case "script":
		return c.lowerScript
	default:
		return c.lowerBody
	}
}

// 单个条件的求值结果三态：命中 / 未命中 / 无效。
// 无效 = 条件本身坏了（正则编译失败、dsl 报错、未知 matcher 类型）。
// 关键区别：negative 只能反转"有效的未命中"，无效既不命中也不能被 negative 反成命中——
// 否则一条写坏的正则配 negative 会凭空造出幽灵指纹。
type evalResult int

const (
	evalMiss    evalResult = iota // 有效的未命中
	evalHit                       // 命中
	evalInvalid                   // 条件无效
)

func boolResult(ok bool) evalResult {
	if ok {
		return evalHit
	}
	return evalMiss
}

// 按 and/or 聚合三态结果，空结果集算未命中。与 SQL 的 NULL 语义一致：
// and 里有 false 就定死 false，否则有 invalid 算 invalid；or 里有 true 就定死 true，否则有 invalid 算 invalid。
func combine3(results []evalResult, condition string) evalResult {
	if len(results) == 0 {
		return evalMiss
	}
	if condition == "and" {
		invalid := false
		for _, r := range results {
			switch r {
			case evalMiss:
				return evalMiss
			case evalInvalid:
				invalid = true
			}
		}
		if invalid {
			return evalInvalid
		}
		return evalHit
	}
	invalid := false
	for _, r := range results {
		switch r {
		case evalHit:
			return evalHit
		case evalInvalid:
			invalid = true
		}
	}
	if invalid {
		return evalInvalid
	}
	return evalMiss
}

func evalMatcher(m Matcher, c *matchCtx) (bool, []Evidence) {
	f := c.f
	var results []evalResult
	var ev []Evidence
	part := m.Part
	if part == "" {
		part = "body"
	}

	switch m.Type {
	case "word":
		// body 有索引走命中集合；空词与 strings.Contains("")=true 对齐
		if c.bodyWordHits != nil && part == "body" {
			for _, w := range m.Words {
				ok := w == "" || c.bodyWordHits[strings.ToLower(w)]
				results = append(results, boolResult(ok))
				if ok {
					ev = append(ev, Evidence{Type: "word", Part: part, Detail: w})
				}
			}
			break
		}
		cmpText := c.partTextLower(m)
		for _, w := range m.Words {
			ok := strings.Contains(cmpText, strings.ToLower(w))
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "word", Part: part, Detail: w})
			}
		}
	case "regex":
		text := c.partText(m)
		for _, r := range m.Regex {
			re, err := compileRegex("(?i)" + r)
			if err != nil {
				re, err = compileRegex(r)
			}
			if err != nil {
				// 正则是坏的，这条件判无效而不是未命中：negative 不能拿它当"没出现"
				results = append(results, evalInvalid)
				continue
			}
			ok := re.MatchString(text)
			results = append(results, boolResult(ok))
			if ok {
				detail := re.FindString(text)
				if len(detail) > 120 {
					detail = detail[:120] + "…"
				}
				if detail == "" {
					detail = "（零宽匹配）"
				}
				ev = append(ev, Evidence{Type: "regex", Part: part, Detail: detail, Pattern: r})
			}
		}
	case "status":
		for _, s := range m.Status {
			ok := f.Status == s
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "status", Detail: fmt.Sprintf("状态码 %d", s)})
			}
		}
	case "icon_hash":
		// 页面的所有 icon 哈希都参与比对，不知道哪个图案才是指纹库里那个
		for _, h := range m.Hash {
			ok := slices.Contains(f.FaviconHashes, h)
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "icon_hash", Detail: fmt.Sprintf("mmh3 %d", h)})
			}
		}
	case "dsl":
		for _, expr := range m.Dsl {
			ok, err := dslEval(expr, c)
			if err != nil {
				// dsl 语法/求值出错判无效，同上 negative 不能反转
				results = append(results, evalInvalid)
				continue
			}
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "dsl", Detail: expr})
			}
		}
	case "js":
		for _, p := range m.Js {
			val, exists := f.Js[p.Path]
			if !exists {
				results = append(results, evalMiss)
				continue
			}
			if p.Pattern == "" {
				results = append(results, evalHit)
				ev = append(ev, Evidence{Type: "js", Detail: jsProbeDetail(p.Path, val)})
				continue
			}
			re, err := compileRegex(p.Pattern)
			if err != nil {
				results = append(results, evalInvalid)
				continue
			}
			ok := re.MatchString(val)
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "js", Detail: jsProbeDetail(p.Path, val)})
			}
		}
	case "dom":
		// 探测结果 f.DomHits 里存的是命中的 probe id；同一组 sel/text/attrs
		// 在 JS 侧和这里算出同一个 id，命中即存在
		for _, sel := range m.Words {
			ok := f.DomHits[probeID(DomProbe{Sel: sel})]
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "dom", Detail: sel})
			}
		}
		for _, p := range m.Dom {
			ok := f.DomHits[probeID(p)]
			results = append(results, boolResult(ok))
			if ok {
				ev = append(ev, Evidence{Type: "dom", Detail: p.Sel})
			}
		}
	default:
		// 未知 matcher 类型：整条 matcher 无效，不产出证据，negative 也不反转
		results = append(results, evalInvalid)
	}

	state := combine3(results, m.Condition)
	if m.Negative {
		switch state {
		case evalHit:
			return false, nil
		case evalMiss:
			// negative 命中 = 东西确实不在，证据就一句话，不罗列具体条件
			return true, []Evidence{{Type: m.Type, Part: part, Detail: "negative 成立：原条件未满足"}}
		default: // evalInvalid：条件坏了，negative 不反转
			return false, nil
		}
	}
	if state != evalHit {
		return false, nil
	}
	return true, ev
}

func jsProbeDetail(path, val string) string {
	detail := "window." + path
	if val != "" {
		detail += " = " + val
	}
	return detail
}

// probeID 把 dom probe 算成稳定 id：sel/text/attrs 全参与，同一内容在任何侧
// 算出同一个值。JS 侧（background/matching.js 的 probeId）用同一套字节序列 + FNV-1a
// 算出来，两边对得上。attrs 键排序后再拼，顺序不影响 id。
func probeID(p DomProbe) string {
	keys := make([]string, 0, len(p.Attrs))
	for k := range p.Attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(p.Sel)
	b.WriteByte(0)
	b.WriteString(p.Text)
	b.WriteByte(0)
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(1)
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(p.Attrs[k])
	}
	return fmt.Sprintf("dom:%08x", fnv1a32(b.String()))
}

func fnv1a32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
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

func validConfidence(c *int) (int, bool) {
	if c == nil || *c < 0 || *c > 100 {
		return 0, false
	}
	return *c, true
}

func matchRule(r Rule, c *matchCtx) (bool, []Evidence, *int) {
	results := make([]bool, 0, len(r.Matchers))
	var ev []Evidence
	var conf *int
	and := r.MatchersCondition == "and"
	for _, m := range r.Matchers {
		ok, sub := evalMatcher(m, c)
		results = append(results, ok)
		ev = append(ev, sub...)
		if !ok {
			continue
		}
		c, ok := validConfidence(m.Confidence)
		if !ok {
			continue
		}
		// or 取最强的已标注信号，and 取已标注信号里的短板
		if conf == nil || (and && c < *conf) || (!and && c > *conf) {
			v := c
			conf = &v
		}
	}
	if !combine(results, r.MatchersCondition) {
		return false, nil, nil
	}
	if rc, ok := validConfidence(r.Confidence); ok {
		if conf == nil {
			v := rc
			conf = &v
		} else {
			v := *conf * rc / 100
			conf = &v
		}
	}
	return true, ev, conf
}

// implies 级联：命中 A 就补上 A 声明的技术，一轮轮推到没有新东西为止。
// 被推导的技术不需要有自己的规则，直接给一条裸命中
// byName 由 rulesetFor 一次性预计算（小写 name/id -> *Rule），避免每次调用重建大 map
func applyImplies(hits []Hit, byName map[string]*Rule) []Hit {
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
// 在 implies 之后跑，推导出来的也能被排掉。byName 同上由 rulesetFor 预计算
func applyExcludes(hits []Hit, byName map[string]*Rule) []Hit {
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
