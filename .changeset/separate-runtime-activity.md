---
'agent-conductor': patch
---

Separate runtime execution detection from protected-delivery composer detection so active Claude
Code and Codex turns remain working when their panes also expose an input composer, including after
a Conductor restart.
