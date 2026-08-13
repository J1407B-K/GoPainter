//go:build !gore2

package engine

import "regexp"

func compileRegexBackend(pattern string) (regexMatcher, error) {
	return regexp.Compile(pattern)
}
