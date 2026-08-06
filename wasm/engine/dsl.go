// dsl 表达式求值：contains(body, "x") && status == 200 这种。
// 手写递归下降，不引第三方库。
//
// 标识符: body / title / url / header / raw / meta / script / status / favicon_hash
// 函数:   contains(a, "子串") / matches(a, "正则")
// 运算符: && || ! == != 和括号
package engine

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// --- 词法 ---

type dslToken struct {
	typ string // ident / string / number / op
	val string
}

func dslLex(s string) ([]dslToken, error) {
	var toks []dslToken
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')' || c == ',':
			toks = append(toks, dslToken{"op", string(c)})
			i++
		case c == '!':
			if i+1 < len(s) && s[i+1] == '=' {
				toks = append(toks, dslToken{"op", "!="})
				i += 2
			} else {
				toks = append(toks, dslToken{"op", "!"})
				i++
			}
		case c == '&' || c == '|':
			if i+1 < len(s) && s[i+1] == c {
				toks = append(toks, dslToken{"op", string([]byte{c, c})})
				i += 2
			} else {
				return nil, fmt.Errorf("第 %d 位：单个 %q 不支持，用 %c%c", i+1, c, c, c)
			}
		case c == '=':
			if i+1 < len(s) && s[i+1] == '=' {
				toks = append(toks, dslToken{"op", "=="})
				i += 2
			} else {
				return nil, fmt.Errorf("第 %d 位：赋值 = 没意义，比较用 ==", i+1)
			}
		case c == '"' || c == '\'':
			var sb strings.Builder
			j := i + 1
			for j < len(s) && s[j] != c {
				if s[j] == '\\' && j+1 < len(s) {
					j++
					switch s[j] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case '"', '\'', '\\':
						sb.WriteByte(s[j]) // 引号和反斜杠本身
					default:
						// \d \w 这种正则转义原样保留，别把反斜杠吃了
						sb.WriteByte('\\')
						sb.WriteByte(s[j])
					}
				} else {
					sb.WriteByte(s[j])
				}
				j++
			}
			if j >= len(s) {
				return nil, fmt.Errorf("第 %d 位：字符串没闭合", i+1)
			}
			toks = append(toks, dslToken{"string", sb.String()})
			i = j + 1
		case c >= '0' && c <= '9' || (c == '-' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9'):
			j := i + 1
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			toks = append(toks, dslToken{"number", s[i:j]})
			i = j
		case unicode.IsLetter(rune(c)) || c == '_':
			j := i + 1
			for j < len(s) && (unicode.IsLetter(rune(s[j])) || unicode.IsDigit(rune(s[j])) || s[j] == '_') {
				j++
			}
			toks = append(toks, dslToken{"ident", s[i:j]})
			i = j
		default:
			return nil, fmt.Errorf("第 %d 位：不认识的字符 %q", i+1, c)
		}
	}
	return toks, nil
}

// --- 语法（AST） ---

type dslNode struct {
	op   string // or / and / not / eq / ne / call / ident / string / number
	name string // ident 名、函数名、字面量
	args []*dslNode
}

type dslParser struct {
	toks []dslToken
	pos  int
}

func (p *dslParser) peek() *dslToken {
	if p.pos < len(p.toks) {
		return &p.toks[p.pos]
	}
	return nil
}

func (p *dslParser) eat() *dslToken {
	t := p.peek()
	p.pos++
	return t
}

func (p *dslParser) expectOp(op string) error {
	t := p.peek()
	if t == nil || t.typ != "op" || t.val != op {
		return fmt.Errorf("第 %d 个 token 附近：想要 %q", p.pos+1, op)
	}
	p.pos++
	return nil
}

func dslParse(s string) (*dslNode, error) {
	toks, err := dslLex(s)
	if err != nil {
		return nil, err
	}
	if len(toks) == 0 {
		return nil, fmt.Errorf("空表达式")
	}
	p := &dslParser{toks: toks}
	n, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.pos != len(toks) {
		return nil, fmt.Errorf("第 %d 个 token 附近：表达式后面还有多余内容", p.pos+1)
	}
	return n, nil
}

func (p *dslParser) parseOr() (*dslNode, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for t := p.peek(); t != nil && t.typ == "op" && t.val == "||"; t = p.peek() {
		p.eat()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = &dslNode{op: "or", args: []*dslNode{left, right}}
	}
	return left, nil
}

func (p *dslParser) parseAnd() (*dslNode, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for t := p.peek(); t != nil && t.typ == "op" && t.val == "&&"; t = p.peek() {
		p.eat()
		right, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		left = &dslNode{op: "and", args: []*dslNode{left, right}}
	}
	return left, nil
}

func (p *dslParser) parseUnary() (*dslNode, error) {
	if t := p.peek(); t != nil && t.typ == "op" && t.val == "!" {
		p.eat()
		n, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return &dslNode{op: "not", args: []*dslNode{n}}, nil
	}
	return p.parseCmp()
}

func (p *dslParser) parseCmp() (*dslNode, error) {
	left, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t != nil && t.typ == "op" && (t.val == "==" || t.val == "!=") {
		op := "eq"
		if t.val == "!=" {
			op = "ne"
		}
		p.eat()
		right, err := p.parsePrimary()
		if err != nil {
			return nil, err
		}
		return &dslNode{op: op, args: []*dslNode{left, right}}, nil
	}
	return left, nil
}

