---
'agent-conductor': patch
---

Retain and durably track each cron occurrence's exact nominal time before delivery delays, and include
that immutable source instant plus the scheduling timezone in cron envelopes and schedule events.
