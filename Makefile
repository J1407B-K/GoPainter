# 唯一受支持的生产构建：Go WASM + 嵌入式 Google RE2（约 13MB，详见 BENCHMARK.md）。
# 其余 target 是未维护的遗留实验入口，不属于发布支持面。

WASM_OUT := extension/wasm/matcher.wasm
EXEC_JS  := extension/wasm/wasm_exec.js

.PHONY: build build-tinygo build-go build-go-stdlib build-go-re2 icons test test-go test-go-stdlib test-go-re2 test-js bench-regex clean

icons:
	node scripts/generate-icons.mjs

# Go 单元测试默认验证生产 go-re2 后端（源码 import 了 syscall/js，原生平台编译不过）。
# 通过 node 调 wasm_exec_node.js 执行，无需先 make build。
test-go:
	GOOS=js GOARCH=wasm go test -count=1 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/...

# 兼容旧命令：go-re2 已经是 test-go 的默认后端。
test-go-re2: test-go

# 开发用：标准库 RE2 的语义对照测试，不属于默认测试流程。
test-go-stdlib:
	GOOS=js GOARCH=wasm go test -tags stdlibregexp -count=1 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/...

test-js:
	node --test test/*.test.cjs

# 独立比较浏览器 WASM 下可用的 regex 后端；不改变生产引擎。
bench-regex:
	GOOS=js GOARCH=wasm go test -run '^$$' -bench '^BenchmarkRegexBackends' -benchmem -count=5 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/engine

test:
	$(MAKE) test-go
	$(MAKE) test-js
	node scripts/smoke-test.mjs

build:
	@$(MAKE) build-go-re2

build-tinygo:
	tinygo build -tags stdlibregexp -target wasm -no-debug -o $(WASM_OUT) ./wasm
	cp "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

# 标准 Go WASM 始终使用默认 go-re2。保留 build-go 别名，避免旧脚本失效。
build-go build-go-re2:
	GOOS=js GOARCH=wasm go build -o $(WASM_OUT) ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

# 开发用：构建标准库 RE2 对照产物。
build-go-stdlib:
	GOOS=js GOARCH=wasm go build -tags stdlibregexp -o $(WASM_OUT) ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)


clean:
	rm -f $(WASM_OUT) $(EXEC_JS)
