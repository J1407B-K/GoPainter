// part=body 的 word matcher 专用索引：Aho-Corasick 自动机。
// 规则几千条时逐词 strings.Contains 是 O(词数×body)，TinyGo wasm 里要几百毫秒；
// 这里把 lowerBody 只扫一遍，一次拿到所有出现的词典词，词匹配退化成 map 查询。
//
// 子树用按字节排序的孩子数组存，查找走二分——孩子度数通常 ≤26，
// 比 map 省内存，也绕开 TinyGo map 慢的问题。

package engine

import "strings"

type acChild struct {
	b byte
	n int32
}

type acNode struct {
	fail    int32
	kids    []acChild
	output  []int32 // 以本节点结尾的词典词下标
	outLink int32   // fail 链上最近的带 output 节点，扫描时顺着收尾部命中的词
}

type bodyWordIndex struct {
	words []string
	nodes []acNode
	root  int32
}

// ruleset 是整包规则的一次性预计算结果：
//   - idx：body word 自动机（扫一次 lowerBody 拿全部命中词）
//   - byName：小写 name/id -> *Rule，applyImplies/applyExcludes 复用。
//     之前这两个函数每次调用都从零重建 8000 条规则的全量 map，
//     O(规则数) 的分配 churn 正是大规则集下超线性变慢的主因。
type ruleset struct {
	idx    *bodyWordIndex
	byName map[string]*Rule
}

// 单槽缓存：同一规则切片（bridge 里解析后复用）只预计算一次。
// 规则一变必然新切片 -> 新首元素地址 -> 自动重建，无需显式失效。
var (
	rsKey *Rule
	rsVal *ruleset
)

func rulesetFor(rules []Rule) *ruleset {
	if len(rules) == 0 {
		return nil
	}
	key := &rules[0]
	if key == rsKey {
		return rsVal
	}
	// 规则集变了：body 词自动机、byName 全部重建，正则编译缓存也一起作废，
	// 不然上一批规则的正则一直占着 WASM 内存
	ClearRegexCache()
	rsKey = key
	rsVal = &ruleset{
		idx:    buildBodyWordIndex(rules),
		byName: buildByName(rules),
	}
	return rsVal
}

func buildByName(rules []Rule) map[string]*Rule {
	m := make(map[string]*Rule, len(rules)*2)
	for i := range rules {
		m[strings.ToLower(rules[i].Name)] = &rules[i]
		m[strings.ToLower(rules[i].ID)] = &rules[i]
	}
	return m
}

// 收集规则里 part=body（含未写 part 默认 body）的 word matcher 词，去重、小写、丢空串
func bodyWords(rules []Rule) []string {
	seen := make(map[string]struct{})
	var out []string
	for i := range rules {
		for j := range rules[i].Matchers {
			m := &rules[i].Matchers[j]
			if m.Type != "word" || (m.Part != "" && m.Part != "body") {
				continue
			}
			for _, w := range m.Words {
				lw := strings.ToLower(w)
				if lw == "" {
					continue
				}
				if _, ok := seen[lw]; ok {
					continue
				}
				seen[lw] = struct{}{}
				out = append(out, lw)
			}
		}
	}
	return out
}

func buildBodyWordIndex(rules []Rule) *bodyWordIndex {
	words := bodyWords(rules)
	if len(words) == 0 {
		return nil
	}
	ix := &bodyWordIndex{words: words}
	ix.nodes = []acNode{{fail: -1, outLink: -1}}
	ix.root = 0
	for wi, w := range words {
		cur := ix.root
		for k := 0; k < len(w); k++ {
			if n := ix.child(cur, w[k]); n >= 0 {
				cur = n
				continue
			}
			ix.nodes = append(ix.nodes, acNode{fail: -1, outLink: -1})
			n := int32(len(ix.nodes) - 1)
			ix.addChild(cur, w[k], n)
			cur = n
		}
		ix.nodes[cur].output = append(ix.nodes[cur].output, int32(wi))
	}
	ix.buildFail()
	return ix
}

// child 二分查找孩子节点，找不到返回 -1
func (ix *bodyWordIndex) child(n int32, c byte) int32 {
	kids := ix.nodes[n].kids
	lo, hi := 0, len(kids)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if kids[mid].b < c {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(kids) && kids[lo].b == c {
		return kids[lo].n
	}
	return -1
}

// addChild 按字节序插入孩子，保持 kids 有序
func (ix *bodyWordIndex) addChild(n int32, c byte, child int32) {
	kids := ix.nodes[n].kids
	i := len(kids)
	for i > 0 && kids[i-1].b > c {
		i--
	}
	kids = append(kids, acChild{})
	copy(kids[i+1:], kids[i:])
	kids[i] = acChild{b: c, n: child}
	ix.nodes[n].kids = kids
}

// buildFail BFS 建 fail 指针和 outLink
func (ix *bodyWordIndex) buildFail() {
	queue := make([]int32, 0, len(ix.nodes))
	for _, k := range ix.nodes[ix.root].kids {
		n := k.n
		ix.nodes[n].fail = ix.root
		queue = append(queue, n)
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		cn := &ix.nodes[cur]
		for _, k := range cn.kids {
			c := k.b
			n := k.n
			f := cn.fail
			for f >= 0 {
				if nx := ix.child(f, c); nx >= 0 {
					ix.nodes[n].fail = nx
					break
				}
				f = ix.nodes[f].fail
			}
			if f < 0 {
				ix.nodes[n].fail = ix.root
			}
			queue = append(queue, n)
		}
		ix.nodes[cur].outLink = ix.outputLinkOf(cn.fail)
	}
}

// outputLinkOf 返回 n（含）在 fail 链上最近的带 output 节点；没有则 -1
func (ix *bodyWordIndex) outputLinkOf(n int32) int32 {
	if n < 0 {
		return -1
	}
	if len(ix.nodes[n].output) > 0 {
		return n
	}
	return ix.nodes[n].outLink
}

// scan 扫一遍 text（lowerBody），返回其中出现的所有词典词（小写原词）
func (ix *bodyWordIndex) scan(text string) map[string]bool {
	hits := make(map[string]bool)
	cur := ix.root
	for i := 0; i < len(text); i++ {
		c := text[i]
		for cur != ix.root {
			if n := ix.child(cur, c); n >= 0 {
				cur = n
				break
			}
			cur = ix.nodes[cur].fail
		}
		if cur == ix.root {
			if n := ix.child(ix.root, c); n >= 0 {
				cur = n
			}
		}
		for _, wi := range ix.nodes[cur].output {
			hits[ix.words[wi]] = true
		}
		for l := ix.nodes[cur].outLink; l >= 0; l = ix.nodes[l].outLink {
			for _, wi := range ix.nodes[l].output {
				hits[ix.words[wi]] = true
			}
		}
	}
	return hits
}
