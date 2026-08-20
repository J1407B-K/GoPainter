package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const (
	maxCandidateMatchers = 50
	maxCandidateItems    = 50
)

// validationLimits keep the untrusted candidate path bounded while allowing the
// editor to faithfully reopen an already-installed third-party rule. Source
// imports have never imposed the candidate-size limit, so applying it again on
// edit made valid Wappalyzer/EHole rules impossible to save unchanged.
type validationLimits struct {
	matchers int
	items    int
}

var (
	candidateValidationLimits = validationLimits{matchers: maxCandidateMatchers, items: maxCandidateItems}
	editorValidationLimits    = validationLimits{}
)

// ValidationIssue 是严格候选校验的稳定错误格式，供 Agent Tool 和 UI 共用。
type ValidationIssue struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type RuntimeCoverage struct {
	Complete                  bool     `json:"complete"`
	MissingJsPaths            []string `json:"missingJsPaths"`
	HasUnverifiedDomSelectors bool     `json:"hasUnverifiedDomSelectors"`
	Note                      string   `json:"note"`
}

type CandidateValidation struct {
	Valid           bool              `json:"valid"`
	Rule            *Rule             `json:"rule,omitempty"`
	CurrentPageHits []Hit             `json:"currentPageHits,omitempty"`
	RuntimeCoverage *RuntimeCoverage  `json:"runtimeCoverage,omitempty"`
	Errors          []ValidationIssue `json:"errors"`
}

func issue(path, code, format string, args ...any) ValidationIssue {
	return ValidationIssue{Path: path, Code: code, Message: fmt.Sprintf(format, args...)}
}

func strictDecodeRule(raw []byte) (Rule, error) {
	var rule Rule
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rule); err != nil {
		return Rule{}, err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("只能包含一个规则对象")
		}
		return Rule{}, err
	}
	return rule, nil
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func validateRawRootNulls(root map[string]json.RawMessage) []ValidationIssue {
	var errors []ValidationIssue
	for _, field := range []string{"confidence", "implies", "excludes"} {
		if value, ok := root[field]; ok && isJSONNull(value) {
			errors = append(errors, issue(field, "invalid_null", "%s 不能是 null", field))
		}
	}
	return errors
}

func validateRawMatcherFields(matcher map[string]json.RawMessage, matcherType, base string) []ValidationIssue {
	payloadFor := map[string]string{"word": "words", "regex": "regex", "status": "status", "icon_hash": "hash", "dsl": "dsl", "js": "js", "dom": "dom"}
	allowed := map[string]bool{"type": true, "part": true, "condition": true, "negative": true, "confidence": true, "version": true}
	allowed[payloadFor[matcherType]] = true
	var errors []ValidationIssue
	for key := range matcher {
		if !allowed[key] {
			errors = append(errors, issue(base+"."+key, "unsupported_field", "matcher type %q 不支持字段 %s", matcherType, key))
		}
	}
	return errors
}

func validateRawMatcherScalars(matcher map[string]json.RawMessage, base string) []ValidationIssue {
	var errors []ValidationIssue
	for _, field := range []string{"part", "condition", "negative", "confidence", "version"} {
		if value, ok := matcher[field]; ok && isJSONNull(value) {
			errors = append(errors, issue(base+"."+field, "invalid_null", "%s 不能是 null", field))
		}
	}
	for _, field := range []string{"part", "condition", "version"} {
		if value, ok := matcher[field]; ok && !isJSONNull(value) {
			var text string
			if json.Unmarshal(value, &text) == nil && text == "" {
				errors = append(errors, issue(base+"."+field, "invalid_enum", "%s 不能是空字符串", field))
			}
		}
	}
	return errors
}

func validateRawJSShape(raw json.RawMessage, base string) []ValidationIssue {
	var probes []map[string]json.RawMessage
	_ = json.Unmarshal(raw, &probes)
	var errors []ValidationIssue
	for i, probe := range probes {
		value, ok := probe["pattern"]
		if !ok {
			continue
		}
		path := fmt.Sprintf("%s.js[%d].pattern", base, i)
		if isJSONNull(value) {
			errors = append(errors, issue(path, "invalid_null", "pattern 不能是 null"))
			continue
		}
		var text string
		if json.Unmarshal(value, &text) == nil && !validNonEmptyString(text, 1000) {
			errors = append(errors, issue(path, "invalid_string", "pattern 必须是有界非空字符串"))
		}
	}
	return errors
}

