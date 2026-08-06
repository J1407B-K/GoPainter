package engine

import (
	"regexp"
	"strings"
	"testing"
)

func TestSplitWappMeta(t *testing.T) {
	p, conf := splitWappMeta(`pattern\;confidence:50`)
	if p != "pattern" || conf == nil || *conf != 50 {
		t.Errorf("应切出 pattern + 50: %q %v", p, conf)
	}
	p, conf = splitWappMeta(`plain`)
	if p != "plain" || conf != nil {
		t.Errorf("无后缀应 conf=nil: %q %v", p, conf)
	}
	// version 不是 confidence，conf 应为 nil
	p, conf = splitWappMeta(`x\;version:1`)
	if p != "x" || conf != nil {
		t.Errorf("version 不应被当 confidence: %q %v", p, conf)
	}
	// confidence 后还有别的后缀也捡到
	p, conf = splitWappMeta(`y\;confidence:95\;version:2`)
	if p != "y" || conf == nil || *conf != 95 {
		t.Errorf("应捡到 95: %q %v", p, conf)
	}
}

func TestTamePattern(t *testing.T) {
	cases := []struct{ in, want string }{
		{`a{1,512}b`, `a{1,}b`},  // 上界超 16 → 放宽
		{`a{0,64}b`, `a{0,}b`},   // 上界超 16 → 放宽
		{`a{17}b`, `a{17,}b`},    // 定次数超 16 → 放宽
		{`a{5}b`, `a{5}b`},       // 小重复不动
		{`a{2,10}b`, `a{2,10}b`}, // 上界 10 没超
		{`a{1,}b`, `a{1,}b`},     // 本来就开放上界
	}
	for _, c := range cases {
		if got := tamePattern(c.in); got != c.want {
			t.Errorf("tamePattern(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNestDepth(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{`((a))`, 2},
		{`\(x\)`, 0}, // 转义括号不算
		{`[(]x(`, 1}, // 字符类里的括号不算
		{`(a`, 1},    // 不闭合也算深度
		{``, 0},
	}
	for _, c := range cases {
		if got := nestDepth(c.in); got != c.want {
			t.Errorf("nestDepth(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestSafeCompileTooDeep(t *testing.T) {
	deep := strings.Repeat("(", maxNestDepth+1) + "a" + strings.Repeat(")", maxNestDepth+1)
	if _, err := safeCompile(deep); err == nil {
		t.Error("嵌套过深应报错")
	}
}

func TestHeaderPattern(t *testing.T) {
	// 值包含语义：不要求值在行首
	re := headerPattern("Server", "nginx")
	if got := safeCompileMust(t, re); !got.MatchString("server: nginx/1.2\n") {
		t.Errorf("值包含语义应命中: %s", re)
	}
	// ^ 开头 → 值必须从行首开始
	re = headerPattern("X-Token", "^Bearer ")
	if got := safeCompileMust(t, re); !got.MatchString("x-token: Bearer abc\n") {
		t.Errorf("^ 锚定开头应命中: %s", re)
	}
	if got := safeCompileMust(t, re); got.MatchString("x-token: no bearer\n") {
		t.Errorf("^ 锚定开头，值中间出现不应命中: %s", re)
	}
	// 空模式只锚 key
	re = headerPattern("Set-Cookie", "")
	if got := safeCompileMust(t, re); !got.MatchString("set-cookie: sid=1\n") {
		t.Errorf("空模式应只锚 key: %s", re)
	}
	// key 大小写不敏感
	re = headerPattern("X-Powered-By", "PHP")
	if got := safeCompileMust(t, re); !got.MatchString("X-POWERED-BY: PHP/8\n") {
		t.Errorf("key 应大小写不敏感: %s", re)
	}
}

func safeCompileMust(t *testing.T, p string) *regexp.Regexp {
	t.Helper()
	re, err := safeCompile(tamePattern(p))
	if err != nil {
		t.Fatalf("safeCompile(%q) 失败: %v", p, err)
	}
	return re
}

func TestPlainLiteral(t *testing.T) {
	if s, ok := plainLiteral("nginx"); !ok || s != "nginx" {
		t.Errorf("纯字符串应原样: %q %v", s, ok)
	}
	if s, ok := plainLiteral(`a\/b`); !ok || s != "a/b" {
		t.Errorf("\\/ 应转成 /: %q %v", s, ok)
	}
	if _, ok := plainLiteral(`a\b`); ok {
		t.Error("非 \\/ 或 \\\\ 转义应按正则处理")
	}
	if _, ok := plainLiteral("a.b"); ok {
		t.Error("正则元字符应按正则处理")
	}
}

func TestSlugify(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Angular Material", "angular-material"},
		{"React", "react"},
		{"  Leading  Space  ", "leading-space"},
		{"致远OA", "致远oa"},
		{"Hello, World!", "hello-world"},
	}
	for _, c := range cases {
		if got := slugify(c.in); got != c.want {
			t.Errorf("slugify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestInformativeSelector(t *testing.T) {
	for _, sel := range []string{".wp-block", "#main", "div[data-x]", "div:hover", "ul.class, li"} {
		if !informativeSelector(sel) {
			t.Errorf("%s 应算有信息量", sel)
		}
	}
	for _, sel := range []string{"*", "div", "body > *", "head > title", ""} {
		if informativeSelector(sel) {
			t.Errorf("%s 不应算有信息量", sel)
		}
	}
}

func TestWappPatterns(t *testing.T) {
	if got := wappPatterns("abc"); len(got) != 1 || got[0] != "abc" {
		t.Errorf("字符串应转数组: %v", got)
	}
	if got := wappPatterns(""); got != nil {
		t.Errorf("空字符串应返回 nil: %v", got)
	}
	if got := wappPatterns([]any{"a", "", "b"}); len(got) != 2 {
		t.Errorf("数组应过滤空串: %v", got)
	}
	if got := wappPatterns(123); got != nil {
		t.Errorf("非字符串类型应返回 nil: %v", got)
	}
}

func TestConvertEHole(t *testing.T) {
	jsonStr := `{"fingerprint":[
		{"cms":"致远OA","method":"keyword","location":"body","keyword":["/seeyon/","/seeyon/personal.do"]},
		{"cms":"致远OA","method":"faviconhash","location":"","keyword":"-123456"},
		{"cms":"SomeCMS","method":"keyword","location":"bad-location","keyword":["x"]},
		{"cms":"BadMethod","method":"weird","keyword":"x"}
	]}`
	rules, err := convertEHole(jsonStr)
	if err != nil {
		t.Fatalf("convertEHole 出错: %v", err)
	}
	if len(rules) != 1 {
		t.Fatalf("应只剩 致远OA 一条，实际 %d: %+v", len(rules), rules)
	}
	r := rules[0]
	if r.Name != "致远OA" || r.ID != "致远oa" || r.MatchersCondition != "or" {
		t.Errorf("规则头不对: %+v", r)
	}
	if len(r.Matchers) != 2 {
		t.Fatalf("应 2 个 matcher（keyword + faviconhash），实际 %+v", r.Matchers)
	}
	if r.Matchers[0].Type != "word" || r.Matchers[0].Part != "body" || r.Matchers[0].Condition != "and" || len(r.Matchers[0].Words) != 2 {
		t.Errorf("keyword matcher 不对: %+v", r.Matchers[0])
	}
	if r.Matchers[1].Type != "icon_hash" || len(r.Matchers[1].Hash) != 1 || r.Matchers[1].Hash[0] != -123456 {
		t.Errorf("faviconhash matcher 不对: %+v", r.Matchers[1])
	}
}

func TestConvertEHoleTopLevelArray(t *testing.T) {
	jsonStr := `[
		{"cms":"宝塔-BT.cn","method":"keyword","location":"body","keyword":["bt.cn","/login"]},
		{"cms":"宝塔-BT.cn","method":"faviconhash","location":"body","keyword":["-386189083","12345"]}
	]`
	rules, err := convertEHole(jsonStr)
	if err != nil {
		t.Fatalf("convertEHole 出错: %v", err)
	}
	if len(rules) != 1 {
		t.Fatalf("应转换 1 条规则，实际 %d: %+v", len(rules), rules)
	}
	r := rules[0]
	if r.ID != "宝塔-bt-cn" || r.Name != "宝塔-BT.cn" {
		t.Errorf("规则头不对: %+v", r)
	}
	if len(r.Matchers) != 2 {
		t.Fatalf("应 2 个 matcher，实际 %+v", r.Matchers)
	}
	hash := r.Matchers[1]
	if hash.Type != "icon_hash" || len(hash.Hash) != 2 || hash.Hash[0] != -386189083 || hash.Hash[1] != 12345 {
		t.Errorf("faviconhash 数组转换不对: %+v", hash)
	}
}

func TestConvertEHoleBadJSON(t *testing.T) {
	if _, err := convertEHole(`not json`); err == nil {
		t.Error("非法 JSON 应报错")
	}
}

func TestConvertWappTech(t *testing.T) {
	tech := wappTech{
		Headers:  map[string]any{"Server": "nginx"},
		Meta:     map[string]any{"generator": "^WordPress"},
		HTML:     []any{"wp-content", `x\;confidence:50`},
		Js:       map[string]any{"React": "^18"},
		Dom:      map[string]any{".wp-block": map[string]any{"text": "Hello"}},
		Implies:  []any{"PHP"},
		Excludes: []any{"Apache"},
	}
	r := convertWappTech("Nginx", tech)
	if r == nil {
		t.Fatal("应产出规则")
	}
	if r.ID != "nginx" || r.Name != "Nginx" || r.MatchersCondition != "or" {
		t.Errorf("规则头不对: %+v", r)
	}
	if len(r.Implies) != 1 || r.Implies[0] != "PHP" {
		t.Errorf("implies 应清理保留: %+v", r.Implies)
	}
	if len(r.Excludes) != 1 || r.Excludes[0] != "Apache" {
		t.Errorf("excludes 应清理保留: %+v", r.Excludes)
	}

	hasHeaderRegex := false
	hasBodyWord := false
	hasConf50 := false
	hasJsProbe := false
	hasDom := false
	for _, m := range r.Matchers {
		switch {
		case m.Type == "regex" && m.Part == "header":
			hasHeaderRegex = true
		case m.Type == "word" && m.Part == "body" && len(m.Words) == 1 && m.Words[0] == "wp-content":
			hasBodyWord = true
		case m.Type == "word" && m.Confidence != nil && *m.Confidence == 50:
			hasConf50 = true
		case m.Type == "js" && len(m.Js) == 1 && m.Js[0].Path == "React":
			hasJsProbe = true
		case m.Type == "dom" && len(m.Dom) == 1 && m.Dom[0].Sel == ".wp-block" && m.Dom[0].Text == "Hello":
			hasDom = true
		}
	}
	if !hasHeaderRegex {
		t.Error("应产出 header 正则 matcher")
	}
	if !hasBodyWord {
		t.Error("应产出 body word matcher")
	}
	if !hasConf50 {
		t.Error("\\;confidence:50 应转到 matcher 置信度")
	}
	if !hasJsProbe {
		t.Error("应产出 js 探针 matcher")
	}
	if !hasDom {
		t.Error("应产出 dom 条件 matcher")
	}
}

func TestConvertWappTechNoMatchers(t *testing.T) {
	// 全是无法编译的正则 → 全部被 compilablePair 丢弃 → 无 matcher → nil
	if r := convertWappTech("Empty", wappTech{HTML: []any{"[a-", "(unclosed"}}); r != nil {
		t.Errorf("无可编译模式应返回 nil: %+v", r)
	}
}

func TestConvertWappTechDomUninformative(t *testing.T) {
	// 裸选择器 div 无信息量 → 不应产生 dom matcher
	tech := wappTech{Dom: []any{"div"}}
	r := convertWappTech("DivOnly", tech)
	if r != nil {
		t.Errorf("仅无信息量 dom 应返回 nil: %+v", r)
	}
}

func TestAppendWordMatchersByConf(t *testing.T) {
	out := appendWordMatchersByConf(nil, "body", []string{"a", "b", "c"}, []*int{ip(50), nil, ip(50)})
	if len(out) != 2 {
		t.Fatalf("应按置信度分 2 组: %+v", out)
	}
	// 遍历顺序：先遇到 conf=50（a、c），后遇到 nil（b），所以 50 组在前
	if out[0].Confidence == nil || *out[0].Confidence != 50 || len(out[0].Words) != 2 {
		t.Errorf("conf=50 组不对: %+v", out[0])
	}
	if out[1].Confidence != nil || len(out[1].Words) != 1 || out[1].Words[0] != "b" {
		t.Errorf("无置信度组不对: %+v", out[1])
	}
}

func TestConfKey(t *testing.T) {
	if v := confKey(nil, 0); v != -1 {
		t.Errorf("越界应 -1: %d", v)
	}
	if v := confKey([]*int{ip(30)}, 0); v != 30 {
		t.Errorf("正常应返回值: %d", v)
	}
	if v := confKey([]*int{ip(999)}, 0); v != -1 {
		t.Errorf("越界置信度应 -1: %d", v)
	}
	if v := confFromKey(-1); v != nil {
		t.Errorf("-1 应转 nil: %v", v)
	}
	if v := confFromKey(40); v == nil || *v != 40 {
		t.Errorf("40 应转指针: %v", v)
	}
}
