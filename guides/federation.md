# Local Conductor Federation

Local federation connects independently running Agent Conductors owned by the same user on one
machine. It adds discovery and routing to the existing agent operations; it is not a workflow
engine, shared database, remote-control service, or network federation.

Federation is completely opt-in. With no `federation` block, Conductor publishes no registry
record, exposes no federation ingress or discovery tool, and gives managed agents the same tool
schemas they had before this feature.

## Prerequisites

Participating Conductors must run on the same machine as the same operating-system user, bind MCP
to `127.0.0.1` or `localhost`, and use compatible Conductor federation protocol versions.
Each running participant needs a unique federation name and MCP port. Named instances derive
separate ports automatically; separate fleet directories normally do as well, and an explicit
`mcp.port` resolves a rare derived-port collision.

## Minimal configuration

Add one block to each participating instance's `supervisor.yaml`:

```yaml
federation:
  name: frontend
  expose:
    - coordinator
    - reviewer
```

`name` is the fleet's unique public routing name. It must be lowercase letters or digits followed
by lowercase letters, digits, or hyphens, with a maximum length of 64 characters.

`expose` controls which sessions peers may discover and address:

```yaml
# Expose the entire current roster. The wildcard must be the only item.
federation:
  name: backend
  expose: ['*']
```

Use `expose: []` to participate in discovery without exposing a session. Explicit names are
allowlist reservations: an absent name is valid but unpublished, becomes exposed if that session is
later spawned, and becomes unpublished again after teardown. Duplicate entries, invalid codenames,
malformed session files, and a wildcard mixed with names fail validation. `"*"` exposes the current
configured roster and follows it as sessions are added or removed.

Supervisor configuration requires a deliberate restart. Session files still hot-reload. With
wildcard exposure, the published roster follows additions and removals; explicit exposure shows
only names that are currently registered.

## Discovery and routing

A managed session in a federated Conductor receives one additional tool:

```json
list_federation({})
```

It returns one direct snapshot:

```json
{
  "localFleet": "frontend",
  "fleets": [
    { "name": "backend", "sessions": ["api", "reviewer"] },
    { "name": "frontend", "sessions": ["coordinator"] }
  ]
}
```

`localFleet` is the configured public name of the Conductor handling the call. `fleets` includes
that local fleet and every directly reachable, protocol-compatible peer. It never asks peers for
their view, so discovery is non-transitive and does not construct a topology graph.

Routable session tools gain one optional `fleet` argument. Omit it for ordinary local behavior,
or pass `localFleet` explicitly. To address a peer, pass a discovered fleet name separately from
the local target codename:

```json
send_to_session({
  "fleet": "backend",
  "codename": "reviewer",
  "message": "Please review the API boundary.",
  "idempotencyKey": "api-boundary-review-v1"
})
```

The remote receiver sees a qualified mechanical origin such as
`[Message from coordinator@frontend]`. To reply, it uses `codename: "coordinator"` and
`fleet: "frontend"`. A qualified string such as `codename: "coordinator@frontend"` is rejected
with guidance because codename and fleet are separate parameters.

Remote message receipts include `fleet`. Receipt numbers are local to their destination database,
so keep that field and pass it to `get_message_status` or `cancel_message`:

```json
get_message_status({ "fleet": "backend", "messageId": 42 })
```

Unknown, stopped, incompatible, or otherwise unavailable fleets fail explicitly. A failed remote
lookup never falls back to a same-named local session.

## What routes

Federation reuses these existing session operations:

- messaging: `send_to_session`, `broadcast`, `get_message_status`, `cancel_message`;
- rooms: `join_room`, `leave_room`, `send_to_room`, `close_room`;
- observation: `list_sessions`, `get_session_status`, `tail_session`;
- lifecycle and workspaces: `start_session`, `continue_session`, `stop_session`, `spawn_session`,
  `teardown_session`;
- terminal control: `type_in_pane`; and
- modes and metadata: `pause_session`, `resume_session`, `toggle_auto`, `set_tag`, `set_sentinel`,
  `toggle_fleet_watch`.

Exposure is canonical policy at the destination for operations targeting existing sessions. It is
applied before direct lookup, `all` expansion, broadcasts, aggregate status reconciliation, branch
inspection, pane capture, raw terminal input, teardown, or sentinel assignment. A peer therefore
cannot infer or directly control an unexposed existing session.

`spawn_session` is the exception because its target does not exist yet. Any known federation peer
may ask the destination to spawn a valid new codename under the destination's ordinary workspace,
template, runtime, and filesystem rules. Relative paths, worktree repositories, system-prompt
files, and configured templates are resolved by the destination fleet. A new session is remotely
addressable afterward only when its name is covered by `"*"` or an explicit exposure reservation;
Conductor never edits `supervisor.yaml` to expose it automatically.

`type_in_pane` remains the raw escape hatch: routing it does not add a message envelope, composer
protection, or delivery queue. Use it only for deliberate terminal control. A remote caller may set
an exposed session as sentinel or clear the destination's sentinel, and may toggle destination-wide
fleet watch.

`send_to_operator`, `whoami`, `get_conductor_docs`, `create_room`, `list_rooms`, and
`list_federation` remain local-only. `create_room` and `list_rooms` are local-only because a routed
`join_room` already creates the room it needs at the destination, and a room listing is
federation-wide before it is routed anywhere.

