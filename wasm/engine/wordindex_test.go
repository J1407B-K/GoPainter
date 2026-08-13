package engine

import (
	"strings"
	"testing"
)

// 自动机扫出来的命中集合，必须与逐词 strings.Contains 完全一致
func TestBodyWordIndexEquivalence(t *testing.T) {
	words := []string{
		"nginx", "wordpress", "/wp-content/", "Powered", "wp-", "abcabc",
		"xyz", "login", "a", "php", "server", "a中b",
	}
	texts := []string{
		"<html>Powered by nginx, running wordpress with /wp-content/ assets</html>",
		"wordpress", // 单短文本
		"abcabcabc", // 重叠/后缀词 abcabc 应命中
		"前缀a中b后缀",   // 非 ASCII 位于词中间，不能走 ASCII 快速跳过
		"nothing here",
		"", // 空 body
	}

	rules := make([]Rule, 0, len(words))
	for _, w := range words {
		rules = append(rules, Rule{ID: "t", Matchers: []Matcher{{Type: "word", Part: "body", Words: []string{w}}}})
	}
	ix := buildBodyWordIndex(rules)
	if ix == nil {
		t.Fatal("自动机不该为 nil")
	}

	for _, text := range texts {
		lower := strings.ToLower(text)
		hits := ix.scan(lower)
		for _, w := range words {
			want := strings.Contains(lower, strings.ToLower(w))
			got := hits[strings.ToLower(w)]
			if want != got {
				t.Errorf("text=%q word=%q: 自动机=%v strings.Contains=%v", text, w, got, want)
			}
		}
	}
}

// 索引含非 ASCII 词（如 "a中b"）时，hasNonASCIIWord 必须为 true，scan 不能跳过
// 非 ASCII 字节（否则漏匹配）。只查 root 子节点不够——词以 ASCII 开头但中间含 UTF-8 字节。
func TestBodyWordIndexNonASCIIWord(t *testing.T) {
	words := []string{"a中b", "nginx", "中段词x"}
	rules := make([]Rule, 0, len(words))
	for _, w := range words {
		rules = append(rules, Rule{ID: "t", Matchers: []Matcher{{Type: "word", Part: "body", Words: []string{w}}}})
	}
	ix := buildBodyWordIndex(rules)
	if ix == nil {
		t.Fatal("自动机不该为 nil")
	}
	if !ix.hasNonASCIIWord {
		t.Error("索引含非 ASCII 词时 hasNonASCIIWord 应为 true，否则 scan 会跳过 UTF-8 字节漏匹配")
	}
	// 含非 ASCII 词的文本必须全部命中
	texts := []string{
		"前缀 a中b 后缀",
		"中段词x 在这里",
		"nginx 服务器",
		"完全无关的纯 ASCII 页面 no hit",
	}
	for _, text := range texts {
		lower := strings.ToLower(text)
		hits := ix.scan(lower)
		for _, w := range words {
			want := strings.Contains(lower, strings.ToLower(w))
			got := hits[strings.ToLower(w)]
			if want != got {
				t.Errorf("text=%q word=%q: 自动机=%v strings.Contains=%v", text, w, got, want)
			}
		}
	}
	// 纯 ASCII 词索引（无任何非 ASCII 字节）→ 快速跳过应仍正确
	ix2 := buildBodyWordIndex([]Rule{{ID: "a", Matchers: []Matcher{{Type: "word", Part: "body", Words: []string{"nginx"}}}}})
	if ix2 == nil || ix2.hasNonASCIIWord {
		t.Error("纯 ASCII 词索引 hasNonASCIIWord 应为 false")
	}
	hits := ix2.scan("hello nginx 世界")
	if !hits["nginx"] {
		t.Error("纯 ASCII 索引快速跳过路径应正确命中 nginx（中文文本中）")
	}
	// 非 ASCII regex literal 从不参与预筛，不能因此关闭纯 ASCII 词典的快速路径。
	regexOnly := buildBodyWordIndex([]Rule{{ID: "r", Matchers: []Matcher{{Type: "regex", Part: "body", Regex: []string{"σ"}}}}})
	if regexOnly != nil && regexOnly.hasNonASCIIWord {
		t.Error("非 ASCII regex literal 不应进入 AC 或关闭 ASCII 快速路径")
	}
}

