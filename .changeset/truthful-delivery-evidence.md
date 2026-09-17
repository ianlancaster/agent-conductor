---
'agent-conductor': patch
---

Require runtime-owned post-write evidence before protected terminal input is reported as delivered.

Unknown-effect submissions now become durable `uncertain` receipts before the terminal write, are
never replayed automatically across retries or restarts, and route one actionable blocked-delivery
health signal without overwriting independent runtime activity.
