# agent-conductor — Developer Guide

Lightweight supervisor for terminal coding agents (Claude Code, Codex). Product principle:
**primitive-first, adapter-driven, no gold-plating** (no dashboards or workflow systems).

> **Mandatory context:** Read this file and [CONTRIBUTING.md](CONTRIBUTING.md) completely
> before planning or changing the repository. They are the working contract for human and
> agent contributors.

## Mandatory project frame

Agent Conductor is an open-source product intended for many people, runtimes, terminals,
workflows, and fleet layouts. It is not a checked-in version of one operator's setup.

- Build generally useful, plainly named behavior. Never bake in a local path, organization,
  private workflow, preferred model, specific fleet, or personal configuration.
- Prefer a small, composable primitive over a narrow workflow. When users legitimately need
  different behavior, expose a coherent setting with a safe default, strict validation, a
  generated example, and documentation. Do not add speculative or dead configuration knobs.
- Keep one strong canonical core. Environment- and provider-specific behavior belongs behind
  the narrowest existing adapter seam. Adapters translate; they do not fork conductor policy.
- Treat clarity as a product feature. Avoid clever, opaque, or unnecessarily indirect
  implementations. Public types, errors, help, configuration, and docs must make the feature
  understandable without knowledge of the original contributor's fleet.
- A feature is not complete when only one entry point works. Audit every applicable vector:
  core operation, operator command and `/help`, session MCP, bundled and injected adapters,
  configuration/schema/scaffold/examples, generated prompts, public exports, persistence,
  tests, README, and setup or migration guides. Explicitly document intentional capability
  differences instead of allowing accidental drift.
- Code quality is non-negotiable: preserve invariants and compatibility, isolate side effects,
  test failure and recovery paths, and run the full repository quality gate.

Fleet-specific policy belongs in fleet YAML, environment variables, prompt files, templates,
or an injected adapter—not in the reusable core. If a proposed feature cannot be explained
without referring to one private deployment, generalize the underlying primitive first.

