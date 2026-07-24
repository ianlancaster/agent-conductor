---
'agent-conductor': patch
---

Make fleet `.conductor/.env` values authoritative over stale inherited variables so a normal restart reliably loads updated operator-channel credentials.
