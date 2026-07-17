# agent-conductor — Implementation Plan

Greenfield build at `~/Projects/agent-conductor`. MIT. Node 22+, pnpm, tsx for dev.
Companion docs: `agent-conductor-registry.md` (what carries over), `competitive-landscape.md`,
`adoption-proposals.md` (what we integrate/borrow).

Product principle (governs every scope decision): **lightweight CLI-only tool giving agents
powerful communication primitives and protocols. Avoid gold-plating.**

---

## Module layout

Single package (no monorepo — lightweight principle). `bin: conductor`.

```
agent-conductor/
├── src/
│   ├── core/            # supervisor, lifecycle, delivery queue, health, sentinel routing
│   │   ├── supervisor.ts        # thin orchestrator — wiring only, logic lives in modules
│   │   ├── lifecycle.ts         # start/stop/continue/restart/spawn/teardown
│   │   ├── delivery.ts          # typing-aware queue (deliverOrQueue, drain, force-deliver)
│   │   ├── health.ts            # event-driven monitor + pane-diff fallback watchdog
│   │   ├── sentinel.ts          # stall queue, sentinel routing, sentinel watchdog
│   │   ├── human-input.ts       # in-memory request_human_input round-trip
│   │   ├── scheduler.ts         # croner-based cron firing
│   │   └── commands.ts          # operator command router (shared by CLI + channels)
│   ├── runtimes/        # AgentRuntime seam
│   │   ├── types.ts             # interface + capability flags
│   │   ├── claude-code/         # launch builder, hooks injection, MCP config, transcript reader
│   │   └── codex/               # config.toml gen, AGENTS.md injection, notify, resume
│   ├── terminals/       # TerminalBackend seam
│   │   ├── types.ts
│   │   ├── iterm/               # async AppleScript driver, focus tracking, rediscovery
│   │   └── tmux/                # send-keys/capture-pane/split-window, pane-env rediscovery
│   ├── channels/        # ChannelAdapter seam
│   │   ├── types.ts             # send, buttons capability, command/free-text/callback events
│   │   └── telegram/
│   ├── mcp/             # HTTP JSON-RPC server: /mcp/<agent>, /events/<agent>, /cmd, /health
│   │   ├── server.ts
│   │   └── tools.ts             # agent tools + sentinel-gated tools
│   ├── store/           # single SQLite store, versioned migrations
│   ├── config/          # zod schemas, loader, single hot-reload watcher
│   ├── cli/             # conductor CLI + interactive client
│   └── logger.ts
├── prompts/             # conductor protocol (base), sentinel default prompt
├── test/                # unit + integration (fakes for all three seams)
├── examples/            # sample supervisor.yaml + agent configs
└── docs/                # these four docs migrate here
```

## The three interfaces (signed off before implementation)

```ts
interface TerminalBackend {
  createPane(agent: string, placement: Placement): Promise<PaneRef>;
  run(pane: PaneRef, text: string): Promise<void>; // bracketed-paste aware
  capture(pane: PaneRef, lines: number): Promise<string>;
  isAlive(pane: PaneRef): Promise<boolean>;
  kill(pane: PaneRef): Promise<void>;
  rename(pane: PaneRef, name: string): Promise<void>; // codename only
  isInputClear(pane: PaneRef, glyphs: InputGlyphs): Promise<boolean>;
  rediscover(): Promise<Map<string, PaneRef>>; // survivor panes after restart
  capabilities: { focusTracking: boolean; headless: boolean };
  getFocusedAgent?(): Promise<string | null>; // iTerm only
}

interface AgentRuntime {
  buildLaunchCommand(agent: AgentConfig, opts: LaunchOpts): LaunchSpec; // cmd + env + files to write
  buildContinueCommand(agent: AgentConfig): LaunchSpec; // claude -c / codex resume
  prepareIdentity(agent: string): Promise<void>; // MCP config + hooks/notify injection
  inputGlyphs: InputGlyphs; // ❯ etc.
  chromePatterns: RegExp[]; // strip terminal chrome from captures
  readLastAssistantMessage?(sessionRef: string): Promise<string | null>; // transcript excerpt
  capabilities: { contextProbe: boolean; hooks: boolean; systemPromptFlag: boolean };
}

interface ChannelAdapter {
  name: string;
  start(handlers: { onCommand; onFreeText; onCallback }): Promise<void>;
  send(text: string, opts?: { buttons?: Choice[][] }): Promise<void>; // falls back to numbered replies
  capabilities: { buttons: boolean };
  stop(): Promise<void>;
}
```

Fakes for all three ship in phase 1 and double as the test harness for everything above them.

## Event-driven health (the A1 architecture)

1. `prepareIdentity` injects per-agent hook config: Claude gets a generated settings file
   (`--settings`) whose `Stop` / `Notification` / `PreCompact` / `SessionEnd` hooks POST to
   `http://127.0.0.1:<port>/events/<codename>`; Codex gets `notify` in its generated config.
