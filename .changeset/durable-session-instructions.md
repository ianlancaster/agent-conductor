---
'agent-conductor': minor
---

Make per-session `systemPromptFile` instructions durable across Claude Code and Codex compaction.
Conductor now validates and privately snapshots up to 5 KiB of UTF-8 role instructions on each
start or continue, fails visibly for invalid sources, preserves provider-specific instruction
ordering, and restores the prepared Codex layers through its compact-only lifecycle hook without
typing into the pane or mutating the working repository.
