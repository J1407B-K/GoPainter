// 匹配引擎：规则定义 + 求值。这是 wasm 的核心，其他文件都是给它打辅助的。
package engine

import (
	"fmt"
	regexpsyntax "regexp/syntax"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
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
var regexCache = make(map[string]regexMatcher)

// ClearRegexCache 清空正则编译缓存。规则集一变（rulesetFor 重建）就调一次，
// 旧规则的正则不再占用 WASM 内存；规则没变时缓存照常复用。
func ClearRegexCache() {
	regexCache = make(map[string]regexMatcher)
	regexASTCache = make(map[string]*regexpsyntax.Regexp)
}

// recover 兜底接住普通 panic；栈溢出接不住，靠 safeCompile 里的驯化+深度检查事前拦
func compileRegex(pattern string) (re regexMatcher, err error) {
	if cached, ok := regexCache[pattern]; ok {
		return cached, nil
	}
	p := tamePattern(pattern)
	if err := validateRegexDepth(p); err != nil {
		return nil, err
	}
	defer func() {
		if r := recover(); r != nil {
			re, err = nil, fmt.Errorf("编译崩溃: %v", r)
		}
	}()
	re, err = compileRegexBackend(p)
	if err == nil {
		regexCache[pattern] = re
	}
	return re, err
}

// 正则「必需字面量」预筛，基于 regexp/syntax 的 AST 按分支保守判定。
//
// 安全模型：要安全跳过整个正则，必须证明它的每一条可匹配路径都被排除。
//   - Concat（序列）：任一子节点被排除 → 整个序列被排除（序列要求全部匹配）
//   - Alternate（交替）：全部分支被排除 → 交替被排除；任一分支仍可能 → 不能排除
//   - Literal：字面量不在文本里 → 该分支被排除
//   - 其他（CharClass / Repeat(min=0) / Quest / Star / 锚点等）：无法证明 → 永不排除
// 这样 (?:foo|[0-9]+) 的数字分支是 CharClass，永不排除 → 永不误跳过（宁少跳，绝不 false negative）。
//
// AST 按 pattern 缓存（跟 regexCache 一起失效），避免每次匹配重复解析。

var regexASTCache = make(map[string]*regexpsyntax.Regexp)

// regexAST 取正则的解析 AST（缓存）。解析失败返回 nil。
func regexAST(pattern string) *regexpsyntax.Regexp {
	if n := regexASTCache[pattern]; n != nil {
		return n
	}
	parsed, err := regexpsyntax.Parse(pattern, regexpsyntax.Perl)
	if err != nil {
		regexASTCache[pattern] = nil // 解析失败，之后不再试
		return nil
	}
	regexASTCache[pattern] = parsed
	return parsed
}

// regexLiterals 提取正则里所有 OpLiteral 的小写串（去重）。预筛的每个必需字面量
// 都要进 body AC 索引，否则预筛 map 查 miss 会误判「不在文本」→ 误跳过。
func regexLiterals(pattern string) []string {
	n := regexAST(pattern)
	if n == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	var walk func(node *regexpsyntax.Regexp)
	walk = func(node *regexpsyntax.Regexp) {
		if node.Op == regexpsyntax.OpLiteral && len(node.Rune) > 0 {
			s := strings.ToLower(string(node.Rune))
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
		for _, s := range node.Sub {
			walk(s)
		}
	}
	walk(n)
	return out
}

// regexCanSkip 判断正则能否安全跳过：AST 全部分支都被排除 → true。
// 解析失败或任何分支无法证明被排除 → false（跑正则确认，语义不变）。
// hasFoldSensitive：part 文本含非 ASCII 时传入 true（此时一律不预筛，见 regexNodeExcluded）。
// litInText：非空时用「查命中集合」代替 Contains 判字面量在不在文本（body 有 AC 索引时传）；
//
//	为 nil 则退化为 strings.Contains（非 body 小文本用）。
func regexCanSkip(pattern, lowerText string, hasFoldSensitive bool, litInText func(string) bool) bool {
	n := regexAST(pattern)
	if n == nil {
		return false
	}
	return regexNodeExcluded(n, lowerText, hasFoldSensitive, litInText)
}

// regexNodeExcluded 递归判定一个 AST 节点是否「必然不匹配」。
func regexNodeExcluded(n *regexpsyntax.Regexp, lowerText string, hasFoldSensitive bool, litInText func(string) bool) bool {
	switch n.Op {
	case regexpsyntax.OpLiteral:
		lit := strings.ToLower(string(n.Rune))
		// 非 ASCII literal：strings.ToLower 与 regexp 的 SimpleFold 可能分歧
		// （(?i)σ 匹配 ς，但 ToLower 不折叠），无法安全证明排除 → 跑原正则。
		if !isASCIIStr(lit) {
			return false
		}
		// part 含 ſ/K（与 ASCII s/k 折叠等价）：该 ASCII literal 保守不排除。
		// 纯中文/纯 ASCII 的 part 不受影响，预筛照常。
		if hasFoldSensitive {
			return false
		}
		if litInText != nil {
			// 字面量不在 AC 命中集合 → 必然不匹配（索引里含全部字面量，查 miss 即不在）
			return !litInText(lit)
		}
		// 非索引路径：Contains 查小写文本
		return !strings.Contains(lowerText, lit)
	case regexpsyntax.OpConcat:
		// 序列：全部子项都要匹配，任一子项被排除 → 整个序列被排除
		for _, s := range n.Sub {
			if regexNodeExcluded(s, lowerText, hasFoldSensitive, litInText) {
				return true
			}
		}
		return false
	case regexpsyntax.OpAlternate:
		// 交替：全部子分支被排除 → 交替被排除；任一分支仍可能 → 不能排除
		for _, s := range n.Sub {
			if !regexNodeExcluded(s, lowerText, hasFoldSensitive, litInText) {
				return false
			}
		}
		return true
	case regexpsyntax.OpCapture:
		if len(n.Sub) == 1 {
			return regexNodeExcluded(n.Sub[0], lowerText, hasFoldSensitive, litInText)
		}
		return false
	case regexpsyntax.OpPlus:
		// 至少一次，内层必需
		if len(n.Sub) == 1 {
			return regexNodeExcluded(n.Sub[0], lowerText, hasFoldSensitive, litInText)
		}
		return false
	case regexpsyntax.OpRepeat:
		if n.Min == 0 {
			return false // 可匹配空（省略）→ 不能排除
		}
		if len(n.Sub) == 1 {
			return regexNodeExcluded(n.Sub[0], lowerText, hasFoldSensitive, litInText)
		}
		return false
	case regexpsyntax.OpStar, regexpsyntax.OpQuest:
		return false // 可匹配空
	default:
		// CharClass / AnyChar / 锚点 / EmptyMatch 等：无法证明，保守不排除
		return false
	}
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
	// raw = header + body（nuclei 的 raw part 也是这个语义）。体量大、又只有
	// part=raw / dsl 里 raw 才用，绝大多数规则用不到——惰性拼，省掉每次匹配
	// 一份 ~body 大小的拷贝。
	raw     string
	rawDone bool
	// raw 的小写版，同样惰性
	lowerRaw     string
	lowerRawDone bool

	// 小写版（word 匹配用），每个 part 只小写一次
	lowerBody   string
	lowerTitle  string
	lowerURL    string
	lowerHeader string
	lowerMeta   string
	lowerScript string

	// body word 命中集合：attachBodyIndex 扫一次 lowerBody 得到，
	// 有索引时 body 的 word matcher 从 O(词数×body) 退化成 map 查询
	bodyWordHits map[string]bool

	// 每个 part 文本是否含「与 ASCII 折叠敏感」的非 ASCII（惰性缓存）：正则预筛用。
	// 只有 ſ/K 这类才禁用预筛；纯中文/纯 ASCII 不受影响。
	foldSens map[string]bool
}

// foldSensitiveRunes：与 ASCII 字母有 SimpleFold 折叠关系的非 ASCII rune 集合。
// 只有这些字符会让 strings.ToLower 与 regexp 的 (?i) 折叠语义分歧（如 ſ↔s、K↔k），
// 预筛需禁用。中文/emoji/CJK 无大小写折叠，不在集合里——含它们的页面仍可安全预筛。
var foldSensitiveRunes = func() map[rune]bool {
	m := make(map[rune]bool)
	for _, r := range "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" {
		for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
			if f >= 0x80 {
				m[f] = true
			}
		}
	}
	return m
}()

// isASCIIStr 判断字符串是否纯 ASCII（用于「非 ASCII literal 不预筛」的边界判断）。
func isASCIIStr(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// partHasFoldSensitive 返回 matcher 的 part 文本是否含「与 ASCII 有折叠关系的非 ASCII
// 字符」（如 ſ/K，惰性缓存一次）。含这类字符才禁用预筛；纯中文/纯 ASCII 都不禁。
func (c *matchCtx) partHasFoldSensitive(m Matcher) bool {
	part := m.Part
	if part == "" {
		part = "body"
	}
	if v, ok := c.foldSens[part]; ok {
		return v
	}
	text := c.partText(m)
	v := false
	for i := 0; i < len(text); i++ {
		if text[i] < 0x80 {
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		if foldSensitiveRunes[r] {
			v = true
			break
		}
		i += size - 1
	}
	if c.foldSens == nil {
		c.foldSens = make(map[string]bool)
	}
	c.foldSens[part] = v
	return v
}

// regexLitLookup 返回「字面量是否在 part 文本」的判定器，给正则预筛用。
// body 有 AC 索引（bodyWordHits 含 regex 字面量）时查 map（O(1)）；其他 part 或
// 无索引时返回 nil（调用方退化为 Contains 小文本）。
func (c *matchCtx) regexLitLookup(m Matcher) func(string) bool {
	if (m.Part == "" || m.Part == "body") && c.bodyWordHits != nil {
		return func(lit string) bool { return c.bodyWordHits[lit] }
	}
	return nil
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
	return c
}

// rawText / lowerRawText 惰性返回 header+body（及小写版）。只有 part=raw 的
// matcher 或 dsl 里的 raw 才触发拼接；无 raw 规则时这些分配直接省掉。
func (c *matchCtx) rawText() string {
	if !c.rawDone {
		c.raw = c.header + c.f.Body
		c.rawDone = true
	}
	return c.raw
}

func (c *matchCtx) lowerRawText() string {
	if !c.lowerRawDone {
		c.lowerRaw = c.lowerHeader + c.lowerBody
		c.lowerRawDone = true
	}
	return c.lowerRaw
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
		return c.rawText()
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
		return c.lowerRawText()
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

// triState 增量聚合 matcher 内多个子条件（多个 words / regex 等）的三态结果。
// 之前先建 []evalResult 再 combine3，每条 matcher 一次切片分配——大规则集里
// 这是按规则数线性累积的 GC 负担。这里边算边折，语义与 combine3 完全一致：
// and 有 miss 定 miss，否则有 invalid 算 invalid；or 有 hit 定 hit，否则有 invalid 算 invalid。
type triState struct {
	val  evalResult
	have bool
}

func (t *triState) add(r evalResult, condition string) {
	if !t.have {
		t.val = r
		t.have = true
		return
	}
	if condition == "and" {
		switch {
		case t.val == evalMiss || r == evalMiss:
			t.val = evalMiss
		case t.val == evalInvalid || r == evalInvalid:
			t.val = evalInvalid
		default:
			t.val = evalHit
		}
		return
	}
	switch {
	case t.val == evalHit || r == evalHit:
		t.val = evalHit
	case t.val == evalInvalid || r == evalInvalid:
		t.val = evalInvalid
	default:
		t.val = evalMiss
	}
}

// result 返回折叠结果；没有任何子条件（空结果集）算未命中。
func (t *triState) result() evalResult {
	if !t.have {
		return evalMiss
	}
	return t.val
}

func evalWordMatcher(m *Matcher, c *matchCtx, part string, st *triState, ev *[]Evidence) {
	// body 有索引走命中集合；空词与 strings.Contains("")=true 对齐
	if c.bodyWordHits != nil && part == "body" {
		for _, word := range m.Words {
			ok := word == "" || c.bodyWordHits[strings.ToLower(word)]
			st.add(boolResult(ok), m.Condition)
			if ok {
				*ev = append(*ev, Evidence{Type: "word", Part: part, Detail: word})
			}
		}
		return
	}
	cmpText := c.partTextLower(*m)
	for _, word := range m.Words {
		ok := strings.Contains(cmpText, strings.ToLower(word))
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "word", Part: part, Detail: word})
		}
	}
}

func evalRegexMatcher(m *Matcher, c *matchCtx, part string, st *triState, ev *[]Evidence) {
	text := c.partText(*m)
	lowerText := c.partTextLower(*m)
	hasFoldSensitive := c.partHasFoldSensitive(*m)
	for _, pattern := range m.Regex {
		re, err := compileRegex("(?i)" + pattern)
		if err != nil {
			re, err = compileRegex(pattern)
		}
		if err != nil {
			// 正则是坏的，这条件判无效而不是未命中：negative 不能拿它当"没出现"
			st.add(evalInvalid, m.Condition)
			continue
		}
		// AST 证明必然不匹配才跳过；含非 ASCII 的 part 不预筛。
		if regexCanSkip(pattern, lowerText, hasFoldSensitive, c.regexLitLookup(*m)) {
			st.add(evalMiss, m.Condition)
			continue
		}
		ok := re.MatchString(text)
		st.add(boolResult(ok), m.Condition)
		if !ok {
			continue
		}
		detail := re.FindString(text)
		if len(detail) > 120 {
			detail = detail[:120] + "…"
		}
		if detail == "" {
			detail = "（零宽匹配）"
		}
		*ev = append(*ev, Evidence{Type: "regex", Part: part, Detail: detail, Pattern: pattern})
	}
}

func evalStatusMatcher(m *Matcher, f *Features, st *triState, ev *[]Evidence) {
	for _, status := range m.Status {
		ok := f.Status == status
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "status", Detail: fmt.Sprintf("状态码 %d", status)})
		}
	}
}

