# GoPainter performance notes

This is the project's living performance record. Every material performance change,
its measured workload, trade-offs, and reproduction command belongs here. The goal
is not to collect micro-benchmarks; it is to make future design decisions auditable.

## v0.6.1 - remove JavaScript and DOM long tasks

v0.6.1 targets the UI-side stalls that remained after the matcher became fast. The
content script no longer materializes the complete document before truncating it;
it now serializes at most 200 KB and stops walking immediately at the limit.
Favicon downloads use six workers, rule/hash/script data is cached until storage
changes, and rescans read only the session entries for open tabs.

Popup snapshots remain bounded at 100 hits, 20 evidence rows per hit, and 500
characters per evidence row. Options, history, hash, and crawl views render at most
300 rows; crawl polling skips unchanged result DOM. A 20,000-rule Chromium run
rendered exactly 300 rule rows, produced 1,080 DOM nodes, and loaded in 32 ms in the
test profile.

| JavaScript benchmark | Result |
|---|---:|
| Filter 10,000 / 50,000 rules | 0.56 / 5.12 ms |
| Filter and sort 10,000 / 50,000 hits | 0.98 / 6.46 ms |
| Compact 2,000 hits x 40 evidence rows | 0.20 ms |
| Compile 100 user scripts / run cached scripts | 0.06 / 0.01 ms |
| Stringify 10,000 custom hashes / cached read | 0.70 / <0.01 ms |
| Three rule searches across 50,000 rules, legacy / indexed | 43.23 / 1.56 ms |

The matching engine stayed in its existing range after these changes: the 8,000-rule
steady benchmark measured a 13.6 ms median, while the 200-page scan measured 28.0 ms
p90 and 31.2 ms p99. Run the JS suite with `make bench-js`.

The Agent path now reads a body-free page overview and shares a cooperatively built
rule-search index. In a Chromium end-to-end run with 20,000 rules, one model round
requested `inspect_page`, three `search_rules` calls, and `search_page_js` before
synthesis. A 10 ms popup heartbeat observed a maximum delay of 37.1 ms throughout.

### Reproduce v0.6.1

```bash
make bench-js                         # JS, popup, collection, and Agent search paths
node scripts/bench-cold.mjs 8000 12  # matcher cold-start curve
node scripts/bench-steady.mjs 8000   # matcher steady-state distribution
node scripts/bench-scan.mjs 8000 200 # continuous 200-page distribution
make test                             # Go, JS, and WASM smoke coverage
```

## Version history

<details>
<summary><strong>v0.5.1 - migrate from Go regexp to embedded Google RE2</strong></summary>

Historical measurements for migrating the final verifier from Go's standard-library
`regexp` to `wasilibs/go-re2`. The main runtime had already moved to standard Go
WASM in v0.5.0; v0.5.1 changes the regex verifier, not the WASM toolchain.

## v0.5.1 — migrate from Go regexp to embedded Google RE2

v0.5.0 made the planner effective: AST + AC eliminates nearly every regex that can
be proved irrelevant. v0.5.1 migrates the verifier for the small set that remains
from Go's standard-library `regexp` to embedded Google RE2 through `wasilibs/go-re2`.
It retains RE2's linear-time, safe matching model and leaves the planner, cache, and
rule semantics unchanged.

This was selected by end-to-end measurement, not a microbenchmark. Chrome crawled the
same 20 pages from `https://github.com/` using the same 1.85 MB / 6,908-rule corpus.

| Chrome crawler, 20 successful pages | Standard Go `regexp` | go-re2 (v0.5.1 default) |
|---|---:|---:|
| Total elapsed time | 12.52 s | **7.61 s** |
| Failed pages | 0 | 0 |
| Total hits | 90 | 90 |
| End-to-end improvement | — | **39% less time (1.65× throughput)** |
| WASM size | 4.62 MB | 13.45 MB |

The extra 8.8 MB is an intentional trade: this is an automatic scanner and crawler,
where a five-second reduction per 20-page crawl is materially more valuable than a
smaller binary. The runtime comparisons retained under v0.5.0 are historical only;
neither TinyGo nor the standard-library regex backend is a supported release target.

</details>

<details>
<summary><strong>v0.5.0 - regex scaling and runtime history</strong></summary>

Historical measurements for the v0.5.0 matching-path redesign and its runtime baselines.

## v0.5.0 — make regex rules scale

v0.5.0 is a performance-focused release. In v0.4.0, large imported rule sets could
turn ordinary page scans into multi-second work: regexes were correctly prefiltered,
but thousands of prefilters still searched the same HTML body independently.

The fix is deliberately conservative: a regex is skipped only after its parsed
syntax tree proves that **every** matching branch is impossible. Required ASCII
literals are collected when the rule set is built, indexed in a shared
Aho–Corasick (AC) automaton, and found by scanning the page body once. The original
regex remains the final authority.

This is a change in execution strategy, not a weakening of detection.

### Comparison with v0.4.0

#### v0.4.0 — fast word matching, incomplete regex scaling

v0.4.0 already cached the parsed rule set and used AC for `body + word`
matchers. This made ordinary word-rule workloads fast, but imported rule sets are
mostly regex-driven: their regex prefilters still performed thousands of independent
`Contains(body, literal)` scans. The result was good synthetic word performance but
multi-second latency on real pages with large regex corpora.

#### v0.5.0 — one body scan for words and regex candidates

