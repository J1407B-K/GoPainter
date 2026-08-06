// 规则规范化：JS 解析完 YAML 把文档 JSON 丢过来，这里统一转成原生规则。
// 支持原生格式和 nuclei 模板（抽 http matchers 里能用的部分）。
package engine

import (
	"encoding/json"
	"strings"
)

type nucleiMatcher struct {
	Type      string   `json:"type"`
	Part      string   `json:"part"`
	Words     []string `json:"words"`
	Regex     []string `json:"regex"`
	Status    []int    `json:"status"`
	Dsl       []string `json:"dsl"`
	Condition string   `json:"condition"`
	Negative  bool     `json:"negative"`
}

type nucleiBlock struct {
	Matchers          []nucleiMatcher `json:"matchers"`
	MatchersCondition string          `json:"matchers-condition"`
}

type nucleiTemplate struct {
	ID   string `json:"id"`
	Info *struct {
		Name string `json:"name"`
	} `json:"info"`
	HTTP     []nucleiBlock `json:"http"`
	Requests []nucleiBlock `json:"requests"`
}

func convertNucleiMatcher(m nucleiMatcher) *Matcher {
	part := m.Part
	switch part {
	case "title", "url", "header", "raw", "meta", "script":
	default:
		part = "body"
	}
	switch m.Type {
	case "word":
		return &Matcher{Type: "word", Part: part, Words: m.Words, Condition: m.Condition, Negative: m.Negative}
	case "regex":
		return &Matcher{Type: "regex", Part: part, Regex: m.Regex, Condition: m.Condition, Negative: m.Negative}
	case "status":
		return &Matcher{Type: "status", Status: m.Status, Negative: m.Negative}
	case "dsl":
		// nuclei 的 dsl 变量名是 status_code，我们叫 status，别的语法基本兼容
		exprs := make([]string, 0, len(m.Dsl))
		for _, d := range m.Dsl {
			exprs = append(exprs, strings.ReplaceAll(d, "status_code", "status"))
		}
		return &Matcher{Type: "dsl", Dsl: exprs, Condition: m.Condition, Negative: m.Negative}
	default:
		return nil // binary / xpath 这类不支持的跳过
	}
}

func normalizeDoc(raw json.RawMessage) []Rule {
	trimmed := strings.TrimSpace(string(raw))

	// 原生格式可以一次给一组规则
	if strings.HasPrefix(trimmed, "[") {
		var rules []Rule
		if err := json.Unmarshal(raw, &rules); err == nil {
			return filterValid(rules)
		}
		return nil
	}

	// nuclei 模板：有 id + info + http/requests
	var tpl nucleiTemplate
	if err := json.Unmarshal(raw, &tpl); err == nil && tpl.ID != "" && tpl.Info != nil &&
		(len(tpl.HTTP) > 0 || len(tpl.Requests) > 0) {
		blocks := tpl.HTTP
		if len(blocks) == 0 {
			blocks = tpl.Requests
		}
		var matchers []Matcher
		condition := "or"
		for _, b := range blocks {
			for _, m := range b.Matchers {
				if converted := convertNucleiMatcher(m); converted != nil {
					matchers = append(matchers, *converted)
				}
			}
			if b.MatchersCondition != "" {
				condition = b.MatchersCondition
			}
		}
		if len(matchers) == 0 {
			return nil
		}
		name := tpl.Info.Name
		if name == "" {
			name = tpl.ID
		}
		return []Rule{{ID: tpl.ID, Name: name, MatchersCondition: condition, Matchers: matchers}}
	}

	// 单条原生规则
	var r Rule
	if err := json.Unmarshal(raw, &r); err == nil {
		return filterValid([]Rule{r})
	}
	return nil
}

func filterValid(rules []Rule) []Rule {
	out := rules[:0]
	for _, r := range rules {
		if r.ID == "" || len(r.Matchers) == 0 {
			continue
		}
		if r.Name == "" {
			r.Name = r.ID
		}
		if r.MatchersCondition != "and" {
			r.MatchersCondition = "or"
		}
		out = append(out, r)
	}
	return out
}