func evalIconHashMatcher(m *Matcher, f *Features, st *triState, ev *[]Evidence) {
	// 页面的所有 icon 哈希都参与比对，不知道哪个图案才是指纹库里那个
	for _, hash := range m.Hash {
		ok := slices.Contains(f.FaviconHashes, hash)
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "icon_hash", Detail: fmt.Sprintf("mmh3 %d", hash)})
		}
	}
}

func evalDSLMatcher(m *Matcher, c *matchCtx, st *triState, ev *[]Evidence) {
	for _, expression := range m.Dsl {
		ok, err := dslEval(expression, c)
		if err != nil {
			// DSL 语法/求值出错判无效，negative 不能反转。
			st.add(evalInvalid, m.Condition)
			continue
		}
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "dsl", Detail: expression})
		}
	}
}

func evalJSMatcher(m *Matcher, f *Features, st *triState, ev *[]Evidence) {
	for _, probe := range m.Js {
		value, exists := f.Js[probe.Path]
		if !exists {
			st.add(evalMiss, m.Condition)
			continue
		}
		if probe.Pattern == "" {
			st.add(evalHit, m.Condition)
			*ev = append(*ev, Evidence{Type: "js", Detail: jsProbeDetail(probe.Path, value)})
			continue
		}
		re, err := compileRegex(probe.Pattern)
		if err != nil {
			st.add(evalInvalid, m.Condition)
			continue
		}
		ok := re.MatchString(value)
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "js", Detail: jsProbeDetail(probe.Path, value)})
		}
	}
}

