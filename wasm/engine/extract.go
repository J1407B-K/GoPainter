// HTML 特征提取：JS 把原始 HTML 丢过来，这里抠出结构化特征。
// 用正则而不是 html parser，指纹场景够用，还省依赖。
package engine

import (
	"regexp"
	"strings"
)

type Extracted struct {
	Title    string            `json:"title"`
	Meta     map[string]string `json:"meta"`
	Scripts  []string          `json:"scripts"`
	Favicons []string          `json:"favicons"` // 所有 <link rel=icon>，站点经常挂好几个尺寸
	Links    []string          `json:"links"`    // <a href> 列表，爬虫用
}

var (
	titleRe   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	metaTagRe = regexp.MustCompile(`(?is)<meta\s[^>]*>`)
	scriptRe  = regexp.MustCompile(`(?is)<script\s[^>]*>`)
	linkRe    = regexp.MustCompile(`(?is)<link\s[^>]*>`)
	anchorRe  = regexp.MustCompile(`(?is)<a\s[^>]*>`)
	attrRe    = regexp.MustCompile(`(?is)([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	spaceRe   = regexp.MustCompile(`\s+`)
)

func parseAttrs(tag string) map[string]string {
	attrs := make(map[string]string)
	for _, m := range attrRe.FindAllStringSubmatch(tag, -1) {
		v := m[2]
		if v == "" {
			v = m[3]
		}
		if v == "" {
			v = m[4]
		}
		attrs[strings.ToLower(m[1])] = v
	}
	return attrs
}

func extractFeatures(html string) Extracted {
	out := Extracted{Meta: make(map[string]string)}

	if m := titleRe.FindStringSubmatch(html); m != nil {
		out.Title = strings.TrimSpace(spaceRe.ReplaceAllString(m[1], " "))
	}
	for _, tag := range metaTagRe.FindAllString(html, -1) {
		attrs := parseAttrs(tag)
		name := attrs["name"]
		if name == "" {
			name = attrs["property"]
		}
		if name == "" || attrs["content"] == "" {
			continue
		}
		out.Meta[strings.ToLower(name)] = attrs["content"]
	}
	for _, tag := range scriptRe.FindAllString(html, -1) {
		if src := parseAttrs(tag)["src"]; src != "" {
			out.Scripts = append(out.Scripts, src)
		}
	}
	for _, tag := range linkRe.FindAllString(html, -1) {
		attrs := parseAttrs(tag)
		if strings.Contains(attrs["rel"], "icon") && attrs["href"] != "" {
			out.Favicons = append(out.Favicons, attrs["href"])
		}
	}
	for _, tag := range anchorRe.FindAllString(html, -1) {
		if href := parseAttrs(tag)["href"]; href != "" {
			out.Links = append(out.Links, href)
		}
	}
	return out
}
