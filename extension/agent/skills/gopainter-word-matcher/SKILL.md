---
name: gopainter-word-matcher
description: Create GoPainter-native literal, HTTP status, and favicon hash matchers. Use when fingerprint evidence can be expressed without structural regular expressions or runtime probes.
---

# GoPainter word matcher

## Workflow

Apply this workflow only when the active goal produces or edits a fingerprint rule. For site identification, use its evidence constraints without returning matcher syntax.

1. Inspect the page and search existing rules before proposing a matcher. Search the page body only when the current page is relevant; use approved web search for public evidence.
2. Prefer `word` for stable literal evidence instead of wrapping a substring in regex.
3. Select the narrowest accurate `part`: `body`, `title`, `url`, `header`, `raw`, `meta`, or `script`.
4. Use `condition: and` only when every listed value must exist; otherwise use `or`.
5. Use integer arrays for `status`, and verified signed mmh3 integers for `icon_hash`.
6. Run `test_word_matcher` against representative positive and negative samples before returning the matcher.
7. Reject generic product names or ordinary page copy as fingerprint evidence.

## Tools

- `inspect_page`: Read the bounded current-page overview.
- `search_rules`: Search existing native rules.
- `search_page_body`: Verify bounded literal evidence on the current page.
- `test_word_matcher`: Test native word-matcher semantics in Go.
- `web_search`: Search approved public sources after host permission.

## Completion

- When producing a rule, return only matcher structures supported by GoPainter.
- Explain the positive evidence and likely false-positive boundary.
