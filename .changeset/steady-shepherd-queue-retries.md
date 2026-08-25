---
'agent-conductor': patch
---

Fix PR Shepherd merge-queue recovery by observing queue membership and removal reasons, emitting a
factual eviction event, and durably retrying an eligible unchanged head with exact-head checks,
increasing backoff, restart-safe attempt generations, and bounded exhaustion.
