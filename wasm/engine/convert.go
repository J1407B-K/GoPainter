// 指纹 JSON → GoPainter 规则。
// 数据由用户在浏览器里实时拉取
// 这个文件只含转换逻辑，不含任何数据
package engine

import (
	"encoding/json"
	"fmt"
	"regexp"
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
// 版本提取我们不支持，切掉；confidence 捡起来填到 matcher 上
var wappConfRe = regexp.MustCompile(`\\;confidence:(\d+)`)

func splitWappMeta(p string) (string, *int) {
	i := strings.Index(p, "\\;")
	if i < 0 {
		return p, nil
	}
	var conf *int
	if m := wappConfRe.FindStringSubmatch(p[i:]); m != nil {
		v, _ := strconv.Atoi(m[1])
		conf = &v
	}
	return p[:i], conf
}

func cleanWappPattern(p string) string {
	c, _ := splitWappMeta(p)
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
	depth, max := 0, 0
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
				if depth > max {
					max = depth
				}
			} else if c == ')' && depth > 0 {
				depth--
			}
		}
	}
	return max
}

// 编译包一层 recover，个别妖孽模式 panic 也不至于炸掉整个 wasm。
// 注意栈溢出 recover 接不住，所以嵌套深度在这里提前卡死
func safeCompile(p string) (re *regexp.Regexp, err error) {
	if nestDepth(p) > maxNestDepth {
		return nil, fmt.Errorf("括号嵌套超过 %d 层，放弃", maxNestDepth)
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

// 成对版：丢模式的同时把它的 confidence 也丢了，保持两个切片对齐
func compilablePair(patterns []string, confs []*int) ([]string, []*int) {
	outP := patterns[:0]
	outC := confs[:0]
	for i, p := range patterns {
		if _, err := safeCompile(tamePattern(p)); err == nil {
			outP = append(outP, tamePattern(p))
			outC = append(outC, confs[i])
		}
	}
	return outP, outC
}

func confKey(confs []*int, i int) int {
	if i >= len(confs) {
		return -1
	}
	c := confs[i]
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

func appendWordMatchersByConf(out []Matcher, part string, words []string, confs []*int) []Matcher {
	byConf := make(map[int][]string)
	var order []int
	for i, w := range words {
		c := confKey(confs, i)
		if _, ok := byConf[c]; !ok {
			order = append(order, c)
		}
		byConf[c] = append(byConf[c], w)
	}
	for _, c := range order {
		out = append(out, Matcher{Type: "word", Part: part, Words: byConf[c], Confidence: confFromKey(c)})
	}
	return out
}

func appendRegexMatchersByConf(out []Matcher, part string, regexes []string, confs []*int) []Matcher {
	byConf := make(map[int][]string)
	var order []int
	for i, r := range regexes {
		c := confKey(confs, i)
		if _, ok := byConf[c]; !ok {
			order = append(order, c)
		}
		byConf[c] = append(byConf[c], r)
	}
	for _, c := range order {
		out = append(out, Matcher{Type: "regex", Part: part, Regex: byConf[c], Confidence: confFromKey(c)})
	}
	return out
}

func appendJsMatchersByConf(out []Matcher, probes []JsProbe, confs []*int) []Matcher {
	byConf := make(map[int][]JsProbe)
	var order []int
	for i, p := range probes {
		c := confKey(confs, i)
		if _, ok := byConf[c]; !ok {
			order = append(order, c)
		}
		byConf[c] = append(byConf[c], p)
	}
	for _, c := range order {
		out = append(out, Matcher{Type: "js", Js: byConf[c], Confidence: confFromKey(c)})
	}
	return out
}

func appendDomMatchersByConf(out []Matcher, probes []DomProbe, confs []*int) []Matcher {
	byConf := make(map[int][]DomProbe)
	var order []int
	for i, p := range probes {
		c := confKey(confs, i)
		if _, ok := byConf[c]; !ok {
			order = append(order, c)
		}
		byConf[c] = append(byConf[c], p)
	}
	for _, c := range order {
		out = append(out, Matcher{Type: "dom", Dom: byConf[c], Confidence: confFromKey(c)})
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
// confs 与 patterns 平行（\;confidence:N 解析来的），跟着各自的模式走
func splitPatterns(patterns []string, confs []*int, part string) []Matcher {
	var words, regexes []string
	var wordConfs, regexConfs []*int
	for i, p := range patterns {
		var conf *int
		if i < len(confs) {
			conf = confs[i]
		}
		if lit, ok := plainLiteral(p); ok {
			words = append(words, lit)
			wordConfs = append(wordConfs, conf)
		} else {
			regexes = append(regexes, p)
			regexConfs = append(regexConfs, conf)
		}
	}
	var out []Matcher
	if len(words) > 0 {
		out = appendWordMatchersByConf(out, part, words, wordConfs)
	}
	if regexes, regexConfs = compilablePair(regexes, regexConfs); len(regexes) > 0 {
		out = appendRegexMatchersByConf(out, part, regexes, regexConfs)
	}
	return out
}

func convertWappTech(name string, t wappTech) *Rule {
	var matchers []Matcher

	var headerRes, metaRes []string
	var headerConfs, metaConfs []*int
	for k, v := range t.Headers {
		for _, p := range wappPatterns(v) {
			clean, conf := splitWappMeta(p)
			headerRes = append(headerRes, headerPattern(k, clean))
			headerConfs = append(headerConfs, conf)
		}
	}
	for k, v := range t.Cookies {
		// cookie 在响应头里是 set-cookie: name=...（书签/爬取链路拿不到 set-cookie，尽力而为）
		ps := wappPatterns(v)
		if len(ps) == 0 {
			headerRes = append(headerRes, headerPattern("set-cookie", regexp.QuoteMeta(k)+`=`))
			headerConfs = append(headerConfs, nil)
		}
		for _, p := range ps {
			clean, conf := splitWappMeta(p)
			headerRes = append(headerRes, headerPattern("set-cookie", regexp.QuoteMeta(k)+`=`+clean))
			headerConfs = append(headerConfs, conf)
		}
	}
	if headerRes, headerConfs = compilablePair(headerRes, headerConfs); len(headerRes) > 0 {
		matchers = appendRegexMatchersByConf(matchers, "header", headerRes, headerConfs)
	}

	for k, v := range t.Meta {
		for _, p := range wappPatterns(v) {
			clean, conf := splitWappMeta(p)
			metaRes = append(metaRes, headerPattern(k, clean))
			metaConfs = append(metaConfs, conf)
		}
	}
	if metaRes, metaConfs = compilablePair(metaRes, metaConfs); len(metaRes) > 0 {
		matchers = appendRegexMatchersByConf(matchers, "meta", metaRes, metaConfs)
	}

	for _, part := range []struct {
		field any
		part  string
	}{
		{t.HTML, "body"},
		{t.ScriptSrc, "script"},
		{t.URL, "url"},
	} {
		var ps []string
		var confs []*int
		for _, p := range wappPatterns(part.field) {
			clean, conf := splitWappMeta(p)
			if clean != "" {
				ps = append(ps, clean)
				confs = append(confs, conf)
			}
		}
		if ps, confs = compilablePair(ps, confs); len(ps) > 0 {
			matchers = append(matchers, splitPatterns(ps, confs, part.part)...)
		}
	}

	// js 全局变量：path 存在即命中，模式非空则值也要匹配
	var probes []JsProbe
	var probeConfs []*int
	for path, v := range t.Js {
		pattern := ""
		var conf *int
		if ps := wappPatterns(v); len(ps) > 0 {
			pattern, conf = splitWappMeta(ps[0])
			if _, err := safeCompile(pattern); err != nil {
				pattern = ""
			}
		}
		probes = append(probes, JsProbe{Path: path, Pattern: tamePattern(pattern)})
		probeConfs = append(probeConfs, conf)
	}
	if len(probes) > 0 {
		matchers = appendJsMatchersByConf(matchers, probes, probeConfs)
	}

	// dom 选择器。
	// 字符串/数组形态：裸"存在"语义，但要过信息量检查（*、div、body > * 这种在哪都中，丢）。
	// 对象形态：{selector: {exists/text/attributes/properties}} —— 条件才是规则本体！
	//
	//	exists          → 只留选择器（但要过信息量检查）
	//	text/attributes → 保留完整条件（content.js 能评估）
	//	properties      → content script 摸不到页面挂在 DOM 上的 expando，丢
	var domProbes []DomProbe
	var domConfs []*int
	for _, s := range wappPatterns(t.Dom) {
		clean, conf := splitWappMeta(s)
		if informativeSelector(clean) {
			domProbes = append(domProbes, DomProbe{Sel: clean})
			domConfs = append(domConfs, conf)
		}
	}
	if domMap, ok := t.Dom.(map[string]any); ok {
		for sel, cond := range domMap {
			condMap, _ := cond.(map[string]any)
			if condMap == nil { // 没条件，退化成 exists
				if informativeSelector(sel) {
					domProbes = append(domProbes, DomProbe{Sel: sel})
					domConfs = append(domConfs, nil)
				}
				continue
			}
			if _, hasProps := condMap["properties"]; hasProps {
				continue // 需要页面运行时属性，放弃这条
			}
			p := DomProbe{Sel: sel}
			var conf *int
			if ps := wappPatterns(condMap["text"]); len(ps) > 0 {
				p.Text, conf = splitWappMeta(ps[0])
			}
			if attrs, ok := condMap["attributes"].(map[string]any); ok {
				p.Attrs = make(map[string]string, len(attrs))
				for k, v := range attrs {
					if ps := wappPatterns(v); len(ps) > 0 {
						c, cc := splitWappMeta(ps[0])
						p.Attrs[k] = c
						if conf == nil {
							conf = cc
						}
					}
				}
			}
			if p.Text == "" && len(p.Attrs) == 0 && !informativeSelector(sel) {
				continue // 裸存在 + 无信息量
			}
			domProbes = append(domProbes, p)
			domConfs = append(domConfs, conf)
		}
	}
	if len(domProbes) > 0 {
		matchers = appendDomMatchersByConf(matchers, domProbes, domConfs)
	}

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

func convertEHoleFingers(fingers []eholeFinger) []Rule {
	// 按 cms 分组，一个系统一条规则
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

	rules := make([]Rule, 0, len(byCms))
	for _, cms := range order {
		var matchers []Matcher
		for _, fp := range byCms[cms] {
			switch fp.Method {
			case "keyword":
				part := fp.Location
				switch part {
				case "body", "title", "header", "url":
				default:
					continue
				}
				var words []string
				switch kw := fp.Keyword.(type) {
				case string:
					words = []string{kw}
				case []any:
					for _, w := range kw {
						if s, ok := w.(string); ok {
							words = append(words, s)
						}
					}
				}
				if len(words) > 0 {
					matchers = append(matchers, Matcher{Type: "word", Part: part, Words: words, Condition: "and"})
				}
			case "faviconhash":
				var hashes []int32
				switch kw := fp.Keyword.(type) {
				case string:
					var h int64
					if _, err := fmt.Sscanf(kw, "%d", &h); err == nil && h != 0 {
						hashes = append(hashes, int32(h))
					}
				case []any:
					for _, v := range kw {
						s, ok := v.(string)
						if !ok {
							continue
						}
						var h int64
						if _, err := fmt.Sscanf(s, "%d", &h); err == nil && h != 0 {
							hashes = append(hashes, int32(h))
						}
					}
				}
				if len(hashes) > 0 {
					matchers = append(matchers, Matcher{Type: "icon_hash", Hash: hashes})
				}
			}
		}
		if len(matchers) > 0 {
			rules = append(rules, Rule{ID: slugify(cms), Name: cms, MatchersCondition: "or", Matchers: matchers})
		}
	}
	return rules
}