## Quick reference

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # the pre-commit gauntlet
pnpm cli start            # conductor CLI from source (tsx)
pnpm test:watch           # focused development test loop
pnpm build && pnpm add --global . # refresh the compiled global CLI
```

Husky runs all four checks on commit; `SKIP_HOOKS=1 git commit` is the escape hatch.

`conductor` runs compiled `dist/` code. Source edits do not change that binary until
`pnpm build`; use `pnpm add --global .` after initial setup, pulling a new checkout, or
changing package/bin metadata. A running Conductor process keeps its loaded code until it
is deliberately restarted—never restart an operator's fleet merely to test a build unless
that disruption is in scope.

## Architecture

Three seams isolate everything environment-specific; the core is pure orchestration logic
tested against in-memory fakes (`test/fakes/`).

- `src/terminals/` — **TerminalBackend**: `iterm/` (AppleScript, async), `tmux/` (headless).
- `src/runtimes/` — **SessionRuntime**: `claude-code/` (hooks via `--settings`, MCP via
  `--mcp-config`), `codex/` (`-c` config overrides, authoritative completion via `notify`, generated
  prompt/compaction lifecycle hooks, and isolated-home AGENTS.override.md injection).
- `src/channels/` — **ChannelAdapter**: `telegram/` (dependency-free long-polling),
  `slack/` (optional Socket Mode SDK, loaded lazily).
- `src/core/` — supervisor (wiring only), lifecycle, delivery (typing-aware queue), health
  (event-driven + pane-diff fallback), sentinel (stall routing), messaging, operations
  (canonical control plane), commands (operator adapter), scheduler, state, status, worktree.
- `src/mcp/` — HTTP JSON-RPC server. **Identity is mechanical**: the codename comes from the
  URL path (`/mcp/<codename>`, `/events/<codename>`), never from request contents.
- `docs/agent-guide.md` + `src/core/documentation.ts` — version-matched, topic-marked operating
  reference exposed lazily to managed sessions through `get_conductor_docs`. Keep the injected
  protocol concise; put extended feature explanations, composition recipes, and troubleshooting
  here. The tool also returns authoritative fleet paths without reading secret values.
- `src/store/` — single SQLite store (runs, messages, health_log,
  session_state, workspace KV). Migrations are append-only entries in `MIGRATIONS`.
- `src/config/` — zod schemas; every tunable has a default in `schema.ts`. One mtime watcher
  feeds both roster reload and scheduler rebuild.

## Extension taxonomy

“Adapter” is used for several deliberately different boundaries. Choose the narrowest seam
that owns the environment-specific behavior:

- **Control-surface adapter** — translates a caller-facing protocol into
  `ConductorOperations`. Session MCP tools are rendered from operation definitions;
  `CommandRouter` maps operator text commands to the same definitions. The local console is
  a native client of `/cmd` plus the `/feed` SSE stream, not a `ChannelAdapter`.
- **Operator channel** (`ChannelAdapter`) — transports operator commands, free text, and
  conductor notifications over an external service such as Telegram or Slack. It owns transport
  parsing, authentication/allowlisting, API limits, and retries; it must not reimplement
  conductor policy or canonical operations.
- **Session runtime** (`SessionRuntime`) — integrates an agent CLI and owns launch syntax,
  generated identity/hook configuration, lifecycle-event parsing, and terminal UI parsing.
- **Terminal backend** (`TerminalBackend`) — owns pane creation, process interaction, capture,
  rediscovery, and backend capabilities.
- **Event subscriber** (`ConductorEventSubscriber`) — observes typed, metadata-only facts from
  owning core modules. It is live, best-effort, failure-isolated, and one-way; it must never become
  control flow or an inbound event path.

Built-in channels ship in this package and may discover opt-in configuration outside the
core. External channels are ordinary `ChannelAdapter` instances injected through
`SupervisorOptions.channels`; they own their own construction and secrets.

## Key invariants

1. **Never trust request contents for identity.** Tool handlers receive `caller` derived
   from the URL. No `from` parameters, ever.
2. **The conductor makes no LLM calls.** All judgment lives in the sentinel agent;
   the conductor's decisions are mechanical (dedup, watchdog, routing).
3. **Auto is one boolean, not an autonomy framework.** Auto off is the implicit hand-driven
   state. `/auto` toggles stall routing. Pause is a separate temporary flag that suppresses
   schedules and stall routing without changing the auto setting.
4. **Health is event-driven first.** Runtime hooks POST to `/events/<codename>`. Claude Code and
   Codex have authoritative turn-completion signals, so pane changes are positive work evidence
   but pane silence can never end their turns. Pane-silence fallback (`eventSilenceMs`) is only for
   runtimes that explicitly lack authoritative completion. On restart/recovery, the same
   runtime-owned composer parser that protects delivery classifies a surviving pane: a visible
   composer is idle, while absent or uncertain composer evidence remains working. Don't add
   runtime-specific pane heuristics to core; parsing belongs in the runtime adapter.
5. **All strings into AppleScript go through the escaping helper**; all tmux invocations
   are execFile arg arrays, never shell strings.
6. **Async only in backends** — no execSync in request/heartbeat paths.

## Adding things

- **New control primitive**: add one definition to `ConductorOperations` with its audiences,
  schema, and handler; map its operator syntax in `buildOperatorCommands`. MCP rendering is
  automatic. Update `/help`, README/protocol docs, relevant channel behavior, and the
  surface-contract test. Verify all applicable callers expose the same semantics.
- **New per-session setting**: `SessionState` in core/types.ts → SessionStateManager (+ persist
  fields in store session_state) → status.ts → the relevant canonical operation.
- **New channel**: implement `ChannelAdapter`, keep protocol classification separate from
  network I/O, and test the transport with a scripted API double. Use `FakeChannel` to test
  the core-to-channel pipeline, then inject the real adapter via
  `new Supervisor(baseDir, { channels: [...] })`. Built-in environment/config discovery is
  only needed when shipping the adapter inside this package.
- **New runtime/backend**: implement the interface in its directory and add fake-based tests.
- **New observable fact**: add the narrowest mechanical event at the owning core choke point,
  update the discriminated union and vocabulary contract test, and preserve the privacy and
  non-blocking guarantees in `guides/event-subscribers.md`. Do not turn existing control-flow
  callbacks into event consumers.

### Change-completeness checklist

For every user-visible change, decide explicitly whether each row applies:

- canonical core behavior and authorization;
- operator commands, aliases, validation, and generated `/help`;
- session MCP schemas/descriptions and `prompts/conductor-protocol.md`;
- every built-in adapter plus the public injected-adapter contract;
- public event-subscriber types, vocabulary, ordering, failure isolation, and privacy contract;
- strict configuration schema, scaffolded defaults, examples, environment template, and secrets;
- store migrations, restart/recovery behavior, and backwards compatibility;
- public exports and package contents;
- focused unit tests, seam-level integration tests, failure paths, and manual shakedowns;
- README, task-specific setup guide, troubleshooting, migration notes, and changeset.
- `docs/agent-guide.md` when managed agents need to understand, compose, configure, or
  troubleshoot the changed capability.

“Not applicable” is valid when a transport or audience should not have a capability, but the
difference must be deliberate, tested where important, and documented where users will see it.

### Operator-channel checklist

- Derive a stable `conversationId` from trusted transport metadata so `/talk` state cannot
  leak between chats or users.
- Authenticate or allowlist inbound callers before invoking handlers. Never infer authority
  from message text.
- Route commands and free text through `ChannelHandlers`; do not call lifecycle, messaging,
  or state modules directly from the adapter.
- Keep startup and shutdown idempotent, bound every network request, and isolate individual
  update failures so one bad event cannot kill the receive loop.
- Treat service limits, formatting, chunking, callbacks, and retry behavior as adapter-owned.
- Keep secrets out of YAML, logs, generated examples, and error messages. Built-in adapter
  secrets come from the resolved process/fleet environment; injected adapters may use their
  host application's secret mechanism.
- Add user-facing configuration only for a bundled adapter. Optional bundled adapters must
  have an explicit enable flag and fail clearly when enabled without required credentials.
- Document setup and limitations, and export public adapter types from `src/index.ts` when
  third-party embedding needs them.

## Testing

Vitest. Fakes for the three seams make full pipelines testable: see commands.test.ts
(mini-conductor from real modules + fakes) and health/sentinel/delivery tests (fake timers).
The MCP server is tested over real HTTP. Worktree tests run real git, and the tmux E2E suite
exercises real panes and a fake agent process. AppleScript and operator-channel network
behavior stay behind pure helpers and adapter tests; real-runtime/backend/service shakedowns
live under `test/manual/`.

For an operator channel, cover four layers as applicable: pure inbound classification and
outbound formatting; a scripted network/API double; `FakeChannel` integration through the
real supervisor/command pipeline; and a documented manual shakedown for the real service.
