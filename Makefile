# 生产默认：Go WASM + 嵌入式 Google RE2（约 13MB，详见 BENCHMARK.md）。
# 对照构建：`make build-go-stdlib`；体积优先：`make build-tinygo`。

WASM_OUT := extension/wasm/matcher.wasm
EXEC_JS  := extension/wasm/wasm_exec.js

.PHONY: build build-tinygo build-go build-go-stdlib build-go-re2 icons test test-go test-go-re2 test-js bench-regex clean

icons:
	node scripts/generate-icons.mjs

# Go 侧单元测试用 js/wasm 目标跑（源码 import 了 syscall/js，原生平台编译不过）。
# 通过 node 调 wasm_exec_node.js 执行，无需先 make build
test-go:
	GOOS=js GOARCH=wasm go test -count=1 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/...

# 实验后端的语义回归；不改变默认构建。
test-go-re2:
	GOOS=js GOARCH=wasm go test -tags gore2 -count=1 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/...

test-js:
	node --test test/*.test.cjs

# 独立比较浏览器 WASM 下可用的 regex 后端；不改变生产引擎。
bench-regex:
	GOOS=js GOARCH=wasm go test -run '^$$' -bench '^BenchmarkRegexBackends' -benchmem -count=5 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/engine

test:
	$(MAKE) test-go
	$(MAKE) test-go-re2
	$(MAKE) test-js
	node scripts/smoke-test.mjs

build:
	@$(MAKE) build-go-re2

build-tinygo:
	tinygo build -target wasm -no-debug -o $(WASM_OUT) ./wasm
	cp "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

# 标准库 RE2 对照后端。保留 build-go 别名，避免旧脚本失效。
build-go build-go-stdlib:
	GOOS=js GOARCH=wasm go build -o $(WASM_OUT) ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

# 生产：用嵌入式 Google RE2 执行最终 regex。
build-go-re2:
	GOOS=js GOARCH=wasm go build -tags gore2 -o $(WASM_OUT) ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

clean:
	rm -f $(WASM_OUT) $(EXEC_JS)
