package engine

import "testing"

// 体检分类的语料：取自真实规则风格，覆盖三类 + 解析失败。
// 期望值按匹配时预筛的实际行为推导。
func classifyHealth(patterns ...string) RegexHealth {
	rules := make([]Rule, 0, len(patterns))
	for _, p := range patterns {
		rules = append(rules, Rule{
			ID:   "r" + p,
			Name: "rule-" + p,
			Matchers: []Matcher{{
				Type: "regex", Part: "body", Regex: []string{p},
			}},
		})
	}
	return ClassifyRegexes(rules)
}

func TestClassifyRegexesSkippable(t *testing.T) {
	// 含必需 ASCII 字面量：预筛能在缺该字面量的页面上证明跳过
	skippable := []string{
		`Powered by <a href="[^>]+phpfusion`, // 必需字面量 phpfusion
		`<[^>]+data-react`,
		`(?:jQuery\.extend\(true, XenForo|<!--XF:branding)`,
		`(?i)^server:\s*GitHub\.com$`,
		`(?:中文)?foo`, // 中文在可选分支，foo 是必需 ASCII → 可跳过
	}
	h := classifyHealth(skippable...)
	if h.TotalPatterns != len(skippable) || h.Skippable != len(skippable) {
		t.Fatalf("期望 %d 条全部可跳过，实际 %+v", len(skippable), h)
	}
	if h.Broad != 0 || h.NonASCII != 0 || h.Invalid != 0 {
		t.Fatalf("不应有泛化/非ascii/无效，实际 %+v", h)
	}
	if len(h.ShortAnchors) != len(skippable) || len(h.LongAnchors) != len(skippable) {
		t.Fatalf("可预筛规则应生成长短锚点榜，实际 short=%d long=%d", len(h.ShortAnchors), len(h.LongAnchors))
	}
}

func TestPrefilterAnchorUsesWeakestAlternateAndIgnoresOptionalLiteral(t *testing.T) {
	h := classifyHealth(`tiny|a-very-long-anchor`, `required(?:optional-very-long)?`)
	if len(h.ShortAnchors) != 2 {
		t.Fatalf("期望 2 条锚点，实际 %+v", h.ShortAnchors)
	}
	byPattern := make(map[string]PrefilterAnchor)
	for _, item := range h.ShortAnchors {
		byPattern[item.Pattern] = item
	}
	if got := byPattern[`tiny|a-very-long-anchor`].Anchor; got != "tiny" {
		t.Fatalf("交替应取最弱分支锚点 tiny，实际 %q", got)
	}
	if got := byPattern[`required(?:optional-very-long)?`].Anchor; got != "required" {
		t.Fatalf("可选长字面量不能美化评分，实际 %q", got)
	}
}

func TestPrefilterAnchorPrefersInformativeCharacters(t *testing.T) {
	h := classifyHealth(`(?:p5(?:\.sound)?(?:\.min)?\.js)`, `(?:/|-)dc(?:\.leaflet)?\.js`)
	byPattern := make(map[string]PrefilterAnchor)
	for _, item := range h.ShortAnchors {
		byPattern[item.Pattern] = item
	}
	if got := byPattern[`(?:p5(?:\.sound)?(?:\.min)?\.js)`]; got.Anchor != "p5" || got.Length != 2 {
		t.Fatalf("p5.js 应优先显示 p5 而非 .js，实际 %+v", got)
	}
	if got := byPattern[`(?:/|-)dc(?:\.leaflet)?\.js`]; got.Anchor != "dc" || got.Length != 2 {
		t.Fatalf("dc.js 应优先显示 dc 而非 .js，实际 %+v", got)
	}
}

func TestPrefilterAnchorDoesNotChoosePunctuationForXenForo(t *testing.T) {
	pattern := `(?:jQuery\.extend\(true, XenForo|<a[^>]+>Forum software by XenForo™|<!--XF:branding|<html[^>]+id="XenForo")`
	h := classifyHealth(pattern)
	if len(h.ShortAnchors) != 1 {
		t.Fatalf("期望一条 XenForo 锚点，实际 %+v", h.ShortAnchors)
	}
	if got := h.ShortAnchors[0]; got.Anchor == "<" || got.Length == 0 {
		t.Fatalf("XenForo 代表锚点不应退化为纯标点，实际 %+v", got)
	}
}

func TestClassifyRegexesNonASCII(t *testing.T) {
	// 非 ascii literal 阻断预筛（SimpleFold 护栏）
	nonASCII := []string{
		`中文|한국어`,
		`foo|中文`, // 一个分支非 ascii → 整条跳不过
	}
	h := classifyHealth(nonASCII...)
	if h.Skippable != 0 || h.NonASCII != len(nonASCII) {
		t.Fatalf("期望 %d 条非ascii，实际 %+v", len(nonASCII), h)
	}
}

func TestClassifyRegexesBroad(t *testing.T) {
	// 无必需字面量：AST 证明不出任何跳过，每次都真跑
	broad := []string{
		`[0-9]+`,
		`[a-zA-Z]{8,16}`,
		`^.*$`,
	}
	h := classifyHealth(broad...)
	if h.Skippable != 0 || h.Broad != len(broad) {
		t.Fatalf("期望 %d 条泛化，实际 %+v", len(broad), h)
	}
	if len(h.BroadPatterns) != len(broad) {
		t.Fatalf("泛化明细应为 %d 条，实际 %d", len(broad), len(h.BroadPatterns))
	}
}

func TestClassifyRegexesInvalid(t *testing.T) {
	// 解析失败：未闭合括号 / 未闭合字符类 / 反向重复上界
	h := classifyHealth(`(`, `[a-`, `a{2,1}`)
	if h.Invalid != 3 || h.TotalPatterns != 3 {
		t.Fatalf("期望 3 条无效，实际 %+v", h)
	}
	if len(h.InvalidPatterns) != 3 || h.InvalidPatterns[0].Reason == "" {
		t.Fatalf("无效正则应返回可修复的明细，实际 %+v", h.InvalidPatterns)
	}
}

func TestClassifyRegexesIgnoresNonRegexMatchers(t *testing.T) {
	rules := []Rule{{
		ID: "w", Name: "word-rule",
		Matchers: []Matcher{{Type: "word", Part: "body", Words: []string{"nginx"}}},
	}, {
		ID: "s", Name: "status-rule",
		Matchers: []Matcher{{Type: "status", Status: []int{200}}},
	}}
	h := ClassifyRegexes(rules)
	if h.TotalPatterns != 0 || h.Skippable != 0 || h.Broad != 0 {
		t.Fatalf("非 regex matcher 不应计入，实际 %+v", h)
	}
}

func TestClassifyRegexesBroadDedup(t *testing.T) {
	// 同一泛化 pattern 出现在多条规则里：明细去重，计数照实
	rules := []Rule{
		{ID: "a", Name: "A", Matchers: []Matcher{{Type: "regex", Regex: []string{`[0-9]+`}}}},
		{ID: "b", Name: "B", Matchers: []Matcher{{Type: "regex", Regex: []string{`[0-9]+`}}}},
	}
	h := ClassifyRegexes(rules)
	if h.Broad != 2 {
		t.Fatalf("计数应去重前 2，实际 %d", h.Broad)
	}
	if len(h.BroadPatterns) != 1 {
		t.Fatalf("明细应去重为 1，实际 %d", len(h.BroadPatterns))
	}
}