func validateRawDOMProbe(probe map[string]json.RawMessage, path string) []ValidationIssue {
	var errors []ValidationIssue
	for _, field := range []string{"text", "attrs"} {
		if value, ok := probe[field]; ok && isJSONNull(value) {
			errors = append(errors, issue(path+"."+field, "invalid_null", "%s 不能是 null", field))
		}
	}
	if value, ok := probe["text"]; ok && !isJSONNull(value) {
		var text string
		if json.Unmarshal(value, &text) == nil && !validNonEmptyString(text, 1000) {
			errors = append(errors, issue(path+".text", "invalid_string", "text 必须是有界非空字符串"))
		}
	}
	if value, ok := probe["attrs"]; ok && !isJSONNull(value) {
		var attrs map[string]string
		if json.Unmarshal(value, &attrs) == nil && len(attrs) == 0 {
			errors = append(errors, issue(path+".attrs", "invalid_map", "attrs 必须是非空字符串映射"))
		}
	}
	return errors
}

func validateRawDOMShape(raw json.RawMessage, base string) []ValidationIssue {
	var probes []map[string]json.RawMessage
	_ = json.Unmarshal(raw, &probes)
	var errors []ValidationIssue
	for i, probe := range probes {
		errors = append(errors, validateRawDOMProbe(probe, fmt.Sprintf("%s.dom[%d]", base, i))...)
	}
	return errors
}

func validateRawMatcherShape(matcher map[string]json.RawMessage, index int) []ValidationIssue {
	base := fmt.Sprintf("matchers[%d]", index)
	var matcherType string
	_ = json.Unmarshal(matcher["type"], &matcherType)
	errors := validateRawMatcherFields(matcher, matcherType, base)
	errors = append(errors, validateRawMatcherScalars(matcher, base)...)
	if matcherType == "js" {
		errors = append(errors, validateRawJSShape(matcher["js"], base)...)
	}
	if matcherType == "dom" {
		errors = append(errors, validateRawDOMShape(matcher["dom"], base)...)
	}
	return errors
}

// validateRawCandidateShape 校验仅靠 Rule 值无法分辨的“字段是否出现”语义，例如
// regex matcher 夹带 words、显式 null，或 attrs: {}。这些都不能被静默吞掉。
func validateRawCandidateShape(raw []byte) []ValidationIssue {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil // strictDecodeRule 会给出主错误
	}
	errors := validateRawRootNulls(root)
	var matchers []map[string]json.RawMessage
	if value, ok := root["matchers"]; ok {
		_ = json.Unmarshal(value, &matchers)
	}
	for i, matcher := range matchers {
		errors = append(errors, validateRawMatcherShape(matcher, i)...)
	}
	return errors
}

func validNonEmptyString(value string, maxLength int) bool {
	return strings.TrimSpace(value) != "" && len(value) <= maxLength
}

func validateStringList(path string, values []string, maxItems, maxLength int) []ValidationIssue {
	if len(values) == 0 || (maxItems > 0 && len(values) > maxItems) {
		if maxItems > 0 {
			return []ValidationIssue{issue(path, "invalid_list", "%s 必须包含 1-%d 个字符串", path, maxItems)}
		}
		return []ValidationIssue{issue(path, "invalid_list", "%s 必须至少包含 1 个字符串", path)}
	}
	for i, value := range values {
		if !validNonEmptyString(value, maxLength) {
			return []ValidationIssue{issue(fmt.Sprintf("%s[%d]", path, i), "invalid_string", "必须是长度不超过 %d 的非空字符串", maxLength)}
		}
	}
	return nil
}

func validateConfidence(path string, value *int) []ValidationIssue {
	if value != nil && (*value < 0 || *value > 100) {
		return []ValidationIssue{issue(path, "out_of_range", "%s 必须是 0-100 的整数", path)}
	}
	return nil
}

