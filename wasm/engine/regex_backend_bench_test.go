package engine

import (
	stdregexp "regexp"
	"slices"
	"strings"
	"testing"

	regexp2 "github.com/dlclark/regexp2/v2"
	grafanaregexp "github.com/grafana/regexp"
	re2 "github.com/wasilibs/go-re2"
)

// regexBackendPatterns 是从真实 Wappalyzer 风格 body regex 选出的代表性子集。
// 它刻意包括泛 HTML 锚点、交替、字符类、命中和未命中项；这里测的是预筛之后
// 仍需要执行的「regex model」成本，而不是完整 Match 的端到端耗时。
var regexBackendPatterns = []string{
	`(?:jQuery\.extend\(true, XenForo|<a[^>]+>Forum software by XenForo™|<!--XF:branding|<html[^>]+id="XenForo")`,
	`<(?:script|link)[^>]*sh(?:Core|Brush|ThemeDefault)`,
	`<link[^>]+foundation[^">]+css`,
	`<[^>]+data-react`,
	`<div [^>]*class=["']mermaid["']>`,
	`<(?:link|a)[^>]+href=["']wss?://`,
	`<link rel=["']stylesheet["'] [^>]+/wp-(?:content|includes)/`,
	`<html[^>]* (?:amp|⚡)[^-]`,
	`Powered by <a href="[^>]+yabbforum`,
	`<!-- (?:End )?Yahoo! Tag Manager -->`,
	`<[^>]+class="[^"]*(?:uk-container|uk-section)`,
	`<input type="hidden" value="[a-zA-Z0-9]{40,}" name="YII_CSRF_TOKEN"`,
}

func regexBackendBody() string {
	// 同时含中文和 HTML。加入几个实际命中，避免 benchmark 只测全 miss 的快路径。
	seed := `<html><head><link rel="stylesheet" href="/wp-content/theme.css"><script src="/assets/app.js"></script></head>` +
		`<body>这是一个中文页面 <div data-reactroot class="uk-container">Powered by nginx</div>` +
		`<a href="wss://example.test/socket">socket</a><!-- Yahoo! Tag Manager --></body></html>`
	return seed + strings.Repeat("<div class=\"content\">中文内容与普通 HTML text 0123456789</div>", 3000)
}

func BenchmarkRegexBackendsMatchCorpus(b *testing.B) {
	body := regexBackendBody()
	b.SetBytes(int64(len(body)))

	b.Run("stdlib-re2", func(b *testing.B) {
		rs := mustCompileStd(b)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			for _, re := range rs {
				_ = re.MatchString(body)
			}
		}
	})
	b.Run("grafana-re2", func(b *testing.B) {
		rs := mustCompileGrafana(b)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			for _, re := range rs {
				_ = re.MatchString(body)
			}
		}
	})
	b.Run("regexp2-backtracking", func(b *testing.B) {
		rs := mustCompileRegexp2(b)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			for _, re := range rs {
				if _, err := re.MatchString(body); err != nil {
					b.Fatal(err)
				}
			}
		}
	})
	b.Run("wasilibs-go-re2", func(b *testing.B) {
		rs := mustCompileGoRE2(b)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			for _, re := range rs {
				_ = re.MatchString(body)
			}
		}
	})
}

