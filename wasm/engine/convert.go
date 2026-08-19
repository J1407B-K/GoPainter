// 指纹 JSON → GoPainter 规则。
// 数据由用户在浏览器里实时拉取
// 这个文件只含转换逻辑，不含任何数据
package engine

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// --- Wappalyzer technologies JSON（github.com/enthec/webappanalyzer） ---
// 我们用的字段；excludes 这些不管
type wappTech struct {
	Headers   map[string]any `json:"headers"`
	Cookies   map[string]any `json:"cookies"`
	Meta      map[string]any `json:"meta"`
	HTML      any            `json:"html"`
	ScriptSrc any            `json:"scriptSrc"`
	URL       any            `json:"url"`
	Js        map[string]any `json:"js"`  // window 全局路径 -> 值模式
	Dom       any            `json:"dom"` // 字符串 / 数组 / {selector: {...}}
	Implies   any            `json:"implies"`
	Excludes  any            `json:"excludes"`
}

// wappalyzer 的模式带 "\;version:\1" / "\;confidence:50" 这种后缀。
// pattern、confidence 和 version 必须一起流过转换器，不能在分组时串到别的模式。
type wappPatternMeta struct {
	confidence *int
	version    string
}

func sortedWappKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func splitWappMeta(p string) (string, *int, string) {
	parts := strings.Split(p, "\\;")
	var conf *int
	version := ""
	for _, tag := range parts[1:] {
		if value, ok := strings.CutPrefix(tag, "confidence:"); ok {
			if parsed, err := strconv.Atoi(value); err == nil {
				v := parsed
				conf = &v
			}
		}
		if value, ok := strings.CutPrefix(tag, "version:"); ok {
			version = value
		}
	}
	return parts[0], conf, version
}

func cleanWappPattern(p string) string {
	c, _, _ := splitWappMeta(p)
	return c
}

// 字段值可能是单个字符串或字符串数组
func wappPatterns(v any) []string {
	switch x := v.(type) {
	case string:
		if x != "" {
			return []string{x}
		}
	case []any:
		var out []string
		for _, s := range x {
			if str, ok := s.(string); ok && str != "" {
				out = append(out, str)
			}
		}
		return out
	}
	return nil
}

// RE2 编译有界重复会按次数展开，TinyGo wasm 的栈很小，{1,512}（Livewire）直接爆，
// 连 {0,64}（bowser）嵌在分组里也扛不住。上界超过 16 就放宽成 {n,}，指纹场景语义几乎不变。
// 注意：栈溢出是致命 panic，recover 接不住，只能事前驯化
var bigRepeatRe = regexp.MustCompile(`\{(\d+)(?:,(\d+))?\}`)

const maxRepeat = 16

func tamePattern(p string) string {
	return bigRepeatRe.ReplaceAllStringFunc(p, func(m string) string {
		sub := bigRepeatRe.FindStringSubmatch(m)
		n, _ := strconv.Atoi(sub[1])
		if strings.Contains(m, ",") {
			if sub[2] == "" { // {n,} 本来就没事
				return m
			}
			if hi, _ := strconv.Atoi(sub[2]); hi > maxRepeat {
				return "{" + sub[1] + ",}"
			}
			return m
		}
		if n > maxRepeat {
			return "{" + sub[1] + ",}"
		}
		return m
	})
}

// 括号嵌套太深 RE2 编译递归也会爆栈（驯化只管重复次数），数一下深度提前拦掉
const maxNestDepth = 32

func nestDepth(p string) int {
	depth, maxDepth := 0, 0
	inClass := false
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c == '\\' {
			i++ // 转义的括号不算
			continue
		}
		if c == '[' {
			inClass = true
		} else if c == ']' {
			inClass = false
		} else if !inClass {
			if c == '(' {
				depth++
				if depth > maxDepth {
					maxDepth = depth
				}
			} else if c == ')' && depth > 0 {
				depth--
			}
		}
	}
	return maxDepth
}

// 编译包一层 recover，个别妖孽模式 panic 也不至于炸掉整个 wasm。
// 注意栈溢出 recover 接不住，所以嵌套深度在这里提前卡死
func validateRegexDepth(p string) error {
	if nestDepth(p) > maxNestDepth {
		return fmt.Errorf("括号嵌套超过 %d 层，放弃", maxNestDepth)
	}
	return nil
}