func evalDOMMatcher(m *Matcher, f *Features, st *triState, ev *[]Evidence) {
	// JS 侧和这里用相同 probeID；命中即存在于 DomHits。
	for _, selector := range m.Words {
		ok := f.DomHits[probeID(DomProbe{Sel: selector})]
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "dom", Detail: selector})
		}
	}
	for _, probe := range m.Dom {
		ok := f.DomHits[probeID(probe)]
		st.add(boolResult(ok), m.Condition)
		if ok {
			*ev = append(*ev, Evidence{Type: "dom", Detail: probe.Sel})
		}
	}
}

func evalMatcherState(m *Matcher, c *matchCtx, part string, ev *[]Evidence) evalResult {
	st := triState{}
	switch m.Type {
	case "word":
		evalWordMatcher(m, c, part, &st, ev)
	case "regex":
		evalRegexMatcher(m, c, part, &st, ev)
	case "status":
		evalStatusMatcher(m, c.f, &st, ev)
	case "icon_hash":
		evalIconHashMatcher(m, c.f, &st, ev)
	case "dsl":
		evalDSLMatcher(m, c, &st, ev)
	case "js":
		evalJSMatcher(m, c.f, &st, ev)
	case "dom":
		evalDOMMatcher(m, c.f, &st, ev)
	default:
		// 未知 matcher 类型：整条 matcher 无效，不产出证据，negative 也不反转。
		st.add(evalInvalid, m.Condition)
	}
	return st.result()
}

