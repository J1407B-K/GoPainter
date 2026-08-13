# GoPainter

**English** | [简体中文](./README_CN.md)

Web asset fingerprinting for the browser. A **Go WASM + Google RE2** matching engine with optional LLM-assisted identification.

GoPainter provides the engine — detection and crawling. The fingerprint definitions (rules) come from community rule sources or your own YAML files; the repository ships no rule data itself.

While you browse, GoPainter fingerprints the current site automatically and surfaces hits in real time: the toolbar icon stays gray when nothing matches, and turns colored with a badge showing the hit count when it does.

## Features

- **YAML fingerprint rules** — word / regex / status / icon_hash / dsl / js / dom matchers, with `and`/`or` combinations and `negative` inversion
- **nuclei template compatibility** — imports automatically extract the HTTP matchers subset, so the large community template library is directly usable
- **Third-party rule sources** — Wappalyzer / EHole / nuclei-templates can be pulled and converted in one click; whether to download is your choice, and the repository ships no rule data itself
- **[Performance-focused Go WASM engine](BENCHMARK.md)** — a ~13.5MB production binary that combines safe regex-literal AC prefiltering with embedded Google RE2; v0.5.1 reduced a real 20-page crawl by 39% with identical hits
- **Hit evidence** — each fingerprint carries the specific keyword, regex, status code, or hash that matched
- **Icon state indicator** — gray = no match, colored + badge = N matches
- **LLM-assisted tech-stack identification** — feed headers/body/js/dom to any OpenAI-compatible endpoint; AI returns structured candidates (confidence + evidence) you can merge into the hit list, or turn into rules
- **Scan history & reports** — choose a 50–5,000 entry rolling window and export it as JSON/CSV

## Quick start

### 1. Install Go

Building only needs the standard Go toolchain (`make build` compiles the production Go WASM + RE2 engine).

