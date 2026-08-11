package engine

import (
	"strings"
	"testing"
)

func dslFeatures() *Features {
	return &Features{
		URL:         "https://www.example.com/wp-admin/",
		Title:       "My WP Blog",
		Body:        "<html>WordPress content with wp-content dir</html>",
		Status:      200,
		Headers:     map[string]string{"server": "nginx"},
		FaviconHashes: []int32{-12345},
		Meta:        map[string]string{"generator": "WordPress 6.5"},
		Scripts:     []string{"/wp-content/theme.js", "/assets/app.js"},
	}
}

// --- 词法 ---

func TestDslLexBasic(t *testing.T) {
	toks, err := dslLex(`contains(body, "a b") && status == 200`)
	if err != nil {
		t.Fatalf("lex 出错: %v", err)
	}
	want := []struct{ typ, val string }{
		{"ident", "contains"}, {"op", "("}, {"ident", "body"}, {"op", ","},
		{"string", "a b"}, {"op", ")"}, {"op", "&&"}, {"ident", "status"},
		{"op", "=="}, {"number", "200"},
	}
	if len(toks) != len(want) {
		t.Fatalf("token 数不对: got %d want %d, %+v", len(toks), len(want), toks)
	}
	for i, w := range want {
		if toks[i].typ != w.typ || toks[i].val != w.val {
			t.Errorf("token[%d] = %+v, want %+v", i, toks[i], w)
		}
	}
}

func TestDslLexEscape(t *testing.T) {
	// \d \w 这类正则转义要原样保留
	toks, err := dslLex(`matches(body, "\d+")`)
	if err != nil {
		t.Fatalf("lex 出错: %v", err)
	}
	if toks[4].typ != "string" || toks[4].val != `\d+` {
		t.Errorf("正则转义应原样保留: %+v", toks[4])
	}
	// \n 转成换行
	toks, _ = dslLex(`"a\nb"`)
	if toks[0].val != "a\nb" {
		t.Errorf("\\n 应转成换行: %q", toks[0].val)
	}
}

func TestDslLexErrors(t *testing.T) {
	cases := []struct{ in, wantSub string }{
		{`contains(body, "abc`, "没闭合"},
		{`a & b`, "单个"},
		{`a = b`, "=="},
		{`a @ b`, "不认识"},
	}
	for _, c := range cases {
		_, err := dslLex(c.in)
		if err == nil || !strings.Contains(err.Error(), c.wantSub) {
			t.Errorf("lex(%q) 应报 %q，实际 %v", c.in, c.wantSub, err)
		}
	}
}

// --- 求值 ---

func TestDslEvalCore(t *testing.T) {
	f := dslFeatures()
	cases := []struct {
		expr string
		want bool
	}{
		{`contains(body, "WordPress")`, true},
		{`contains(body, "不存在")`, false},
		{`contains(title, "WP")`, true},
		{`contains(url, "wp-admin")`, true},
		{`contains(header, "server: nginx")`, true},
		{`contains(raw, "server: nginx") && contains(raw, "WordPress")`, true},
		{`contains(meta, "generator: WordPress 6.5")`, true}, // dsl 的 contains 大小写敏感
		{`contains(script, "theme.js")`, true},
		{`status == 200`, true},
		{`status == "200"`, true}, // 一边数字一边字符串也能比
		{`status != 404`, true},
		{`favicon_hash == -12345`, true},
		{`true`, true},
		{`false`, false},
		{`!false`, true},
		{`matches(body, "wp-\\w+")`, true},
		{`contains(body, "WordPress") && status == 200`, true},
		{`contains(body, "WordPress") && status == 500`, false},
		{`contains(body, "WordPress") || status == 500`, true},
		{`contains(body, "x") || contains(title, "x")`, false},
	}
	for _, c := range cases {
		got, err := dslEval(c.expr, newMatchCtx(f))
		if err != nil {
			t.Errorf("dslEval(%q) 出错: %v", c.expr, err)
			continue
		}
		if got != c.want {
			t.Errorf("dslEval(%q) = %v, want %v", c.expr, got, c.want)
		}
	}
}

func TestDslEvalPrecedence(t *testing.T) {
	f := dslFeatures()
	// && 优先于 ||：a || (b && c)
	got, err := dslEval(`false || true && true`, newMatchCtx(f))
	if err != nil || !got {
		t.Errorf("优先级 && > || 应求值为 true, got=%v err=%v", got, err)
	}
	// 括号改变
	got, _ = dslEval(`(false || true) && false`, newMatchCtx(f))
	if got {
		t.Error("带括号表达式应求值为 false")
	}
}

func TestDslEvalShortCircuit(t *testing.T) {
	f := dslFeatures()
	// 左边 false 时右边不应求值；未知函数放右边不应报错
	got, err := dslEval(`false && notafunc(body, "x")`, newMatchCtx(f))
	if err != nil || got {
		t.Errorf("&& 短路应返回 false 不报错, got=%v err=%v", got, err)
	}
	// 左边 true 时右边短路
	got, err = dslEval(`true || notafunc(body, "x")`, newMatchCtx(f))
	if err != nil || !got {
		t.Errorf("|| 短路应返回 true 不报错, got=%v err=%v", got, err)
	}
}

func TestDslEvalErrors(t *testing.T) {
	f := dslFeatures()
	cases := []struct{ expr, wantSub string }{
		{`unknown_var`, "未知标识符"},
		{`notafunc(body, "x")`, "未知函数"},
		{`contains(body)`, "要两个参数"},
		{``, "空表达式"},
		{`contains(body, "a") extra`, "多余内容"},
		{`contains(body, "a") &&`, "表达式突然结束"},
	}
	for _, c := range cases {
		_, err := dslEval(c.expr, newMatchCtx(f))
		if err == nil || !strings.Contains(err.Error(), c.wantSub) {
			t.Errorf("dslEval(%q) 应报 %q，实际 %v", c.expr, c.wantSub, err)
		}
	}
}

func TestDslEqMixed(t *testing.T) {
	if !dslEq(int64(200), "200") {
		t.Error("数字与字符串应可比")
	}
	if dslEq(int64(200), "201") {
		t.Error("数字与字符串不等应判不等")
	}
	if !dslEq("abc", "abc") {
		t.Error("字符串相等应判等")
	}
	if dslEq(int64(1), int64(2)) {
		t.Error("数字不等应判不等")
	}
}
