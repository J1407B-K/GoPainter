package engine

import (
	"fmt"
	"strings"
	"testing"
)

// regexCanSkip 必须零 false negative：判定「可跳过」时，正则必须真的不可能命中。
// 约定：text 已小写（生产里传 partTextLower），字面量也 ToLower 后比较。
func TestRegexCanSkip(t *testing.T) {
	cases := []struct {
		pattern  string
		text     string // 已小写
		wantSkip bool
		why      string
	}{
		// 简单字面量
		{"yabbforum", "hello world", true, "字面量不在 → 必然不命中"},
		{"yabbforum", "yabbforum here", false, "字面量在 → 不能跳过"},
		// 交替：全分支排除才跳过
		{"foo|bar", "hello", true, "foo、bar 都不在 → 交替全排除"},
		{"foo|bar", "hello bar", false, "bar 在 → 分支仍可能"},
		// ★ 反例：数字分支是字符类，永不排除 → 永不误跳过
		{"(?:foo|[0-9]+)", "hello 123", false, "数字分支可能命中 → 必须跑正则"},
		{"(?:foo|[0-9]+)", "hello", false, "数字分支无法证明排除 → 保守不跳过"},
		// 序列：任一必需项缺失 → 排除（<div 和 data-pjax-container 都要在）
		{"<div[^>]+data-pjax-container", "no pjax here", true, "必需字面量缺失 → 序列排除"},
		{"<div[^>]+data-pjax-container", "<div class=data-pjax-container x", false, "两个必需词都在 → 不能跳过"},
		{"<div[^>]+data-pjax-container", "<div no pjax", true, "data-pjax-container 缺失 → 排除"},
		// 可选量词 / 通配：可能匹配空或无法证明 → 不排除
		{"foo(bar)?", "hello", true, "foo 不在 → 序列排除（bar 可选与否无关）"},
		{"foo(bar)?", "foobar", false, "foo 在、bar 可选 → 不能跳过"},
		{"foo.*bar", "foo alone", true, "bar 缺失 → 序列排除"},
		{"foo.*bar", "foo and bar", false, "两个必需词都在 → 不能跳过"},
		// 交替取长技术名
		{"class=\"[^\"]*(?:uk-container|uk-section)", "no tech", true, "两分支字面量都不在 → 排除"},
		{"class=\"[^\"]*(?:uk-container|uk-section)", "class=\"x uk-container y\"", false, "一分支在 → 不能跳过"},
		// 锚点 + 字面量
		{"^wordpress", "no", true, "wordpress 不在 → 排除"},
		{"^wordpress", "wordpress install", false, "在 → 不能跳过"},
		// 无法证明的结构 → 不跳过
		{"[a-z]+", "anything", false, "字符类 → 不排除"},
		{"\\d+", "letters", false, "字符类 → 不排除"},
		// 交替：两分支字面量都排除才跳过
		{"(wordpress|joomla)", "no cms", true, "两分支都不在 → 排除"},
		{"(wordpress|joomla)", "joomla", false, "分支在 → 不跳过"},
		// 散文式（空格分隔）字面量
		{"powered by nginx", "apache here", true, "两个词都不在 → 排除"},
		{"powered by nginx", "powered by nginx", false, "两个词都在 → 不能跳过"},
	}
	for _, c := range cases {
		got := regexCanSkip(c.pattern, c.text, false, nil) // 测试文本全 ASCII
		if got != c.wantSkip {
			t.Errorf("regexCanSkip(%q, %q) = %v, want %v（%s）", c.pattern, c.text, got, c.wantSkip, c.why)
		}
	}
}

// foldSensitive 判定：只有 ſ/K 这类「与 ASCII 有折叠关系」的非 ASCII 才禁预筛；
// 纯中文/纯 ASCII 不禁。这是修复「含中文页面被误禁预筛」的关键。
func TestPartHasFoldSensitive(t *testing.T) {
	// 中文 CJK 无大小写折叠 → 不是 fold-sensitive → 预筛可启用
	if newMatchCtx(&Features{Body: "这是一个中文页面 hello"}).partHasFoldSensitive(Matcher{Part: "body"}) {
		t.Error("纯中文不应是 fold-sensitive")
	}
	// 纯 ASCII → 不是
	if newMatchCtx(&Features{Body: "hello world <div>"}).partHasFoldSensitive(Matcher{Part: "body"}) {
		t.Error("纯 ASCII 不应是 fold-sensitive")
	}
	// ſ / K → 是 fold-sensitive（(?i)s 匹配 ſ、(?i)k 匹配 K）
	for _, body := range []string{"hello ſt", "Kelvin", "woſdpress"} {
		if !newMatchCtx(&Features{Body: body}).partHasFoldSensitive(Matcher{Part: "body"}) {
			t.Errorf("含 %q 应是 fold-sensitive", body)
		}
	}
}

// 审阅指出的 Unicode 折叠漏洞：(?i)s 匹配 ſ、(?i)k 匹配 K，但 strings.ToLower 折叠不到。
// foldSensitive 页（含 ſ/K）→ 不预筛（宁慢勿漏）。
func TestRegexCanSkipFoldSensitive(t *testing.T) {
	for _, tc := range []struct{ pattern, text string }{
		{"s", "hello ſt"},
		{"k", "Kelvin"},
	} {
		if regexCanSkip(tc.pattern, tc.text, true, nil) {
			t.Errorf("foldSensitive 页 regexCanSkip(%q, %q)=true，应不跳过", tc.pattern, tc.text)
		}
	}
}