func matcherPayloadCount(m Matcher) int {
	count := 0
	for _, length := range []int{len(m.Words), len(m.Regex), len(m.Status), len(m.Hash), len(m.Dsl), len(m.Js), len(m.Dom)} {
		if length > 0 {
			count++
		}
	}
	return count
}

func validateRegexPayload(m Matcher, base string, maxItems int) []ValidationIssue {
	errors := validateStringList(base+".regex", m.Regex, maxItems, 4000)
	for i, pattern := range m.Regex {
		if _, err := compileRegex(pattern); err != nil {
			errors = append(errors, issue(fmt.Sprintf("%s.regex[%d]", base, i), "invalid_regex", "正则无法由 Go RE2 编译：%v", err))
		}
	}
	return errors
}

func validateStatusPayload(m Matcher, base string, maxItems int) []ValidationIssue {
	var errors []ValidationIssue
	if len(m.Status) == 0 || (maxItems > 0 && len(m.Status) > maxItems) {
		if maxItems > 0 {
			errors = append(errors, issue(base+".status", "invalid_list", "status 必须包含 1-50 个整数"))
		} else {
			errors = append(errors, issue(base+".status", "invalid_list", "status 必须至少包含 1 个整数"))
		}
	}
	for i, value := range m.Status {
		if value < 100 || value > 599 {
			errors = append(errors, issue(fmt.Sprintf("%s.status[%d]", base, i), "out_of_range", "HTTP 状态码必须在 100-599 之间"))
		}
	}
	return errors
}

func validateDSLPayload(m Matcher, base string, features Features, maxItems int) []ValidationIssue {
	errors := validateStringList(base+".dsl", m.Dsl, maxItems, 4000)
	ctx := newMatchCtx(&features)
	for i, expression := range m.Dsl {
		if _, err := dslEval(expression, ctx); err != nil {
			errors = append(errors, issue(fmt.Sprintf("%s.dsl[%d]", base, i), "invalid_dsl", "DSL 无法执行：%v", err))
		}
	}
	return errors
}

func validateJSProbe(probe JsProbe, path string) []ValidationIssue {
	var errors []ValidationIssue
	if !validNonEmptyString(probe.Path, 500) {
		errors = append(errors, issue(path+".path", "invalid_string", "path 必须是长度不超过 500 的非空字符串"))
	}
	if probe.Pattern == "" {
		return errors
	}
	if !validNonEmptyString(probe.Pattern, 1000) {
		return append(errors, issue(path+".pattern", "invalid_string", "pattern 必须是长度不超过 1000 的非空字符串"))
	}
	if _, err := compileRegex(probe.Pattern); err != nil {
		errors = append(errors, issue(path+".pattern", "invalid_regex", "正则无法由 Go RE2 编译：%v", err))
	}
	return errors
}

func validateJSPayload(m Matcher, base string, maxItems int) []ValidationIssue {
	var errors []ValidationIssue
	if len(m.Js) == 0 || (maxItems > 0 && len(m.Js) > maxItems) {
		if maxItems > 0 {
			errors = append(errors, issue(base+".js", "invalid_list", "js 必须包含 1-50 个探针"))
		} else {
			errors = append(errors, issue(base+".js", "invalid_list", "js 必须至少包含 1 个探针"))
		}
	}
	for i, probe := range m.Js {
		errors = append(errors, validateJSProbe(probe, fmt.Sprintf("%s.js[%d]", base, i))...)
	}
	return errors
}

