// 爬虫调度：BFS 队列、去重、同站过滤、页数上限，状态都在这。
// 网络抓取在 JS 侧（wasm 不碰 I/O），JS 取一批 URL 抓完把页面链接喂回来。
package engine

import (
	"errors"
	"net/url"
	"strings"
)

type crawler struct {
	baseHost string
	maxPages int // 0 = 不限
	visited  int
	seen     map[string]struct{}
	queue    []string
}

// 同一时间只跑一个任务，简单点
var crawlState *crawler

var errCrawlerNotStarted = errors.New("爬虫没启动")

// 去重 key：去 fragment、去路径末尾的 /（根路径除外）
func normURL(u *url.URL) string {
	v := *u
	v.Fragment = ""
	if len(v.Path) > 1 && strings.HasSuffix(v.Path, "/") {
		v.Path = strings.TrimSuffix(v.Path, "/")
	}
	return v.String()
}

func (c *crawler) sameSite(host string) bool {
	return host == c.baseHost || strings.HasSuffix(host, "."+c.baseHost)
}

var staticExts = []string{
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
	".css", ".js", ".woff", ".woff2", ".ttf", ".eot",
	".pdf", ".zip", ".tar", ".gz", ".mp3", ".mp4", ".avi", ".mov",
	".doc", ".docx", ".xls", ".xlsx",
}

func isStaticPath(p string) bool {
	p = strings.ToLower(p)
	for _, ext := range staticExts {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}

func crawlStart(seed string, maxPages int) error {
	u, err := url.Parse(seed)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("起始 URL 得是 http/https")
	}
	// 注册域名粗略取最后两段（co.uk 这类会不准，够用）
	host := u.Hostname()
	parts := strings.Split(host, ".")
	base := host
	if len(parts) > 2 {
		base = strings.Join(parts[len(parts)-2:], ".")
	}
	c := &crawler{baseHost: base, maxPages: maxPages, seen: make(map[string]struct{})}
	key := normURL(u)
	c.seen[key] = struct{}{}
	c.queue = []string{key}
	crawlState = c
	return nil
}

// 喂回一个页面里发现的链接，过滤+去重后入队，返回新增数
func (c *crawler) feed(pageURL string, links []string) int {
	base, err := url.Parse(pageURL)
	if err != nil {
		return 0
	}
	added := 0
	for _, l := range links {
		u, err := base.Parse(l) // 相对链接转绝对
		if err != nil {
			continue
		}
		if u.Scheme != "http" && u.Scheme != "https" {
			continue // mailto: / javascript: 之类
		}
		if !c.sameSite(u.Hostname()) {
			continue // 只爬本站
		}
		if isStaticPath(u.Path) {
			continue
		}
		key := normURL(u)
		if _, ok := c.seen[key]; ok {
			continue
		}
		c.seen[key] = struct{}{}
		c.queue = append(c.queue, key)
		added++
	}
	return added
}

// 取下一批要抓的 URL；done = 没有更多可抓的（队列空或达到上限）
func (c *crawler) batch(n int) (urls []string, done bool) {
	for len(urls) < n && len(c.queue) > 0 && (c.maxPages == 0 || c.visited+len(urls) < c.maxPages) {
		urls = append(urls, c.queue[0])
		c.queue = c.queue[1:]
	}
	c.visited += len(urls)
	done = len(c.queue) == 0 || (c.maxPages > 0 && c.visited >= c.maxPages)
	return urls, done
}
