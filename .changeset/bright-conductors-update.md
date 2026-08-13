---
'agent-conductor': minor
---

Add `conductor update` for Git-source installations. It fetches the source remote, preserves local
feature work, permits only unambiguous fast-forwards, rebuilds and verifies the package, refreshes
the global CLI link, and migrates the selected fleet database.

Declare the fleet-store schema version explicitly and check it before startup. Behind databases
migrate in the parent process so failures are immediately visible; when a database is ahead of the
loaded binary, startup attempts the same strictly safe source refresh and restarts under the updated
binary. Dirty, detached, diverged, running, or still-incompatible sources fail with an actionable
diagnostic and never downgrade the database.
