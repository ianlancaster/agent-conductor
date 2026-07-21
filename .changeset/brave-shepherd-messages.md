---
'agent-conductor': minor
---

Add the standalone PR Shepherd V2 service with strict profiles, a transactional SQLite
event/outbox engine, async GitHub polling, configurable enterprise workflows, and durable
Conductor delivery. Extend `send_to_session` with sender-scoped idempotency keys and structured
persisted-message receipts.
