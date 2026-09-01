---
'agent-conductor': patch
---

Fix the stray blank newline left in Codex's input composer after every iTerm-backed start and
resume: the delivery submit keystroke now sends exactly one carriage return instead of letting
iTerm's `write text` append a second one that leaked past the shell into the launched runtime.
