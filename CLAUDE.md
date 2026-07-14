# agent-conductor — Developer Guide

Lightweight supervisor for terminal coding agents (Claude Code, Codex). Product principle:
**CLI-only, powerful communication primitives, no gold-plating** (no dashboards, no workflow
systems).

## Quick reference

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # the pre-commit gauntlet
pnpm dev                  # run from source (tsx)
pnpm cli -- start         # conductor CLI from source
```

Husky runs all four checks on commit; `SKIP_HOOKS=1 git commit` is the escape hatch.

## Architecture

Three seams isolate everything environment-specific; the core is pure orchestration logic
tested against in-memory fakes (`test/fakes/`).

- `src/terminals/` — **TerminalBackend**: `iterm/` (AppleScript, async), `tmux/` (headless).
- `src/runtimes/` — **AgentRuntime**: `claude-code/` (hooks via `--settings`, MCP via
  `--mcp-config`), `codex/` (`-c` config overrides, `notify`, AGENTS.override.md injection).
- `src/channels/` — **ChannelAdapter**: `telegram/` (dependency-free long-polling).
- `src/core/` — supervisor (wiring only), lifecycle, delivery (typing-aware queue), health
  (event-driven + pane-diff fallback), sentinel (stall routing), human-input, messaging,
  commands (operator router), scheduler (croner), state, status, worktree, focus-autopause.
- `src/mcp/` — HTTP JSON-RPC server. **Identity is mechanical**: the codename comes from the
  URL path (`/mcp/<codename>`, `/events/<codename>`), never from request contents.
- `src/store/` — single SQLite store (sessions, messages, health_log, agent_state,
  workspace KV). Migrations are append-only entries in `MIGRATIONS`.
- `src/config/` — zod schemas; every tunable has a default in `schema.ts`. One mtime watcher
  feeds both roster reload and scheduler rebuild.

## Key invariants

1. **Never trust request contents for identity.** Tool handlers receive `caller` derived
   from the URL. No `from` parameters, ever.
2. **The conductor makes no LLM calls.** All judgment lives in the sentinel agent;
   the conductor's decisions are mechanical (dedup, watchdog, routing).
3. **Two autonomy modes only** — `facilitated` and `autonomous`. Pause = temporary
   facilitated with mode memory.
4. **Health is event-driven first.** Runtime hooks POST to `/events/<codename>`; pane
   diffing is only the fallback watchdog (`eventSilenceMs`). Don't add pane-scraping
   heuristics to core — runtime-specific parsing belongs in the runtime adapter.
5. **All strings into AppleScript go through the escaping helper**; all tmux invocations
   are execFile arg arrays, never shell strings.
6. **Async only in backends** — no execSync in request/heartbeat paths.

## Adding things

- **New per-agent setting**: `AgentState` in core/types.ts → AgentStateManager (+ persist
  fields in store agent_state) → status.ts → command in commands.ts → MCP tool in
  mcp/tools.ts → wire in supervisor.ts.
- **New MCP tool**: definition in `buildMcpTools` (schema + handler(args, caller));
  `sentinelOnly: true` gates visibility and calls. Wire deps in supervisor.
- **New channel/runtime/backend**: implement the interface in its directory; add a fake-based
  test; register in supervisor.ts. Update the examples.

## Testing

Vitest. Fakes for the three seams make full pipelines testable: see commands.test.ts
(mini-conductor from real modules + fakes) and health/sentinel/delivery tests (fake timers).
The MCP server is tested over real HTTP. Worktree tests run real git. Anything AppleScript/
tmux/Telegram-network stays behind pure helpers that ARE unit-tested.
