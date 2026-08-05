// 指纹 JSON → GoPainter 规则。
// 数据由用户在浏览器里实时拉取
// 这个文件只含转换逻辑，不含任何数据
package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"syscall/js"
	"unicode"
)

// --- Wappalyzer technologies JSON（github.com/enthec/webappanalyzer） ---
// 我们用的字段；dom/js/implies/excludes 这些不管
type wappTech struct {
	Headers   map[string]any `json:"headers"`
	Cookies   map[string]any `json:"cookies"`
	Meta      map[string]any `json:"meta"`
	HTML      any            `json:"html"`
	ScriptSrc any            `json:"scriptSrc"`
	URL       any            `json:"url"`
}

// wappalyzer 的模式带 "\;version:\1" / "\;confidence:50" 这种后缀，切掉
func cleanWappPattern(p string) string {
	if i := strings.Index(p, "\\;"); i >= 0 {
		p = p[:i]
	}
	return p
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

// RE2 编译 {1,512} 这种大重复会展开成几百份副本，栈直接爆（Livewire 踩的坑）。
// 上界超过 64 就放宽成 {n,}，指纹场景语义几乎不变
var bigRepeatRe = regexp.MustCompile(`\{(\d+)(?:,(\d+))?\}`)

func tamePattern(p string) string {
	return bigRepeatRe.ReplaceAllStringFunc(p, func(m string) string {
		sub := bigRepeatRe.FindStringSubmatch(m)
		n, _ := strconv.Atoi(sub[1])
		if strings.Contains(m, ",") {
			if sub[2] == "" { // {n,} 本来就没事
				return m
			}
			if hi, _ := strconv.Atoi(sub[2]); hi > 64 {
				return "{" + sub[1] + ",}"
			}
			return m
		}
		if n > 64 {
			return "{" + sub[1] + ",}"
		}
		return m
	})
}

// 编译包一层 recover，个别妖孽模式 panic 也不至于炸掉整个 wasm
func safeCompile(p string) (re *regexp.Regexp, err error) {
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

// 响应头是 "k: v" 格式（k 小写），按行首匹配更准确
func headerPattern(key, pattern string) string {
	p := `(?im)^` + regexp.QuoteMeta(strings.ToLower(key)) + `:`
	if pattern != "" {
		p += `\s*` + pattern
	}
	return p
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

// 模式列表拆成"纯字符串"和"真正则"两组，各做一个 matcher
func splitPatterns(patterns []string, part string) []Matcher {
	var words, regexes []string
	for _, p := range patterns {
		if lit, ok := plainLiteral(p); ok {
			words = append(words, lit)
		} else {
			regexes = append(regexes, p)
		}
	}
	var out []Matcher
	if len(words) > 0 {
		out = append(out, Matcher{Type: "word", Part: part, Words: words})
	}
	if regexes = compilable(regexes); len(regexes) > 0 {
		out = append(out, Matcher{Type: "regex", Part: part, Regex: regexes})
	}
	return out
}

func convertWappTech(name string, t wappTech) *Rule {
	var matchers []Matcher

	var headerRes, metaRes []string
	for k, v := range t.Headers {
		for _, p := range wappPatterns(v) {
			headerRes = append(headerRes, headerPattern(k, cleanWappPattern(p)))
		}
	}
	for k, v := range t.Cookies {
		// cookie 在响应头里是 set-cookie: name=...（书签/爬取链路拿不到 set-cookie，尽力而为）
		ps := wappPatterns(v)
		if len(ps) == 0 {
			headerRes = append(headerRes, headerPattern("set-cookie", regexp.QuoteMeta(k)+`=`))
		}
		for _, p := range ps {
			headerRes = append(headerRes, headerPattern("set-cookie", regexp.QuoteMeta(k)+`=`+cleanWappPattern(p)))
		}
	}
	if headerRes = compilable(headerRes); len(headerRes) > 0 {
		matchers = append(matchers, Matcher{Type: "regex", Part: "header", Regex: headerRes})
	}

	for k, v := range t.Meta {
		for _, p := range wappPatterns(v) {
			metaRes = append(metaRes, headerPattern(k, cleanWappPattern(p)))
		}
	}
	if metaRes = compilable(metaRes); len(metaRes) > 0 {
		matchers = append(matchers, Matcher{Type: "regex", Part: "meta", Regex: metaRes})
	}

	if ps := compilable(cleanAll(wappPatterns(t.HTML))); len(ps) > 0 {
		matchers = append(matchers, splitPatterns(ps, "body")...)
	}
	if ps := compilable(cleanAll(wappPatterns(t.ScriptSrc))); len(ps) > 0 {
		matchers = append(matchers, splitPatterns(ps, "script")...)
	}
	if ps := compilable(cleanAll(wappPatterns(t.URL))); len(ps) > 0 {
		matchers = append(matchers, splitPatterns(ps, "url")...)
	}

	if len(matchers) == 0 {
		return nil
	}
	return &Rule{
		ID:                slugify(name),
		Name:              name,
		MatchersCondition: "or",
		Matchers:          matchers,
	}
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
	return b.String()
}

// goConvertWappalyzer(techJSON) -> {"rules":[...]}
// techJSON 是 wappalyzer 的 technologies 对象（{"技术名": {...}}）
func jsConvertWappalyzer(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("convertWappalyzer(techJSON) 需要一个参数")
	}
	var techs map[string]wappTech
	if err := json.Unmarshal([]byte(args[0].String()), &techs); err != nil {
		return jsError("Wappalyzer JSON 解析失败: %s", err)
	}
	rules := make([]Rule, 0, len(techs))
	for name, t := range techs {
		if r := convertWappTech(name, t); r != nil {
			rules = append(rules, *r)
		}
	}
	out, _ := json.Marshal(map[string]any{"rules": rules})
	return string(out)
}

// --- EHole finger.json（github.com/EdgeSecurityTeam/EHole） ---
// 格式: {"fingerprint":[{"cms":"致远OA","method":"keyword","location":"body","keyword":["/seeyon/"]}]}
// method 就两种：keyword（body/title/header 关键词）和 faviconhash

type eholeFinger struct {
	Cms      string `json:"cms"`
	Method   string `json:"method"`
	Location string `json:"location"`
	Keyword  any    `json:"keyword"` // keyword 是 []string，faviconhash 是字符串数字
}

func convertEHole(jsonStr string) ([]Rule, error) {
	var data struct {
		Fingerprint []eholeFinger `json:"fingerprint"`
	}
	if err := json.Unmarshal([]byte(jsonStr), &data); err != nil {
		return nil, err
	}

	// 按 cms 分组，一个系统一条规则
	byCms := make(map[string][]eholeFinger)
	var order []string
	for _, fp := range data.Fingerprint {
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
				// keyword 是字符串形式的 mmh3 整数
				s, _ := fp.Keyword.(string)
				var h int64
				if _, err := fmt.Sscanf(s, "%d", &h); err == nil && h != 0 {
					matchers = append(matchers, Matcher{Type: "icon_hash", Hash: []int32{int32(h)}})
				}
			}
		}
		if len(matchers) > 0 {
			rules = append(rules, Rule{ID: slugify(cms), Name: cms, MatchersCondition: "or", Matchers: matchers})
		}
	}
	return rules, nil
}

// goConvertEHole(fingerJSON) -> {"rules":[...]}
func jsConvertEHole(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("convertEHole(fingerJSON) 需要一个参数")
	}
	rules, err := convertEHole(args[0].String())
	if err != nil {
		return jsError("EHole JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(map[string]any{"rules": rules})
	return string(out)
}
