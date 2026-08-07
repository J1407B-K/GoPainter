# 优先用 TinyGo（产物几百 KB），没装就回退标准 Go（4MB 左右，也能跑）

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
ifeq ($(shell command -v tinygo 2>/dev/null),)
	@echo "未检测到 tinygo，回退到标准 Go 构建（产物约 4MB，装 tinygo 后可降到几百 KB）"
	@$(MAKE) build-go
else
	@$(MAKE) build-tinygo
endif

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
