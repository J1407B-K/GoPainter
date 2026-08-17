---
name: gopainter-regex-matcher
description: Create GoPainter-native regex matchers compatible with its Go RE2 execution backend. Use when fingerprint evidence requires bounded structural or variable-text matching.
---

# GoPainter regex matcher

## Workflow

Apply this workflow only when the active goal produces or edits a fingerprint rule. For site identification, use its evidence constraints without returning matcher syntax.

1. Inspect the page and search existing rules. Verify candidate text with page-body search or an approved public source.
2. Produce `regex: [string]` inside a matcher with `type: regex`.
3. Keep patterns RE2-compatible. Do not use lookaround, backreferences, recursion, atomic groups, or backtracking-only syntax.
4. Anchor patterns around stable literals and keep repetition bounded. Avoid broad `.*` scans when a narrower expression works.
5. Prefer a `word` matcher when a literal substring is sufficient.
6. Run `test_regex` before returning a pattern. Treat a Go RE2 compilation error as a hard rejection.
7. Account for YAML quoting separately from regex escaping.

## Tools

- `inspect_page`: Read the bounded current-page overview.
- `search_rules`: Search existing native rules.
- `search_page_body`: Verify bounded structural evidence on the current page.
- `test_regex`: Compile and test patterns with the production Go RE2 backend.
- `web_search`: Search approved public sources after host permission.
- `fetch_url`: Read bounded text from an approved public source after host permission.

## Completion

- When producing a rule, return only RE2-compatible matcher structures supported by GoPainter.
- Explain the positive evidence and likely false-positive boundary.
