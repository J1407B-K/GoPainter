package engine

import "strings"

// RegexToolMatch 是 Agent 正则验证工具对一条样本文本的真实 Go RE2 执行结果。
type RegexToolMatch struct {
	Index   int    `json:"index"`
	Matched bool   `json:"matched"`
	Detail  string `json:"detail,omitempty"`
}

type RegexToolResult struct {
	Pattern string           `json:"pattern"`
	Valid   bool             `json:"valid"`
	Error   string           `json:"error,omitempty"`
	Matches []RegexToolMatch `json:"matches"`
}

// TestRegexPatterns 复用生产 matcher 的大小写、驯化、深度限制和 go-re2 backend。
func TestRegexPatterns(patterns, samples []string) []RegexToolResult {
	out := make([]RegexToolResult, 0, len(patterns))
	for _, pattern := range patterns {
		result := RegexToolResult{Pattern: pattern, Matches: make([]RegexToolMatch, 0, len(samples))}
		re, err := compileRegex("(?i)" + pattern)
		if err != nil {
			re, err = compileRegex(pattern)
		}
		if err != nil {
			result.Error = err.Error()
			out = append(out, result)
			continue
		}
		result.Valid = true
		for index, sample := range samples {
			matched := re.MatchString(sample)
			detail := ""
			if matched {
				detail = re.FindString(sample)
				if len(detail) > 200 {
					detail = detail[:200] + "…"
				}
			}
			result.Matches = append(result.Matches, RegexToolMatch{Index: index, Matched: matched, Detail: detail})
		}
		out = append(out, result)
	}
	return out
}

type WordToolMatch struct {
	Index        int      `json:"index"`
	Matched      bool     `json:"matched"`
	MatchedWords []string `json:"matchedWords"`
}

// TestWordMatcher 与生产 word matcher 一样执行不区分大小写的 Contains 和 and/or 聚合。
func TestWordMatcher(words, samples []string, condition string, negative bool) []WordToolMatch {
	and := strings.EqualFold(condition, "and")
	out := make([]WordToolMatch, 0, len(samples))
	for index, sample := range samples {
		lower := strings.ToLower(sample)
		matchedWords := make([]string, 0, len(words))
		matched := and
		for _, word := range words {
			ok := strings.Contains(lower, strings.ToLower(word))
			if ok {
				matchedWords = append(matchedWords, word)
			}
			if and {
				matched = matched && ok
			} else {
				matched = matched || ok
			}
		}
		if negative {
			matched = !matched
		}
		out = append(out, WordToolMatch{Index: index, Matched: matched, MatchedWords: matchedWords})
	}
	return out
}
