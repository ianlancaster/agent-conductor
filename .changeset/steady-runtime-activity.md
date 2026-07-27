---
'agent-conductor': patch
---

Continuously reconcile Claude Code and Codex working/idle activity from their runtime-owned composer state, preserve state on inconclusive captures, and track overlapping Codex turns without treating a nested completion as a completed pane.
