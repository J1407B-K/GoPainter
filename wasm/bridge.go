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

// 规则 JSON 解析缓存：同一规则集反复调 goMatch（重扫/爬虫）时不再每次 unmarshal
// 大规则包。规则一变 JSON 字符串必变，字符串不同就自动重新解析。
// engine.Match 只读不改 rules，跨调用共享解析结果安全。
var (
	lastRulesKey   string
	lastRulesCache []engine.Rule
)

// goMatch(rulesJSON, featuresJSON) -> {"hits":[...]}
func match(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("match(rulesJSON, featuresJSON) 需要两个参数")
	}
	var rules []engine.Rule
	key := args[0].String()
	if key == lastRulesKey {
		rules = lastRulesCache
	} else if err := json.Unmarshal([]byte(key), &rules); err != nil {
		return jsError("规则 JSON 解析失败: %s", err)
	} else {
		lastRulesKey = key
		lastRulesCache = rules
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

// goValidateCandidate(ruleJSON, featuresJSON) -> 严格候选校验、生产 matcher 命中与运行时覆盖。
func jsValidateCandidate(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("validateCandidate(ruleJSON, featuresJSON) 需要两个参数")
	}
	var features engine.Features
	if err := json.Unmarshal([]byte(args[1].String()), &features); err != nil {
		return jsError("特征 JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(engine.ValidateCandidate([]byte(args[0].String()), features))
	return string(out)
}

// goPlanRequiredProbes(rulesJSON) -> Host 需要采集的 JS path 和 DOM probes。
func jsPlanRequiredProbes(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("planRequiredProbes(rulesJSON) 需要一个参数")
	}
	var rules []engine.Rule
	if err := json.Unmarshal([]byte(args[0].String()), &rules); err != nil {
		return jsError("规则 JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(engine.PlanRequiredProbes(rules))
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

// goAgentRegexTest(patternsJSON, samplesJSON) -> 生产 Go RE2 编译与匹配结果。
func jsAgentRegexTest(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("agentRegexTest(patternsJSON, samplesJSON) 需要两个参数")
	}
	var patterns, samples []string
	if err := json.Unmarshal([]byte(args[0].String()), &patterns); err != nil {
		return jsError("正则数组 JSON 解析失败: %s", err)
	}
	if err := json.Unmarshal([]byte(args[1].String()), &samples); err != nil {
		return jsError("样本数组 JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(map[string]any{"backend": engine.RegexBackendName(), "results": engine.TestRegexPatterns(patterns, samples)})
	return string(out)
}

// goAgentWordTest(wordsJSON, samplesJSON, condition, negative) -> 原生 word matcher 结果。
func jsAgentWordTest(_ js.Value, args []js.Value) any {
	if len(args) < 4 {
		return jsError("agentWordTest(wordsJSON, samplesJSON, condition, negative) 需要四个参数")
	}
	var words, samples []string
	if err := json.Unmarshal([]byte(args[0].String()), &words); err != nil {
		return jsError("word 数组 JSON 解析失败: %s", err)
	}
	if err := json.Unmarshal([]byte(args[1].String()), &samples); err != nil {
		return jsError("样本数组 JSON 解析失败: %s", err)
	}
	out, _ := json.Marshal(map[string]any{"results": engine.TestWordMatcher(words, samples, args[2].String(), args[3].Bool())})
	return string(out)
}

func registerJSExports() {
	g := js.Global()
	g.Set("goRegexBackend", js.FuncOf(func(this js.Value, args []js.Value) any { return engine.RegexBackendName() }))
	g.Set("goMatch", js.FuncOf(match))
	g.Set("goMmh3", js.FuncOf(jsMmh3))
	g.Set("goExtractFeatures", js.FuncOf(jsExtract))
	g.Set("goNormalizeRules", js.FuncOf(jsNormalize))
	g.Set("goValidateCandidate", js.FuncOf(jsValidateCandidate))
	g.Set("goPlanRequiredProbes", js.FuncOf(jsPlanRequiredProbes))
	g.Set("goHashLookup", js.FuncOf(jsHashLookup))
	g.Set("goConvertWappalyzer", js.FuncOf(jsConvertWappalyzer))
	g.Set("goConvertEHole", js.FuncOf(jsConvertEHole))
	g.Set("goDslEval", js.FuncOf(jsDslEval))
	g.Set("goAgentRegexTest", js.FuncOf(jsAgentRegexTest))
	g.Set("goAgentWordTest", js.FuncOf(jsAgentWordTest))
	g.Set("goCrawlStart", js.FuncOf(jsCrawlStart))
	g.Set("goCrawlBatch", js.FuncOf(jsCrawlBatch))
	g.Set("goCrawlFeed", js.FuncOf(jsCrawlFeed))
	g.Set("goCrawlStatus", js.FuncOf(jsCrawlStatus))
}
