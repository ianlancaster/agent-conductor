---
'agent-conductor': patch
---

Let exact-head PR Shepherd claims safely take ownership of pull requests that already have a GitHub
merge-queue entry or persistent auto-merge. The durable, idempotent handoff compensates provider
state before creating the tracked generation and resumes safely after failures or crashes.
