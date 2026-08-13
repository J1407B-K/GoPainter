//go:build stdlibregexp

package engine

import "regexp"

func compileRegexBackend(pattern string) (regexMatcher, error) {
	return regexp.Compile(pattern)
}
