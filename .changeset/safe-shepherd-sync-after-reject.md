---
'agent-conductor': minor
---

Add a disabled-by-default PR Shepherd merge-queue recovery that conditionally syncs one recent,
unchanged, conclusively attributed rejected head before exact-head CI and readiness-based re-entry.
Optionally post one repository-configured, exact-head PR validation command after the confirmed
sync and require a new passing check with a configured exact name on that same head before re-entry.
