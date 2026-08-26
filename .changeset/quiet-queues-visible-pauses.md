---
'agent-conductor': patch
---

Fix protected Codex delivery stalls and make paused automation operationally visible.

Recognize current Codex empty-composer hints on plain iTerm captures, record a specific flush state
for every FIFO-waiting receipt, and retry protected delivery on raw recipient activation. Persist
pause start times, inject and return warnings during direct operator interaction, show all
configured PR Shepherd states in fleet status, and allow an explicitly paused session to resume
itself so managed ingestion can recover without a silent outage.
