---
'agent-conductor': patch
---

Replace named fleet stall watches with one persisted fleet-wide toggle. Fleet watch now follows
the registered roster automatically, excludes the sentinel, and uses a 15-second confirmation by default.