2. `health.ts` consumes events: `Stop` → idle-candidate (start quiet timer), `Notification`
   → blocked-on-decision (immediate stall event with reason), `PreCompact`/`SessionStart(compact)`
   → compaction event, `SessionEnd` → session death.
3. Fallback watchdog: pane-diff polling at heartbeat cadence _only_ flags agents whose events
   have gone silent but whose pane is alive (wedged TUI) — it no longer drives normal detection.
4. Every stall event carries: pane capture (chrome-stripped), last assistant message
   (transcript excerpt when the runtime supports it), event type + reason, agent status.

## Sentinel design (N4)

- Config: `sentinel.codename` designates the sentinel; conductor refuses `autonomous` mode
  fleet-wide (with a channel warning) if no healthy sentinel is registered.
- Routing: stall events for `autonomous` agents enqueue to the sentinel's stall queue and the
  conductor messages the sentinel (`[Stall] <agent> ...` envelope). `facilitated` agents never route.
- Sentinel-gated MCP tools (visible only when caller == sentinel): `get_stall_queue`,
  `resolve_stall` (nudge text | answer option N | suppress | escalate_to_operator with question).
  Plus the normal toolset (`tail_agent`, `send_to_agent`, `type_in_pane`) for digging deeper.
- Watchdog-over-sentinel (B5): the mechanical layer monitors the sentinel itself; sentinel
  stalled/dead/absent → escalate directly to operator via ChannelAdapter.
- Default sentinel prompt ships in `prompts/sentinel.md` (raw material: the three old judge prompts).

## Final MCP tool surface

Agent tools: `send_to_agent`, `broadcast` (description: use sparingly, prefer explicit recipients),
`notify_agents`, `respond_to_user`, `request_human_input`, `start_agent`, `stop_agent`,
`continue_agent`, `spawn_agent` (with `--worktree`), `teardown_agent`, `create_worktree`,
`remove_worktree`, `set_autonomy` (facilitated|autonomous), `set_tag`, `get_tag`, `list_agents`,
`get_agent_status`, `tail_agent`, `type_in_pane`, `request_context` (capability-gated),
`request_restart`, `agent_exists`.
Sentinel-gated: `get_stall_queue`, `resolve_stall`.
v1.x: `reserve_files`, `release_files` (N11).

Removed vs cc-conductor: `set_nudge_level`, `list_escalations`, `check_orchestration_policy`.

---

## Phases

Each phase ends with typecheck + lint + format + tests green in CI, and a runnable milestone.

### Phase 0 — Scaffold & quality rails (S)

Repo init at `~/Projects/agent-conductor`, MIT license, pnpm, `.nvmrc` 24 / engines >=22.
tsconfig strict + `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals/Parameters`.
ESLint flat config (typescript-eslint strict + import order), Prettier (midgard `.prettierrc`),
husky pre-commit (`SKIP_HOOKS` escape: typecheck → lint → format:check → vitest), GitHub Actions
CI (frozen install → quality matrix → gate job), PR template, changesets. Vitest configured with
coverage reporting. Migrate the four docs/ files. **Rails first so every later PR is gated.**

### Phase 1 — Domain types, config, store, fakes (M)

Core types (Autonomy = facilitated|autonomous, AgentConfig, events, envelopes). zod config
schemas + loader + `conductor validate` + single hot-reload watcher. SQLite store with versioned
migrations: `sessions`, `messages`, `health_log`, `agent_state` (autonomy/tag/pause),
`workspace` (pane refs) — the single-store consolidation. The three interfaces + Fake
implementations + their test suites. Port bugs-fixed pure logic: content similarity, envelope
builders, input-clear parsing.

### Phase 2 — Minimum working conductor: Claude + iTerm + CLI (L)

`ClaudeCodeRuntime`: launch builder (**`--model` passed** — bug fix; env block configurable,
no `DISABLE_NONESSENTIAL_TRAFFIC`), per-agent MCP config, hooks settings injection, transcript
reader. `ITermBackend`: async port of iterm.ts (execFile not execSync; no event-loop blocking),
bracketed paste, rediscovery, codename-only badges. MCP server port with `/events/<codename>`
added. Messaging tools + lifecycle tools. `core/lifecycle`, `core/delivery` (typing-aware queue
**with the dedicated test suite**), `core/commands`, CLI + interactive client.
**Milestone: start/stop/message a Claude fleet in iTerm2 from the CLI — feature parity with
daily-driver cc-conductor minus stalls/Telegram.**

### Phase 3 — Event-driven health + sentinel (L)

