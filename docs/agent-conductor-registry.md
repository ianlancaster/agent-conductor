# Agent Conductor — Functionality Registry & Rearchitecture Plan

Status: v2 — incorporates operator review (2026-07-14).
Source: full audit of cc-conductor as of commit d3b1a6f.

---

## Decision Log (operator calls, round 2)

| Decision                                           | Call                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product principle                                  | **Lightweight CLI-only tool giving agents powerful communication primitives and protocols. Avoid gold-plating** (no dashboards, no workflow systems).                                                                                                    |
| Health architecture                                | **Event-driven** via runtime lifecycle hooks (Claude `Stop`/`Notification`/`PreCompact`/`SessionEnd`, Codex `notify`) posting to `POST /events/<codename>`; pane-diff demoted to fallback watchdog. See `adoption-proposals.md` A1.                      |
| Repo strategy                                      | **Greenfield** `agent-conductor` repo; port modules over.                                                                                                                                                                                                |
| Nudge levels (low/regular/aggressive)              | **CUT.** All stalls are surfaced; the stall sentinel decides what to do.                                                                                                                                                                                 |
| Autonomy modes                                     | **CUT `approve`.** Two modes: `facilitated` + `autonomous`. If sign-off behavior is wanted, the stall sentinel escalates by asking the operator before acting.                                                                                           |
| Cognitive-template bindings                        | **CUT** all template-specific instructions/URLs/rituals. **KEEP** the generic marker-file concept: any project containing the agent marker file is displayed as an "agent" (vs plain session) in status. Marker is display-only — no behavioral binding. |
| Usage-level detection & response system            | **CUT** entirely (system pane `/usage` polling, thresholds, `[RATE LIMIT]` pause/resume).                                                                                                                                                                |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` env var | **REMOVE** — it breaks the `/advisor` command, which we want to support.                                                                                                                                                                                 |
| Permission model                                   | **CUT** entirely (PermissionEngine, `autoApprove`, `escalateAlways`, permission_log table) — **including the orchestration policy** (cross-agent verb deny-lists). Months of real use found no need for it.                                              |
| Escalations & escalation queue                     | **CUT** entirely (escalation-queue.ts, escalations table, approve/deny commands, pending-approval machinery). See consequences below.                                                                                                                    |
| SDK execution path                                 | **CUT** (SessionManager, MessageRouter, SDK deps). Confirmed.                                                                                                                                                                                            |
| Tags                                               | Keep the tag feature, but the iTerm inline badge (red text) shows **codename only** — tag appears in status output only.                                                                                                                                 |
| Typing-aware delivery queue                        | Keep, and add **dedicated test coverage** (brittle area).                                                                                                                                                                                                |
| Relay server                                       | **Phase 2.** Build and refine the local conductor first; then add a deployed non-local server that interacts with local conductor instances securely.                                                                                                    |
| Hardcoded settings                                 | Audit complete (Part 3). Make key knobs config-driven with sensible defaults.                                                                                                                                                                            |
| Bugs found in audit                                | Fix all in the greenfield implementation.                                                                                                                                                                                                                |
| Codex instruction injection                        | Do whatever is needed to inject the conductor protocol into Codex sessions (AGENTS.md / config-based; runtime adapter's job).                                                                                                                            |

### Consequences of cutting escalations

The escalation table was the resolution plumbing for three flows:

1. **Approve-mode gating** of nudges and outbound messages → gone entirely (supports cutting `approve` mode).
2. **`request_human_input` in facilitated mode** → needs a lighter mechanism: keep the MCP tool, hold the pending question in memory, route it to the operator via the ChannelAdapter, and route the operator's reply back into the agent's pane. No persistence, no expiry engine, no approve/deny state machine.
3. **`/queue`, `/approve <id>`, `/deny <id>`, `/clear` commands and `list_escalations` tool** → removed.

### Autonomy mode recommendation

`approve` mode existed to gate the built-in judge's nudges and agent outbound messages through Telegram sign-off — machinery that is now entirely cut (judge → sentinel, escalations → gone). Recommendation: **two modes only**:

- `facilitated` — operator drives; stalls are not routed to the sentinel; operator messages relayed directly.
- `autonomous` — stalls are routed to the stall sentinel; agent runs unattended.

`pause` remains as "temporarily facilitated, remember previous mode."

---

## Part 1 — Existing Functionality: Keep vs Cut (final verdicts)

### KEEP (core)

| Feature                                                           | Origin                       | Notes                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Agent lifecycle: start / continue / stop / restart                | supervisor.ts                | Restart loses cognitive rituals.                                                                                                         |
| Agent config hot-reload                                           | supervisor.ts L692–721       | Merge with scheduler's separate YAML watcher — one watcher, two consumers.                                                               |
| Survivor pane rediscovery                                         | supervisor + iterm user-vars | Per-backend mechanism (tmux: pane env/title).                                                                                            |
| spawn / teardown agent                                            | supervisor.ts                | Spawn template externalized to a config file (currently inline heredoc).                                                                 |
| Autonomy: facilitated / autonomous                                | mode-manager                 | `approve` cut (pending confirmation). All `facil` → `facilitated`.                                                                       |
| Tags                                                              | mode-manager                 | Badge = codename only; tag shown in status only.                                                                                         |
| Pause / resume with mode memory                                   | mode-manager                 |                                                                                                                                          |
| Mechanical stall detection + dedup                                | health-monitor.ts            | Fix: threshold hardcoded to 1 beat; make `stallBeatsThreshold` + `captureLines` + suppress window/similarity configurable.               |
| Cron scheduler (croner lib), freshSession, pause gate, hot-reload | scheduler.ts                 | Replace hand-rolled cron parser with `croner`.                                                                                           |
| SQLite store: sessions, messages, health_log                      | state-store.ts               | escalations + permission_log tables dropped. Add versioned migrations.                                                                   |
| Typing-aware delivery queue (drain/force-deliver)                 | supervisor L1899–1950        | Dedicated tests required (fake TerminalBackend harness).                                                                                 |
| Broadcast / notify / respond_to_user                              | supervisor                   | Via ChannelAdapter.                                                                                                                      |
| `request_human_input`                                             | mcp/tools                    | Rebuilt lightweight: in-memory pending question, ChannelAdapter round-trip; sentinel answers in autonomous mode.                         |
| MCP HTTP server + URL-path identity                               | mcp/server.ts                | Shared protocol for Claude Code and Codex. Token auth added in Phase 2 (relay).                                                          |
| MCP tools (minus escalation/nudge tools)                          | mcp/tools.ts                 | Fix `set_autonomy` enum; remove `set_nudge_level`, `list_escalations`.                                                                   |
| Agent marker file (generic)                                       | was `.cognitive-agent`       | Renamed/configurable marker (e.g. `.conductor-agent`); presence marks a project as an "agent" in status display. Display-only.           |
| System prompt injection                                           | agent-session                | Per-runtime: Claude `--append-system-prompt-file`; Codex via AGENTS.md/config injection (runtime adapter responsibility).                |
| CLI (`status`, `logs`, `focus`, daemon)                           | cli.ts                       | `queue/approve/deny` commands dropped with escalations. Add systemd alongside launchd.                                                   |
| Config loader                                                     | config.ts                    | zod validation; drop dead fields (`localModel`, `autoResponses`?, `stallRestartAttempts`, `defaultMaxTurns`, `escalationDefaultAction`). |
| Logger                                                            | logger.ts                    |                                                                                                                                          |

### KEEP → behind an adapter seam

| Feature                                                                    | Seam                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| iterm.ts (all AppleScript ops)                                             | `ITermBackend implements TerminalBackend`. Fix sync `execSync` blocking in the port.                                       |
| telegram.ts                                                                | `TelegramAdapter implements ChannelAdapter` (reference impl).                                                              |
| Launch command construction, env vars, MCP config wiring, session continue | `ClaudeCodeRuntime implements AgentRuntime`. Env block configurable; `DISABLE_NONESSENTIAL_TRAFFIC` removed from defaults. |
| Input-clear detection (`❯` glyph), terminal-chrome patterns                | AgentRuntime capability (runtime-specific glyphs/patterns).                                                                |
| Context monitoring (`/context`)                                            | Optional AgentRuntime capability.                                                                                          |
| Focus auto-pause                                                           | Optional TerminalBackend capability (iTerm-only) — pending keep/cut decision (explained in review notes).                  |

### CUT (final)

| Feature                                                                                                                                                                 | Reason                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| StallJudge (built-in Haiku judge + 3 nudge-level prompts)                                                                                                               | Replaced by stall sentinel.                                               |
| Nudge levels (types, setter, MCP tool, `/nudge` command, persistence)                                                                                                   | Sentinel decides everything.                                              |
| `approve` autonomy mode + queueForApproval + pendingApprovals                                                                                                           | Confirmed cut. Sentinel escalates to operator when sign-off is warranted. |
| Orchestration policy (orchestration-policy.ts, `orchestration.deny*` config, `check_orchestration_policy` tool)                                                         | Cut with the permission model — no use found in months of operation.      |
| Escalation queue, escalations table, expiry, `/queue` `/approve` `/deny` `/clear`, `list_escalations`                                                                   | Operator call.                                                            |
| PermissionEngine, `autoApprove`, `escalateAlways`, permission_log                                                                                                       | Operator call.                                                            |
| SessionManager + MessageRouter (Agent SDK path) + `@anthropic-ai/claude-agent-sdk` dep                                                                                  | Parallel execution model; one model: terminal panes.                      |
| Usage/rate-limit monitor, system pane `/usage` parsing, thresholds, `[RATE LIMIT]` prompts, sessions cost/turns columns                                                 | Operator call.                                                            |
| spawnCognitiveAgent, template clone URLs, `/awaken` `/sleep` `/caffeinate` `/nap` handling, post-sleep detection, cognitive prompts/preambles, cognitive restart ritual | Operator call — no template binding.                                      |
| Operator emulator                                                                                                                                                       | Superseded by sentinel.                                                   |
| Post-compaction auto-nudge                                                                                                                                              | Compaction shows up as a stall; sentinel sees it in the capture.          |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`                                                                                                                              | Breaks `/advisor`.                                                        |
| local-model.ts + `localModel` config + Ollama docs                                                                                                                      | Dead code.                                                                |
| claude-oneshot.ts                                                                                                                                                       | Dead code.                                                                |
| telegram-bot.ts                                                                                                                                                         | Dead duplicate.                                                           |
| Hardcoded `'ian'` resolver, personal GitHub URLs                                                                                                                        | With escalations/cognitive cuts.                                          |
| Tag text in iTerm badge                                                                                                                                                 | Badge = codename only.                                                    |
| `facil` abbreviations                                                                                                                                                   | Full word everywhere.                                                     |

