package engine

// PlannedDomProbe 是浏览器 Host 应采集的 DOM 特征。ID 由 Core 生成，避免 Host
// 重复实现 matcher 使用的哈希协议。
type PlannedDomProbe struct {
	ID    string            `json:"id"`
	Sel   string            `json:"sel"`
	Text  string            `json:"text,omitempty"`
	Attrs map[string]string `json:"attrs,omitempty"`
}

type RequiredProbes struct {
	Paths  []string          `json:"paths"`
	Probes []PlannedDomProbe `json:"probes"`
}

// PlanRequiredProbes 决定规则需要采集 WHAT；Chrome MAIN/DOM 中如何采集仍由 JS Host 负责。
func PlanRequiredProbes(rules []Rule) RequiredProbes {
	paths := make([]string, 0)
	probes := make([]PlannedDomProbe, 0)
	seenPaths := make(map[string]bool)
	seenProbes := make(map[string]bool)
	addDOM := func(probe DomProbe) {
		id := probeID(probe)
		if seenProbes[id] {
			return
		}
		seenProbes[id] = true
		probes = append(probes, PlannedDomProbe{ID: id, Sel: probe.Sel, Text: probe.Text, Attrs: probe.Attrs})
	}
	for _, rule := range rules {
		for _, matcher := range rule.Matchers {
			switch matcher.Type {
			case "js":
				for _, probe := range matcher.Js {
					if probe.Path != "" && !seenPaths[probe.Path] {
						seenPaths[probe.Path] = true
						paths = append(paths, probe.Path)
					}
				}
			case "dom":
				for _, selector := range matcher.Words {
					addDOM(DomProbe{Sel: selector})
				}
				for _, probe := range matcher.Dom {
					addDOM(probe)
				}
			}
		}
	}
	return RequiredProbes{Paths: paths, Probes: probes}
}