func safeCompile(p string) (re *regexp.Regexp, err error) {
	if err := validateRegexDepth(p); err != nil {
		return nil, err
	}
	defer func() {
		if r := recover(); r != nil {
			re, err = nil, fmt.Errorf("编译崩溃: %v", r)
		}
	}()
	return regexp.Compile(p)
}

// Go 的 regexp 是 RE2，不支持反向引用，个别模式编译不了就丢
func compilable(patterns []string) []string {
	out := patterns[:0]
	for _, p := range patterns {
		if _, err := safeCompile(tamePattern(p)); err == nil {
			out = append(out, tamePattern(p))
		}
	}
	return out
}

// 丢坏模式时元数据同步丢弃，保持 version/confidence 与 pattern 对齐。
func compilableMeta(patterns []string, metas []wappPatternMeta) ([]string, []wappPatternMeta) {
	outP := patterns[:0]
	outM := metas[:0]
	for i, p := range patterns {
		if _, err := safeCompile(tamePattern(p)); err == nil {
			outP = append(outP, tamePattern(p))
			outM = append(outM, metas[i])
		}
	}
	return outP, outM
}

func confKey(c *int) int {
	if c == nil || *c < 0 || *c > 100 {
		return -1
	}
	return *c
}

func confFromKey(c int) *int {
	if c < 0 {
		return nil
	}
	v := c
	return &v
}

type matcherMetaKey struct {
	confidence int
	version    string
}

func metaKey(meta wappPatternMeta) matcherMetaKey {
	return matcherMetaKey{confidence: confKey(meta.confidence), version: meta.version}
}

func appendWordMatchersByMeta(out []Matcher, part string, words []string, metas []wappPatternMeta) []Matcher {
	grouped := make(map[matcherMetaKey][]string)
	var order []matcherMetaKey
	for i, w := range words {
		key := metaKey(metas[i])
		if _, ok := grouped[key]; !ok {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], w)
	}
	for _, key := range order {
		out = append(out, Matcher{Type: "word", Part: part, Words: grouped[key], Confidence: confFromKey(key.confidence), Version: key.version})
	}
	return out
}

func appendRegexMatchersByMeta(out []Matcher, part string, regexes []string, metas []wappPatternMeta) []Matcher {
	grouped := make(map[matcherMetaKey][]string)
	var order []matcherMetaKey
	for i, r := range regexes {
		key := metaKey(metas[i])
		if _, ok := grouped[key]; !ok {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], r)
	}
	for _, key := range order {
		out = append(out, Matcher{Type: "regex", Part: part, Regex: grouped[key], Confidence: confFromKey(key.confidence), Version: key.version})
	}
	return out
}

func appendJsMatchersByMeta(out []Matcher, probes []JsProbe, metas []wappPatternMeta) []Matcher {
	grouped := make(map[matcherMetaKey][]JsProbe)
	var order []matcherMetaKey
	for i, p := range probes {
		key := metaKey(metas[i])
		if _, ok := grouped[key]; !ok {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], p)
	}
	for _, key := range order {
		out = append(out, Matcher{Type: "js", Js: grouped[key], Confidence: confFromKey(key.confidence), Version: key.version})
	}
	return out
}

func appendDomMatchersByMeta(out []Matcher, probes []DomProbe, metas []wappPatternMeta) []Matcher {
	grouped := make(map[matcherMetaKey][]DomProbe)
	var order []matcherMetaKey
	for i, p := range probes {
		key := metaKey(metas[i])
		if _, ok := grouped[key]; !ok {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], p)
	}
	for _, key := range order {
		out = append(out, Matcher{Type: "dom", Dom: grouped[key], Confidence: confFromKey(key.confidence), Version: key.version})
	}
	return out
}

// 响应头是 "k: v" 格式（k 小写），按行首匹配 key。
// 值模式两种语义要区分（之前一律 \s* 接值开头，把"值里包含"类规则全弄死了）：
//
//	原版以 ^ 开头 → 值的开头匹配（剥掉 ^，我们自己的行首锚定已经管了）
//	否则           → 值里任意位置包含（补 [^\n]*）
//
// 结尾的 $ 保留，(?m) 下能正确锚到行尾
func headerPattern(key, pattern string) string {
	p := `(?im)^` + regexp.QuoteMeta(strings.ToLower(key)) + `:`
	if pattern == "" {
		return p
	}
	if strings.HasPrefix(pattern, "^") {
		return p + `\s*` + strings.TrimPrefix(pattern, "^")
	}
	return p + `[^\n]*` + pattern
}

