// GoPainter wasm 入口：只做 JS 导出和 JSON 进出，逻辑都在别的文件里。
// 纯计算、零 I/O —— 网络、存储这些都在 JS 侧。
package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"syscall/js"
)

func jsError(format string, args ...any) string {
	return `{"error":` + fmt.Sprintf("%q", fmt.Sprintf(format, args...)) + `}`
}

// goMatch(rulesJSON, featuresJSON) -> {"hits":[...]}
func match(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("match(rulesJSON, featuresJSON) 需要两个参数")
	}
	var rules []Rule
	if err := json.Unmarshal([]byte(args[0].String()), &rules); err != nil {
		return jsError("规则 JSON 解析失败: %s", err)
	}
	var features Features
	if err := json.Unmarshal([]byte(args[1].String()), &features); err != nil {
		return jsError("特征 JSON 解析失败: %s", err)
	}

	hits := make([]Hit, 0)
	for _, r := range rules {
		if ok, ev := matchRule(r, &features); ok {
			hits = append(hits, Hit{ID: r.ID, Name: r.Name, Evidence: ev})
		}
	}
	out, _ := json.Marshal(map[string]any{"hits": hits})
	return string(out)
}

// goMmh3(base64Str) -> int32
func jsMmh3(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return 0
	}
	return mmh3Sum32(args[0].String())
}

// goExtractFeatures(html) -> {"title":...,"meta":{...},"scripts":[...]}
func jsExtract(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("extractFeatures(html) 需要一个参数")
	}
	out, _ := json.Marshal(extractFeatures(args[0].String()))
	return string(out)
}

// goNormalizeRules(docsJSON) -> {"rules":[...]}，docs 是 YAML 解析后的文档数组
func jsNormalize(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("normalizeRules(docsJSON) 需要一个参数")
	}
	var docs []json.RawMessage
	if err := json.Unmarshal([]byte(args[0].String()), &docs); err != nil {
		return jsError("文档 JSON 解析失败: %s", err)
	}
	rules := make([]Rule, 0)
	for _, d := range docs {
		rules = append(rules, normalizeDoc(d)...)
	}
	out, _ := json.Marshal(map[string]any{"rules": rules})
	return string(out)
}

// goHashLookup(hash, customJSON) -> {"name":"..."} 或 {}，自定义（{"hash":"name"}）覆盖内置
func jsHashLookup(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("hashLookup(hash, customJSON) 需要两个参数")
	}
	hash := int32(args[0].Int())
	var custom map[string]string
	if err := json.Unmarshal([]byte(args[1].String()), &custom); err != nil {
		return jsError("自定义哈希 JSON 解析失败: %s", err)
	}
	name := custom[strconv.Itoa(int(hash))]
	if name == "" {
		name = builtinHashDB[hash]
	}
	if name == "" {
		return "{}"
	}
	out, _ := json.Marshal(map[string]string{"name": name})
	return string(out)
}

func main() {
	g := js.Global()
	g.Set("goMatch", js.FuncOf(match))
	g.Set("goMmh3", js.FuncOf(jsMmh3))
	g.Set("goExtractFeatures", js.FuncOf(jsExtract))
	g.Set("goNormalizeRules", js.FuncOf(jsNormalize))
	g.Set("goHashLookup", js.FuncOf(jsHashLookup))
	select {} // 挂着别退，等 JS 调用
}
