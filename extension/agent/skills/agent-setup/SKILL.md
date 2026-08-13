---
name: agent-setup
description: Verify the configured model can make a native tool call and accept its result. Use when testing an Agent provider connection.
---

# Agent connection verification

Use `ping` to verify that the configured model can issue a native tool call and
accept its result. `ping` is read-only and has no page, rule-set, network, or
storage side effects. Stop after the model receives the tool result.

Tool permissions are enforced by the extension host, not this document.