Events endpoint consumption, health.ts state machine, fallback watchdog, stall queue,
sentinel routing + gated tools, sentinel watchdog, `request_human_input` in-memory round-trip,
default sentinel prompt. Full pipeline integration tests against fakes (hook event → stall →
sentinel tool call → nudge delivered).
**Milestone: autonomous mode works end-to-end with a live sentinel agent.**

### Phase 4 — ChannelAdapter + Telegram (M)

Finalize adapter interface (buttons + fallback), port TelegramAdapter (splitting, Markdown
fallback, `//` passthrough), wire operator command router to channels, human-input and sentinel
escalations over buttons.
**Milestone: full remote fleet operation from Telegram.**

### Phase 5 — tmux backend + Codex runtime (L)

`TmuxBackend` (pane-env rediscovery, headless; systemd unit gen alongside launchd).
`CodexRuntime` (config profile gen: `mcp_servers` HTTP + raised `tool_timeout_sec`, `notify`
hook, AGENTS.md protocol injection, `codex resume`, Codex glyphs/chrome).
**Milestone: mixed Claude+Codex fleet running headless in tmux on Linux.**

### Phase 6 — Scheduler, worktrees, focus auto-pause, release (M)

Scheduler on croner (freshContext, pause gate, hot-reload via the shared watcher). N10 worktree
lifecycle (`create_worktree`/`remove_worktree` tools + `spawn_agent --worktree`, teardown
integration). Focus auto-pause (iTerm capability flag). README + architecture doc + examples,
npm publish via changesets.
**Milestone: v1.0.0 on npm.**

### Post-v1 (v1.x)

N11 file leases (origin-keyed, TTL, status visibility, optional pre-commit hook) → A3 background
placement → revisit deferred items. **Phase 2 relay** gets its own design doc (Happy-style E2E,
outbound-only conductor connections, agent→agent envelopes).

## Porting map (old → new)

| cc-conductor                                                                                                                                       | agent-conductor             | Treatment                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------- |
| supervisor.ts (1990 ln)                                                                                                                            | core/* split into 7 modules | Rewrite, port logic selectively                 |
| transport/iterm.ts                                                                                                                                 | terminals/iterm/            | Port, async-ify, de-usage-pane                  |
| transport/telegram.ts                                                                                                                              | channels/telegram/          | Port behind interface                           |
| mcp/server.ts                                                                                                                                      | mcp/server.ts               | Port + /events route                            |
| mcp/tools.ts                                                                                                                                       | mcp/tools.ts                | Port minus cut tools, fix schemas               |
| session/agent-session.ts                                                                                                                           | runtimes/claude-code/       | Rewrite (bugs, hooks, config-driven env)        |
| session/mode-manager.ts                                                                                                                            | store (agent_state) + core  | Absorb; 2 modes; JSON → SQLite                  |
| engine/health-monitor.ts                                                                                                                           | core/health.ts              | Rewrite event-driven; keep similarity util      |
| engine/scheduler.ts                                                                                                                                | core/scheduler.ts           | Port on croner                                  |
| engine/state-store.ts                                                                                                                              | store/                      | Port minus escalations/permissions; +migrations |
| config.ts                                                                                                                                          | config/                     | Rewrite with zod                                |
| logger.ts, cli.ts, cli-client                                                                                                                      | logger.ts, cli/             | Port lightly                                    |
| stall-judge, local-model, claude-oneshot, telegram-bot, session-manager, message-router, permission-engine, orchestration-policy, escalation-queue | —                           | Not ported                                      |

## Test strategy

- **Unit**: every pure function; every module against fakes. Priority per operator: the
  **typing-aware delivery queue** (input-clear edges, drain timing with fake timers, force-deliver,
  interleaving), launch builders (both runtimes, golden-command tests), config validation.
- **Integration**: MCP server over real HTTP (identity routing, events, tool dispatch);
  stall pipeline end-to-end on fakes; store migrations round-trip.
- **Smoke (manual/local, documented)**: real iTerm2 and real tmux checklists — AppleScript and
  send-keys can't be CI'd honestly; a scripted `conductor doctor`-style self-test covers the gap.
- Coverage reported in CI; thresholds introduced once the porting settles (parity with midgard).

## Risks

| Risk                                                  | Mitigation                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Hook payload/format drift across Claude Code releases | Hooks logic quarantined in ClaudeCodeRuntime; fallback watchdog keeps working regardless   |
| Codex TUI hostile to pane driving                     | CodexRuntime internals private; `codex exec`/`mcp-server` contingency (adoption doc A6)    |
| AppleScript fragility/blocking                        | async execFile, all escaping through one tested util, tmux as the always-works alternative |
| Agent Teams absorbs the niche for Claude-only fleets  | Runtime-agnostic layer; future team-as-unit adapter noted in runtimes/types.ts             |
| Scope creep vs "lightweight" principle                | Every addition passes the decision log's product principle; declines stay declined         |
