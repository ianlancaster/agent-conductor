---
'agent-conductor': minor
---

Add optional per-session `continuityStateFile` support for bounded current state that is validated
before launch and read fresh at Claude Code and Codex startup, native resume, and confirmed
compaction boundaries, with content-free degraded-restoration diagnostics and no terminal input.
