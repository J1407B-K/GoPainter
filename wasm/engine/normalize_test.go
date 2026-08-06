package engine

import (
	"encoding/json"
	"testing"
)

func doc(t *testing.T, s string) json.RawMessage {
	t.Helper()
	return json.RawMessage(s)
}

// 数组里的第 2 条缺 name（应回退 id）、第 3 条缺 id（应过滤）、第 4 条无 matcher（应过滤）
func TestNormalizeNativeArray(t *testing.T) {
	raw := doc(t, `[
		{"id":"nginx","name":"Nginx","matchers":[{"type":"word","part":"header","words":["server: nginx"]}]},
		{"id":"empty","matchers":[{"type":"word","words":["x"]}]},
		{"name":"NoId","matchers":[{"type":"word","words":["x"]}]},
		{"id":"no-matcher"}
	]`)
	rules := normalizeDoc(raw)
	if len(rules) != 2 {
		t.Fatalf("应剩 2 条有效规则，实际 %d", len(rules))
	}
	if rules[0].ID != "nginx" || rules[0].Name != "Nginx" || rules[0].MatchersCondition != "or" {
		t.Errorf("第一条规则不对: %+v", rules[0])
	}
	if rules[1].ID != "empty" || rules[1].Name != "empty" {
		t.Errorf("缺 name 应回退 id: %+v", rules[1])
	}
}

func TestNormalizeSingleRule(t *testing.T) {
	raw := doc(t, `{"id":"react","name":"React","matchers-condition":"and","matchers":[{"type":"word","words":["react"]}]}`)
	rules := normalizeDoc(raw)
	if len(rules) != 1 || rules[0].ID != "react" || rules[0].MatchersCondition != "and" {
		t.Errorf("单条原生规则解析不对: %+v", rules)
	}
}

// binary 类型不被支持，转换时应被跳过，剩 4 个 matcher
func TestNormalizeNucleiTemplate(t *testing.T) {
	raw := doc(t, `{
		"id":"nuclei-jenkins",
		"info":{"name":"Jenkins Detect"},
		"http":[{"matchers":[
			{"type":"word","part":"header","words":["x-jenkins"]},
			{"type":"dsl","dsl":["status_code == 401"]},
			{"type":"regex","part":"body","regex":["jenkins\\.io"]},
			{"type":"status","status":[200]},
			{"type":"binary"}
		]}]
	}`)
	rules := normalizeDoc(raw)
	if len(rules) != 1 {
		t.Fatalf("应产出 1 条规则，实际 %d", len(rules))
	}
	r := rules[0]
	if r.ID != "nuclei-jenkins" || r.Name != "Jenkins Detect" {
		t.Errorf("规则头不对: %+v", r)
	}
	if len(r.Matchers) != 4 {
		t.Fatalf("binary 应被跳过，剩 4 个 matcher: %+v", r.Matchers)
	}
	// dsl 里的 status_code 应转成 status
	dslFound := false
	for _, m := range r.Matchers {
		if m.Type == "dsl" {
			dslFound = true
			if m.Dsl[0] != "status == 401" {
				t.Errorf("dsl 应把 status_code 转成 status: %+v", m.Dsl)
			}
		}
		if m.Type == "regex" && m.Part != "body" {
			t.Errorf("regex part 应为 body: %+v", m)
		}
	}
	if !dslFound {
		t.Error("应保留 dsl matcher")
	}
}

func TestNormalizeNucleiUsesRequestsFallback(t *testing.T) {
	raw := doc(t, `{
		"id":"tpl",
		"info":{"name":"Fallback"},
		"requests":[{"matchers":[{"type":"word","words":["hello"]}]}]
	}`)
	rules := normalizeDoc(raw)
	if len(rules) != 1 || rules[0].Name != "Fallback" || len(rules[0].Matchers) != 1 {
		t.Errorf("requests 兜底解析不对: %+v", rules)
	}
}

func TestNormalizeNucleiNoMatchers(t *testing.T) {
	raw := doc(t, `{"id":"tpl","info":{"name":"X"},"http":[{"matchers":[]}]}`)
	rules := normalizeDoc(raw)
	if len(rules) != 0 {
		t.Errorf("无可用 matcher 应产出空: %+v", rules)
	}
}

func TestNormalizeInvalid(t *testing.T) {
	if rules := normalizeDoc(doc(t, `not json`)); rules != nil {
		t.Errorf("非法 JSON 应返回 nil: %+v", rules)
	}
	// 单条规则能 unmarshal，但缺 id/matcher 被过滤后是空切片（非 nil）
	if rules := normalizeDoc(doc(t, `{"foo":1}`)); len(rules) != 0 {
		t.Errorf("无有效规则应返回空: %+v", rules)
	}
}

func TestFilterValidDefaults(t *testing.T) {
	rules := filterValid([]Rule{
		{ID: "a", Name: "A", Matchers: []Matcher{{Type: "word", Words: []string{"x"}}}},
		{ID: "b", Matchers: []Matcher{{Type: "word", Words: []string{"x"}}}, MatchersCondition: "weird"},
	})
	if len(rules) != 2 {
		t.Fatalf("应剩 2 条: %+v", rules)
	}
	if rules[0].MatchersCondition != "or" {
		t.Errorf("条件应为 or: %+v", rules[0])
	}
	if rules[1].Name != "b" || rules[1].MatchersCondition != "or" {
		t.Errorf("name 回退/条件规范化不对: %+v", rules[1])
	}
}