// 不含正则元字符的模式转成纯字符串（word matcher 用 strings.Contains，比正则快几个量级）。
// 只认 \/ 和 \\ 两种转义，其他带 \ 的都按正则处理
func plainLiteral(p string) (string, bool) {
	if strings.ContainsAny(p, ".+*?()|[]{}^$") {
		return "", false
	}
	var b strings.Builder
	for i := 0; i < len(p); i++ {
		if p[i] == '\\' {
			if i+1 < len(p) && (p[i+1] == '/' || p[i+1] == '\\') {
				b.WriteByte(p[i+1])
				i++
				continue
			}
			return "", false
		}
		b.WriteByte(p[i])
	}
	return b.String(), true
}

// 模式列表拆成"纯字符串"和"真正则"两组，各做一个 matcher。
// metas 与 patterns 平行，跟着各自的模式走。
func splitPatterns(patterns []string, metas []wappPatternMeta, part string) []Matcher {
	var words, regexes []string
	var wordMetas, regexMetas []wappPatternMeta
	for i, p := range patterns {
		if lit, ok := plainLiteral(p); ok {
			words = append(words, lit)
			wordMetas = append(wordMetas, metas[i])
		} else {
			regexes = append(regexes, p)
			regexMetas = append(regexMetas, metas[i])
		}
	}
	var out []Matcher
	if len(words) > 0 {
		out = appendWordMatchersByMeta(out, part, words, wordMetas)
	}
	if regexes, regexMetas = compilableMeta(regexes, regexMetas); len(regexes) > 0 {
		out = appendRegexMatchersByMeta(out, part, regexes, regexMetas)
	}
	return out
}

func convertWappHeaders(t wappTech) []Matcher {
	var patterns []string
	var metas []wappPatternMeta
	for _, k := range sortedWappKeys(t.Headers) {
		v := t.Headers[k]
		for _, p := range wappPatterns(v) {
			clean, conf, version := splitWappMeta(p)
			patterns = append(patterns, headerPattern(k, clean))
			metas = append(metas, wappPatternMeta{confidence: conf, version: version})
		}
	}
	for _, k := range sortedWappKeys(t.Cookies) {
		v := t.Cookies[k]
		// cookie 在响应头里是 set-cookie: name=...（书签/爬取链路拿不到 set-cookie，尽力而为）
		ps := wappPatterns(v)
		if len(ps) == 0 {
			patterns = append(patterns, headerPattern("set-cookie", regexp.QuoteMeta(k)+`=`))
			metas = append(metas, wappPatternMeta{})
		}
		for _, p := range ps {
			clean, conf, version := splitWappMeta(p)
			patterns = append(patterns, headerPattern("set-cookie", regexp.QuoteMeta(k)+`=`+clean))
			metas = append(metas, wappPatternMeta{confidence: conf, version: version})
		}
	}
	if patterns, metas = compilableMeta(patterns, metas); len(patterns) > 0 {
		return appendRegexMatchersByMeta(nil, "header", patterns, metas)
	}
	return nil
}

func convertWappMeta(t wappTech) []Matcher {
	var patterns []string
	var metas []wappPatternMeta
	for _, k := range sortedWappKeys(t.Meta) {
		v := t.Meta[k]
		for _, p := range wappPatterns(v) {
			clean, conf, version := splitWappMeta(p)
			patterns = append(patterns, headerPattern(k, clean))
			metas = append(metas, wappPatternMeta{confidence: conf, version: version})
		}
	}
	if patterns, metas = compilableMeta(patterns, metas); len(patterns) > 0 {
		return appendRegexMatchersByMeta(nil, "meta", patterns, metas)
	}
	return nil
}

func convertWappPatternParts(t wappTech) []Matcher {
	var matchers []Matcher
	for _, part := range []struct {
		field any
		part  string
	}{
		{t.HTML, "body"},
		{t.ScriptSrc, "script"},
		{t.URL, "url"},
	} {
		var ps []string
		var metas []wappPatternMeta
		for _, p := range wappPatterns(part.field) {
			clean, conf, version := splitWappMeta(p)
			if clean != "" {
				ps = append(ps, clean)
				metas = append(metas, wappPatternMeta{confidence: conf, version: version})
			}
		}
		if ps, metas = compilableMeta(ps, metas); len(ps) > 0 {
			matchers = append(matchers, splitPatterns(ps, metas, part.part)...)
		}
	}
	return matchers
}

