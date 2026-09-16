---
'agent-conductor': patch
---

Preserve bounded GitHub merge-queue removal actor and enqueuer evidence, and allow the existing
exact-head retry sequence to recover from provider-confirmed GitHub Actions manual removals while
continuing to fence human and unverified manual removals.
