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

`expose` controls which configured sessions peers may discover and address:

```yaml
# Expose the entire current roster. The wildcard must be the only item.
federation:
  name: backend
  expose: ['*']
```

Use `expose: []` to participate in discovery without exposing a session. Explicit unknown
codenames, duplicate entries, invalid codenames, and a wildcard mixed with names fail validation.
`"*"` means the current configured roster only; it never authorizes a peer to invent or spawn a
session name.

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
- observation: `list_sessions`, `get_session_status`, `tail_session`;
- lifecycle: `start_session`, `continue_session`, `stop_session`; and
- modes and metadata: `pause_session`, `resume_session`, `toggle_auto`, `set_tag`.

Exposure is canonical policy at the destination. It is applied before direct lookup, `all`
expansion, broadcasts, aggregate status reconciliation, branch inspection, or pane capture. A peer
therefore cannot infer or affect unexposed sessions through aggregate operations.

The following tools remain local-only because routing them would add authority or distributed
machinery beyond this primitive: `spawn_session`, `teardown_session`, `type_in_pane`,
`send_to_operator`, `set_sentinel`, `toggle_fleet_watch`, `whoami`, `get_conductor_docs`, and
`list_federation`. Operator commands remain local to the operator's selected instance.

If an agent needs a remote operator decision, it should message an exposed peer session and let
that session compose a local `send_to_operator` request. Federation does not hold an HTTP call open
while a human decides, proxy raw keystrokes, or delete another fleet's workspace.

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
