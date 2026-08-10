---
'agent-conductor': patch
---

Suppress automated delivery from background integrations, PR Shepherd, stalls, and cron schedules
while a recipient session is paused, including queued work and pause races, while keeping human
messages available.
