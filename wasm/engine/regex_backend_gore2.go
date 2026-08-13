//go:build !stdlibregexp

package engine

import re2 "github.com/wasilibs/go-re2"

// 默认执行器：使用嵌入式 Google RE2 完成最终 MatchString / FindString。
func compileRegexBackend(pattern string) (regexMatcher, error) {
	return re2.Compile(pattern)
}