func (p *dslParser) parsePrimary() (*dslNode, error) {
	t := p.eat()
	if t == nil {
		return nil, fmt.Errorf("表达式突然结束了")
	}
	switch t.typ {
	case "string":
		return &dslNode{op: "string", name: t.val}, nil
	case "number":
		return &dslNode{op: "number", name: t.val}, nil
	case "ident":
		// 函数调用？
		if nt := p.peek(); nt != nil && nt.typ == "op" && nt.val == "(" {
			p.eat()
			n := &dslNode{op: "call", name: t.val}
			if nt := p.peek(); nt != nil && nt.typ == "op" && nt.val == ")" {
				p.eat()
				return n, nil
			}
			for {
				arg, err := p.parseOr()
				if err != nil {
					return nil, err
				}
				n.args = append(n.args, arg)
				nt := p.peek()
				if nt != nil && nt.typ == "op" && nt.val == "," {
					p.eat()
					continue
				}
				break
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			return n, nil
		}
		return &dslNode{op: "ident", name: t.val}, nil
	case "op":
		if t.val == "(" {
			n, err := p.parseOr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			return n, nil
		}
	}
	return nil, fmt.Errorf("第 %d 个 token 附近：%q 不该出现在这", p.pos, t.val)
}

// --- 求值 ---

// 值就三种：string / int64 / bool，直接用 any 装

func dslBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case int64:
		return x != 0
	}
	return false
}

func dslStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case int64:
		return strconv.FormatInt(x, 10)
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}

func dslEq(a, b any) bool {
	// 两边都是数字就按数字比，否则按字符串比
	ai, aok := a.(int64)
	bi, bok := b.(int64)
	if aok && bok {
		return ai == bi
	}
	if aok != bok {
		// 一边数字一边字符串，转字符串比（status == "200" 也能过）
		return dslStr(a) == dslStr(b)
	}
	return dslStr(a) == dslStr(b)
}

func dslEvalNode(n *dslNode, f *Features) (any, error) {
	switch n.op {
	case "string":
		return n.name, nil
	case "number":
		v, err := strconv.ParseInt(n.name, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("数字 %q 解析失败", n.name)
		}
		return v, nil
	case "ident":
		switch n.name {
		case "true":
			return true, nil // nuclei 模板里常见 dsl: ["true"] 这种兜底
		case "false":
			return false, nil
		case "body":
			return f.Body, nil
		case "title":
			return f.Title, nil
		case "url":
			return f.URL, nil
		case "header":
			return headerString(f), nil
		case "raw":
			return headerString(f) + f.Body, nil
		case "meta":
			var b strings.Builder
			for k, v := range f.Meta {
				fmt.Fprintf(&b, "%s: %s\n", k, v)
			}
			return b.String(), nil
		case "script":
			return strings.Join(f.Scripts, "\n"), nil
		case "status", "status_code":
			return int64(f.Status), nil
		case "favicon_hash":
			return int64(f.FaviconHash), nil
		}
		return nil, fmt.Errorf("未知标识符 %q（支持 body/title/url/header/raw/meta/script/status/favicon_hash）", n.name)
	case "not":
		v, err := dslEvalNode(n.args[0], f)
		return !dslBool(v), err
	case "and":
		for _, a := range n.args {
			v, err := dslEvalNode(a, f)
			if err != nil {
				return nil, err
			}
			if !dslBool(v) {
				return false, nil // 短路
			}
		}
		return true, nil
	case "or":
		for _, a := range n.args {
			v, err := dslEvalNode(a, f)
			if err != nil {
				return nil, err
			}
			if dslBool(v) {
				return true, nil
			}
		}
		return false, nil
	case "eq", "ne":
		a, err := dslEvalNode(n.args[0], f)
		if err != nil {
			return nil, err
		}
		b, err := dslEvalNode(n.args[1], f)
		if err != nil {
			return nil, err
		}
		eq := dslEq(a, b)
		if n.op == "ne" {
			return !eq, nil
		}
		return eq, nil
	case "call":
		if len(n.args) != 2 {
			return nil, fmt.Errorf("%s 要两个参数", n.name)
		}
		a, err := dslEvalNode(n.args[0], f)
		if err != nil {
			return nil, err
		}
		b, err := dslEvalNode(n.args[1], f)
		if err != nil {
			return nil, err
		}
		switch n.name {
		case "contains":
			return strings.Contains(dslStr(a), dslStr(b)), nil
		case "matches":
			re, err := compileRegex(dslStr(b))
			if err != nil {
				return nil, fmt.Errorf("matches 的正则写错了: %s", err)
			}
			return re.MatchString(dslStr(a)), nil
		}
		return nil, fmt.Errorf("未知函数 %q（支持 contains/matches）", n.name)
	}
	return nil, fmt.Errorf("坏掉的 AST 节点 %q", n.op)
}

// dslEval 评估一条表达式，语法/求值错误也算不匹配
func dslEval(expr string, f *Features) (bool, error) {
	ast, err := dslParse(expr)
	if err != nil {
		return false, err
	}
	v, err := dslEvalNode(ast, f)
	if err != nil {
		return false, err
	}
	return dslBool(v), nil
}