Operator commands remain local to the operator's selected instance, with one deliberate exception
described under [Rooms across fleets](#rooms-across-fleets).

## Rooms across fleets

A room is a named group conversation. Cross-fleet rooms are decentralized: each fleet owns its own
members and publishes them in its own registry record, so a room name shared by two participating
fleets is one conversation. There is no host fleet, no room owner, and no shared database.

Add a remote member by routing the membership call, then speak normally:

```json
join_room({ "fleet": "backend", "room": "design-review", "codename": "api" })
send_to_room({ "room": "design-review", "message": "Both sides please confirm the contract." })
```

The speaker's Conductor delivers to its own members and then calls each participating fleet
directly. A peer-originated room call acts on that fleet's local members only and is never routed
onward, so **a room message crosses at most one fleet boundary**. That keeps the topology loop-free
without message identity, deduplication tables, or a time-to-live, and it preserves the same
non-transitive property discovery has. A fleet that cannot be reached is reported in the result;
room traffic is a broadcast, so nothing is retried or queued for it.

Exposure governs cross-fleet participation. Only federation-exposed sessions are published as room
members and only they receive peer-originated room traffic; an unexposed member takes part in its
own fleet's local room traffic and stays invisible to peers, and `join_room` says so when that
applies. `close_room` tears the room down in every participating fleet.

Peer records gained an additive `rooms` field for this. A record written by an older peer has no
such field, contributes no room members, and is otherwise fully compatible — the federation
protocol version is unchanged.

Room fan-out is the one place a Conductor acts across fleets on the operator's behalf, so
`/room say` and `/room close` reach remote members. Those calls carry an explicit operator origin
and a remote member sees `operator@<fleet>`. This grants no additional authority: a peer-originated
call is authorized as a peer session whatever role it holds at home, so it still reaches only
routable operations and is still exposure-filtered. Every other operator command remains local.

If an agent needs a remote operator decision, it should message an exposed peer session and let
that session compose a local `send_to_operator` request. Federation does not hold an HTTP call open
while a human decides.

## Multiple Conductors in one directory

The historical default instance is unchanged:

```bash
cd /path/to/fleet
conductor start
```

Use a global instance selector only when another independent Conductor must share that directory:

```bash
conductor --instance frontend start
conductor --instance backend start
```

The first start creates each named scaffold below:

```text
.conductor/
└── instances/
    ├── frontend/
    │   ├── .env
    │   ├── config/
    │   │   ├── supervisor.yaml
    │   │   └── sessions/
    │   └── data/
    └── backend/
        ├── .env
        ├── config/
        │   ├── supervisor.yaml
        │   └── sessions/
        └── data/
```

Use the selector for every CLI operation aimed at that instance:

```bash
conductor --instance frontend validate
conductor --instance frontend doctor
conductor --instance frontend console
conductor --instance frontend status
conductor --instance frontend daemon install
```

Each named instance receives distinct derived MCP port, tmux session/window identity, pane
ownership marker, data and lock paths, and launchd/systemd service identity. Session `repo` paths
continue to resolve from the shared fleet directory. `default` is reserved as an instance name;
omit the option to select the default. Named instances require the modern `.conductor/` layout and
are intentionally rejected for legacy root-level fleets.

Federation does not require named instances. Conductors in separate directories can federate, and
same-directory instances may stay isolated.

## Two-instance shakedown

1. In the shared directory, start `frontend` once and stop it after its scaffold appears. Repeat
   for `backend`.
2. Add a unique federation block to each generated supervisor file. Add at least one session file
   under each instance's `config/sessions/` directory.
3. Run `conductor --instance frontend validate` and the matching backend command.
4. Start each instance in its own terminal.
5. Confirm each operator `/status` contains its federation name, exposed roster, and peer count.
6. From a managed session, call `list_federation`, send one cross-fleet message, and inspect its
   receipt with the destination fleet argument.
7. In the frontend console, run `/room create shakedown <local session>`, then have that session
   call `join_room` with `fleet: "backend"` for an exposed backend session.
8. Run `/room list shakedown` in both consoles and confirm each shows the other fleet's member.
9. Run `/room say shakedown hello` from frontend and confirm the backend member receives
   `[Room: shakedown from operator@frontend]`.
10. Run `/room close shakedown` and confirm both fleets report the room gone and each member
    received one closure notice.

## Limitations and troubleshooting

If discovery omits a running peer, confirm that the names are unique, both MCP hosts remain on
loopback, both processes run as the same operating-system user, and both builds use a compatible
federation protocol. Discovery filters incompatible records rather than breaking the whole list;
an incompatible ingress call fails with an explicit error.

## Local trust boundary

Federation intentionally has no tokens, keys, ACLs, or permission system. Conductor's loopback
`/cmd` endpoint already grants full operator authority to any process running as the same user;
federation adds faithful peer identity and convenient routing, not a new security boundary. Keep
`mcp.host` on loopback, do not publish the port through a tunnel or proxy, and do not use this
feature between mutually untrusted users.

Peer records contain only name, loopback host, port, process ID, protocol version, and exposed
session names. They live beneath writable `XDG_RUNTIME_DIR` when available, otherwise the stable
`~/.agent-conductor/federation/` directory. Conductor uses exclusive name claims, removes stale or
malformed records, and proves actual liveness when the routed call succeeds; there is no network
probe loop, authentication handshake, durable cross-fleet queue, topology service, or central
coordinator.

## Disabling or removing federation

Stop the participating Conductor normally, remove its `federation` block, and start it again. Clean
shutdown removes that process's registry record; stale records from crashes are pruned
automatically, so there is no federation database to migrate or delete.

To retire a named instance, first stop that exact instance and uninstall its daemon if one was
installed:

```bash
conductor --instance frontend daemon uninstall
```

Its files remain under `.conductor/instances/frontend/` for recovery. After confirming the process
is stopped and preserving any configuration, logs, event history, or database you need, remove or
archive that exact instance directory yourself. Never delete a live instance's data directory.