// evalMatcherInto 求值单个 matcher，证据直接追加进调用方共享的 ev 切片。
// 之前 evalMatcher 内部自建 ev、返回后再被 matchRule 拷贝一次，命中多的规则集里
// 这两次切片分配按命中数线性累积；共享切片把命中路径的分配砍半。
func evalMatcherInto(m Matcher, c *matchCtx, ev *[]Evidence) bool {
	part := m.Part
	if part == "" {
		part = "body"
	}
	state := evalMatcherState(&m, c, part, ev)
	if m.Negative {
		switch state {
		case evalHit:
			return false
		case evalMiss:
			// negative 命中 = 东西确实不在，证据就一句话，不罗列具体条件
			*ev = append(*ev, Evidence{Type: m.Type, Part: part, Detail: "negative 成立：原条件未满足"})
			return true
		default: // evalInvalid：条件坏了，negative 不反转
			return false
		}
	}
	if state != evalHit {
		return false
	}
	return true
}

// evalMatcher 两参签名，测试用；热路径走 evalMatcherInto。
func evalMatcher(m Matcher, c *matchCtx) (bool, []Evidence) {
	var ev []Evidence
	ok := evalMatcherInto(m, c, &ev)
	return ok, ev
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

func validConfidence(c *int) (int, bool) {
	if c == nil || *c < 0 || *c > 100 {
		return 0, false
	}
	return *c, true
}

func matchRule(r Rule, c *matchCtx) (bool, []Evidence, *int) {
	and := r.MatchersCondition == "and"
	var ev []Evidence
	var conf *int
	// 边算边折叠 and/or，省掉 results []bool 这个每条规则一次的切片分配
	hit := false
	have := false
	for i := range r.Matchers {
		ok := evalMatcherInto(r.Matchers[i], c, &ev)
		if !have {
			hit = ok
			have = true
		} else if and {
			hit = hit && ok
		} else {
			hit = hit || ok
		}
		if !ok {
			continue
		}
		mc, valid := validConfidence(r.Matchers[i].Confidence)
		if !valid {
			continue
		}
		// or 取最强的已标注信号，and 取已标注信号里的短板
		if conf == nil || (and && mc < *conf) || (!and && mc > *conf) {
			v := mc
			conf = &v
		}
	}
	if !have || !hit {
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