func convertWappJS(t wappTech) []Matcher {
	// js 全局变量：path 存在即命中，模式非空则值也要匹配
	var probes []JsProbe
	var probeMetas []wappPatternMeta
	for _, path := range sortedWappKeys(t.Js) {
		v := t.Js[path]
		pattern := ""
		var conf *int
		version := ""
		if ps := wappPatterns(v); len(ps) > 0 {
			pattern, conf, version = splitWappMeta(ps[0])
			if _, err := safeCompile(pattern); err != nil {
				pattern = ""
			}
		}
		probes = append(probes, JsProbe{Path: path, Pattern: tamePattern(pattern)})
		probeMetas = append(probeMetas, wappPatternMeta{confidence: conf, version: version})
	}
	if len(probes) > 0 {
		return appendJsMatchersByMeta(nil, probes, probeMetas)
	}
	return nil
}

func convertWappDOM(t wappTech) []Matcher {
	// dom 选择器。
	// 字符串/数组形态：裸"存在"语义，但要过信息量检查（*、div、body > * 这种在哪都中，丢）。
	// 对象形态：{selector: {exists/text/attributes/properties}} —— 条件才是规则本体！
	//
	//	exists          → 只留选择器（但要过信息量检查）
	//	text/attributes → 保留完整条件（content.js 能评估）
	//	properties      → content script 摸不到页面挂在 DOM 上的 expando，丢
	var domProbes []DomProbe
	var domMetas []wappPatternMeta
	for _, s := range wappPatterns(t.Dom) {
		clean, conf, version := splitWappMeta(s)
		if informativeSelector(clean) {
			domProbes = append(domProbes, DomProbe{Sel: clean})
			domMetas = append(domMetas, wappPatternMeta{confidence: conf, version: version})
		}
	}
	if domMap, ok := t.Dom.(map[string]any); ok {
		for _, sel := range sortedWappKeys(domMap) {
			cond := domMap[sel]
			condMap, _ := cond.(map[string]any)
			if condMap == nil { // 没条件，退化成 exists
				if informativeSelector(sel) {
					domProbes = append(domProbes, DomProbe{Sel: sel})
					domMetas = append(domMetas, wappPatternMeta{})
				}
				continue
			}
			if _, hasProps := condMap["properties"]; hasProps {
				continue // 需要页面运行时属性，放弃这条
			}
			p := DomProbe{Sel: sel}
			var conf *int
			version := ""
			if ps := wappPatterns(condMap["text"]); len(ps) > 0 {
				p.Text, conf, version = splitWappMeta(ps[0])
			}
			if attrs, ok := condMap["attributes"].(map[string]any); ok {
				p.Attrs = make(map[string]string, len(attrs))
				for _, k := range sortedWappKeys(attrs) {
					v := attrs[k]
					if ps := wappPatterns(v); len(ps) > 0 {
						c, cc, vv := splitWappMeta(ps[0])
						p.Attrs[k] = c
						if conf == nil {
							conf = cc
						}
						if version == "" {
							version = vv
						}
					}
				}
			}
			if p.Text == "" && len(p.Attrs) == 0 && !informativeSelector(sel) {
				continue // 裸存在 + 无信息量
			}
			domProbes = append(domProbes, p)
			domMetas = append(domMetas, wappPatternMeta{confidence: conf, version: version})
		}
	}
	if len(domProbes) > 0 {
		return appendDomMatchersByMeta(nil, domProbes, domMetas)
	}
	return nil
}

func convertWappTech(name string, t wappTech) *Rule {
	var matchers []Matcher
	matchers = append(matchers, convertWappHeaders(t)...)
	matchers = append(matchers, convertWappMeta(t)...)
	matchers = append(matchers, convertWappPatternParts(t)...)
	matchers = append(matchers, convertWappJS(t)...)
	matchers = append(matchers, convertWappDOM(t)...)
	if len(matchers) == 0 {
		return nil
	}
	return &Rule{
		ID:                slugify(name),
		Name:              name,
		MatchersCondition: "or",
		Matchers:          matchers,
		Implies:           cleanAll(wappPatterns(t.Implies)),
		Excludes:          cleanAll(wappPatterns(t.Excludes)),
	}
}

