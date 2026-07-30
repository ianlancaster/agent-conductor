---
'agent-conductor': minor
---

Let a fleet refuse selectable operator requests at the server

Some fleets hold that an agent must not put a blocking decision in front of a human. Enforcing that
from the agent side does not work: a runtime hook can deny a tool call and the runtime may execute it
anyway, which was demonstrated live. `send_to_operator` is Conductor's own operation, so Conductor is
the boundary that can actually refuse it.

`messaging.allowOperatorRequestOptions` (default `true`) governs whether sessions may raise selectable
requests. Set `false` and:

- a `send_to_operator` call carrying `options` is refused **before** any `operator_requests` row is
  inserted and before any `operator.request.created` event is emitted — rejected, not compensated,
  since a row created and rolled back has still taken an id and announced itself;
- empty and malformed option lists are refused for the same stated reason rather than falling through
  to a shape complaint, which would tell an agent that a well-formed list would be accepted;
- `send_to_operator` stops advertising `options` in its MCP schema and says so in its description, so
  no agent reads a capability this fleet does not have;
- prose-only `send_to_operator` is unchanged, and existing rows, `respond_to_operator_request`, and
  every read path over them keep working — enabling the policy cannot strand a pending question.

The default preserves current behavior exactly; no fleet loses the capability without asking for it.
