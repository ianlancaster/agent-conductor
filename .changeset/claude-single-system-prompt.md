---
'agent-conductor': patch
---

Fix Claude Code sessions silently losing `systemPromptFile`. Claude Code keeps only the last `--append-system-prompt-file` argument, so the session layer was dropped in favor of the protocol. Conductor now writes the session instructions and then the protocol into one private `system-prompt.md` and passes it once. Each layer keeps its own size check, and the protocol stays last and complete.
