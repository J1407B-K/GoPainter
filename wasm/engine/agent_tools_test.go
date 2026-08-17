package engine

import "testing"

func TestAgentRegexToolUsesProductionRE2(t *testing.T) {
	results := TestRegexPatterns([]string{`data-react(root|id)`, `(?=lookahead)`}, []string{"DATA-REACTROOT", "other"})
	if !results[0].Valid || !results[0].Matches[0].Matched || results[0].Matches[1].Matched {
		t.Fatalf("有效 RE2 执行结果不对: %+v", results[0])
	}
	if results[1].Valid || results[1].Error == "" {
		t.Fatalf("RE2 不支持的 lookahead 应返回编译错误: %+v", results[1])
	}
}

func TestAgentWordToolUsesMatcherSemantics(t *testing.T) {
	results := TestWordMatcher([]string{"server:", "nginx"}, []string{"Server: NGINX", "nginx"}, "and", false)
	if !results[0].Matched || results[1].Matched {
		t.Fatalf("word and 聚合结果不对: %+v", results)
	}
}