- macOS: `brew install go`
- Windows / Linux: see the [Go download page](https://go.dev/dl/)

> For a smaller WASM binary (~925K, but with 140–300ms GC tail-latency spikes at steady-state p99), install [TinyGo](https://tinygo.org/getting-started/install/) and run `make build-tinygo`.

### 2. Build the WASM engine

**macOS / Linux**
```bash
make build        # produces extension/wasm/matcher.wasm + wasm_exec.js
make icons        # regenerate icons (optional; the repo ships them)
```

The WASM engine has three build backends — `make build` (go-re2, the **default**) is the heavyweight performance build:

| command | engine | size | notes |
|---|---|---|---|
| `make build` | go-re2 (embedded Google RE2) | ~13.5MB | **default**; performance-first |
| `make build-go-stdlib` | Go standard-library regex | smaller | comparison/fallback backend, dev use |
| `make build-tinygo` | TinyGo + stdlib RE2 | ~925K | size-first; GC tail-latency spikes (needs [TinyGo](https://tinygo.org/getting-started/install/)) |

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
3. When nothing matches, use "AI identification" to get tech-stack candidates (configure an API in settings first), tick the ones you accept and merge them into the hit list; candidates without a rule can be turned into a new one in one click. A rule that actually matched the current page can be optimized against that page to add matchers; existing rules are also maintained in Settings → "Fingerprint rules"

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
| `dom` | CSS selector presence | `words` holding selectors |

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

The settings page can pull community fingerprint libraries in real time from your browser and convert them into rules:

| source | size | description |
|---|---|---|
| [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer) | several thousand | community-maintained Wappalyzer, web technology fingerprints |
| [EdgeSecurityTeam/EHole](https://github.com/EdgeSecurityTeam/EHole) | 958 | EHole fingerprints, strong domestic-system coverage |
| [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) | hundreds | http/technologies recognition templates |

Thanks to these communities for their long-term maintenance. The conversion logic lives in `wasm/engine/convert.go` and runs client-side at fetch time.

**Disclaimer**: this project is a format-conversion tool only; it bundles and distributes no third-party rule data. The content, licensing, and compliance of third-party sources are the responsibility of their maintainers; your pulling and use of them is likewise your own responsibility. Please respect each source's license and applicable law, and use this only for authorized security testing and research.

## AI configuration

Fill in any **OpenAI-compatible endpoint** in settings:

| service | Base URL | example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5` |

## AI & security notes

- GoPainter never embeds, stores on a server, or uploads your API key. Keys live only in the extension's local storage and the extension requests your Base URL directly.
- When using a cloud LLM, page features are sent to the model service you configure: URL, title, response headers, meta, script paths, favicon hashes, and a truncated HTML snippet. Do not enable AI on sensitive sites unless you are certain these can be shared with that provider.
- AI-assisted identification, AI-generated rules, and AI bookmark fallback can be wrong or hallucinated. Review before promoting AI-generated rules into your long-term rule set. The project is not responsible for AI output accuracy, compliance, or external service costs.
- External scripts execute with extension privileges. Only add scripts you wrote or fully trust; don't paste code of unknown provenance.

## External scripts

Settings → "External scripts" lets you append custom identification logic after rule matching and the favicon hash database. The script body is executed as a function:

```js
// Arguments: features, hits
// Return: an array of extra fingerprints; returning nothing is fine
if (features.body.includes('hello-world-cta')) {
  return [{
    id: 'my-product',
    name: 'My Product',
    evidence: [{ type: 'script', detail: 'hello-world-cta' }],
  }];
}
```

Available inputs:

- `features.url` / `features.title` / `features.body`
- `features.headers` / `features.status`
- `features.meta` / `features.scripts` / `features.links`
- `features.faviconHash` / `features.faviconHashes`
- `hits`: results already matched by the rules and hash database

Returned items need at least `id` and `name`. An `id` that already exists is skipped to avoid duplicates.

## Commands

| command | description |
|---|---|
| `make build` | Build the production Go WASM + embedded RE2 engine |
| `make build-go-stdlib` | Build the standard-library regex comparison/fallback engine |
| `make build-tinygo` | Size-optimized TinyGo build (~925K, with GC tail-latency spikes) |
| `make test` | Run Go and JS unit tests, then the WASM smoke test |
| `make test-go` | Run only the Go unit tests (js/wasm target, executed via node; no build required) |
| `make test-js` | Run only the Node unit tests for shared extension logic |
| `make icons` | Regenerate extension icons |
| `make clean` | Remove `extension/wasm/matcher.wasm` and `wasm_exec.js` |
| `node scripts/generate-icons.mjs` | Run the icon generator directly |
| `node scripts/generate-hashdb.mjs` | Generate `wasm/engine/hashdb.go` from `data/favicon-hashes.json` |
| `node scripts/smoke-test.mjs` | Run the WASM smoke test directly |
| `powershell -ExecutionPolicy Bypass -File scripts/build.ps1` | Build WASM on Windows |

## Architecture

```
JS side (glue layer, all I/O)            Go WASM (pure functions, zero I/O)
──────────────────────────               ───────────────────────────
content.js   collects DOM / raw HTML ─┐
background   collects headers/status   │     goMatch            rule matching + evidence
  .js        favicon download        ─┼─→  goMmh3            favicon hash (fofa standard)
             AI API calls             │     goExtractFeatures HTML → title/meta/scripts
             icon state switching     │     goNormalizeRules  YAML docs → native rules
options      YAML parsing (js-yaml)  ─┘    ←  everything in JSON, out JSON
popup        results & evidence / AI button
sidepanel    crawl progress / start-stop (Side Panel, alongside the page)
```

Core boundary: **the WASM does pure computation only** (JSON in, JSON out; no network, YAML, or DOM).
Matching, mmh3, HTML feature extraction, and nuclei conversion all live in Go.

## Directory layout

```
├── wasm/                     # WASM entry package (thin JS bridge)
│   ├── main.go               #   register JS exports
│   ├── bridge.go             #   JSON in/out for matching/conversion/hash/dsl
│   ├── crawl_bridge.go       #   JSON in/out for crawler APIs
│   └── engine/               #   pure Go logic package
│       ├── matcher.go        #   matching engine (core)
│       ├── mmh3.go           #   favicon hashing
│       ├── extract.go        #   HTML feature extraction (title/meta/scripts/favicons/links)
│       ├── normalize.go      #   rule normalization (nuclei conversion)
│       ├── dsl.go            #   dsl expression evaluator
│       ├── convert.go        #   Wappalyzer/EHole fingerprint conversion
│       ├── crawl.go          #   crawler scheduling (BFS/dedup/same-site/max pages)
│       └── hashdb.go         #   favicon hash database (generated)
├── extension/                # Chrome extension (MV3)
│   ├── manifest.json
│   ├── background.js         # service worker: AI/bookmarks/crawl/message routing
│   ├── background/           # service worker layers: wasm, browser state, matching
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

## Roadmap

**Done**
- [x] Go WASM matching engine (word / regex / status / icon_hash)
- [x] nuclei template import compatibility (http matchers subset)
- [x] hit evidence display
- [x] icon state indicator (gray/colored + badge)
- [x] AI-assisted tech-stack identification (structured candidates with confidence/evidence, merge into hit list)
- [x] AI rule optimization & creation (strengthen a matched rule against the current page, or create a missing rule)
- [x] bookmark auto-categorization (sort bookmarks by fingerprint hit; optional AI fallback)
- [x] mmh3 / HTML extraction / nuclei conversion moved into Go (added meta, script dimensions)
- [x] built-in favicon hash database (956 entries, BishopFox dataset) + custom hash import
- [x] built-in top-130 common fingerprint rule library (one-click import in options)
- [x] bookmark scan backfills favicon hashes (icon_hash rules & DB apply to bookmarks)
- [x] external scripts (custom JS hooking into the match pipeline)
- [x] recursive site crawling (BFS / dedup / same-site filtering in Go; max pages configurable, blank = unlimited; one-click from popup)
- [x] crawl progress side panel (live scanned / queue / failures + matched fingerprints; button disabled while running)
- [x] multi-favicon continuous matching (all icons from DOM + network count; late icons trigger re-match)
- [x] SPA route-change watching (main world hooks pushState/replaceState; re-scan on change)
- [x] dsl expression matcher subset (hand-rolled recursive descent evaluator; nuclei dsl converts too)
- [x] third-party rule source marketplace (Wappalyzer / EHole / nuclei-templates)
- [x] js runtime variable probing (MAIN world) + dom selector probing + implies cascading
- [x] Go unit tests (matcher / dsl / mmh3 / extract / normalize / crawl / convert, `make test-go`)
- [x] JS unit tests (confidence filtering, rule merging, favicon hash de-duplication, YAML extraction; `make test-js`)
- [x] scan history and report export (JSON/CSV)

**In progress / planned**
- [ ] rule-set management: group enable/disable, remote rule source subscriptions & auto-update
- [ ] WASM size reduction (production RE2 build ~13.5MB; TinyGo remains available for size-first builds)

## License

[MIT](LICENSE)
