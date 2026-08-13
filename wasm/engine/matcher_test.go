package engine

import (
	"strings"
	"testing"
)

func TestHeaderString(t *testing.T) {
	f := &Features{Headers: map[string]string{"server": "nginx", "x-powered-by": "php"}}
	out := headerString(f)
	if !strings.Contains(out, "server: nginx\n") {
		t.Errorf("headerString 缺 server 头: %q", out)
	}
	if !strings.Contains(out, "x-powered-by: php\n") {
		t.Errorf("headerString 缺 x-powered-by 头: %q", out)
	}
}

// ip 转 *int，测试里大量用来标注置信度
func ip(v int) *int { return &v }

func baseFeatures() *Features {
	return &Features{
		URL:           "https://www.example.com/login",
		Title:         "Example Login",
		Body:          "<html>Powered by Nginx and PHP 8.1</html>",
		Status:        200,
		Headers:       map[string]string{"server": "nginx", "set-cookie": "sid=abc"},
		FaviconHashes: []int32{12345},
		Meta:          map[string]string{"generator": "WordPress 6.5"},
		Scripts:       []string{"/wp-content/theme.js"},
		Js:            map[string]string{"React.version": "18.2.0"},
		DomHits: map[string]bool{
			probeID(DomProbe{Sel: ".wp-block"}):   true,
			probeID(DomProbe{Sel: "#login-form"}): true,
		},
	}
}

func TestEvalMatcherWord(t *testing.T) {
	f := baseFeatures()
	ok, ev := evalMatcher(Matcher{Type: "word", Words: []string{"POWERED BY"}}, newMatchCtx(f))
	if !ok {
		t.Error("word 应大小写不敏感命中")
	}
	if len(ev) == 0 || ev[0].Detail != "POWERED BY" {
		t.Errorf("word 证据应有原文: %+v", ev)
	}
}

