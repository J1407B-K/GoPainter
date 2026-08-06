package engine

import (
	"net/url"
	"testing"
)

func TestNormURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://www.example.com/", "https://www.example.com/"}, // 根路径的 / 保留
		{"https://www.example.com", "https://www.example.com"},
		{"https://www.example.com/about/", "https://www.example.com/about"},
		{"https://www.example.com/about#section", "https://www.example.com/about"},
		{"https://www.example.com/about/?a=1", "https://www.example.com/about?a=1"},
	}
	for _, c := range cases {
		u, err := url.Parse(c.in)
		if err != nil {
			t.Fatalf("parse %s: %v", c.in, err)
		}
		if got := normURL(u); got != c.want {
			t.Errorf("normURL(%s) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestSameSite(t *testing.T) {
	c := &crawler{baseHost: "example.com"}
	for _, host := range []string{"example.com", "www.example.com", "a.b.example.com"} {
		if !c.sameSite(host) {
			t.Errorf("%s 应算同站", host)
		}
	}
	for _, host := range []string{"example.org", "fakeexample.com", "example.com.evil.com"} {
		if c.sameSite(host) {
			t.Errorf("%s 不应算同站", host)
		}
	}
}

func TestIsStaticPath(t *testing.T) {
	for _, p := range []string{"/a.png", "/b.JPG", "/css/style.css", "/js/app.js", "/doc.pdf", "/files/data.tar.gz"} {
		if !isStaticPath(p) {
			t.Errorf("%s 应判静态", p)
		}
	}
	for _, p := range []string{"/", "/about", "/wp-admin/", "/download", "/api/user"} {
		if isStaticPath(p) {
			t.Errorf("%s 不应判静态", p)
		}
	}
}

func TestCrawlStart(t *testing.T) {
	if err := crawlStart("not a url", 0); err == nil {
		t.Error("非法 URL 应报错")
	}
	if err := crawlStart("ftp://example.com", 0); err == nil {
		t.Error("非 http/https 应报错")
	}
	if err := crawlStart("https://www.example.com/", 10); err != nil {
		t.Fatalf("合法 seed 应成功: %v", err)
	}
	if crawlState == nil || crawlState.baseHost != "example.com" {
		t.Errorf("baseHost 应为 example.com: %+v", crawlState)
	}
	if len(crawlState.queue) != 1 {
		t.Errorf("种子应入队: %+v", crawlState.queue)
	}
}

func TestCrawlStartSubdomainBase(t *testing.T) {
	if err := crawlStart("https://a.b.c.example.co.uk/x", 0); err != nil {
		t.Fatalf("err: %v", err)
	}
	// 当前实现是粗略取域名后两段（注释里也说明了 co.uk 会不准，够用）
	if crawlState.baseHost != "co.uk" {
		t.Errorf("baseHost 应为 co.uk: %s", crawlState.baseHost)
	}
}

func TestCrawlFeed(t *testing.T) {
	c := &crawler{baseHost: "example.com", seen: map[string]struct{}{}}
	added := c.feed("https://www.example.com/index.html", []string{
		"/about",                             // 相对 → 绝对
		"https://www.example.com/about/",     // 归一化后与 /about 去重
		"https://docs.example.com/api",       // 子域，同站
		"https://evil.com/phish",             // 异站
		"/static/logo.png",                   // 静态
		"mailto:x@y.com",                     // 非 http
		"javascript:void(0)",                 // 非 http
		"https://www.example.com/about#frag", // 去 fragment 后重复
	})
	if added != 2 {
		t.Errorf("feed 应新增 2 个（/about + 子域 api），实际 %d: %+v", added, c.queue)
	}
	if len(c.queue) != 2 {
		t.Fatalf("队列应有 2 个: %+v", c.queue)
	}
}

func TestCrawlFeedInvalidBase(t *testing.T) {
	c := &crawler{baseHost: "example.com", seen: map[string]struct{}{}}
	if n := c.feed("::bad::", []string{"/x"}); n != 0 {
		t.Errorf("非法 pageURL 应返回 0: %d", n)
	}
}

func TestCrawlBatch(t *testing.T) {
	c := &crawler{
		baseHost: "example.com",
		maxPages: 10,
		queue:    []string{"https://example.com/a", "https://example.com/b", "https://example.com/c"},
	}
	urls, done := c.batch(2)
	if len(urls) != 2 || urls[0] != "https://example.com/a" || urls[1] != "https://example.com/b" {
		t.Errorf("batch(2) 应取前 2 个: %+v", urls)
	}
	if done {
		t.Error("还有剩余不应 done")
	}
	if c.visited != 2 {
		t.Errorf("visited 应为 2: %d", c.visited)
	}
	urls, done = c.batch(2)
	if len(urls) != 1 || !done {
		t.Errorf("取完应 done: urls=%v done=%v", urls, done)
	}
}

func TestCrawlBatchMaxPages(t *testing.T) {
	c := &crawler{baseHost: "example.com", maxPages: 2, queue: []string{"a", "b", "c"}}
	urls, done := c.batch(5)
	if len(urls) != 2 || !done {
		t.Errorf("达到 maxPages 应截断并 done: urls=%v done=%v", urls, done)
	}
	if c.visited != 2 {
		t.Errorf("visited 应为 2: %d", c.visited)
	}
}

func TestCrawlBatchNoLimit(t *testing.T) {
	c := &crawler{baseHost: "example.com", maxPages: 0, queue: []string{"a", "b"}}
	urls, done := c.batch(2)
	// 不限页数也会取完；队列清空即 done（没有更多可抓）
	if len(urls) != 2 || !done {
		t.Errorf("应取完且 done: urls=%v done=%v", urls, done)
	}
}
