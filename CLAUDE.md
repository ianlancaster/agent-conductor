# agent-conductor — Developer Guide

Lightweight supervisor for terminal coding agents (Claude Code, Codex). Product principle:
**primitive-first, adapter-driven, no gold-plating** (no dashboards or workflow systems).

## Quick reference

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # the pre-commit gauntlet
pnpm dev                  # run from source (tsx)
pnpm cli start            # conductor CLI from source
```

Husky runs all four checks on commit; `SKIP_HOOKS=1 git commit` is the escape hatch.

## Architecture

Three seams isolate everything environment-specific; the core is pure orchestration logic
tested against in-memory fakes (`test/fakes/`).

- `src/terminals/` — **TerminalBackend**: `iterm/` (AppleScript, async), `tmux/` (headless).
- `src/runtimes/` — **SessionRuntime**: `claude-code/` (hooks via `--settings`, MCP via
  `--mcp-config`), `codex/` (`-c` config overrides, `notify`, AGENTS.override.md injection).
- `src/channels/` — **ChannelAdapter**: `telegram/` (dependency-free long-polling).
- `src/core/` — supervisor (wiring only), lifecycle, delivery (typing-aware queue), health
  (event-driven + pane-diff fallback), sentinel (stall routing), messaging, operations
  (canonical control plane), commands (operator adapter), scheduler, state, status, worktree.
- `src/mcp/` — HTTP JSON-RPC server. **Identity is mechanical**: the codename comes from the
  URL path (`/mcp/<codename>`, `/events/<codename>`), never from request contents.
- `src/store/` — single SQLite store (runs, messages, health_log, session_state,
  workspace KV). Migrations are append-only entries in `MIGRATIONS`.
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
  conductor notifications over an external service such as Telegram. It owns transport
  parsing, authentication/allowlisting, API limits, and retries; it must not reimplement
  conductor policy or canonical operations.
- **Session runtime** (`SessionRuntime`) — integrates an agent CLI and owns launch syntax,
  generated identity/hook configuration, lifecycle-event parsing, and terminal UI parsing.
- **Terminal backend** (`TerminalBackend`) — owns pane creation, process interaction, capture,
  rediscovery, and backend capabilities.

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
4. **Health is event-driven first.** Runtime hooks POST to `/events/<codename>`; pane
   diffing is only the fallback watchdog (`eventSilenceMs`). Don't add pane-scraping
   heuristics to core — runtime-specific parsing belongs in the runtime adapter.
5. **All strings into AppleScript go through the escaping helper**; all tmux invocations
   are execFile arg arrays, never shell strings.
6. **Async only in backends** — no execSync in request/heartbeat paths.

## Adding things

- **New control primitive**: add one definition to `ConductorOperations` with its audiences,
  schema, and handler; map its operator syntax in `buildOperatorCommands`. MCP rendering is
  automatic. Update README/protocol docs and the surface-contract test.
- **New per-session setting**: `SessionState` in core/types.ts → SessionStateManager (+ persist
  fields in store session_state) → status.ts → the relevant canonical operation.
- **New channel**: implement `ChannelAdapter`, keep protocol classification separate from
  network I/O, and test the transport with a scripted API double. Use `FakeChannel` to test
  the core-to-channel pipeline, then inject the real adapter via
  `new Supervisor(baseDir, { channels: [...] })`. Built-in environment/config discovery is
  only needed when shipping the adapter inside this package.
- **New runtime/backend**: implement the interface in its directory and add fake-based tests.

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
exercises real panes and a fake agent process. AppleScript and Telegram-network behavior stay
behind pure helpers and adapter tests; real-runtime/backend shakedowns live under `test/manual/`.

For an operator channel, cover four layers as applicable: pure inbound classification and
outbound formatting; a scripted network/API double; `FakeChannel` integration through the
real supervisor/command pipeline; and a documented manual shakedown for the real service.
