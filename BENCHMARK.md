# GoPainter benchmarks and browser validation

[README](./README.md) | [简体中文](./BENCHMARK_CN.md)

This is the project's reproducible performance and browser-validation record. It keeps
three kinds of evidence separate: browser E2E correctness, bounded resource behavior,
and historical performance measurements. Each result states its workload and command;
numbers from different sections should not be compared unless their workloads match.

The latest browser-correctness suite targets v0.7.0. The multi-tab resource measurements
remain the v0.6.8 baseline because v0.7.0 does not change that workload or its limits.
Older results remain available below for design history and regression context.

## Current browser validation and resource baseline

### 1. Browser E2E correctness: v0.7.0

The v0.7.0 suite runs the real unpacked extension in Chromium.
Unlike the resource benchmark below, this is a deterministic correctness test: a local
fixture supplies known title, meta, body, script, response-cookie, JavaScript-runtime,
DOM, favicon, and SPA-route signals, then the test verifies the complete capture → match
→ session storage → popup path.

It checks 7 initial fingerprint signals, 2 favicon hashes, extracted JavaScript version
`1.0.0`, and a rendered popup. The test then opens the matched rule from that popup,
changes its YAML, waits for live production-WASM validation, saves it, and verifies the
rematched result. It also completes a two-URL batch scan and replaces the old page result
with the SPA-only `e2e-spa` hit.

No real third-party repository is contacted: upstream availability, rate limits, and
mutable rule data would make CI nondeterministic. Source-download bounds and routing are
covered by deterministic tests instead.

A successful run prints:

```json
{"e2e":"passed","initialHits":7,"spaHit":"e2e-spa","faviconHashes":2,"popupRendered":true,"version":"1.0.0","liveRuleEdit":true,"batchResults":2}
```

### 2. Multi-tab resource bounds: v0.6.8

v0.6.8 closes the multi-tab resource-hardening work with a real Chromium run, not
just source-level queue assertions. The benchmark launches a fresh profile, loads
the unpacked extension through CDP, serves ten deliberately slow unique favicon
responses per page, and polls the extension service worker while it runs. It checks
the active and pending scan/favicon queues, `storage.session` bytes, storage errors,
stale result commits, orphan per-tab keys, and final results for every still-open tab.

The first 50-tab run exposed a real loss-of-work bug: evicting a still-current scan
from a full queue could leave that tab without a result. The final implementation
keeps the bounded queue and has the content script retry its already-bounded feature
snapshot; the measurements below are from that corrected run.

| Fresh-profile Chromium workload | Live tabs | Scan active / pending max | Favicon active / pending max | Peak session bytes | Storage errors / stale commits / orphan keys | Live tabs with final result |
|---|---:|---:|---:|---:|---:|---:|
| 30 tabs | 30 | 3 / 26 | 6 / 74 | 125,792 | 0 / 0 / 0 | 30 / 30 |
| 50 tabs | 50 | 3 / 32 | 6 / 97 | 200,960 | 0 / 0 / 0 | 50 / 50 |
| 30 tabs; 10 rapid SPA routes; 10 immediately closed | 20 | 3 / 18 | 6 / 197 | 104,688 | 0 / 0 / 0 | 20 / 20 |

All runs remained inside the release limits: scan active ≤3, scan pending ≤32,
favicon active ≤6, favicon pending ≤256, and page snapshot storage ≤6,500,000 bytes.
This establishes resource and lifecycle behavior only; it is not an identification-
accuracy measurement.

### Reproduce the current baseline

Both browser commands require a local Chrome or Chromium build.

| Purpose | Command |
|---|---|
| Build and run the deterministic browser correctness test | `make build && make test-browser-e2e` |
| Build and run the multi-tab resource benchmark | `make build && make bench-chromium` |
| Run the complete Go, JavaScript, WASM, and smoke suite | `make test` |

## Historical measurements