### DISCUSS (remaining)

1. **Numbered-option auto-responses** — explained in review notes; audit found the `autoResponses` config block is loaded but never wired (only one hardcoded regex fires). Lean: cut, sentinel handles prompts — consistent with "surface all stalls, sentinel decides."
2. **Focus auto-pause** — explained in review notes; keep/cut pending.
3. **Orchestration policy** — included in "permission model" cut or kept? Recommend keep.

### Bugs to fix in the greenfield port

1. `policy.model` never passed to launched agents (`--model` missing — every agent runs the CLI default model).
2. `set_autonomy` MCP schema/handler mismatch.
3. `stallThresholdMinutes` config ignored; threshold hardcoded to 1 beat.
4. `/mode` in help but unimplemented.
5. `claudeCode.binary` config exists but launch command hardcodes `claude`.
6. Stale `consult_agent` reference; stale model/token numbers in tool descriptions.
7. Version drift: cli.ts says 0.1.0, MCP server says 1.0.0 — single-source from package.json.
8. Two overlapping YAML hot-reload mechanisms.

---

## Part 2 — New Functionality Registry (v2)

| ID  | Feature                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                               | Size | Phase |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| N1  | **ChannelAdapter framework**    | Operator-channel interface (send, buttons, command/free-text/callback events, operator identity). TelegramAdapter first; Slack/Discord later; multiple simultaneous adapters.                                                                                                                                                                                                                                                                             | M    | 1     |
| N2  | **AgentRuntime abstraction**    | Runtime-specific seam: launch command, resume, MCP wiring, instruction injection, chrome patterns, input-clear glyphs. `ClaudeCodeRuntime` + `CodexRuntime`. Codex: MCP via config.toml `mcp_servers`; conductor protocol injected via AGENTS.md or config — whatever it takes to get the protocol into Codex sessions. Capability flags for graceful degradation.                                                                                        | L    | 1     |
| N3  | **TerminalBackend abstraction** | `ITermBackend` (async port of iterm.ts) + `TmuxBackend` (send-keys/capture-pane/split-window; headless, SSH, Linux).                                                                                                                                                                                                                                                                                                                                      | L    | 1     |
| N4  | **Stall sentinel**              | Conductor detects stalls mechanically and routes ALL of them to a designated sentinel agent (no filtering by nudge level — sentinel decides). Sentinel MCP tools: pull stall queue, capture target pane, deliver nudge, answer human-input request, escalate to operator via channel, suppress/mark-idle. Watchdog: conductor alerts operator if no sentinel is registered or the sentinel itself stalls. Default sentinel prompt ships with the project. | M    | 1     |
| N5  | **Conductor relay server**      | Deployed non-local server; local conductors connect outbound over secure channel (token auth, TLS). Registry/discovery, presence (online/offline, last-seen), WebSocket message passthrough, delivery receipts, offline queueing, monitoring endpoints. Same message envelope local or remote.                                                                                                                                                            | XL   | **2** |
| N6  | **Quality infrastructure**      | ESLint (flat, typescript-eslint strict), Prettier (midgard `.prettierrc`), husky pre-commit (typecheck → lint → format:check → tests, `SKIP_HOOKS` escape), danger-style local rules, GitHub Actions CI with gate job, stricter tsconfig, CODEOWNERS, PR template.                                                                                                                                                                                        | M    | 1     |
| N7  | **Test hardening**              | Fake implementations of all three adapter interfaces as test harnesses. Priority targets: **typing-aware delivery queue** (drain, force-deliver, input-clear edge cases), launch-command builders per runtime, MCP server HTTP + identity routing, stall pipeline end-to-end, scheduler, supervisor command router, mode persistence.                                                                                                                     | M    | 1     |
| N8  | **Config-driven settings**      | zod-validated schema; every knob from the Part 3 audit exposed with sensible defaults; generated JSON Schema; `conductor validate`.                                                                                                                                                                                                                                                                                                                       | M    | 1     |
| N9  | **OSS packaging**               | License, README/architecture docs, CONTRIBUTING, changesets, npm publish, example configs.                                                                                                                                                                                                                                                                                                                                                                | M    | 1     |
| N10 | **Worktree lifecycle**          | Git worktrees as a first-class agent workspace: `spawn_agent --worktree <repo> [--branch]` plus dedicated MCP tools to create and destroy worktrees (mirroring spawn/teardown semantics — safety checks, registration, cleanup via `git worktree remove`). Separate clones remain fully supported; worktrees are the fast path for parallel work on one repo.                                                                                             | S–M  | 1     |
| N11 | **Advisory file leases**        | `reserve_files` / `release_files` MCP tools; leases keyed by **repo origin + path glob** so they work across worktrees AND separate clones of the same repo; TTL expiry so dead agents can't hold leases; lease visibility in `get_agent_status`; optional git pre-commit hook for hard enforcement. Conductor protocol prompt instructs agents to reserve before editing shared repos.                                                                   | M    | 1.x   |

