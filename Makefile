# 生产默认用标准 Go（无 TinyGo 的 GC 尾延迟尖峰，产物约 4.4MB，详见 BENCHMARK.md）。
# 体积优先时用 `make build-tinygo`（约 925K，但稳态 p99 有 140-300ms 尖峰）。

WASM_OUT := extension/wasm/matcher.wasm
EXEC_JS  := extension/wasm/wasm_exec.js

.PHONY: build build-tinygo build-go icons test test-go test-js clean

icons:
	node scripts/generate-icons.mjs

# Go 侧单元测试用 js/wasm 目标跑（源码 import 了 syscall/js，原生平台编译不过）。
# 通过 node 调 wasm_exec_node.js 执行，无需先 make build
test-go:
	GOOS=js GOARCH=wasm go test -count=1 -exec "node --stack-size=8192 $$(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./wasm/...

test-js:
	node --test test/*.test.cjs

test:
	$(MAKE) test-go
	$(MAKE) test-js
	node scripts/smoke-test.mjs

build:
	@$(MAKE) build-go

build-tinygo:
	tinygo build -target wasm -no-debug -o $(WASM_OUT) ./wasm
	cp "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

build-go:
	GOOS=js GOARCH=wasm go build -o $(WASM_OUT) ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(EXEC_JS)
	@ls -lh $(WASM_OUT)

clean:
	rm -f $(WASM_OUT) $(EXEC_JS)
