---
'agent-conductor': minor
---

Make the "a session cannot toggle its own auto mode" rule configurable at both the fleet and the
session level. `defaults.allowSelfAuto` sets the fleet policy and a session's `allowSelfAuto`
overrides it in either direction, so a fleet can grant self-management to one worker without opening
it to everything, or open it fleet-wide and still withhold it from a specific session. Both default
to the previous behavior, so existing fleets are unchanged.

The resolved value is observable rather than implicit: `whoami` and `get_session_status` both report
`allowSelfAuto`, and a refusal now names the policy instead of stating a flat rule. The permission is
deliberately narrow — a session still cannot start, stop, continue, pause, resume, or tear itself
down, `toggle_auto all` includes the caller only when its own policy permits, and a federated peer
that shares a codename is still a different session governed by the ordinary peer rules.
