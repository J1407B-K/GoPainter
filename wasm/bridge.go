// JS bridge：只处理 syscall/js 参数、JSON 进出和全局导出。
package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	"gopainter/wasm/engine"
)

func jsError(format string, args ...any) string {
	return `{"error":` + fmt.Sprintf("%q", fmt.Sprintf(format, args...)) + `}`
}

// goMatch(rulesJSON, featuresJSON) -> {"hits":[...]}
func match(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("match(rulesJSON, featuresJSON) 需要两个参数")
	}
	var rules []engine.Rule
	if err := json.Unmarshal([]byte(args[0].String()), &rules); err != nil {
		return jsError("规则 JSON 解析失败: %s", err)
	}
	var features engine.Features
	if err := json.Unmarshal([]byte(args[1].String()), &features); err != nil {
		return jsError("特征 JSON 解析失败: %s", err)
	}

	out, _ := json.Marshal(map[string]any{"hits": engine.Match(rules, features)})
	return string(out)
}

// goMmh3(base64Str) -> int32
func jsMmh3(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return 0
	}
	return engine.Mmh3Sum32(args[0].String())
}

// goExtractFeatures(html) -> {"title":...,"meta":{...},"scripts":[...]}
func jsExtract(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("extractFeatures(html) 需要一个参数")
	}
	out, _ := json.Marshal(engine.ExtractFeatures(args[0].String()))
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
	out, _ := json.Marshal(map[string]any{"rules": engine.NormalizeDocs(docs)})
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
	name := engine.HashLookup(hash, custom)
	if name == "" {
		return "{}"
	}
	out, _ := json.Marshal(map[string]string{"name": name})
	return string(out)
}

// goConvertWappalyzer(techJSON) -> {"rules":[...]}
func jsConvertWappalyzer(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("convertWappalyzer(techJSON) 需要一个参数")
	}
	rules, err := engine.ConvertWappalyzerJSON(args[0].String())
	if err != nil {
		return jsError("Wappalyzer JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(map[string]any{"rules": rules})
	return string(out)
}

// goConvertEHole(fingerJSON) -> {"rules":[...]}
func jsConvertEHole(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("convertEHole(fingerJSON) 需要一个参数")
	}
	rules, err := engine.ConvertEHoleJSON(args[0].String())
	if err != nil {
		return jsError("EHole JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(map[string]any{"rules": rules})
	return string(out)
}

// goDslEval(exprJSON, featuresJSON) -> {"results":[true,false],"errors":[...]}，给调试/测试用
func jsDslEval(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("dslEval(exprsJSON, featuresJSON) 需要两个参数")
	}
	var exprs []string
	if err := json.Unmarshal([]byte(args[0].String()), &exprs); err != nil {
		return jsError("表达式 JSON 解析失败: %s", err)
	}
	var features engine.Features
	if err := json.Unmarshal([]byte(args[1].String()), &features); err != nil {
		return jsError("特征 JSON 解析失败: %s", err)
	}
	results, errs := engine.DslEvalMany(exprs, features)
	out, _ := json.Marshal(map[string]any{"results": results, "errors": errs})
	return string(out)
}

func registerJSExports() {
	g := js.Global()
	g.Set("goMatch", js.FuncOf(match))
	g.Set("goMmh3", js.FuncOf(jsMmh3))
	g.Set("goExtractFeatures", js.FuncOf(jsExtract))
	g.Set("goNormalizeRules", js.FuncOf(jsNormalize))
	g.Set("goHashLookup", js.FuncOf(jsHashLookup))
	g.Set("goConvertWappalyzer", js.FuncOf(jsConvertWappalyzer))
	g.Set("goConvertEHole", js.FuncOf(jsConvertEHole))
	g.Set("goDslEval", js.FuncOf(jsDslEval))
	g.Set("goCrawlStart", js.FuncOf(jsCrawlStart))
	g.Set("goCrawlBatch", js.FuncOf(jsCrawlBatch))
	g.Set("goCrawlFeed", js.FuncOf(jsCrawlFeed))
	g.Set("goCrawlStatus", js.FuncOf(jsCrawlStatus))
}