| Release | Focus | Headline result |
|---|---|---|
| v0.6.4 | Host modularisation and bounded UI work | 50,000-rule indexed search: 1.15 ms |
| v0.6.1 | JavaScript and DOM long-task removal | 20,000 rules rendered as 300 rows in 32 ms |
| v0.5.1 | Embedded Google RE2 verifier | 20-page crawl: 12.52 s → 7.61 s |
| v0.5.0 | Regex candidate prefilter and Go WASM | Real warm scan: 5–13 s → ~100–200 ms |

> Historical rows mentioning user scripts predate removal of external scripts; they
> are measurements of the old release, not current product capabilities.

<details>
<summary><strong>v0.6.4 - bounded Host runtime and rule-health inspection</strong></summary>

> **Focus:** split the service-worker control path and bound large UI/data operations.

- Page, rule, history, crawl, bookmark, AI, and Agent lifecycles moved into independent
  Host modules with duplicate-safe message registration.
- Popup, options, content collection, Markdown, and Agent trace paths update bounded
  data and DOM sets.
- Go Core rule health reports regex validity and prefilter cost signals. It does not
  claim fingerprint accuracy or per-page heat.

| JavaScript benchmark | v0.6.4 result |
|---|---:|
| Filter 10,000 / 50,000 rules | 0.58 / 5.81 ms |
| Filter and sort 10,000 / 50,000 hits | 1.06 / 7.08 ms |
| Compact 2,000 hits x 40 evidence rows | 0.31 ms |
| Compile 100 user scripts / run cached scripts | 0.06 / 0.01 ms |
| Stringify 10,000 custom hashes / cached read | 0.73 / <0.01 ms |
| Three rule searches across 50,000 rules, legacy / indexed | 44.08 / 1.15 ms |

**Reproduce:** `make bench-js` · **Validate:** `make test`

</details>

<details>
<summary><strong>v0.6.1 - remove JavaScript and DOM long tasks</strong></summary>

| Boundary introduced | Limit or behavior |
|---|---|
| Document serialization | Stop at 200 KB; do not materialize the complete DOM |
| Favicon downloads | 6 workers |
| Popup snapshot | 100 hits × 20 evidence rows × 500 characters |
| Options, history, hash, and crawl lists | 300 rendered rows |
| Storage reads | Cache until invalidated; rescan open tabs only |

| JavaScript benchmark | Result |
|---|---:|
| Filter 10,000 / 50,000 rules | 0.56 / 5.12 ms |
| Filter and sort 10,000 / 50,000 hits | 0.98 / 6.46 ms |
| Compact 2,000 hits x 40 evidence rows | 0.20 ms |
| Compile 100 user scripts / run cached scripts | 0.06 / 0.01 ms |
| Stringify 10,000 custom hashes / cached read | 0.70 / <0.01 ms |
| Three rule searches across 50,000 rules, legacy / indexed | 43.23 / 1.56 ms |

| Browser/runtime check | Result |
|---|---:|
| 20,000-rule options render | 300 rows, 1,080 DOM nodes, 32 ms load |
| 8,000-rule steady matcher median | 13.6 ms |
| 200-page continuous scan | 28.0 ms p90 / 31.2 ms p99 |
| 20,000-rule Agent flow, 10 ms popup heartbeat | 37.1 ms maximum delay |

**Reproduce**

```bash
make bench-js                         # JS, popup, collection, and Agent search paths
node scripts/bench-cold.mjs 8000 12  # matcher cold-start curve
node scripts/bench-steady.mjs 8000   # matcher steady-state distribution
node scripts/bench-scan.mjs 8000 200 # continuous 200-page distribution
make test                             # Go, JS, and WASM smoke coverage
```

</details>

<details>
<summary><strong>v0.5.1 - migrate from Go regexp to embedded Google RE2</strong></summary>

> **Decision:** move only the final verifier from Go `regexp` to embedded Google RE2.
> The AST + AC planner, cache, rule semantics, and standard Go WASM runtime stayed the same.

Chrome crawled the same 20 pages from `https://github.com/` with the same 1.85 MB,
6,908-rule corpus.

