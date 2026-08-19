# GoPainter

[![CI](https://img.shields.io/github/actions/workflow/status/J1407B-K/GoPainter/ci.yml?branch=master&style=flat-square&label=CI)](https://github.com/J1407B-K/GoPainter/actions/workflows/ci.yml)
[![CodeFactor](https://www.codefactor.io/repository/github/j1407b-k/gopainter/badge)](https://www.codefactor.io/repository/github/j1407b-k/gopainter)
[![Release](https://img.shields.io/github/v/release/J1407B-K/GoPainter?style=flat-square)](https://github.com/J1407B-K/GoPainter/releases/latest)
[![License](https://img.shields.io/github/license/J1407B-K/GoPainter?style=flat-square)](./LICENSE)
![Go WASM](https://img.shields.io/badge/Go-WASM-00ADD8?style=flat-square&logo=go&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)

> **Project goal:** keep GoPainter small, fast, and auditable as it grows. New capabilities should preserve the Go Core / JavaScript Host boundary and improve real maintainability without fragmenting cohesive domain logic for metrics.

**English** | [简体中文](./README_CN.md) · [Example rules](./rules/examples.yaml)

**Browser-native web technology fingerprinting with live, explainable evidence.**

GoPainter detects technologies directly from the browser using HTTP, HTML, DOM,
JavaScript runtime, and favicon signals. It combines a deterministic **Go/WASM + Google RE2**
engine with Wappalyzer, EHole, and nuclei rule sources, site crawling, and an AI Agent
that can research, test, and validate new fingerprints.

GoPainter is built for inspectable results: every hit carries the concrete evidence that
matched, and the Agent proposes rules while the Go Core remains the final validator.

While you browse, GoPainter fingerprints the current site automatically and surfaces hits in real time: the toolbar icon stays gray when nothing matches, and turns colored with a badge showing the hit count when it does.

## Why GoPainter?

- **Deterministic matching** — Go/WASM + Google RE2 with bounded, browser-friendly performance
- **Browser-native evidence** — HTTP, HTML, DOM, live JavaScript runtime, and favicon signals
- **Existing rule ecosystems** — import and convert Wappalyzer, EHole, and nuclei sources
- **Explainable results** — each hit includes the keyword, regex, status, or hash that matched
- **Agent-assisted research** — inspect → search → test → validate, with auditable tool traces

## Features

- **YAML fingerprint rules** — word / regex / status / icon_hash / dsl / js / dom matchers, with `and`/`or` combinations and `negative` inversion
- **Rule health inspection** — checks regex validity and structural prefilter opportunities, with short/long anchor rankings and actionable invalid/no-anchor details
- **Composable rule sets** — keep imports separated, enable any combination for matching, and review a YAML diff before replacing a conflicting rule
- **nuclei template compatibility** — imports automatically extract the HTTP matchers subset, so the large community template library is directly usable
- **Third-party rule sources** — refresh Wappalyzer / EHole / nuclei-templates manually or on a daily/weekly schedule, with bounded downloads, atomic per-source rule-set replacement, update summaries, and one-version rollback; source data is fetched by the user and is never bundled or redistributed by GoPainter
- **Performance-focused runtime** — Go WASM + Google RE2 matching, bounded page/UI data paths, and indexed Agent rule search
- **Hit evidence** — each fingerprint carries the specific keyword, regex, status code, or hash that matched
- **Icon state indicator** — gray = no match, colored + badge = N matches
- **Agent-assisted fingerprint research** — a bounded, streaming tool loop researches the current tab or a rule, shows its auditable tool trace, and returns an evidence-based task report
- **Scan history & reports** — choose a 50–5,000 entry rolling window and export it as JSON/CSV

## Current release: v0.6.9

v0.6.9 adds user-initiated third-party rule-source updates for Wappalyzer, EHole, and nuclei-templates: bounded streaming downloads, separate source rule sets, optional daily/weekly checks (off by default), change summaries, and one-version rollback. Third-party rule data is fetched by the user and remains unbundled and undistributed by GoPainter. See the resource measurements and previous versions in the [performance record](BENCHMARK.md).

## Quick start

### 1. Install Go

Building only needs the standard Go toolchain (`make build` compiles the production Go WASM + RE2 engine).

- macOS: `brew install go`
- Windows / Linux: see the [Go download page](https://go.dev/dl/)

### 2. Build the WASM engine

**macOS / Linux**
```bash
make build        # produces extension/wasm/matcher.wasm + wasm_exec.js
make icons        # regenerate icons (optional; the repo ships them)
```

`make build` is the only supported production build: standard Go WASM with embedded Google RE2. The Makefile still contains legacy experimental targets for TinyGo and the standard-library regex backend, but they are not maintained or supported release targets.

**Windows (PowerShell)**
```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

### 3. Install into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this repo's **`extension/`** directory

> Edge and Brave (Chromium-based) work the same way (`edge://extensions`).

### 4. Import rules & use

1. Click the GoPainter toolbar icon → "Rules" → import `rules/examples.yaml` (or any nuclei template)
2. Visit a site — the icon turns colored on a match; click it to inspect details and evidence
3. Click **Agent** to identify the current tab, research a fingerprint, or prepare an optimization suggestion. Automatic read-only tools may run concurrently up to five; permission-gated tools remain serialized and ask before use. `fetch_url` accepts HTTPS only, and a remembered grant is scoped to the approved origin. The visible trace streams as work completes, and no rule is written automatically.

### 5. Crawl a site (Side Panel)

1. Click the GoPainter toolbar icon → "Crawl this site", confirm the seed URL and max page count
2. A crawl **Side Panel** slides out alongside the page, showing scanned count / queue / failures in real time, plus matched fingerprints per page
3. While a crawl is running the toolbar button is disabled; clicking it again returns to the panel
4. Crawling can also be started from any URL under Settings → "Site crawl"

> The side panel requires the `chrome.sidePanel` API (Chrome 126+). Older browsers won't auto-open it, but progress remains visible in the settings page.

## Rule format

See [`rules/examples.yaml`](rules/examples.yaml). Supported matcher types:

| type | description | fields |
|---|---|---|
| `word` | plain-text containment | `words` |
| `regex` | regular expression match | `regex` |
| `status` | HTTP status code | `status` |
| `icon_hash` | favicon mmh3 hash (fofa standard) | `hash` |
| `dsl` | expression evaluation (nuclei dsl subset) | `dsl` |
| `js` | page runtime globals (MAIN world probe) | `js: [{path, pattern?}]` |
| `dom` | CSS selector with optional text/attribute constraints | `dom: [{sel, text?, attrs?}]` |

Rules also support `implies: ["other technology"]` — on a hit, the listed technologies are derived automatically (e.g. Next.js → React), each derived hit carrying a "derived from X" evidence.

The dsl subset supports the identifiers `body` / `title` / `url` / `header` / `raw` / `meta` / `script` / `status` / `favicon_hash`,
the functions `contains(a, "substr")` / `matches(a, "regex")`, operators `&&` `||` `!` `==` `!=`, and parentheses.
Example: `contains(body, "wp-content") && status == 200`

- `part`: `body` / `title` / `url` / `header` / `raw` / `meta` / `script` (default `body`)
- `condition`: combines conditions within a matcher, `and` / `or` (default `or`)
- `matchers-condition`: combines multiple matchers within a rule
- `negative: true`: inverts the match
- `confidence: 0-100`: optional, on a matcher or a rule, expressing signal strength — strong signals (meta generator, proprietary paths) get high values,
  weak signals (e.g. "page declares a manifest" is only a PWA candidate) get low ones; when unset the output is `confidence: null`, never fabricated as 100.
  Aggregation: `or` takes the max confidence among matched matchers, `and` takes the min (the weakest link); a rule-level `confidence` acts as a scale factor;
  derived (`implies`) hits inherit the source's confidence. `\;confidence:N` suffixes from the Wappalyzer source are converted on import,
  and patterns of the same field with different confidences are split into separate matchers so a low-confidence miss doesn't drag down a high-confidence hit.
  With "Confidence" enabled in settings, the popup shows a badge for every hit: numeric confidences as percentages, unannotated hits as `null`;
  sorting and threshold filtering only apply to numeric confidences (off by default).

## Third-party rule sources

The settings page offers three fixed community sources. Refreshes use bounded streaming downloads and strict host allowlists, convert into a separate rule set per source, atomically replace the previous set, and retain one rollback version in IndexedDB. Optional daily or weekly checks are off by default and use Chrome alarms only after the user enables them; arbitrary source URLs are intentionally unsupported.

| source | size | description |
|---|---|---|
| [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer) | several thousand | community-maintained Wappalyzer, web technology fingerprints |
| [EdgeSecurityTeam/EHole](https://github.com/EdgeSecurityTeam/EHole) | 958 | EHole fingerprints, strong domestic-system coverage |
| [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) | hundreds | http/technologies recognition templates |

Thanks to these communities for their long-term maintenance. The conversion logic lives in `wasm/engine/convert.go` and runs client-side at fetch time. A `304 Not Modified` response or unchanged content hash avoids rewriting the rule set.

**Disclaimer**: this project is a format-conversion tool only; it bundles and distributes no third-party rule data. The content, licensing, and compliance of third-party sources are the responsibility of their maintainers; your pulling and use of them is likewise your own responsibility. Please respect each source's license and applicable law, and use this only for authorized security testing and research.

## AI / Agent configuration

Choose the OpenAI-compatible or Anthropic protocol in Settings, then fill in your endpoint and model. Use **Test Agent tools** before the first run.

| service | Base URL | example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5` |

## AI & security notes

- GoPainter never embeds, stores on a server, or uploads your API key. Keys live only in the extension's local storage and the extension requests your Base URL directly.
- When using a cloud LLM, page features are sent to the model service you configure. Agent workflows start with a compact overview and send HTML snippets only when the page-body search tool is used; the direct AI identification/rule helpers may send a truncated HTML snippet. Do not enable AI on sensitive sites unless these can be shared with that provider.
- AI-assisted identification, AI-generated rules, and AI bookmark fallback can be wrong or hallucinated. Review before promoting AI-generated rules into your long-term rule set. The project is not responsible for AI output accuracy, compliance, or external service costs.
- Agent tool calls are limited to the selected task. Automatic read-only calls may run concurrently up to five; permission-gated network calls remain serialized and pause for approval. External results are untrusted reference material, not instructions.
- Runtime and DOM signals come from the scanned page and are therefore untrusted evidence, not an authenticity assertion. Favicon downloads are bounded by URL count and response bytes.

## Commands

| command | description |
|---|---|
| `make build` | Build the production Go WASM + embedded RE2 engine |
| `make test` | Run Go and JS unit tests, then the WASM smoke test |
| `make test-go` | Run only the Go unit tests (js/wasm target, executed via node; no build required) |
| `make test-js` | Run only the Node unit tests for shared extension logic |
| `make test-browser-e2e` | Run the small Chromium content-collection, match, session, popup, and SPA end-to-end test |
| `make bench-js` | Benchmark popup, collection, serialization, and Agent rule-search paths |
| `make bench-chromium` | Run the 30/50-tab Chromium resource benchmark (requires a local Chrome build) |
| `make icons` | Regenerate extension icons |
| `make clean` | Remove `extension/wasm/matcher.wasm` and `wasm_exec.js` |
| `node scripts/generate-icons.mjs` | Run the icon generator directly |
| `node scripts/generate-hashdb.mjs` | Generate `wasm/engine/hashdb.go` from `data/favicon-hashes.json` |
| `node scripts/smoke-test.mjs` | Run the WASM smoke test directly |
| `powershell -ExecutionPolicy Bypass -File scripts/build.ps1` | Build WASM on Windows |

<details>
<summary><strong>Architecture and repository layout</strong></summary>

## Architecture

```
GoPainter Host / Runtime (JS)            GoPainter Core / Authority (Go WASM)
all external I/O and lifecycle           deterministic product semantics, zero I/O
──────────────────────────────           ────────────────────────────────────────
content.js   collects DOM / raw HTML ─┐
background   collects headers/status   │     goMatch            rule matching + evidence
  .js        favicon download        ─┼─→  goMmh3            favicon hash (fofa standard)
             AI / Agent API calls     │     goExtractFeatures HTML → title/meta/scripts
             icon state switching     │     goNormalizeRules  YAML docs → native rules
             permission / lifecycle   │     goValidateCandidate strict Agent artifact validation
                                      │     goPlanRequiredProbes Rule → JS/DOM feature plan
options      YAML parsing (js-yaml)  ─┘    ←  everything in JSON, out JSON
popup        results & evidence / Agent task runner
sidepanel    crawl progress / start-stop (Side Panel, alongside the page)
```

Core boundary: **the WASM does pure computation only** (JSON in, JSON out; no network, YAML, or DOM).
Rule semantics—including strict Agent candidate validation and required-probe planning—live in Go; JS owns browser/model I/O, permissions, and lifecycle.

> **Architecture invariant — do not blur this boundary.** Before adding logic, ask what it represents: deterministic GoPainter domain semantics belong in Go; interaction with browsers, models, users, storage, or networks belongs in JS. Never duplicate rule grammar, matcher semantics, normalization, probe planning, or probe-ID algorithms in the JS Host. Do not move the Agent loop, permissions, providers, Chrome APIs, DOM collection, or network I/O into WASM merely to increase the amount of Go code.

## Directory layout

```
├── wasm/                     # WASM entry package (thin JS bridge)
│   ├── main.go               #   register JS exports
│   ├── bridge.go             #   JSON in/out for matching/conversion/hash/dsl
│   ├── crawl_bridge.go       #   JSON in/out for crawler APIs
│   └── engine/               #   pure Go logic package
│       ├── matcher.go        #   matching engine (core)
│       ├── candidate.go      #   strict Agent candidate validation + runtime coverage
│       ├── probes.go         #   required JS/DOM probe planning and stable probe IDs
│       ├── mmh3.go           #   favicon hashing
│       ├── extract.go        #   HTML feature extraction (title/meta/scripts/favicons/links)
│       ├── normalize.go      #   rule normalization (nuclei conversion)
│       ├── dsl.go            #   dsl expression evaluator
│       ├── convert.go        #   Wappalyzer/EHole fingerprint conversion
│       ├── health.go         #   regex validity, prefilter potential and anchor quality
│       ├── crawl.go          #   crawler scheduling (BFS/dedup/same-site/max pages)
│       └── hashdb.go         #   favicon hash database (generated)
├── extension/                # Chrome extension (MV3)
│   ├── manifest.json
│   ├── background.js         # thin service-worker composition root and message router
│   ├── agent/                # bounded agent loop, tools and skills
│   ├── background/           # Host modules: page/rules/history/crawl/bookmarks/AI/Agent
│   ├── content.js            # page feature collection
│   ├── popup.*               # results & evidence / AI identification / AI rule generation
│   ├── options.*             # rule import / AI config / prompts / bookmark organization
│   ├── sidepanel.*           # crawl progress / start-stop (Side Panel)
│   ├── icons/                # colored & gray icon sets (script-generated)
│   └── lib/                  # js-yaml (the only third-party JS)
├── scripts/
│   ├── generate-icons.mjs    # icon generator (pure Node, zero deps)
│   ├── generate-hashdb.mjs   # favicon hash DB generator (data/ → wasm/engine/hashdb.go)
│   ├── smoke-test.mjs        # wasm smoke test
│   └── build.ps1             # Windows build script
├── data/favicon-hashes.json  # hash DB source data (BishopFox/Favicons)
├── rules/examples.yaml       # example rules
└── Makefile                  # macOS/Linux build
```

</details>

## Project status

The core browser workflow is implemented: automatic matching, evidence, composable rule sets and imports, third-party rule-source updates and rollback, Agent research and importable rule generation, crawling, history/report export, and bookmark organization. Browser E2E coverage now protects the complete capture → match → storage → popup path in CI; the next work should return to recognition quality and carefully scoped rule improvements.

## License

[MIT](LICENSE)