// 非 ASCII regex literal 不应进 AC 索引：它不参与预筛（regexNodeExcluded 的
// isASCIIStr 边界直接放行），却会置 hasNonASCIIWord=true，关闭整个中文页的
// ASCII 字节快速跳过路径——纯副作用。bodyWords 过滤后 AC 保持全 ASCII。
func TestBodyWordIndexRegexNonASCILLiteralExcluded(t *testing.T) {
	rules := []Rule{
		{ID: "r1", Matchers: []Matcher{{Type: "regex", Part: "body", Regex: []string{`<div[^>]+σ`}}}},
		{ID: "w1", Matchers: []Matcher{{Type: "word", Part: "body", Words: []string{"nginx"}}}},
	}
	ix := buildBodyWordIndex(rules)
	if ix == nil {
		t.Fatal("自动机不该为 nil（有 word 词 nginx）")
	}
	if ix.hasNonASCIIWord {
		t.Error("regex 的非 ASCII literal 不应进 AC 索引，否则关闭中文页快速路径")
	}
	text := "这是中文页面 <div> nginx 服务器" // 含 <div（ASCII literal 在）+ 无 σ
	lower := strings.ToLower(text)
	hits := ix.scan(lower)
	// <div 在文本、σ 是非 ASCII literal（不参与预筛）→ 无法证明排除 → 必须不跳过。
	// 若 σ 被误当 ASCII 放进预筛，hits 里无 σ 会误判排除 → 误跳过。
	if regexCanSkip(`<div[^>]+σ`, lower, false, func(lit string) bool { return hits[lit] }) {
		t.Error("含非 ASCII literal 的正则不应被跳过（<div 在文本、σ 不预筛）")
	}
	// 快速路径仍应命中 ASCII word（中文文本中）
	if !hits["nginx"] {
		t.Error("快速路径应命中 nginx（中文文本中）")
	}
}

// Match 集成的 word 命中结果应与逐词 Contains 等价（含 non-body part 混排）
func TestMatchUsesBodyIndex(t *testing.T) {
	f := &Features{
		Body:    "<html>Powered by Nginx and PHP</html>",
		Title:   "Login",
		Headers: map[string]string{"server": "nginx"},
		Meta:    map[string]string{"generator": "WordPress"},
	}
	rules := []Rule{
		{ID: "a", Matchers: []Matcher{{Type: "word", Words: []string{"powered by"}}}},
		{ID: "b", Matchers: []Matcher{{Type: "word", Words: []string{"Nginx"}}}},
		{ID: "c", Matchers: []Matcher{{Type: "word", Part: "title", Words: []string{"login"}}}},
		{ID: "d", Matchers: []Matcher{{Type: "word", Part: "header", Words: []string{"server: nginx"}}}},
		{ID: "e", Matchers: []Matcher{{Type: "word", Part: "meta", Words: []string{"wordpress"}}}},
		{ID: "f", Matchers: []Matcher{{Type: "word", Words: []string{"不存在的词"}}}},
	}
	hits := Match(rules, *f)
	got := map[string]bool{}
	for _, h := range hits {
		got[h.ID] = true
	}
	for _, want := range []string{"a", "b", "c", "d", "e"} {
		if !got[want] {
			t.Errorf("规则 %s 应命中，实际 %v", want, got)
		}
	}
	if got["f"] {
		t.Error("规则 f 不应命中")
	}
}

// 空词与 strings.Contains("")=true 对齐：自动机跳过空词，Match 里 w=="" 直接算命中
func TestBodyWordIndexEmptyWord(t *testing.T) {
	rules := []Rule{{ID: "t", Matchers: []Matcher{{Type: "word", Words: []string{""}}}}}
	if ix := buildBodyWordIndex(rules); ix != nil {
		t.Fatalf("全是空词时不该建自动机，实际建了: %+v", ix.words)
	}
	f := &Features{Body: "anything"}
	hits := Match(rules, *f)
	if len(hits) != 1 {
		t.Errorf("空词应命中，实际 %v", hits)
	}
}
