---
'agent-conductor': minor
---

Add a fleet-scoped `conductor kill` recovery command that verifies the ownership lock and process
identity before stopping an orphaned Conductor, while leaving managed session panes running.
