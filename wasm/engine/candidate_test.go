package engine

import (
	"encoding/json"
	"strings"
	"testing"
)

func candidateJSON(value any) []byte {
	out, _ := json.Marshal(value)
	return out
}

func validCandidate() map[string]any {
	return map[string]any{
		"id":                 "react",
		"name":               "React",
		"matchers-condition": "or",
		"matchers": []any{
			map[string]any{"type": "regex", "regex": []string{"data-reactroot"}},
		},
	}
}

func hasIssue(result CandidateValidation, path, code string) bool {
	for _, item := range result.Errors {
		if item.Path == path && item.Code == code {
			return true
		}
	}
	return false
}

func TestValidateCandidateStrictAndExecutable(t *testing.T) {
	result := ValidateCandidate(candidateJSON(validCandidate()), Features{Body: `<div data-reactroot></div>`})
	if !result.Valid || result.Rule == nil {
		t.Fatalf("expected valid candidate, got %+v", result.Errors)
	}
	if len(result.CurrentPageHits) != 1 || result.CurrentPageHits[0].ID != "react" {
		t.Fatalf("production matcher did not run: %+v", result.CurrentPageHits)
	}
	if result.RuntimeCoverage == nil || !result.RuntimeCoverage.Complete {
		t.Fatalf("unexpected coverage: %+v", result.RuntimeCoverage)
	}
}

func TestValidateCandidateRejectsUnknownAndWrongPayload(t *testing.T) {
	unknown := validCandidate()
	unknown["surprise"] = true
	result := ValidateCandidate(candidateJSON(unknown), Features{})
	if result.Valid || !hasIssue(result, "$", "invalid_json") {
		t.Fatalf("unknown field should be rejected: %+v", result.Errors)
	}

	wrongPayload := validCandidate()
	wrongPayload["matchers"] = []any{map[string]any{
		"type": "regex", "regex": []string{"react"}, "words": []string{"React"},
	}}
	result = ValidateCandidate(candidateJSON(wrongPayload), Features{})
	if result.Valid || !hasIssue(result, "matchers[0].words", "unsupported_field") {
		t.Fatalf("cross-type payload should be rejected: %+v", result.Errors)
	}
}

func TestValidateCandidateRejectsInvalidRegexAndNull(t *testing.T) {
	broken := validCandidate()
	broken["matchers"] = []any{map[string]any{"type": "regex", "regex": []string{"([broken"}}}
	result := ValidateCandidate(candidateJSON(broken), Features{})
	if result.Valid || !hasIssue(result, "matchers[0].regex[0]", "invalid_regex") {
		t.Fatalf("broken regex should be rejected: %+v", result.Errors)
	}

	raw := []byte(`{"id":"x","name":"X","matchers-condition":"or","confidence":null,"matchers":[{"type":"js","js":[{"path":"React","pattern":null}]}]}`)
	result = ValidateCandidate(raw, Features{})
	if result.Valid || !hasIssue(result, "confidence", "invalid_null") || !hasIssue(result, "matchers[0].js[0].pattern", "invalid_null") {
		t.Fatalf("explicit null should be rejected: %+v", result.Errors)
	}
}

func TestValidateCandidateVersionTemplate(t *testing.T) {
	rule := validCandidate()
	rule["matchers"] = []any{map[string]any{
		"type": "regex", "regex": []string{`React ([\d.]+)`}, "version": `\1`,
	}}
	result := ValidateCandidate(candidateJSON(rule), Features{Body: "React 18.3.1"})
	if !result.Valid || len(result.CurrentPageHits) != 1 || result.CurrentPageHits[0].Version != "18.3.1" {
		t.Fatalf("valid version template should extract a version: valid=%v hits=%+v errors=%+v", result.Valid, result.CurrentPageHits, result.Errors)
	}

	for _, test := range []struct {
		name    string
		version any
		code    string
	}{
		{name: "null", version: nil, code: "invalid_null"},
		{name: "empty", version: "", code: "invalid_enum"},
		{name: "too long", version: strings.Repeat("x", 501), code: "invalid_string"},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := validCandidate()
			candidate["matchers"] = []any{map[string]any{
				"type": "regex", "regex": []string{"React"}, "version": test.version,
			}}
			validation := ValidateCandidate(candidateJSON(candidate), Features{})
			if validation.Valid || !hasIssue(validation, "matchers[0].version", test.code) {
				t.Fatalf("invalid version template should be rejected: %+v", validation.Errors)
			}
		})
	}
}

func TestValidateCandidateReportsRuntimeCoverage(t *testing.T) {
	rule := validCandidate()
	rule["matchers"] = []any{
		map[string]any{"type": "js", "js": []any{map[string]any{"path": "React.version"}}},
		map[string]any{"type": "dom", "dom": []any{map[string]any{"sel": "#root"}}},
	}
	result := ValidateCandidate(candidateJSON(rule), Features{Js: map[string]string{}})
	if !result.Valid || result.RuntimeCoverage.Complete || !result.RuntimeCoverage.HasUnverifiedDomSelectors {
		t.Fatalf("unexpected coverage: %+v", result.RuntimeCoverage)
	}
	if len(result.RuntimeCoverage.MissingJsPaths) != 1 || result.RuntimeCoverage.MissingJsPaths[0] != "React.version" {
		t.Fatalf("missing JS paths not reported: %+v", result.RuntimeCoverage.MissingJsPaths)
	}
}

func TestPlanRequiredProbesDeduplicatesAndOwnsIDs(t *testing.T) {
	rules := []Rule{{Matchers: []Matcher{
		{Type: "js", Js: []JsProbe{{Path: "React.version"}, {Path: "React.version"}}},
		{Type: "dom", Words: []string{"#root"}, Dom: []DomProbe{{Sel: "#app", Text: "React", Attrs: map[string]string{"data-v": ".+"}}}},
		{Type: "dom", Words: []string{"#root"}},
	}}}
	planned := PlanRequiredProbes(rules)
	if len(planned.Paths) != 1 || planned.Paths[0] != "React.version" {
		t.Fatalf("unexpected paths: %+v", planned.Paths)
	}
	if len(planned.Probes) != 2 {
		t.Fatalf("unexpected probes: %+v", planned.Probes)
	}
	for _, probe := range planned.Probes {
		if probe.ID == "" || probe.ID != probeID(DomProbe{Sel: probe.Sel, Text: probe.Text, Attrs: probe.Attrs}) {
			t.Fatalf("core did not produce stable probe ID: %+v", probe)
		}
	}
}
