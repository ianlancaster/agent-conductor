---
'agent-conductor': patch
---

Route compaction stalls only after the runtime reports completion and its composer confirms the
session is waiting, while keeping different stall kinds from suppressing one another.