// 非 ASCII literal 不预筛：regexp 的 (?i) 对希腊 σ/ς 折叠等价，但 strings.ToLower
// 不折叠 ς→σ。literal 含非 ASCII → 必须跑原正则，不能套 ToLower + Contains。
func TestRegexCanSkipNonASCILLiteral(t *testing.T) {
	// σ 在含 ς 的文本上，(?i)σ 匹配 ς → 预筛必须不跳过（否则误跳）
	if regexCanSkip("σ", "ς", false, nil) {
		t.Error("非 ASCII literal σ 在含 ς 文本上应不跳过（(?i)σ 匹配 ς）")
	}
	// 与真实匹配对照：若预筛说不跳，就正常；重点是不能返回 true
	re, err := compileRegex("(?i)σ")
	if err != nil {
		t.Fatalf("编译 σ 失败: %v", err)
	}
	if regexCanSkip("σ", "ς", false, nil) && re.MatchString("ς") {
		t.Error("FALSE NEGATIVE: 非 ASCII literal 预筛跳过但实际命中")
	}
}

// body AC 收集 regex 的所有字面量后，索引查询必须与原 Contains 预筛得出相同结论。
// 这防止今后新增 AST 节点时漏把 literal 放进 bodyWords，导致 map miss 被误当成不存在。
func TestRegexPrefilterBodyIndexEquivalence(t *testing.T) {
	patterns := []string{
		"wordpress.{0,100}wp-content",
		"(?:foo|bar)",
		"<div[^>]+data-pjax-container",
		"(?:foo|[0-9]+)", // 字符类分支：两条路径均不能排除
	}
	rules := make([]Rule, 0, len(patterns))
	for i, pattern := range patterns {
		rules = append(rules, Rule{ID: fmt.Sprintf("r%d", i), Matchers: []Matcher{{Type: "regex", Part: "body", Regex: []string{pattern}}}})
	}
	ix := buildBodyWordIndex(rules)
	if ix == nil {
		t.Fatal("regex literal 应构建 body AC 索引")
	}
	for _, text := range []string{
		"中文页面 wordpress /wp-content/",
		"<div class=x data-pjax-container>",
		"nothing relevant",
	} {
		lower := strings.ToLower(text)
		hits := ix.scan(lower)
		lookup := func(lit string) bool { return hits[lit] }
		for _, pattern := range patterns {
			want := regexCanSkip(pattern, lower, false, nil)
			got := regexCanSkip(pattern, lower, false, lookup)
			if got != want {
				t.Errorf("pattern=%q text=%q indexed skip=%v, Contains skip=%v", pattern, text, got, want)
			}
		}
	}
}

// 中文页 foldSensitive=false → 预筛照常可用（不会因含中文被全禁）
func TestRegexCanSkipChinese(t *testing.T) {
	// 中文页不含 wordpress → 应跳过（字面量不在）
	if !regexCanSkip("wordpress", strings.ToLower("这是一个中文页面，没有技术签名"), false, nil) {
		t.Error("中文页不含 wordpress，预筛应跳过")
	}
	// 中文页含 wordpress → 不应跳过
	if regexCanSkip("wordpress", strings.ToLower("这是一个中文页面 wordpress 技术签名"), false, nil) {
		t.Error("中文页含 wordpress，不应跳过")
	}
}

// foldSensitive 页的强断言：不跳过，跑原正则 → 真实匹配一定保留（零误跳）。
func TestRegexCanSkipFoldSensitiveNoFalseNegative(t *testing.T) {
	patterns := []string{"s", "k", "wordpress", "yabbforum"}
	texts := []string{
		"hello ſt wordpress", // 含 ſ + 含 wordpress
		"Kelvin sign",        // 含 K
		"中文 woſdpress 页面",
	}
	for _, p := range patterns {
		re, err := compileRegex(p)
		if err != nil {
			t.Logf("跳过 %q: %v", p, err)
			continue
		}
		for _, txt := range texts {
			if regexCanSkip(p, txt, true, nil) && re.MatchString(txt) {
				t.Errorf("FALSE NEGATIVE: regexCanSkip(%q, %q, true)=true 但正则实际命中！", p, txt)
			}
		}
	}
}

// 可跳过时，真实正则匹配必须为 false（零 false negative 的强断言）
func TestRegexCanSkipNoFalseNegative(t *testing.T) {
	patterns := []string{
		"(?:foo|[0-9]+)",
		"<div[^>]+data-pjax-container",
		"wordpress.{0,100}wp-content",
		"(wordpress|joomla)",
		"foo(bar)?",
		"foo.*bar",
		"Powered by <a href=\"[^>]+yabbforum",
		"<!--[^>]*(?:InstanceBeginEditable|Dreamweaver)",
		"class=\"[^\"]*(?:uk-container|uk-section)",
	}
	texts := []string{
		"hello 123 wordpress wp-content",
		"class=data-pjax-container data",
		"<div class=x data-pjax-container",
		"powered by yabbforum here",
		"<!-- dreamweaver target -->",
		"<html>uk-container</html>",
	}
	for _, p := range patterns {
		re, err := compileRegex(p)
		if err != nil {
			t.Logf("跳过无法编译的正则 %q: %v", p, err)
			continue
		}
		for _, txt := range texts {
			if regexCanSkip(p, txt, false, nil) && re.MatchString(txt) {
				t.Errorf("FALSE NEGATIVE: regexCanSkip(%q, %q)=true 但正则实际命中！", p, txt)
			}
		}
	}
}