---

## Part 3 — Configuration Audit (hardcoded → config-driven)

Full audit of every magic number/string completed. Items tied to cut features (usage monitor, escalations, permissions, cognitive, nudge prompts, Ollama) are dropped with their features. The knobs worth exposing, with proposed defaults:

### Priority knobs

| Config key                                            | Default                          | Currently                                   | Controls                                                |
| ----------------------------------------------------- | -------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `health.captureLines`                                 | 40                               | hardcoded                                   | Pane lines captured per heartbeat for stall detection   |
| `health.stallBeatsThreshold`                          | 1                                | hardcoded (ignores `stallThresholdMinutes`) | Unchanged beats before stall fires                      |
| `health.stallSuppressWindowMs`                        | 300000                           | hardcoded                                   | Duplicate-stall suppression window                      |
| `health.stallSuppressSimilarity`                      | 0.8                              | hardcoded                                   | Similarity ratio for suppression                        |
| `messaging.queueDrainMs`                              | 2000                             | hardcoded                                   | Typing-aware queue drain poll                           |
| `messaging.queueMaxAgeMs`                             | 60000                            | hardcoded                                   | Force-deliver age for queued messages                   |
| `runtime.claudeCode.binary`                           | `claude`                         | config exists, ignored                      | Launch binary                                           |
| `runtime.claudeCode.autocompactPct`                   | 70                               | hardcoded env export                        | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`                       |
| `runtime.claudeCode.env`                              | map (minus nonessential-traffic) | hardcoded block                             | Env vars exported to every agent                        |
| `runtime.claudeCode.skipPermissions`                  | true                             | hardcoded flag                              | `--dangerously-skip-permissions`                        |
| `defaults.autonomy`                                   | `facilitated`                    | hardcoded                                   | Starting mode for new agents                            |
| `defaults.placement`                                  | `pane`                           | hardcoded                                   | New-agent pane/tab/window                               |
| `spawn.templateFile`                                  | built-in                         | inline heredoc                              | Spawned-agent YAML policy template                      |
| `spawn.dirPattern`                                    | `../<codename>`                  | hardcoded                                   | Spawned agent directory convention                      |
| `terminal.iterm.bracketedPasteThreshold`              | 512                              | hardcoded                                   | Paste-vs-type cutoff (input-corruption hotspot)         |
| `terminal.iterm.launchTimeoutSec` / `pollIntervalSec` | 8 / 0.25                         | hardcoded                                   | Shell-init race handling                                |
| `terminal.iterm.focusCheckMs`                         | 5000                             | hardcoded                                   | Focus auto-pause poll (if kept)                         |
| `scheduler.reloadIntervalBeats`                       | 10                               | hardcoded                                   | YAML hot-reload cadence                                 |
| `mcp.host`                                            | 127.0.0.1                        | hardcoded                                   | MCP bind address (relay/Phase 2 relevant)               |
| `mcp.keepAliveTimeoutMs`                              | 60000                            | hardcoded                                   | Long-consult HTTP tuning                                |
| `tail.defaultLines` / `tail.maxLines`                 | 30 / 500                         | hardcoded ×2 places                         | Tail defaults (dedupe supervisor + tools)               |
| `channel.telegram.panePreviewLines`                   | 20                               | hardcoded                                   | Pane preview lines sent to operator                     |
| `operator.name`                                       | `operator`                       | hardcoded `'ian'`                           | Audit-trail identity (mostly moot after escalation cut) |

### Config fields that exist but are silently ignored (drop or wire up)

- `supervisor.stallThresholdMinutes` — ignored (threshold hardcoded to 1 beat) → replaced by `health.stallBeatsThreshold`
- `supervisor.stallRestartAttempts` — never referenced → drop
- `supervisor.defaultMaxTurns` — never referenced → drop
- `telegram.escalationDefaultAction` — never applied → gone with escalations
- `localModel.*` (entire block) — dead → drop
- `autoResponses.*` — loaded but never wired; only a hardcoded settings-edit regex fires → resolve with DISCUSS item 1
- `IterminalConfig.defaultTailLines` — declared, never consumed → wire up as `tail.defaultLines`

Keep-hardcoded (implementation details, promote to named constants): terminal-chrome regexes, prompt-detection glyphs, message envelope formats (`[Message from X]`, `[Broadcast from X]`), Telegram 4096 split, SQLite pragmas, MCP route paths, AppleScript pacing delays, OSC escape formats.

---

## Part 4 — Prior Art & Landscape (July 2026)

Full research report available on request; condensed findings:

**Native tooling now covers intra-session multi-agent, not our layer.** Claude Code ships subagents (stable), experimental Agent Teams (peer instances in one session, tmux/iTerm split-pane display, JSON mailboxes, SendMessage — Claude-only, single-session), background sessions, and research-preview operator Channels plugins (Telegram/Discord/iMessage). Codex ships native subagents (parent-routed threads), MCP client support incl. **streamable HTTP with per-server URLs — our URL-identity scheme works with Codex as-is**, `codex mcp-server` (Codex as an orchestratable MCP tool), AGENTS.md instruction chain, and `codex resume`. Neither vendor covers cross-process, cross-runtime, cross-machine supervision with health monitoring and an operator channel.

**Closest projects:** Gas Town (~17k★, tmux, mailboxes, Witness health monitors — heavyweight, no operator channel, notorious token burn), amux (~300★, closest lightweight rival: tmux watchdog, channels, scheduler — but no mechanical identity, no chat adapters, no auth), claude-squad (~8k★, parallel session management only), mcp_agent_mail (agent inboxes + advisory file leases), Happy (~22k★, E2E-encrypted relay — human→agent only). Parallel-session management is commoditized; avoid claude-flow/ruflo (audited stub tools, security incidents).

**Our differentiation (survives the native roadmap):** (1) unforgeable mechanical caller identity via per-agent MCP URLs — almost nobody else has this; (2) judgment-based stall handling with graduated autonomy (sentinel + operator channel sign-off) — nobody has this; (3) the combination: runtime-agnostic supervision layer (health, identity, operator control, scheduling) above whatever intra-session teams the vendors ship.

**Design considerations to adopt:**

- **Hooks as stall signals**: supplement pane-diffing with Claude Code `Stop`/`Notification` hooks (deterministic, transcript-based) and Codex `notify` events; keep pane-diff as fallback for wedged TUIs. Pane-scraping fragility is the #1 documented failure mode in this space (Omnara abandoned it).
- **Anti-spam on `broadcast`**: explicit-recipient bias / rate-limit (mcp_agent_mail's lesson).
- **Advisory file leases** (reserve-before-edit + git hook) as a future MCP tool — solves multi-agent merge collisions.
- **Happy's E2E relay design** as reference architecture for Phase 2 (client-held keys, server sees ciphertext).
- **Naming**: "Conductor" collides with conductor.build (well-known Mac app for parallel Claude agents). Consider a distinct name before publishing.

## Part 5 — Remaining Open Questions

All resolved (2026-07-14):

1. Numbered-option auto-responses: **CUT** — menus surface as stall events; sentinel handles them.
2. Focus auto-pause: **KEEP** as optional iTerm-only capability.
3. `request_human_input`: **in-memory + ChannelAdapter round-trip** (sentinel answers or escalates in autonomous mode).
4. State: **single SQLite store** — mode-state.json and workspace.json folded in.
5. Hooks-based stall signals: **ADOPTED** (see `adoption-proposals.md` A1).
6. Naming: **keep `agent-conductor`** (collision with conductor.build accepted as brand-level only). License: **MIT**. Location: `~/Projects/agent-conductor`.

Also resolved earlier: greenfield ✓ · SDK path cut ✓ · approve mode cut ✓ · permission model + orchestration policy cut ✓ · nudge levels cut ✓ · escalations cut ✓ · usage monitor cut ✓ · relay deferred to Phase 2 ✓ · worktrees + origin-keyed file leases adopted (N10/N11) ✓

Next: `docs/implementation-plan.md`.
