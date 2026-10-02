---
'agent-conductor': patch
---

Add an opt-in PR Shepherd merge-queue preflight that synchronizes against the exact target-base
SHA, requires source-run-backed exact-head validation, and safely yields to provider-owned queue
recovery and hold signals before every Shepherd enqueue.

Add a general `automation.holdLabels` admission condition that suspends direct and merge-queue
mutations across authored and tracked lanes without cancelling durable pending work.