v0.5.0 extends the existing body AC index to required regex literals. It adds
conservative AST branch analysis, Unicode-safe prefilter boundaries, and direct
evidence/result allocation reductions. It also moves the WASM runtime from TinyGo
to standard Go after continuous-scan measurements showed that TinyGo's GC p99
remained 7–10× worse even after the matching work was reduced.

The outcome is not merely a lower average: v0.5.0 turns the actual 6,908-rule
workload from a blocking multi-second operation into a generally background-safe
scan while preserving the original regex as the final check.

| Real workload: 6,908 rules, 1.85 MB rules JSON, 195 KB Chinese HTML body | Result |
|---|---:|
| Regex patterns | 6,350 |
| Safely skipped by the prefilter | 6,341 (99.86%) |
| Regex patterns still executed | 9 |
| Runtime validation false negatives | 0 |
| Typical warm scan | ~100–200 ms |
| First scan, including rule parsing and AC construction | ~600 ms |
| Before regex-literal AC prefiltering | ~5–13 s |

The remaining cost is a handful of broad HTML regexes (for example, a XenForo
pattern), which are rule-quality concerns rather than a general engine bottleneck.

### Execution strategy changes

| v0.4.0 | v0.5.0 |
|---|---|
| Each regex prefilter repeatedly searched the full body | One AC scan produces a shared literal-hit set |
| 195 KB real pages could take 5–13 s | Typical warm scan is ~100–200 ms |
| Compiler/GC looked like the likely culprit | Profiling identified repeated regex prefilter scans as the dominant cost |
| TinyGo was the default build | Standard Go removes TinyGo GC tail-latency spikes |

## The v0.5.0 matching path

AC does **not** replace regular expressions. It acts as a candidate filter.

```text
Regex AST -> required ASCII literals -> AC index, built once per rule set
                                                |
Page body ----------------------------------- scan once
                                                |
                                   literal-hit set
                                                |
Regex AST proves every branch impossible? -- yes --> skip regex
                                                |
                                               no
                                                |
                                    run the original regex
```

For example, `Powered by <a href="[^>]+phpfusion` cannot match unless the
page contains `phpfusion`. AC finds all such literals in one pass, instead of
letting every regex repeatedly scan the whole HTML body.

### Correctness is non-negotiable

The prefilter is deliberately one-way: it only skips a regex when the parsed
`regexp/syntax` AST proves that every possible branch is excluded.

| AST construct | Safe exclusion rule |
|---|---|
| Concatenation (`A B`) | Exclude when any required child is absent |
| Alternation (`A|B`) | Exclude only when every branch is excluded |
| `*`, `?`, character classes, anchors, unknown constructs | Do not prefilter; run the regex |

The matcher uses Go's case-insensitive regex semantics. To avoid Unicode folding
false negatives, non-ASCII literals are never prefiltered, and body text containing
non-ASCII runes that fold to ASCII (such as `ſ`/`s` and `K`/`k`) falls back to the
original regex. Chinese and emoji alone do not disable ASCII-literal filtering.

Unit tests cover branch semantics, Unicode folding boundaries, and equivalence of
the AC literal-hit set with the former `strings.Contains` prefilter. A runtime
verification pass over the real 6,350-pattern rule set and page reported zero
false negatives; the original regex remains the final matcher in all cases.

### Supporting optimisations

- Rule JSON, compiled regexes, AC index, and name lookup are cached while the rule
  set is unchanged.
- `raw` / lowercased `raw` text is built only when a rule needs it.
- The body AC scan skips non-ASCII bytes directly when the index holds only ASCII
  words (a single reset per byte). Chinese and other non-ASCII pages therefore skip
  the fail-transition work entirely; semantics are unchanged because a non-ASCII
  byte can never match an ASCII word.
- Matcher and rule `and`/`or` results are folded incrementally, avoiding temporary
  result slices.
- Evidence is appended directly to the rule result, avoiding intermediate slices.
- `implies` and `excludes` post-processing is skipped when the rule set has none.

## Historical runtime comparison: Go WASM versus TinyGo

The following is a 200-page synthetic continuous scan: 8,000 rules, bodies from
20–400 KB, varying matches, and a cached rule set.

| Metric | Standard Go (4.5 MB) | TinyGo (935 KB) |
|---|---:|---:|
| p50 | ~15 ms | ~16 ms |
| p90 | ~28 ms | ~28 ms |
| p99 | **~30 ms** | **~222–234 ms** |
| max | **~31 ms** | **~290–322 ms** |

TinyGo preserves its GC tail-latency spikes even after prefiltering removes most
regex work. The production runtime is therefore Go WASM; v0.5.1 then upgrades its
regex verifier to go-re2. TinyGo is retained only for historical/development comparison and is not maintained as a release target.

## Baseline: synthetic word rules

This benchmark isolates the ordinary `word` path rather than the production regex
workload. It uses a ~98 KB body and measures 50 iterations after 30 warm-up calls.

| Rules | min | median | p90 | max |
|---:|---:|---:|---:|---:|
| 1,000 | 3.7 ms | 4.3 ms | 5.1 ms | 25.1 ms |
| 8,000 | 8.7 ms | 13.9 ms | 16.8 ms | 19.2 ms |

The original first scan of this synthetic workload is ~150 ms because it includes
rule JSON parsing and AC construction. Warm scans are ~15 ms.

## Reproduce the measurements

```bash
make build                              # Go WASM + go-re2, production default
node scripts/bench-cold.mjs 8000        # first-scan curve
node scripts/bench-steady.mjs 8000      # synthetic steady-state distribution
```

</details>
