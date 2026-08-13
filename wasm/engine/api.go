package engine

import (
	"encoding/json"
	"strconv"
)

func Match(rules []Rule, features Features) []Hit {
	hits := make([]Hit, 0)
	c := newMatchCtx(&features) // 各 part 预计算一次，所有规则复用
	rs := rulesetFor(rules)     // body word 自动机 + byName 查找，整包只算一次
	if rs != nil {
		c.attachBodyIndex(rs.idx)
	}
	for _, r := range rules {
		if ok, ev, conf := matchRule(r, c); ok {
			hits = append(hits, Hit{ID: r.ID, Name: r.Name, Evidence: ev, Confidence: conf})
		}
	}
	if rs == nil {
		return hits
	}
	if rs.hasImplies {
		hits = applyImplies(hits, rs.byName)
	}
	if rs.hasExcludes {
		hits = applyExcludes(hits, rs.byName)
	}
	return hits
}

func Mmh3Sum32(data string) int32 {
	return mmh3Sum32(data)
}

func ExtractFeatures(html string) Extracted {
	return extractFeatures(html)
}

func NormalizeDocs(docs []json.RawMessage) []Rule {
	rules := make([]Rule, 0)
	for _, d := range docs {
		rules = append(rules, normalizeDoc(d)...)
	}
	return rules
}

func HashLookup(hash int32, custom map[string]string) string {
	if name := custom[strconv.Itoa(int(hash))]; name != "" {
		return name
	}
	return builtinHashDB[hash]
}

func ConvertWappalyzerJSON(techJSON string) ([]Rule, error) {
	var techs map[string]wappTech
	if err := json.Unmarshal([]byte(techJSON), &techs); err != nil {
		return nil, err
	}
	rules := make([]Rule, 0, len(techs))
	for name, t := range techs {
		if r := convertWappTech(name, t); r != nil {
			rules = append(rules, *r)
		}
	}
	return rules, nil
}

func ConvertEHoleJSON(fingerJSON string) ([]Rule, error) {
	return convertEHole(fingerJSON)
}

func DslEvalMany(exprs []string, features Features) ([]bool, []string) {
	results := make([]bool, 0, len(exprs))
	errs := make([]string, 0, len(exprs))
	c := newMatchCtx(&features)
	for _, e := range exprs {
		ok, err := dslEval(e, c)
		results = append(results, ok)
		if err != nil {
			errs = append(errs, err.Error())
		} else {
			errs = append(errs, "")
		}
	}
	return results, errs
}

func CrawlStart(seed string, maxPages int) error {
	return crawlStart(seed, maxPages)
}

func CrawlBatch(n int) ([]string, bool, error) {
	if crawlState == nil {
		return nil, false, errCrawlerNotStarted
	}
	urls, done := crawlState.batch(n)
	return urls, done, nil
}

func CrawlFeed(pageURL string, links []string) (int, error) {
	if crawlState == nil {
		return 0, errCrawlerNotStarted
	}
	return crawlState.feed(pageURL, links), nil
}

func CrawlStatus() (visited int, queued int, err error) {
	if crawlState == nil {
		return 0, 0, errCrawlerNotStarted
	}
	return crawlState.visited, len(crawlState.queue), nil
}