// 裸标签/通配选择器（*、div、body > *、head > title 这种）在任何页面都命中，
// 没有信息量，丢掉。含 class/id/属性/伪类的才保留
func informativeSelector(sel string) bool {
	for _, part := range strings.Split(sel, ",") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, ".#[:") {
			return true
		}
	}
	return false
}

func cleanAll(ps []string) []string {
	out := ps[:0]
	for _, p := range ps {
		if c := cleanWappPattern(p); c != "" {
			out = append(out, c)
		}
	}
	return out
}

// "Angular Material" -> "angular-material"，"致远OA" -> "致远oa"（汉字保留）
func slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || unicode.Is(unicode.Han, r):
			b.WriteRune(r)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// --- EHole finger.json（github.com/EdgeSecurityTeam/EHole） ---
// 格式: [{"cms":"致远OA","method":"keyword","location":"body","keyword":["/seeyon/"]}]
// 旧版/部分镜像也可能包一层 {"fingerprint":[...]}，两种都兼容。
// method 就两种：keyword（body/title/header 关键词）和 faviconhash

type eholeFinger struct {
	Cms      string `json:"cms"`
	Method   string `json:"method"`
	Location string `json:"location"`
	Keyword  any    `json:"keyword"` // keyword 是 []string，faviconhash 是字符串数字
}

func convertEHole(jsonStr string) ([]Rule, error) {
	var fingers []eholeFinger
	if err := json.Unmarshal([]byte(jsonStr), &fingers); err != nil {
		var data struct {
			Fingerprint []eholeFinger `json:"fingerprint"`
		}
		if err := json.Unmarshal([]byte(jsonStr), &data); err != nil {
			return nil, err
		}
		fingers = data.Fingerprint
	}
	return convertEHoleFingers(fingers), nil
}

func groupEHoleFingers(fingers []eholeFinger) (map[string][]eholeFinger, []string) {
	byCms := make(map[string][]eholeFinger)
	var order []string
	for _, fp := range fingers {
		if fp.Cms == "" {
			continue
		}
		if _, ok := byCms[fp.Cms]; !ok {
			order = append(order, fp.Cms)
		}
		byCms[fp.Cms] = append(byCms[fp.Cms], fp)
	}
	return byCms, order
}

func eholeStrings(value any) []string {
	switch typed := value.(type) {
	case string:
		return []string{typed}
	case []any:
		var values []string
		for _, item := range typed {
			if value, ok := item.(string); ok {
				values = append(values, value)
			}
		}
		return values
	default:
		return nil
	}
}

func eholeHashes(value any) []int32 {
	var hashes []int32
	for _, text := range eholeStrings(value) {
		var hash int64
		if _, err := fmt.Sscanf(text, "%d", &hash); err == nil && hash != 0 {
			hashes = append(hashes, int32(hash))
		}
	}
	return hashes
}

func convertEHoleFinger(fp eholeFinger) (Matcher, bool) {
	switch fp.Method {
	case "keyword":
		switch fp.Location {
		case "body", "title", "header", "url":
		default:
			return Matcher{}, false
		}
		words := eholeStrings(fp.Keyword)
		return Matcher{Type: "word", Part: fp.Location, Words: words, Condition: "and"}, len(words) > 0
	case "faviconhash":
		hashes := eholeHashes(fp.Keyword)
		return Matcher{Type: "icon_hash", Hash: hashes}, len(hashes) > 0
	default:
		return Matcher{}, false
	}
}

func convertEHoleFingers(fingers []eholeFinger) []Rule {
	// 按 cms 分组，一个系统一条规则。
	byCms, order := groupEHoleFingers(fingers)

	rules := make([]Rule, 0, len(byCms))
	for _, cms := range order {
		var matchers []Matcher
		for _, fp := range byCms[cms] {
			if matcher, ok := convertEHoleFinger(fp); ok {
				matchers = append(matchers, matcher)
			}
		}
		if len(matchers) > 0 {
			rules = append(rules, Rule{ID: slugify(cms), Name: cms, MatchersCondition: "or", Matchers: matchers})
		}
	}
	return rules
}
