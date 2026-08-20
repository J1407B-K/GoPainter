# GoPainter

[![CI](https://img.shields.io/github/actions/workflow/status/J1407B-K/GoPainter/ci.yml?branch=master&style=flat-square&label=CI)](https://github.com/J1407B-K/GoPainter/actions/workflows/ci.yml)
[![CodeFactor](https://www.codefactor.io/repository/github/j1407b-k/gopainter/badge)](https://www.codefactor.io/repository/github/j1407b-k/gopainter)
[![Release](https://img.shields.io/github/v/release/J1407B-K/GoPainter?style=flat-square)](https://github.com/J1407B-K/GoPainter/releases/latest)
[![License](https://img.shields.io/github/license/J1407B-K/GoPainter?style=flat-square)](./LICENSE)
![Go WASM](https://img.shields.io/badge/Go-WASM-00ADD8?style=flat-square&logo=go&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)

**English** | [简体中文](./README_CN.md) · [Example rules](./rules/examples.yaml) · [Performance record](./BENCHMARK.md)

> **The best open-source web fingerprinting tool for Chromium browsers.**
>
> It runs locally with Go/WASM and Google RE2, and shows the evidence behind every result.

GoPainter identifies the technology behind the current page from HTTP, HTML, DOM,
JavaScript runtime, and favicon signals. Matching is deterministic, local, and explainable:
every result shows exactly why it matched. Optional AI tools can research and propose
fingerprints; validation still happens in the Go core.

While you browse, the toolbar icon stays gray when nothing matches and becomes colored
with a hit-count badge when fingerprints are found.

## What makes GoPainter different

- **Explainable detection** — inspect the exact keyword, regex, status code, runtime value, DOM selector, favicon hash, and extracted version behind each hit.
- **Deterministic rule engine** — seven matcher types, `and`/`or`, negative conditions, confidence propagation, and Google RE2 semantics.
- **Composable rule sets** — keep sources separate, enable any combination, and resolve same-ID conflicts with a YAML diff.
- **Third-party rule sources** — user-initiated Wappalyzer, EHole, and nuclei-templates updates with bounded downloads, summaries, and one-version rollback.
- **Rule tooling** — import native YAML or a supported nuclei HTTP subset; edit a matched rule directly and validate it against the current page.
- **Browser workflows** — automatic current-tab scans, batch URL scans, site crawling, bookmark organization, scan history, and JSON/CSV reports.
- **Auditable AI Agent** — bounded inspect → search → test → validate workflows with visible tool traces and explicit permission gates.

## Current release: v0.7.1

v0.7.1 adds a first-run local rule demo, clearer YAML editing and validation, and smoother
popup result presentation. Third-party source sets retain stable identities across manual
and scheduled updates, and their full installed rules can now be reopened and saved without
being constrained by the AI-candidate 50-matcher limit. Settings can scan up to 500 URLs and
export JSON or CSV; batch work uses four fetch workers, byte-bounded response streams, and a
separate 2.5 MB session-results budget.

See [BENCHMARK.md](./BENCHMARK.md) for the Chromium resource measurements, browser E2E
baseline, and historical performance notes.

## Quick start

### 1. Build

Install the standard [Go toolchain](https://go.dev/dl/), then run:

```bash
make build
```

This produces `extension/wasm/matcher.wasm` and `extension/wasm/wasm_exec.js`. The only
supported production target is standard Go WASM with embedded Google RE2; the TinyGo and
standard-library-regexp targets in the Makefile are legacy experiments.

On Windows, use PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

### 2. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `extension/` directory.

Edge and Brave use the same unpacked-extension flow from their extensions pages.

### 3. Detect a site

1. Open the GoPainter popup and go to **Rules**.
2. Import [`rules/examples.yaml`](./rules/examples.yaml), another native rule file, or a supported nuclei template.
3. Visit a page and open the popup to inspect its hits and evidence.

Use **Agent** to identify the current tab, research a fingerprint, or prepare a rule
optimization. The Agent never writes a rule automatically; you review and import the
validated result.

### Crawl a site

Choose **Crawl this site** from the popup, confirm the seed URL and optional page limit,
then follow progress in the Side Panel. Crawls stay on the same site, deduplicate URLs,
and show the queue, failures, and per-page hits. They can also be started from
**Settings → Site crawl**.

The automatic Side Panel opening requires Chrome 126+. On older Chromium builds, crawl
progress remains available in Settings.

### Batch scan and live editing

Paste one URL per line into **Settings → Batch scan**. The task deduplicates input,
rejects non-HTTP(S) addresses, and keeps fixed concurrency and storage bounds. It does
not open tabs or execute page JavaScript/DOM probes; matching uses HTTP, HTML, meta,
script, and favicon signals. JSON and CSV downloads are available when results arrive.

Click a rule name or **Edit rule** on any popup hit to open its effective YAML. Edits are
validated live against the cached features from the current page; only a strictly valid
rule can be saved and applied. If the hit came from another rule set, saving copies the
rule into the active editing set and explicitly selects that copy.

## Rule model

See [`rules/examples.yaml`](./rules/examples.yaml) for complete examples.

| Type | Matches | Payload field |
|---|---|---|
| `word` | Plain-text containment | `words` |
| `regex` | Google RE2 regular expression | `regex` |
| `status` | HTTP status code | `status` |
| `icon_hash` | Favicon mmh3 hash (FOFA format) | `hash` |
| `dsl` | Supported nuclei-style expression subset | `dsl` |
| `js` | Page runtime global with an optional pattern | `js: [{path, pattern?}]` |
| `dom` | CSS selector with optional text/attribute patterns | `dom: [{sel, text?, attrs?}]` |

Rule composition:

- `part`: `body`, `title`, `url`, `header`, `raw`, `meta`, or `script`; defaults to `body`.
- `condition`: combines entries inside one matcher with `and` or `or`; defaults to `or`.
- `matchers-condition`: combines multiple matchers in one rule.
- `negative: true`: inverts a valid matcher result; an invalid condition is never turned into a hit.
- `implies`: derives related technologies and records “derived from X” evidence.
- `confidence: 0-100`: optional signal strength on a matcher or rule; an unannotated hit remains `null`, not an invented 100.
- `version`: optional version template; regex and JavaScript patterns support `\1`, `\2`, and `\1?present:absent`, with output capped at 120 characters.

For confidence aggregation, `or` takes the strongest matched signal and `and` takes the
weakest. A rule-level value scales the matcher result, and an `implies` hit inherits its
source confidence, but an implied hit never invents a version. Wappalyzer
`\;confidence:N` and `\;version:\1` suffixes are converted during import.

The DSL subset supports:

- Identifiers: `body`, `title`, `url`, `header`, `raw`, `meta`, `script`, `status`, `favicon_hash`
- Functions: `contains(a, "text")`, `matches(a, "regex")`
- Operators: `&&`, `||`, `!`, `==`, `!=`, and parentheses

Example: `contains(body, "wp-content") && status == 200`

## Third-party rule sources

GoPainter offers three fixed community sources in Settings. Nothing is fetched until the
user clicks **Refresh now** or explicitly enables daily/weekly checks.

| Source | Approximate size | Purpose |
|---|---:|---|
| [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer) | Several thousand | Community-maintained Wappalyzer web fingerprints |
| [EdgeSecurityTeam/EHole](https://github.com/EdgeSecurityTeam/EHole) | About 958 | EHole fingerprints with strong Chinese-product coverage |
| [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) | Hundreds | `http/technologies` recognition templates |

The extension downloads only from fixed HTTPS hosts, follows validated redirects, omits
credentials, and enforces a 3 MB per-file / 30 MB per-update byte budget, a globally shared
four-worker download pool, and a 25,000-rule result limit. A source is converted locally,
validated, and atomically replaced in its own rule set. ETag, Last-Modified, and content
hashes avoid unnecessary rewrites; one previous version is kept locally in IndexedDB for
rollback.
Arbitrary source URLs are intentionally unsupported.

The conversion code lives in `wasm/engine/convert.go`. GoPainter is a format-conversion
tool and does **not** bundle or redistribute these libraries. Their content, licenses, and
compliance remain the responsibility of their maintainers and users. Respect each source's
license and applicable law, and use the data only for authorized testing and research.

The built-in favicon hash database is a separate generated dataset derived from
[BishopFox/Favicons](https://github.com/BishopFox/Favicons); its attribution and source are
kept in `data/favicon-hashes.json`.

## AI and Agent

AI features are optional. In Settings, choose an OpenAI-compatible or Anthropic protocol,
enter the endpoint and model, then run **Test Agent tools** before the first task.

| Service | Base URL | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5` |

Automatic read-only Agent tools may run concurrently, up to five at a time. Permission-
gated network tools remain serialized and pause for approval. `fetch_url` accepts HTTPS
only, applies bounded reads and private/local-address guards, and scopes remembered grants
to the approved origin. External results are untrusted references, never instructions.

## Security and privacy boundaries

- **No GoPainter server** — API keys stay in extension-local storage and requests go directly to the endpoint you configure.
- **Model disclosure is explicit** — cloud AI receives page features; Agent starts with a compact overview and sends HTML snippets only when needed, while direct AI helpers may send truncated HTML. Do not use AI on sensitive pages unless that disclosure is acceptable.
- **Cookie evidence stays local** — `Set-Cookie` may participate in fingerprint matching but is removed from Agent snapshots and model prompts.
- **Page evidence is untrusted** — DOM and runtime values originate from the scanned page. A match is evidence that a signal existed, not proof that a technology is authentic.
- **Browser resources are bounded** — page snapshots, UI lists, scan queues, favicon URL counts, concurrent downloads, response bytes, redirects, and history windows all have limits; batch scans accept at most 500 URLs and have a separate 2.5 MB session-results budget.
- **AI output requires review** — identification, generated rules, and bookmark fallback can be wrong. The deterministic Go core validates structure and semantics, not real-world truth.

## Development and verification

| Command | Purpose |
|---|---|
| `make build` | Build the production Go WASM + embedded RE2 engine |
| `make test` | Run Go/WASM and JavaScript tests, then the WASM smoke test |
| `make test-go` | Run Go tests through the js/wasm target |
| `make test-js` | Run Node tests and JavaScript syntax checks |
| `make test-browser-e2e` | Verify Chromium capture, version extraction, popup rendering, live rule editing, batch scan, and SPA replacement |
| `make bench-js` | Benchmark UI, collection, serialization, and Agent rule-search paths |
| `make bench-chromium` | Run the 30/50-tab Chromium resource benchmark |
| `make icons` | Regenerate extension icons |
| `make clean` | Remove generated WASM artifacts |

Browser E2E and Chromium benchmarks require a local Chrome/Chromium build. Additional
generators and direct script entry points live under `scripts/` and are documented in the
Makefile.

<details>
<summary><strong>Architecture and repository layout</strong></summary>

### Architecture

```text
JavaScript Host / Runtime                 Go WASM Core / Authority
browser, network, storage, lifecycle      deterministic semantics, zero I/O
────────────────────────────────────      ─────────────────────────────
content.js ─ page/DOM collection ────┐
background ─ headers, icons, AI ─────┼──→ matching, evidence, mmh3
options ─ YAML parsing and settings ─┘    normalization, validation,
popup / sidepanel ─ interaction           probe planning, crawl scheduling
```

The boundary is deliberate: browser/model/user/storage/network concerns belong in the
JavaScript Host; rule grammar, matcher semantics, normalization, strict candidate
validation, probe planning, and other deterministic product rules belong in Go.

Do not duplicate core semantics in JavaScript, and do not move Chrome APIs, DOM access,
network I/O, provider code, permissions, or the Agent loop into WASM merely to increase
the amount of Go code.

### Repository layout

```text
├── wasm/
│   ├── main.go, bridge.go       # thin JSON bridge exposed to JavaScript
│   └── engine/                  # pure Go matching, conversion and validation
├── extension/
│   ├── background.js            # MV3 composition root and message router
│   ├── background/              # page, rule, source, crawl, history and AI hosts
│   ├── agent/                   # bounded Agent loop, tools and skills
│   ├── content.js               # page feature collection
│   ├── popup.*, options.*       # results, rules and settings
│   └── sidepanel.*              # crawl progress and controls
├── scripts/                     # build, generation, benchmark and smoke scripts
├── data/favicon-hashes.json     # favicon database source
├── rules/examples.yaml          # example native rules
└── Makefile
```

</details>

## Project status

The core browser workflow is implemented and covered by unit, smoke, and browser E2E
tests. GoPainter owns reliable collection, matching, validation, and result workflows;
v0.7.1 does not expand the fingerprint corpus. Users import, edit, or explicitly update
the compatible rule sources they choose to use.

## License

[MIT](./LICENSE)