func validateDOMProbe(probe DomProbe, path string) []ValidationIssue {
	var errors []ValidationIssue
	if !validNonEmptyString(probe.Sel, 1000) {
		errors = append(errors, issue(path+".sel", "invalid_string", "sel 必须是长度不超过 1000 的非空字符串"))
	}
	if probe.Text != "" {
		if !validNonEmptyString(probe.Text, 1000) {
			errors = append(errors, issue(path+".text", "invalid_string", "text 必须是长度不超过 1000 的非空字符串"))
		} else if _, err := compileRegex(probe.Text); err != nil {
			errors = append(errors, issue(path+".text", "invalid_regex", "正则无法由 Go RE2 编译：%v", err))
		}
	}
	if len(probe.Attrs) > 30 {
		errors = append(errors, issue(path+".attrs", "too_many_items", "attrs 最多包含 30 项"))
	}
	for key, pattern := range probe.Attrs {
		attrPath := path + ".attrs." + key
		if !validNonEmptyString(key, 200) || !validNonEmptyString(pattern, 1000) {
			errors = append(errors, issue(attrPath, "invalid_string", "属性名和值必须是有界非空字符串"))
		} else if _, err := compileRegex(pattern); err != nil {
			errors = append(errors, issue(attrPath, "invalid_regex", "正则无法由 Go RE2 编译：%v", err))
		}
	}
	return errors
}

func validateDOMPayload(m Matcher, base string, maxItems int) []ValidationIssue {
	var errors []ValidationIssue
	if len(m.Dom) == 0 || (maxItems > 0 && len(m.Dom) > maxItems) {
		if maxItems > 0 {
			errors = append(errors, issue(base+".dom", "invalid_list", "dom 必须包含 1-50 个探针"))
		} else {
			errors = append(errors, issue(base+".dom", "invalid_list", "dom 必须至少包含 1 个探针"))
		}
	}
	for i, probe := range m.Dom {
		errors = append(errors, validateDOMProbe(probe, fmt.Sprintf("%s.dom[%d]", base, i))...)
	}
	return errors
}

func validateMatcherPayload(m Matcher, base string, features Features, maxItems int) []ValidationIssue {
	switch m.Type {
	case "word":
		return validateStringList(base+".words", m.Words, maxItems, 4000)
	case "regex":
		return validateRegexPayload(m, base, maxItems)
	case "status":
		return validateStatusPayload(m, base, maxItems)
	case "icon_hash":
		if len(m.Hash) == 0 || (maxItems > 0 && len(m.Hash) > maxItems) {
			if maxItems > 0 {
				return []ValidationIssue{issue(base+".hash", "invalid_list", "hash 必须包含 1-50 个 int32")}
			}
			return []ValidationIssue{issue(base+".hash", "invalid_list", "hash 必须至少包含 1 个 int32")}
		}
	case "dsl":
		return validateDSLPayload(m, base, features, maxItems)
	case "js":
		return validateJSPayload(m, base, maxItems)
	case "dom":
		return validateDOMPayload(m, base, maxItems)
	}
	return nil
}

func validateMatcherStrict(m Matcher, index int, features Features, maxItems int) []ValidationIssue {
	base := fmt.Sprintf("matchers[%d]", index)
	allowedTypes := map[string]bool{"word": true, "regex": true, "status": true, "icon_hash": true, "dsl": true, "js": true, "dom": true}
	allowedParts := map[string]bool{"body": true, "title": true, "url": true, "header": true, "raw": true, "meta": true, "script": true}
	var errors []ValidationIssue
	if !allowedTypes[m.Type] {
		return []ValidationIssue{issue(base+".type", "invalid_enum", "不支持的 matcher 类型 %q", m.Type)}
	}
	if m.Part != "" && !allowedParts[m.Part] {
		errors = append(errors, issue(base+".part", "invalid_enum", "part 必须是受支持的页面区域"))
	}
	if m.Condition != "" && m.Condition != "and" && m.Condition != "or" {
		errors = append(errors, issue(base+".condition", "invalid_enum", "condition 只能是 and 或 or"))
	}
	errors = append(errors, validateConfidence(base+".confidence", m.Confidence)...)
	if m.Version != "" && !validNonEmptyString(m.Version, 500) {
		errors = append(errors, issue(base+".version", "invalid_string", "version 必须是长度不超过 500 的非空模板"))
	}

	if matcherPayloadCount(m) != 1 {
		errors = append(errors, issue(base, "invalid_payload", "matcher 必须且只能包含与 type 对应的一个非空载荷"))
		return errors
	}
	errors = append(errors, validateMatcherPayload(m, base, features, maxItems)...)
	return errors
}

