---
'agent-conductor': patch
---

Stop PR Shepherd review follow-up from emitting scoped re-review work solely because a pull request head changed. Explicit review requests and review-thread activity continue to emit the existing event.
