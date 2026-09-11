---
'agent-conductor': minor
---

Add a disabled-by-default PR Shepherd merge-queue recovery that conditionally syncs one recent,
unchanged, conclusively attributed rejected head before exact-head CI and readiness-based re-entry.
Optionally post one repository-configured, exact-head PR validation command after the confirmed
sync and require a new passing check with a configured exact name on that same head before re-entry.
Treat complete upstream-queued-PR attribution as unrelated, and preserve an attributable
failed-eviction validation obligation across later author heads by invalidating old proof and
issuing the existing exact-head trigger for each new current head without another recovery sync.
