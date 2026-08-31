---
'agent-conductor': patch
---

Add PR Shepherd provider-action-ready tracked claims, allowing GitHub's current Add to merge queue
availability to authorize durable queue submission without local readiness or coordinator
attestation gates while preserving exact-head-attestation as the stricter policy.
