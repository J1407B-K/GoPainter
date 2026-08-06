package main

import (
	"encoding/json"
	"syscall/js"

	"gopainter/wasm/engine"
)

// goCrawlStart(seed, maxPages) -> {"ok":true}；maxPages 0 = 不限
func jsCrawlStart(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("crawlStart(seed, maxPages) 需要两个参数")
	}
	if err := engine.CrawlStart(args[0].String(), args[1].Int()); err != nil {
		return jsError("%s", err)
	}
	return `{"ok":true}`
}

// goCrawlBatch(n) -> {"urls":[...],"done":bool}
func jsCrawlBatch(_ js.Value, args []js.Value) any {
	n := 5
	if len(args) >= 1 {
		n = args[0].Int()
	}
	urls, done, err := engine.CrawlBatch(n)
	if err != nil {
		return jsError("%s", err)
	}
	out, _ := json.Marshal(map[string]any{"urls": urls, "done": done})
	return string(out)
}

// goCrawlFeed(pageURL, linksJSON) -> {"added":n}
func jsCrawlFeed(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("crawlFeed(pageURL, linksJSON) 需要两个参数")
	}
	var links []string
	if err := json.Unmarshal([]byte(args[1].String()), &links); err != nil {
		return jsError("链接 JSON 解析失败: %s", err)
	}
	added, err := engine.CrawlFeed(args[0].String(), links)
	if err != nil {
		return jsError("%s", err)
	}
	out, _ := json.Marshal(map[string]any{"added": added})
	return string(out)
}

// goCrawlStatus() -> {"visited":n,"queued":n}
func jsCrawlStatus(_ js.Value, _ []js.Value) any {
	visited, queued, err := engine.CrawlStatus()
	if err != nil {
		return jsError("%s", err)
	}
	out, _ := json.Marshal(map[string]any{"visited": visited, "queued": queued})
	return string(out)
}
