---
name: gopainter-runtime-matcher
description: Create GoPainter-native JavaScript property, DOM selector, and DSL matchers. Use when reliable fingerprint evidence exists only in page runtime state, DOM structure, or supported cross-field expressions.
---

# GoPainter runtime matcher

## Workflow

Apply this workflow only when the active goal produces or edits a fingerprint rule. For site identification, use its evidence constraints without returning matcher syntax.

1. Inspect the target and search existing rules. Use runtime search to verify property paths; use approved web search for public evidence.
2. Use `js: [{path, pattern?}]`; treat `path` as a runtime property path, never JavaScript source.
3. Use `dom: [{sel, text?, attrs?}]` with specific, stable selectors and verified constraints.
4. Keep DSL expressions within GoPainter identifiers, `contains`, `matches`, comparisons, booleans, and parentheses.
5. Run `evaluate_dsl` against the current page before returning a DSL matcher.
6. Never place executable JavaScript in `condition`; it accepts only `and` or `or`.

## Tools

- `inspect_page`: Read the bounded current-page overview.
- `search_rules`: Search existing native rules.
- `search_page_js`: Verify bounded runtime property paths on the current page.
- `evaluate_dsl`: Evaluate native DSL expressions against current-page features.
- `web_search`: Search approved public sources after host permission.

## Completion

- When producing a rule, return only runtime matcher structures supported by GoPainter.
- Explain the positive evidence and likely false-positive boundary.