// TestRegexBackendParity 让默认 go-re2 与 `-tags stdlibregexp` 对照后端分别对同一批
// RE2 兼容模式跑差分。后端可以不同，但 GoPainter 对规则的 MatchString / Evidence 文本语义必须一致。
func TestRegexBackendParity(t *testing.T) {
	patterns := append(append([]string{}, regexBackendPatterns...),
		`(?i)wordpress`, `(?i)σ`, `(?i)s`, `(?im)^server:\s*nginx$`,
		`foo.*bar`, `(?:foo|bar)[0-9]+`, `a{2,4}`, `\breact\b`, `^$`,
	)
	texts := []string{
		"", "SERVER: Nginx\n", "WordPress 6.7", "foo---bar", "bar42",
		"ſ and K and ς", "<div data-reactroot>中文页面</div>", regexBackendBody(),
	}
	ClearRegexCache()
	for _, pattern := range patterns {
		want, wantErr := stdregexp.Compile(tamePattern(pattern))
		got, gotErr := compileRegex(pattern)
		if (wantErr != nil) != (gotErr != nil) {
			t.Fatalf("pattern=%q compile mismatch: stdlib=%v backend=%v", pattern, wantErr, gotErr)
		}
		if wantErr != nil {
			continue
		}
		for _, text := range texts {
			if got.MatchString(text) != want.MatchString(text) {
				t.Errorf("pattern=%q text=%q: MatchString mismatch", pattern, text)
			}
			if got.FindString(text) != want.FindString(text) {
				t.Errorf("pattern=%q text=%q: FindString backend=%q stdlib=%q", pattern, text, got.FindString(text), want.FindString(text))
			}
			if !slices.Equal(got.FindStringSubmatch(text), want.FindStringSubmatch(text)) {
				t.Errorf("pattern=%q text=%q: FindStringSubmatch backend=%q stdlib=%q", pattern, text, got.FindStringSubmatch(text), want.FindStringSubmatch(text))
			}
		}
	}
}

func BenchmarkRegexBackendsCompileCorpus(b *testing.B) {
	benchCompile := func(name string, compile func(string) error) {
		b.Run(name, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				for _, p := range regexBackendPatterns {
					if err := compile(p); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
	benchCompile("stdlib-re2", func(p string) error { _, err := stdregexp.Compile(insensitivePattern(p)); return err })
	benchCompile("grafana-re2", func(p string) error { _, err := grafanaregexp.Compile(insensitivePattern(p)); return err })
	benchCompile("regexp2-backtracking", func(p string) error { _, err := regexp2.Compile(insensitivePattern(p)); return err })
	benchCompile("wasilibs-go-re2", func(p string) error { _, err := re2.Compile(insensitivePattern(p)); return err })
}

// 生产 matcher 优先以 (?i) 编译规则；基准必须保持同一语义和同一执行路径。
func insensitivePattern(p string) string { return "(?i)" + p }

func mustCompileStd(b *testing.B) []*stdregexp.Regexp {
	b.Helper()
	rs := make([]*stdregexp.Regexp, 0, len(regexBackendPatterns))
	for _, p := range regexBackendPatterns {
		re, err := stdregexp.Compile(insensitivePattern(p))
		if err != nil {
			b.Fatal(err)
		}
		rs = append(rs, re)
	}
	return rs
}

func mustCompileGrafana(b *testing.B) []*grafanaregexp.Regexp {
	b.Helper()
	rs := make([]*grafanaregexp.Regexp, 0, len(regexBackendPatterns))
	for _, p := range regexBackendPatterns {
		re, err := grafanaregexp.Compile(insensitivePattern(p))
		if err != nil {
			b.Fatal(err)
		}
		rs = append(rs, re)
	}
	return rs
}

func mustCompileRegexp2(b *testing.B) []*regexp2.Regexp {
	b.Helper()
	rs := make([]*regexp2.Regexp, 0, len(regexBackendPatterns))
	for _, p := range regexBackendPatterns {
		re, err := regexp2.Compile(insensitivePattern(p))
		if err != nil {
			b.Fatal(err)
		}
		rs = append(rs, re)
	}
	return rs
}

func mustCompileGoRE2(b *testing.B) []*re2.Regexp {
	b.Helper()
	rs := make([]*re2.Regexp, 0, len(regexBackendPatterns))
	for _, p := range regexBackendPatterns {
		re, err := re2.Compile(insensitivePattern(p))
		if err != nil {
			b.Fatal(err)
		}
		rs = append(rs, re)
	}
	return rs
}
