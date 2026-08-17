// 规则集体检：不跑真实匹配，只按正则 AST 结构把每条 pattern 分成
// 「具备预筛条件 / 非 ASCII 阻断 / 无预筛锚点」三类，让用户知道一批规则
// 从结构上是否存在安全的字面量预筛机会。分类逻辑与匹配时的预筛判定同构，
// 不做任何新算法——只是把 regexNodeExcluded 的「能跳过吗」从依赖文本变成
// 结构上的「存在某个文本能让它被跳过」。
package engine

import (
	"fmt"
	"regexp/syntax"
	"sort"
)

// BroadPattern 是无预筛锚点的正则明细：字面量预筛永远无法证明它不匹配。
type BroadPattern struct {
	RuleID   string `json:"ruleId"`
	RuleName string `json:"ruleName"`
	Pattern  string `json:"pattern"`
}

// InvalidPattern 是无法被生产正则后端解析的规则明细，供用户定位并修复。
type InvalidPattern struct {
	RuleID   string `json:"ruleId"`
	RuleName string `json:"ruleName"`
	Pattern  string `json:"pattern"`
	Reason   string `json:"reason"`
}

// PrefilterAnchor 是可预筛正则的结构评分。交替分支取最弱代表锚点，串联结构
// 取最强必需锚点；Length 只计算 ASCII 字母/数字，避免 .js 之类标点虚增强度。
type PrefilterAnchor struct {
	RuleID   string `json:"ruleId"`
	RuleName string `json:"ruleName"`
	Pattern  string `json:"pattern"`
	Anchor   string `json:"anchor"`
	Length   int    `json:"length"`
}

// RegexHealth 是单个规则集的 regex 体检结果。
//   - Skippable：含必需 ASCII 字面量；仅表示页面缺少该字面量时存在安全跳过机会
//   - NonASCII：必需字面量含非 ASCII，SimpleFold 护栏下字面量预筛不参与
//   - Broad：无必需字面量（纯字符类/锚点/可选结构），AST 证明不出跳过条件
//   - Invalid：解析失败（导入时本就会被 compilable() 丢弃）
//
// 这是结构分类，不预测某个页面的实际跳过数；实际结果取决于页面文本。
type RegexHealth struct {
	TotalPatterns   int               `json:"totalPatterns"`
	Skippable       int               `json:"skippable"`
	NonASCII        int               `json:"nonAscii"`
	Broad           int               `json:"broad"`
	Invalid         int               `json:"invalid"`
	BroadPatterns   []BroadPattern    `json:"broadPatterns"`
	InvalidPatterns []InvalidPattern  `json:"invalidPatterns"`
	ShortAnchors    []PrefilterAnchor `json:"shortAnchors"`
	LongAnchors     []PrefilterAnchor `json:"longAnchors"`
}

// 问题明细只带前 maxHealthEntries 条去重项，避免超大规则集把体检结果撑爆。
const maxHealthEntries = 50
const maxAnchorEntries = 20

func ClassifyRegexes(rules []Rule) RegexHealth {
	var h RegexHealth
	seenBroad := make(map[string]bool)
	seenInvalid := make(map[string]bool)
	anchors := make([]PrefilterAnchor, 0)
	recordInvalid := func(rule *Rule, pattern string, err error) {
		h.Invalid++
		if len(h.InvalidPatterns) >= maxHealthEntries || seenInvalid[pattern] {
			return
		}
		seenInvalid[pattern] = true
		h.InvalidPatterns = append(h.InvalidPatterns, InvalidPattern{
			RuleID: rule.ID, RuleName: rule.Name, Pattern: pattern, Reason: err.Error(),
		})
	}
	for i := range rules {
		r := &rules[i]
		for j := range r.Matchers {
			m := &r.Matchers[j]
			if m.Type != "regex" {
				continue
			}
			for _, p := range m.Regex {
				h.TotalPatterns++
				tamed := tamePattern(p)
				if depthErr := validateRegexDepth(tamed); depthErr != nil {
					recordInvalid(r, p, depthErr)
					continue
				}
				n, parseErr := syntax.Parse(tamed, syntax.Perl)
				if parseErr != nil {
					recordInvalid(r, p, fmt.Errorf("正则解析失败: %w", parseErr))
					continue
				}
				if anchor, ok := prefilterAnchor(n); ok {
					h.Skippable++
					anchors = append(anchors, PrefilterAnchor{
						RuleID: r.ID, RuleName: r.Name, Pattern: p, Anchor: anchor, Length: anchorStrength(anchor),
					})
					continue
				}
				// 无法建立 ASCII 预筛条件：区分「非 ascii literal 阻断」还是「无锚点」。
				// 只要 pattern 里出现非 ascii literal（含可选位置的），SimpleFold
				// 护栏就让它跳不过，归入 non-ascii；否则是结构上无必需字面量，归入泛化。
				hasNonASCII := false
				for _, lit := range regexLiterals(p) {
					if !isASCIIStr(lit) {
						hasNonASCII = true
						break
					}
				}
				if hasNonASCII {
					h.NonASCII++
				} else {
					h.Broad++
					if len(h.BroadPatterns) < maxHealthEntries && !seenBroad[p] {
						seenBroad[p] = true
						h.BroadPatterns = append(h.BroadPatterns, BroadPattern{
							RuleID: r.ID, RuleName: r.Name, Pattern: p,
						})
					}
				}
			}
		}
	}
	setAnchorRankings(&h, anchors)
	return h
}

