---
'agent-conductor': minor
---

Add rooms: named group conversations for managed sessions and the operator. `create_room`,
`join_room`, `leave_room`, `close_room`, `send_to_room`, and `list_rooms` are canonical operations
with a matching `/room` operator command, so several sessions can hold one conversation instead of
a mesh of direct messages. A room message reaches every member except the sender as
`[Room: <name> from <sender>]`, and the injected protocol instructs agents to reply into the room
rather than by direct message. Membership notices are explicitly informational no-ops in both the
notice text and the protocol.

Rooms broadcast rather than address: they deliver to members that are running, skip and report
members that are stopped instead of starting them, and mint no delivery receipts. Rooms also span
local federation. Each fleet owns its own members and publishes them in an additive `rooms` field
on its peer registry record, so no protocol bump is required and a peer built before this release
stays compatible. A locally-originated fan-out calls each participating fleet directly and a
peer-originated call acts on local members only, so a room message crosses at most one fleet
boundary and is never relayed onward. Only federation-exposed sessions take part in cross-fleet
room traffic. `/room say` and `/room close` carry an explicit operator origin across fleets, which
grants no additional authority: a peer caller is still authorized as a peer session, still limited
to routable operations, and still exposure-filtered.
