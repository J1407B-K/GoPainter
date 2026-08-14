# GoPainter

**English** | [简体中文](./README_CN.md) · [Example rules](./rules/examples.yaml)

Web asset fingerprinting for the browser. A **Go WASM + Google RE2** matching engine with optional LLM-assisted identification.

GoPainter provides the detection and crawling engine. Rules can come from your own YAML, live community-source conversion, the example file, or the curated built-in starter set. Third-party rule libraries are not vendored into the repository.

While you browse, GoPainter fingerprints the current site automatically and surfaces hits in real time: the toolbar icon stays gray when nothing matches, and turns colored with a badge showing the hit count when it does.

## Current release: v0.6.2

This release expands rule-set management: multiple sets can participate in matching, editing stays scoped to one selected set, and conflicting imports or AI updates require an explicit YAML diff decision before replacement. It also fixes nuclei template imports, moves large rule-set activation work off the settings-page main thread, and adds YAML export for the current editing set. The latest published performance measurements remain available in the [performance record](BENCHMARK.md).

## Features

- **YAML fingerprint rules** — word / regex / status / icon_hash / dsl / js / dom matchers, with `and`/`or` combinations and `negative` inversion
- **Composable rule sets** — keep imports separated, enable any combination for matching, and review a YAML diff before replacing a conflicting rule
- **nuclei template compatibility** — imports automatically extract the HTTP matchers subset, so the large community template library is directly usable
- **Third-party rule sources** — Wappalyzer / EHole / nuclei-templates can be pulled and converted in one click; whether to download is your choice, and their complete libraries are not vendored into the repository
- **Performance-focused runtime** — Go WASM + Google RE2 matching, bounded page/UI data paths, and indexed Agent rule search
- **Hit evidence** — each fingerprint carries the specific keyword, regex, status code, or hash that matched
- **Icon state indicator** — gray = no match, colored + badge = N matches
- **Agent-assisted fingerprint research** — a bounded, streaming tool loop researches the current tab or a rule, shows its auditable tool trace, and returns an evidence-based task report
- **Scan history & reports** — choose a 50–5,000 entry rolling window and export it as JSON/CSV

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
3. Click **Agent** to identify the current tab, research a fingerprint, or prepare an optimization suggestion. Automatic read-only tools may run concurrently up to five; permission-gated tools remain serialized and ask before use. The visible trace streams as work completes, and no rule is written automatically.

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
| `make test` | Run Go and JS unit tests, then the WASM smoke test |
| `make test-go` | Run only the Go unit tests (js/wasm target, executed via node; no build required) |
| `make test-js` | Run only the Node unit tests for shared extension logic |
| `make bench-js` | Benchmark popup, collection, serialization, and Agent rule-search paths |
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
JS side (glue layer, all I/O)            Go WASM (pure functions, zero I/O)
──────────────────────────               ───────────────────────────
content.js   collects DOM / raw HTML ─┐
background   collects headers/status   │     goMatch            rule matching + evidence
  .js        favicon download        ─┼─→  goMmh3            favicon hash (fofa standard)
             AI / Agent API calls     │     goExtractFeatures HTML → title/meta/scripts
             icon state switching     │     goNormalizeRules  YAML docs → native rules
options      YAML parsing (js-yaml)  ─┘    ←  everything in JSON, out JSON
popup        results & evidence / Agent task runner
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
│   ├── agent/                # bounded agent loop, tools and skills
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

</details>

## Project status

The core browser workflow is implemented: automatic matching, evidence, composable rule sets and imports, Agent research and importable rule generation, crawling, history/report export, bookmark organization, and external scripts. The next planned area is remote rule-source subscriptions and updates.

## License

[MIT](LICENSE)
