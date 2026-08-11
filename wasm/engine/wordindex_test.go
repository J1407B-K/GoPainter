package engine

import (
	"strings"
	"testing"
)

// 自动机扫出来的命中集合，必须与逐词 strings.Contains 完全一致
func TestBodyWordIndexEquivalence(t *testing.T) {
	words := []string{
		"nginx", "wordpress", "/wp-content/", "Powered", "wp-", "abcabc",
		"xyz", "login", "a", "php", "server",
	}
	texts := []string{
		"<html>Powered by nginx, running wordpress with /wp-content/ assets</html>",
		"wordpress", // 单短文本
		"abcabcabc", // 重叠/后缀词 abcabc 应命中
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