func validateRuleHeader(rule Rule, limits validationLimits) []ValidationIssue {
	var errors []ValidationIssue
	if !validNonEmptyString(rule.ID, 4000) {
		errors = append(errors, issue("id", "invalid_string", "id 必须是有界非空字符串"))
	}
	if !validNonEmptyString(rule.Name, 4000) {
		errors = append(errors, issue("name", "invalid_string", "name 必须是有界非空字符串"))
	}
	if rule.MatchersCondition != "and" && rule.MatchersCondition != "or" {
		errors = append(errors, issue("matchers-condition", "invalid_enum", "matchers-condition 只能是 and 或 or"))
	}
	if len(rule.Matchers) == 0 || (limits.matchers > 0 && len(rule.Matchers) > limits.matchers) {
		if limits.matchers > 0 {
			errors = append(errors, issue("matchers", "invalid_list", "matchers 必须包含 1-50 项"))
		} else {
			errors = append(errors, issue("matchers", "invalid_list", "matchers 必须至少包含 1 项"))
		}
	}
	return errors
}

func validateRuleMatchers(rule Rule, features Features, maxItems int) []ValidationIssue {
	var errors []ValidationIssue
	for i, matcher := range rule.Matchers {
		errors = append(errors, validateMatcherStrict(matcher, i, features, maxItems)...)
	}
	return errors
}

func runtimeCoverage(rule Rule, features Features) *RuntimeCoverage {
	missing := make([]string, 0)
	seenMissing := make(map[string]bool)
	hasDOM := false
	for _, matcher := range rule.Matchers {
		if matcher.Type == "js" {
			for _, probe := range matcher.Js {
				if _, ok := features.Js[probe.Path]; !ok && !seenMissing[probe.Path] {
					seenMissing[probe.Path] = true
					missing = append(missing, probe.Path)
				}
			}
		}
		hasDOM = hasDOM || matcher.Type == "dom"
	}
	complete := len(missing) == 0 && !hasDOM
	note := "js/dom 候选可能尚未被当前页面采集器探测；无命中不能单独证明规则不匹配。"
	if complete {
		note = "当前页面特征覆盖了候选规则的运行时输入。"
	}
	return &RuntimeCoverage{Complete: complete, MissingJsPaths: missing, HasUnverifiedDomSelectors: hasDOM, Note: note}
}

func validateRuleStrict(raw []byte, features Features, limits validationLimits) CandidateValidation {
	rule, err := strictDecodeRule(raw)
	if err != nil {
		return CandidateValidation{Errors: []ValidationIssue{issue("$", "invalid_json", "候选规则结构无效：%v", err)}}
	}
	errors := validateRawCandidateShape(raw)
	errors = append(errors, validateRuleHeader(rule, limits)...)
	errors = append(errors, validateConfidence("confidence", rule.Confidence)...)
	errors = append(errors, validateStringListOptional("implies", rule.Implies, limits.items)...)
	errors = append(errors, validateStringListOptional("excludes", rule.Excludes, limits.items)...)
	errors = append(errors, validateRuleMatchers(rule, features, limits.items)...)
	if len(errors) > 0 {
		return CandidateValidation{Errors: errors}
	}
	return CandidateValidation{
		Valid:           true,
		Rule:            &rule,
		CurrentPageHits: Match([]Rule{rule}, features),
		RuntimeCoverage: runtimeCoverage(rule, features),
		Errors:          []ValidationIssue{},
	}
}

// ValidateCandidate validates agent-generated rules. Its small list limits are
// a deliberate boundary for model output.
func ValidateCandidate(raw []byte, features Features) CandidateValidation {
	return validateRuleStrict(raw, features, candidateValidationLimits)
}

// ValidateEditableRule validates a single existing rule before saving it from
// the editor. It retains the strict schema and matcher checks but deliberately
// does not impose candidate-only list limits on installed source rules.
func ValidateEditableRule(raw []byte, features Features) CandidateValidation {
	return validateRuleStrict(raw, features, editorValidationLimits)
}

func validateStringListOptional(path string, values []string, maxItems int) []ValidationIssue {
	if values == nil {
		return nil
	}
	return validateStringList(path, values, maxItems, 500)
}
