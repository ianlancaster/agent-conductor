---
'agent-conductor': patch
---

Do not report an idle or completed-compaction stall while text is waiting in the session's composer.

The idle confirmation path now consults the runtime-owned input parser immediately before routing
the stall. This preserves each runtime's placeholder handling—including plain iTerm captures—while
preventing a sentinel from interrupting a human who is composing a message in the pane.
