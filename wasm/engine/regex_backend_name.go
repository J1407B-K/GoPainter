package engine

// RegexBackendName 暴露当前编译进 WASM 的最终 regex 执行器，仅供开发基准标注。
func RegexBackendName() string { return regexBackendName }
