---
'agent-conductor': minor
---

Allow `continue_session` and `/continue` to resume a specific native Claude Code or Codex
conversation by passing an optional session ID (`-s`/`--session-id` in operator commands), while
preserving latest-conversation behavior when the ID is omitted.
