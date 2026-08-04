---
'agent-conductor': minor
---

Publish whether an operator is attached as a typed observation. Whether a human is listening decides
what deferring to one costs: with an operator attached, an unanswered question is a pause; with none,
it is a termination with no timeout and no signal — observed on a dogfooding fleet when a sentinel
escalated a judgement call to an absent operator and stopped receiving messages for five hours.
`operator.attachment.changed` carries the attached surfaces and the last inbound operator
interaction, for host applications and the event journal.

It is deliberately not exposed to managed sessions. A session that could read attachment state would
change its behaviour on the basis of the measurement, which turns a recorded condition into an
intervention — a distinction that matters for anyone using Conductor to study agent behaviour rather
than only to run it.
