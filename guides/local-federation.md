# Connect local Conductor fleets

Local federation lets separately configured Conductor instances running as the same OS user discover one
another and exchange durable agent messages. It is optional, disabled by default, and messages-only:
peers cannot start, stop, inspect, spawn, tear down, or type into another fleet's sessions.

## Trust boundary

Each Conductor binds a dedicated federation server to loopback and registers it under
`~/.agent-conductor/federation/`. Registry records and link credentials are owner-only. The credential
mechanically maps an inbound request to a fleet, but it is not a sandbox against another process running
as the same OS user: such a process can read the registry. Do not use local federation across OS users or
as a network protocol.

Only explicitly exposed sessions are visible and allowed to send or receive peer messages. Published
metadata is limited to the stable instance ID, fleet name, operator-authored public descriptions,
session codename, stopped/running presence, and the `messages` capability. Paths, branches, models,
effort, tags, pane output, schedules, and health details are never published.

## Configure two fleets

Give each fleet a unique lowercase slug and expose only intended participants:

```yaml
# ~/fleet-a/.conductor/config/supervisor.yaml
federation:
  name: fleet-a
  description: Coordinates application work
  sessions:
    expose: [alpha]
    descriptions:
      alpha: Application coordinator
  local:
    enabled: true
    registryDir: null
    heartbeatSeconds: 5
    staleAfterSeconds: 20
```

```yaml
# ~/fleet-b/.conductor/config/supervisor.yaml
federation:
  name: fleet-b
  description: Reviews changes
  sessions:
    expose: [reviewer]
    descriptions:
      reviewer: Independent code reviewer
  local:
    enabled: true
    registryDir: null
    heartbeatSeconds: 5
    staleAfterSeconds: 20
```

`name` defaults to the fleet's existing stable slug. Explicit names make addresses easier to remember.
Use `expose: ['*']` only when every current and future registered session should be public to local
same-UID peers. Descriptions are deliberately public, limited to 200 characters, and valid only for
exposed sessions. A fleet may expose at most 100 sessions; wildcard exposure is validated after
expansion. Unknown sessions and duplicate live fleet names fail validation/startup. Exposure and
public-description edits use last-good hot reload; invalid edits are logged without replacing the active
policy. Enabling/disabling federation or changing its name still requires a restart because those values
own transport lifecycle and identity.

Start or restart both Conductors after the initial transport configuration:

```bash
conductor -C ~/fleet-a start
conductor -C ~/fleet-b start
```

## Discover and message

From a managed session, federation adds:

- `list_peers`
- `send_to_peer`
- `get_peer_message_status`

Addresses are qualified as `session@fleet`. Copy the exact address returned by `list_peers`; do not
synthesize it. For example, `alpha` can send:

```text
send_to_peer({
  "address": "reviewer@fleet-b",
  "message": "Please review the proposed change.",
  "idempotencyKey": "review-request-42"
})
```

The receiver sees:

```text
[Message from alpha@fleet-a] Please review the proposed change.
```

It replies by copying that exact sender into `send_to_peer`. A bare codename remains local. Supplying a
qualified address to `send_to_session` returns guidance to use `send_to_peer`.

Operators use:

```text
/peers
/tell-peer alpha reviewer@fleet-b Please review the proposed change.
/peer-message-status <message-uuid>
```

The operator command names the exposed local session represented as the sender. Session MCP callers do
not supply a source identity; Conductor derives it mechanically from their MCP endpoint.
Fleet-wide `/status` also shows local federation health: running state, last registry/peer contact,
queued and received counts, oldest pending age, and the last typed error code. It never includes
message bodies, credentials, or private session metadata.

## Delivery and lifecycle semantics

`send_to_peer` persists before attempting HTTP delivery and returns a UUID receipt. Its optional
`idempotencyKey` is scoped to the local source session, so a retry returns the original receipt.

Statuses mean:

- `queued`: the origin Conductor durably owns retry responsibility.
- `received`: the destination Conductor durably accepted the final-hop message.
- `delivered`: the destination's protected queue submitted it to the agent pane.
- `expired`: the seven-day undelivered deadline elapsed.
- `failed`: a permanent address, exposure, validation, or collision error occurred.

Federation never starts a recipient. A stopped exposed session retains an accepted message until an
operator starts it; ordinary pending-message recovery then delivers it. Every retry preserves the same
federation UUID, and the destination deduplicates it atomically with the local message row.
Terminal origin receipts and expired federation correlation metadata are retained for 30 days. The core
local message row follows Conductor's ordinary message-retention policy.

## Troubleshooting

| Symptom                                     | Check                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/peers` is empty                           | Both local adapters must be enabled and running; each fleet must explicitly expose at least one session.        |
| Duplicate federation name at startup        | Set a unique lowercase `federation.name`; live instances may not share a friendly name.                         |
| `recipient_hidden`                          | Add the target codename to the destination's `federation.sessions.expose`; the policy hot-reloads last-good.    |
| Source session cannot send                  | Add it to its own fleet's exposure list so its qualified sender address remains replyable.                      |
| Message remains `queued`                    | The peer is offline or restarting. Inspect `/peer-message-status`; retry ownership remains durable at origin.   |
| Message remains `received`                  | The destination accepted it but its stopped/busy session has not completed protected pane delivery.             |
| Registry appears stale after a crash        | Records older than `staleAfterSeconds` are pruned regardless of PID reuse. A live peer recreates its heartbeat. |
| Two fleets use different registry locations | Leave `registryDir: null` on both, or set the same absolute advanced/test override.                             |

Clean shutdown removes only the current process's matching registry record. Crash leftovers contain a
short-lived credential and are removed after their heartbeat becomes stale.

Run the [manual local-federation shakedown](../test/manual/local-federation.md) before relying on a new
installation for active work.
