package engine

// regexMatcher 是 matcher 所需的最小 RE2 兼容表面。所有 backend 都先经过同一套
// 规则驯化、深度限制、AST/AC 预筛和缓存；backend 只负责最终执行。
type regexMatcher interface {
	MatchString(string) bool
	FindString(string) string
}