func setAnchorRankings(health *RegexHealth, anchors []PrefilterAnchor) {
	short := append([]PrefilterAnchor(nil), anchors...)
	sort.SliceStable(short, func(i, j int) bool {
		if short[i].Length != short[j].Length {
			return short[i].Length < short[j].Length
		}
		return short[i].Pattern < short[j].Pattern
	})
	long := append([]PrefilterAnchor(nil), short...)
	sort.SliceStable(long, func(i, j int) bool {
		if long[i].Length != long[j].Length {
			return long[i].Length > long[j].Length
		}
		return long[i].Pattern < long[j].Pattern
	})
	if len(short) > maxAnchorEntries {
		short = short[:maxAnchorEntries]
	}
	if len(long) > maxAnchorEntries {
		long = long[:maxAnchorEntries]
	}
	health.ShortAnchors = short
	health.LongAnchors = long
}

// canSkipEver 问结构上的可跳过性：是否存在某个文本，让匹配路径的预筛
// 判定能证明这条正则必然不匹配。不依赖具体文本，递归镜像 regexNodeExcluded
// 的判定结构，只是把 Literal 的「在不在文本」换成「是否 ASCII」（ASCII 才可能被缺席排除）。
//   - Literal：仅 ASCII 字面量可被「缺席」排除（非 ASCII 受 SimpleFold 护栏，永不排除）
//   - Concat：任一子节点可排除 → 整体可排除（序列要求全部匹配）
//   - Alternate：全部分支可排除 → 才可排除
//   - Star/Quest/CharClass/锚点/Repeat(min=0)：永不
func canSkipEver(n *syntax.Regexp) bool {
	_, ok := prefilterAnchor(n)
	return ok
}

func anchorStrength(anchor string) int {
	strength := 0
	for i := 0; i < len(anchor); i++ {
		c := anchor[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			strength++
		}
	}
	return strength
}

// preferAnchor 在有效字符数相同时优先标点更少、展示更直观的锚点。
func preferAnchor(candidate, current string) bool {
	candidateStrength, currentStrength := anchorStrength(candidate), anchorStrength(current)
	if candidateStrength != currentStrength {
		return candidateStrength > currentStrength
	}
	candidatePunctuation := len(candidate) - candidateStrength
	currentPunctuation := len(current) - currentStrength
	if candidatePunctuation != currentPunctuation {
		return candidatePunctuation < currentPunctuation
	}
	return candidate < current
}

// prefilterAnchor 返回能支撑结构预筛的代表 ASCII 锚点：
//   - Concat 任一必需项缺席即可排除，取有效字符最多的项作为最强锚点
//   - Alternate 必须排除全部分支，取有效字符最少的分支锚点表示最弱环节
//   - 可选结构不提供锚点
func prefilterAnchor(n *syntax.Regexp) (string, bool) {
	switch n.Op {
	case syntax.OpLiteral:
		literal := string(n.Rune)
		return literal, literal != "" && isASCIIStr(literal)
	case syntax.OpConcat:
		best := ""
		for _, s := range n.Sub {
			if anchor, ok := prefilterAnchor(s); ok && (best == "" || preferAnchor(anchor, best)) {
				best = anchor
			}
		}
		return best, best != ""
	case syntax.OpAlternate:
		weakest := ""
		for _, s := range n.Sub {
			anchor, ok := prefilterAnchor(s)
			if !ok {
				return "", false
			}
			anchorScore, weakestScore := anchorStrength(anchor), anchorStrength(weakest)
			if weakest == "" || anchorScore < weakestScore || (anchorScore == weakestScore && preferAnchor(anchor, weakest)) {
				weakest = anchor
			}
		}
		return weakest, weakest != ""
	case syntax.OpCapture, syntax.OpPlus:
		if len(n.Sub) == 1 {
			return prefilterAnchor(n.Sub[0])
		}
		return "", false
	case syntax.OpRepeat:
		if n.Min == 0 {
			return "", false // 可匹配空，永不排除
		}
		if len(n.Sub) == 1 {
			return prefilterAnchor(n.Sub[0])
		}
		return "", false
	default:
		return "", false
	}
}
