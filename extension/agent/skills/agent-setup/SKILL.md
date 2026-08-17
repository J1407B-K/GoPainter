---
name: agent-setup
description: Verify that the configured model can make a native tool call and accept its result. Use when testing an Agent provider connection.
---

# Agent setup

## Workflow

1. Call `ping` to verify that the configured model can issue a native tool call.
2. Confirm that the model receives the local result.
3. Stop after the successful result. Do not inspect pages, rules, storage, or the network.

## Tools

- `ping`: Return a read-only local connectivity result.

## Completion

- Finish only after receiving the `ping` result.
- Rely on host-enforced tool permissions, not this document, for the security boundary.
