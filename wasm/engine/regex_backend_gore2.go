//go:build gore2

package engine

import re2 "github.com/wasilibs/go-re2"

// gore2 构建标签的实验执行器。它与 Go regexp 同为 RE2 语义，只替换最终 MatchString /
// FindString；默认生产构建仍使用标准库。用 `make build-go-re2` 生成 Chrome A/B 产物。
func compileRegexBackend(pattern string) (regexMatcher, error) {
	return re2.Compile(pattern)
}