| Chrome crawler, 20 successful pages | Standard Go `regexp` | go-re2 (v0.5.1 default) |
|---|---:|---:|
| Total elapsed time | 12.52 s | **7.61 s** |
| Failed pages | 0 | 0 |
| Total hits | 90 | 90 |
| End-to-end change | — | **39% less time (1.65× throughput)** |
| WASM size | 4.62 MB | 13.45 MB |

> **Trade-off:** +8.8 MB WASM for roughly five seconds less work per 20-page crawl.
> TinyGo and the standard-library regex backend are not supported release targets.

</details>

<details>
<summary><strong>v0.5.0 - regex scaling and runtime history</strong></summary>

> **Headline:** the real 6,908-rule warm scan fell from 5–13 seconds to roughly
> 100–200 ms without changing regex matching semantics.

v0.4.0 indexed `body + word` matchers, but regex prefilters still performed thousands
of independent full-body searches. v0.5.0 adds required ASCII regex literals to the
shared Aho–Corasick index, scans the body once, and runs the original regex for the
remaining candidates. It also moves the WASM runtime from TinyGo to standard Go.

```text
Regex AST → required ASCII literals → shared AC index
                                            ↓
Page body ───────────────────────────→ scan once
                                            ↓
                              candidate regex set
                                            ↓
                                  original regex
```

**Real-rule workload**

| Real workload: 6,908 rules, 1.85 MB rules JSON, 195 KB Chinese HTML body | Result |
|---|---:|
| Regex patterns | 6,350 |
| Safely skipped by the prefilter | 6,341 (99.86%) |
| Regex patterns still executed | 9 |
| Runtime validation false negatives | 0 |
| Typical warm scan | ~100–200 ms |
| First scan, including rule parsing and AC construction | ~600 ms |
| Before regex-literal AC prefiltering | ~5–13 s |

The remaining cost came from a few broad HTML regexes: a rule-quality issue rather
than a general engine bottleneck.

**Safety contract**

The prefilter is deliberately one-way: it only skips a regex when the parsed
`regexp/syntax` AST proves that every possible branch is excluded.

| AST construct | Safe exclusion rule |
|---|---|
| Concatenation (`A B`) | Exclude when any required child is absent |
| Alternation (`A|B`) | Exclude only when every branch is excluded |
| Optional, character class, anchor, or unknown construct | Do not prefilter; run the regex |

Non-ASCII literals are never prefiltered, and Unicode folds such as `ſ`/`s` and `K`/`k`
fall back to the original regex. Tests covered AST branches, Unicode boundaries, and
the real 6,350-pattern workload with zero prefilter false negatives.

<details>
<summary>Supporting runtime and synthetic baselines</summary>

**Standard Go versus TinyGo**

The following is a 200-page synthetic continuous scan: 8,000 rules, bodies from
20–400 KB, varying matches, and a cached rule set.

| Metric | Standard Go (4.5 MB) | TinyGo (935 KB) |
|---|---:|---:|
| p50 | ~15 ms | ~16 ms |
| p90 | ~28 ms | ~28 ms |
| p99 | **~30 ms** | **~222–234 ms** |
| max | **~31 ms** | **~290–322 ms** |

TinyGo retained GC tail-latency spikes, so standard Go WASM became the release runtime.

**Synthetic word-only baseline**

This benchmark isolates the ordinary `word` path rather than the production regex
workload. It uses a ~98 KB body and measures 50 iterations after 30 warm-up calls.

| Rules | min | median | p90 | max |
|---:|---:|---:|---:|---:|
| 1,000 | 3.7 ms | 4.3 ms | 5.1 ms | 25.1 ms |
| 8,000 | 8.7 ms | 13.9 ms | 16.8 ms | 19.2 ms |

The first synthetic scan was ~150 ms including rule parsing and AC construction;
warm scans were ~15 ms.

</details>

**Reproduce**

```bash
make build                              # Go WASM + go-re2, production default
node scripts/bench-cold.mjs 8000        # first-scan curve
node scripts/bench-steady.mjs 8000      # synthetic steady-state distribution
```

</details>