func TestEvalMatcherWordPart(t *testing.T) {
	f := baseFeatures()
	ok, _ := evalMatcher(Matcher{Type: "word", Part: "title", Words: []string{"login"}}, newMatchCtx(f))
	if !ok {
		t.Error("title part 应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "word", Part: "header", Words: []string{"server: nginx"}}, newMatchCtx(f))
	if !ok {
		t.Error("header part 应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "word", Part: "meta", Words: []string{"generator: wordpress 6.5"}}, newMatchCtx(f))
	if !ok {
		t.Error("meta part 应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "word", Part: "script", Words: []string{"/wp-content/theme.js"}}, newMatchCtx(f))
	if !ok {
		t.Error("script part 应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "word", Part: "url", Words: []string{"/login"}}, newMatchCtx(f))
	if !ok {
		t.Error("url part 应命中")
	}
}

func TestEvalMatcherWordNegative(t *testing.T) {
	f := baseFeatures()
	ok, _ := evalMatcher(Matcher{Type: "word", Words: []string{"nginx"}, Negative: true}, newMatchCtx(f))
	if ok {
		t.Error("negative：命中内容应不匹配")
	}
	ok, ev := evalMatcher(Matcher{Type: "word", Words: []string{"tomcat"}, Negative: true}, newMatchCtx(f))
	if !ok {
		t.Error("negative：内容缺席应匹配")
	}
	if len(ev) == 0 || !strings.Contains(ev[0].Detail, "未满足") {
		t.Errorf("negative 证据应标注原条件未满足: %+v", ev)
	}
}

// 三态求值：坏正则配 negative 不能反转成命中（幽灵指纹）
func TestEvalMatcherInvalidNegative(t *testing.T) {
	f := baseFeatures()
	ok, ev := evalMatcher(Matcher{Type: "regex", Regex: []string{`([unclosed`}, Negative: true}, newMatchCtx(f))
	if ok {
		t.Errorf("无效正则 + negative 不应反成命中，实际 ok=%v ev=%+v", ok, ev)
	}
	// dsl 报错同理
	ok, ev = evalMatcher(Matcher{Type: "dsl", Dsl: []string{`unknown_var`}, Negative: true}, newMatchCtx(f))
	if ok {
		t.Errorf("dsl 报错 + negative 不应反成命中，实际 ok=%v ev=%+v", ok, ev)
	}
	// 未知 matcher 类型同理
	ok, ev = evalMatcher(Matcher{Type: "bogus_type"}, newMatchCtx(f))
	if ok {
		t.Errorf("未知 matcher 类型应判不命中，实际 ok=%v ev=%+v", ok, ev)
	}
	ok, ev = evalMatcher(Matcher{Type: "bogus_type", Negative: true}, newMatchCtx(f))
	if ok {
		t.Errorf("未知 matcher 类型 + negative 不应反成命中，实际 ok=%v ev=%+v", ok, ev)
	}
	// 多条件里混进一个坏的：or 里其余全 miss 时应是 invalid（negative 不反转）
	ok, _ = evalMatcher(Matcher{Type: "word", Negative: true, Words: []string{"tomcat"}}, newMatchCtx(f))
	if !ok {
		t.Error("有效未命中 + negative 应正常反成命中")
	}
}

func TestMatchRuleInvalidMatcher(t *testing.T) {
	f := baseFeatures()
	// and：一个 matcher 是坏正则，规则整体不命中
	r := Rule{ID: "bad", MatchersCondition: "and", Matchers: []Matcher{
		{Type: "word", Words: []string{"Nginx"}},
		{Type: "regex", Regex: []string{`([unclosed`}},
	}}
	ok, _, _ := matchRule(r, newMatchCtx(f))
	if ok {
		t.Error("and 里有无效 matcher，规则应不命中")
	}
	// or：坏 matcher 不拖后腿，另一个命中就命中
	r.MatchersCondition = "or"
	ok, _, _ = matchRule(r, newMatchCtx(f))
	if !ok {
		t.Error("or 里无效 matcher 不影响其他命中")
	}
}

func TestEvalMatcherRegex(t *testing.T) {
	f := baseFeatures()
	ok, ev := evalMatcher(Matcher{Type: "regex", Regex: []string{`Powered\s+by`}}, newMatchCtx(f))
	if !ok {
		t.Error("regex 应命中")
	}
	if len(ev) == 0 || !strings.Contains(ev[0].Detail, "Powered by") {
		t.Errorf("regex 证据应带命中文本: %+v", ev)
	}
	if len(ev) == 0 || ev[0].Pattern != `Powered\s+by` {
		t.Errorf("regex 证据应分离保存规则表达式: %+v", ev)
	}
}

func TestEvalMatcherRegexInvalid(t *testing.T) {
	f := baseFeatures()
	// 非法正则不应 panic，应判不匹配
	ok, _ := evalMatcher(Matcher{Type: "regex", Regex: []string{`([unclosed`}}, newMatchCtx(f))
	if ok {
		t.Error("非法正则应判不匹配")
	}
}

func TestEvalMatcherStatus(t *testing.T) {
	f := baseFeatures()
	ok, _ := evalMatcher(Matcher{Type: "status", Status: []int{200}}, newMatchCtx(f))
	if !ok {
		t.Error("status 200 应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "status", Status: []int{301, 500}}, newMatchCtx(f))
	if ok {
		t.Error("status 不匹配应判假")
	}
}

func TestEvalMatcherIconHash(t *testing.T) {
	f := baseFeatures()
	ok, _ := evalMatcher(Matcher{Type: "icon_hash", Hash: []int32{12345}}, newMatchCtx(f))
	if !ok {
		t.Error("主 favicon 哈希应命中")
	}
	// 多 favicon：主哈希不中，但额外列表里有
	ok, _ = evalMatcher(Matcher{Type: "icon_hash", Hash: []int32{999}}, newMatchCtx(&Features{FaviconHashes: []int32{999, 12345}}))
	if !ok {
		t.Error("额外 favicon 哈希应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "icon_hash", Hash: []int32{777}}, newMatchCtx(f))
	if ok {
		t.Error("哈希不匹配应判假")
	}
}

func TestEvalMatcherDsl(t *testing.T) {
	f := baseFeatures()
	ok, _ := evalMatcher(Matcher{Type: "dsl", Dsl: []string{`contains(body, "Nginx") && status == 200`}}, newMatchCtx(f))
	if !ok {
		t.Error("dsl 命中条件应通过")
	}
	ok, _ = evalMatcher(Matcher{Type: "dsl", Dsl: []string{`contains(body, "不存在")`}}, newMatchCtx(f))
	if ok {
		t.Error("dsl 未命中应判假")
	}
}

func TestEvalMatcherJs(t *testing.T) {
	f := baseFeatures()
	ok, ev := evalMatcher(Matcher{Type: "js", Js: []JsProbe{{Path: "React.version"}}}, newMatchCtx(f))
	if !ok {
		t.Error("js 全局变量存在应命中")
	}
	if len(ev) == 0 || !strings.Contains(ev[0].Detail, "window.React.version") {
		t.Errorf("js 证据应带路径: %+v", ev)
	}
	// 带 pattern：值要匹配
	ok, _ = evalMatcher(Matcher{Type: "js", Js: []JsProbe{{Path: "React.version", Pattern: `^18\.`}}}, newMatchCtx(f))
	if !ok {
		t.Error("js pattern 命中应通过")
	}
	ok, _ = evalMatcher(Matcher{Type: "js", Js: []JsProbe{{Path: "React.version", Pattern: `^19\.`}}}, newMatchCtx(f))
	if ok {
		t.Error("js pattern 不匹配应判假")
	}
	ok, _ = evalMatcher(Matcher{Type: "js", Js: []JsProbe{{Path: "NotExist"}}}, newMatchCtx(f))
	if ok {
		t.Error("js 变量不存在应判假")
	}
}

func TestEvalMatcherDom(t *testing.T) {
	f := baseFeatures()
	ok, _ := evalMatcher(Matcher{Type: "dom", Words: []string{".wp-block"}}, newMatchCtx(f))
	if !ok {
		t.Error("dom 裸选择器应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "dom", Dom: []DomProbe{{Sel: "#login-form"}}}, newMatchCtx(f))
	if !ok {
		t.Error("dom probe 应命中")
	}
	ok, _ = evalMatcher(Matcher{Type: "dom", Dom: []DomProbe{{Sel: ".nope"}}}, newMatchCtx(f))
	if ok {
		t.Error("dom 未命中选择器应判假")
	}
}

func TestMatchRuleOrCondition(t *testing.T) {
	f := baseFeatures()
	// or：两个 matcher 任一命中即规则命中
	r := Rule{ID: "r1", Matchers: []Matcher{
		{Type: "word", Words: []string{"Nginx"}},
		{Type: "word", Words: []string{"Tomcat"}},
	}}
	ok, ev, _ := matchRule(r, newMatchCtx(f))
	if !ok || len(ev) != 1 {
		t.Errorf("or 应命中一个 matcher: ok=%v ev=%+v", ok, ev)
	}
}

func TestMatchRuleAndCondition(t *testing.T) {
	f := baseFeatures()
	r := Rule{ID: "r2", MatchersCondition: "and", Matchers: []Matcher{
		{Type: "word", Words: []string{"Nginx"}},
		{Type: "word", Words: []string{"Tomcat"}},
	}}
	ok, _, _ := matchRule(r, newMatchCtx(f))
	if ok {
		t.Error("and：缺一个条件应不命中")
	}
	r.Matchers[1].Words = []string{"PHP 8.1"}
	ok, _, _ = matchRule(r, newMatchCtx(f))
	if !ok {
		t.Error("and：条件齐了应命中")
	}
}

func TestValidConfidence(t *testing.T) {
	if v, ok := validConfidence(nil); ok {
		t.Errorf("nil 应非法, got %d", v)
	}
	if v, ok := validConfidence(ip(0)); !ok || v != 0 {
		t.Errorf("0 应合法, got %d ok=%v", v, ok)
	}
	if v, ok := validConfidence(ip(100)); !ok || v != 100 {
		t.Errorf("100 应合法, got %d ok=%v", v, ok)
	}
	if _, ok := validConfidence(ip(101)); ok {
		t.Error("101 应非法")
	}
	if _, ok := validConfidence(ip(-1)); ok {
		t.Error("-1 应非法")
	}
}

func TestMatchRuleConfidence(t *testing.T) {
	f := baseFeatures()
	// or 取最强信号
	r := Rule{ID: "c1", Matchers: []Matcher{
		{Type: "word", Words: []string{"Nginx"}, Confidence: ip(60)},
		{Type: "word", Words: []string{"PHP 8.1"}, Confidence: ip(90)},
	}}
	_, _, conf := matchRule(r, newMatchCtx(f))
	if conf == nil || *conf != 90 {
		t.Errorf("or 置信度应取最大值 90，实际 %v", conf)
	}

	// and 取最短板
	r.MatchersCondition = "and"
	_, _, conf = matchRule(r, newMatchCtx(f))
	if conf == nil || *conf != 60 {
		t.Errorf("and 置信度应取最小值 60，实际 %v", conf)
	}

	// 规则级缩放：60 * 50 / 100 = 30
	r.Confidence = ip(50)
	_, _, conf = matchRule(r, newMatchCtx(f))
	if conf == nil || *conf != 30 {
		t.Errorf("规则级缩放后应为 30，实际 %v", conf)
	}

	// 无任何置信度 → nil（不是伪造 100）
	r2 := Rule{ID: "c2", Matchers: []Matcher{{Type: "word", Words: []string{"Nginx"}}}}
	_, _, conf = matchRule(r2, newMatchCtx(f))
	if conf != nil {
		t.Errorf("无置信度应为 nil，实际 %v", *conf)
	}

	// 只有规则级置信度、matcher 没标 → 直接用规则级
	r3 := Rule{ID: "c3", Confidence: ip(70), Matchers: []Matcher{{Type: "word", Words: []string{"Nginx"}}}}
	_, _, conf = matchRule(r3, newMatchCtx(f))
	if conf == nil || *conf != 70 {
		t.Errorf("仅有规则级置信度应为 70，实际 %v", conf)
	}

	// 越界置信度按无标注处理
	r4 := Rule{ID: "c4", Matchers: []Matcher{{Type: "word", Words: []string{"Nginx"}, Confidence: ip(999)}}}
	_, _, conf = matchRule(r4, newMatchCtx(f))
	if conf != nil {
		t.Errorf("越界置信度应视为无标注 -> nil，实际 %v", *conf)
	}
}

func TestMatchRuleDefaultCondition(t *testing.T) {
	f := baseFeatures()
	r := Rule{ID: "d", Matchers: []Matcher{
		{Type: "word", Words: []string{"Nginx"}},
		{Type: "word", Words: []string{"Tomcat"}},
	}}
	ok, _, _ := matchRule(r, newMatchCtx(f))
	if !ok {
		t.Error("默认 matchers-condition 应为 or")
	}
}

func TestApplyImpliesCascade(t *testing.T) {
	rules := []Rule{
		{ID: "nextjs", Name: "Next.js", Implies: []string{"React"}},
		{ID: "react", Name: "React", Implies: []string{"Node.js"}},
	}
	hits := []Hit{{ID: "nextjs", Name: "Next.js", Confidence: ip(90)}}
	out := applyImplies(hits, buildByName(rules))
	names := map[string]bool{}
	for _, h := range out {
		names[h.Name] = true
	}
	for _, want := range []string{"Next.js", "React", "Node.js"} {
		if !names[want] {
			t.Errorf("implies 级联应推导出 %s，实际: %v", want, names)
		}
	}
	// 推导命中继承来源置信度
	for _, h := range out {
		if h.Name == "React" && (h.Confidence == nil || *h.Confidence != 90) {
			t.Errorf("推导命中应继承置信度 90，实际 %v", h.Confidence)
		}
	}
}

func TestApplyImpliesDedup(t *testing.T) {
	rules := []Rule{
		{ID: "nextjs", Name: "Next.js", Implies: []string{"React"}},
		{ID: "react", Name: "React", Implies: []string{"React"}}, // 自指/重复不无限循环
	}
	hits := []Hit{{ID: "nextjs", Name: "Next.js"}}
	out := applyImplies(hits, buildByName(rules))
	react := 0
	for _, h := range out {
		if h.Name == "React" {
			react++
		}
	}
	if react != 1 {
		t.Errorf("implies 应去重，React 出现 %d 次", react)
	}
}

func TestApplyExcludes(t *testing.T) {
	rules := []Rule{
		{ID: "a", Name: "TechA", Excludes: []string{"TechB"}},
		{ID: "b", Name: "TechB"},
	}
	hits := []Hit{{Name: "TechA"}, {Name: "TechB"}}
	out := applyExcludes(hits, buildByName(rules))
	if len(out) != 1 || out[0].Name != "TechA" {
		t.Errorf("excludes 应踢掉 TechB，剩余: %+v", out)
	}
}

func TestExcludesAfterImplies(t *testing.T) {
	// 推导出来的也能被排除
	rules := []Rule{
		{ID: "a", Name: "TechA", Implies: []string{"TechB"}, Excludes: []string{"TechB"}},
		{ID: "b", Name: "TechB"},
	}
	hits := []Hit{{Name: "TechA"}}
	hits = applyImplies(hits, buildByName(rules))
	hits = applyExcludes(hits, buildByName(rules))
	if len(hits) != 1 || hits[0].Name != "TechA" {
		t.Errorf("推导后排除应只剩 TechA，实际: %+v", hits)
	}
}
