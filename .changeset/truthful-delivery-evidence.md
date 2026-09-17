---
'agent-conductor': patch
---

Require runtime-owned post-write evidence before protected terminal input is reported as delivered.

Unknown-effect submissions now become durable `uncertain` receipts before the terminal write, are
never replayed automatically across retries or restarts, and retain one owner notice until a console
or channel accepts it without overwriting independent runtime activity. Operators can durably record
an inspected receipt as `manually-submitted` or `abandoned`; this preserves the uncertain transport
receipt, reconciles parked Shepherd delivery from evidence, and performs no terminal action.
Reconciliation waits until the original terminal attempt has fully settled.
