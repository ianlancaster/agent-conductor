# Competitive Landscape — Agent Conductor

Purpose: before building the greenfield agent-conductor, verify we are not reinventing the
wheel — map what exists natively in Claude Code / Codex and in the open-source community,
identify where we should reuse or borrow instead of build, and confirm (or refute) our
differentiation.

Research date: July 2026. Sources linked at the bottom.

---

## 0. What we are building (the comparison baseline)

A runtime-agnostic supervisor for terminal coding agents (Claude Code + Codex CLI) with:

1. **Terminal pane orchestration** — launch/manage agent sessions in iTerm2 or tmux panes
2. **Inter-agent messaging with mechanical identity** — agents message peers via MCP tools; caller identity derived from per-agent MCP URLs, unforgeable
3. **Stall detection + stall sentinel** — mechanical detection; a designated agent decides how to respond
4. **Operator channel adapters** — Telegram/Slack/Discord remote control and escalation
5. **Cron scheduling** of agent prompts
6. **Phase 2: hosted relay** — cross-machine agent-to-agent messaging

---

## 1. Native vendor tooling

### 1.1 Claude Code

| Capability            | Status                            | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents (Task tool) | Stable                            | In-session child agents with own context and tool allowlists (`.claude/agents/*.md`). One-way report-back to the parent; subagents don't message each other.                                                                                                                                                                                                                                                                                 |
| **Agent Teams**       | **Experimental** (env-flag gated) | Multiple peer Claude Code instances _within one session_: team lead + teammates, shared task list with dependencies, JSON-file mailboxes (`~/.claude/teams/<name>/inboxes/`), teammate-to-teammate `SendMessage`, plan-approval gates. Display via in-process view or **split panes in tmux/iTerm2** — Anthropic is building the pane-per-agent UX natively. Limits: one team per session, Claude-only, no resume with in-process teammates. |
| Background sessions   | Stable                            | `claude --bg`, `claude agents` dashboard, `claude attach <id>` — sessions survive terminal close with status previews.                                                                                                                                                                                                                                                                                                                       |
| Channels plugins      | Research preview                  | Two-way Telegram / Discord / iMessage forwarding into a running session (`--channels plugin:telegram@claude-plugins-official`). Single-session scope.                                                                                                                                                                                                                                                                                        |
| Hooks                 | Stable                            | `Stop`, `Notification`, `PreToolUse`/`PostToolUse`, `SubagentStart/Stop` — deterministic lifecycle signals.                                                                                                                                                                                                                                                                                                                                  |
| Scheduling            | Partial                           | `/loop` (session-scoped, only fires while the session is open); `/schedule` cloud routines (Anthropic-hosted, ≥1h granularity). No local unattended cron of CLI sessions.                                                                                                                                                                                                                                                                    |
| Headless / SDK        | Stable                            | `claude -p`, `--output-format stream-json`, `--resume <id>`, Agent SDK — the sanctioned surface for building supervisors.                                                                                                                                                                                                                                                                                                                    |

**Similar to us:** Agent Teams overlaps meaningfully — peer instances, mailbox messaging, pane display. Channels plugins overlap with our operator adapters for the single-session case.

**Different / not covered:** everything Agent Teams does is scoped to _one session, one runtime, one machine_. There is no cross-process supervision, no stall detection (idle panes are nobody's problem), no health monitoring, no operator approval loop across a fleet, no Codex interop, no unattended scheduling of terminal sessions.

**How we use it rather than fight it:**

- Adopt `Stop`/`Notification` **hooks as primary stall signals** (deterministic, transcript-based) with pane-diff as fallback — this de-risks the fragility that killed other pane-scraping projects.
- Watch Agent Teams' trajectory. If it graduates, the strongest position is _supervising_ native teams (identity + sentinel + operator channel on top) rather than replacing their mailbox.

### 1.2 OpenAI Codex CLI

| Capability            | Status                | What it gives you                                                                                                                                                                                                                                         |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents             | Native, on by default | Explicit-delegation agent threads (`[agents]` in config.toml: `max_threads` 6, `max_depth` 1). Parent-routed; no peer messaging.                                                                                                                          |
| MCP client            | Stable                | `[mcp_servers.<name>]` in `~/.codex/config.toml` or project `.codex/config.toml` — stdio **and streamable HTTP with `url`** (+ bearer token env). `codex mcp add` CLI. Note the 60s default `tool_timeout_sec` — must be raised for long conductor tools. |
| `codex mcp-server`    | Stable                | Codex itself exposed as an MCP tool — the documented way to orchestrate Codex headlessly.                                                                                                                                                                 |
| Instruction injection | Stable                | `AGENTS.md` chain (global → project, plus `AGENTS.override.md`), `developer_instructions` config, `-c key=value` overrides. No `--append-system-prompt` equivalent.                                                                                       |
| Session resume        | Stable                | `codex resume --last "..."` / picker; `codex exec` for non-interactive runs.                                                                                                                                                                              |

**Key finding for us:** Codex's HTTP MCP support means **our per-agent-URL identity scheme works with Codex unmodified**. The CodexRuntime adapter needs: AGENTS.md-based protocol injection, config.toml MCP wiring (with raised tool timeouts), `codex resume` for continue, and Codex-specific chrome/glyph patterns. Codex has no `/usage`/`/context` equivalents — fine, since usage monitoring is cut and context introspection is an optional capability.

**Not covered natively:** peer messaging between separate Codex processes, pane orchestration, stall detection, operator channels, scheduling, Claude interop.

---

## 2. Open-source and community projects

### 2.1 Gas Town — the heavyweight incumbent

[github.com/steveyegge/gastown](https://github.com/steveyegge/gastown) · ~17k★ · Go · very active

Multi-agent "workspace manager": tmux-backed roles (Mayor coordinator, Polecat workers, **Witness per-rig health monitors, Deacon supervisor daemon**, Refinery merge queue), git-backed Beads issue tracker as the unit of work, agent mailboxes/handoffs, stall surfacing ("GUPP violations"), capacity governor, severity-routed escalations. Multi-runtime (Claude, Codex, Copilot, Gemini, Cursor).

- **Similar:** tmux orchestration, inter-agent mail, health monitoring, multi-runtime — the closest philosophical sibling.
- **Different:** no remote operator channel (no Telegram/Slack); stall responses are mechanical, not judgment-based; deeply opinionated around Beads/roles; notorious token burn (~$100/hr at 12–30 agents) and steep learning curve. Identity is role-based/self-declared, not mechanical.
- **Verdict:** don't adopt; **borrow the idea** of a git-backed work ledger as durable agent memory, and its Witness/Deacon split (per-agent monitor + fleet supervisor) validates our sentinel-with-watchdog design.

### 2.2 amux — the closest lightweight rival

[github.com/mixpeek/amux](https://github.com/mixpeek/amux) · ~300★ · Python · young

Single-file control plane: tmux-native (parses ANSI-stripped pane output), self-healing watchdog (auto-compact, restart on corruption, fleet-wide rate-limit handling), web dashboard + iOS app, inter-agent coordination (REST API, shared channels with @mentions, atomic task claiming), scheduler. Multi-runtime.

- **Similar:** almost feature-for-feature — pane orchestration, watchdog, messaging, scheduling.
- **Different:** no mechanical identity (REST, unauthenticated dashboard), no LLM/sentinel judgment on stalls, no chat-channel adapters, Python single-file architecture won't carry production hardening.
- **Verdict:** validates demand for exactly our shape. Nothing to reuse directly; watch it.

### 2.3 claude-squad

[github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) · ~7.9k★ · Go · AGPL-3.0 · active

TUI managing multiple Claude Code/Codex/Gemini/Aider instances in tmux sessions + git worktrees, background auto-accept mode.

- **Similar:** multi-instance terminal session management, multi-runtime, tmux.
- **Different:** no messaging, no stall detection, no operator channel, no scheduling — it's parallel session _management_, not orchestration. AGPL also complicates borrowing code.
- **Verdict:** different category; confirms session-management alone is commoditized.

### 2.4 Tmux-Orchestrator (and forks)

[github.com/Jedward23/Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) · shell scripts · proto-project (2025)

Orchestrator/PM/Engineer hierarchy in tmux windows, `send-claude-message.sh`, self-scheduled check-ins.

- **Similar:** the original proof that pane-message orchestration works.
- **Different:** shell-script grade; messaging is unauthenticated keystroke injection; no health monitoring beyond prompted check-ins.
- **Verdict:** superseded; historical validation only.

### 2.5 Agent-MCP

[github.com/rinadelph/Agent-MCP](https://github.com/rinadelph/Agent-MCP) · ~1.3k★

MCP server for multi-agent orchestration: admin/worker agents, task assignment, shared RAG knowledge graph, agent communication tools, dashboard.

- **Similar:** MCP as the agent-coordination protocol (same bet we made).
- **Different:** no terminal/pane layer, no stall detection, no operator channel; token-registered identities rather than mechanical.
- **Verdict:** parallel validation of MCP-as-coordination-bus; nothing to reuse.

### 2.6 mcp_agent_mail

[github.com/Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) · (Yegge maintains a fork)

"Gmail for coding agents": MCP inboxes, searchable threads, **advisory file leases** (git hook blocks commits touching files another agent reserved), contact handshake for cross-project messaging, deliberately **no broadcast** (anti-spam).

- **Similar:** MCP-based inter-agent messaging with identities.
- **Different:** pure coordination layer — no sessions, health, or operator features.
- **Verdict:** **borrow two ideas**: advisory file leases (future MCP tool solving the biggest real multi-agent failure — merge collisions) and explicit-recipient bias / rate-limiting on our `broadcast` tool.

### 2.7 Happy

[github.com/slopus/happy](https://github.com/slopus/happy) · ~22.6k★ · MIT

E2E-encrypted mobile/web client for Claude Code and Codex (`happy claude`); relay server with instant device switching.

- **Similar:** the most mature hosted-relay architecture in the space; multi-runtime.
- **Different:** relays **human→agent** control only; no agent→agent messaging, no orchestration, stall detection, or scheduling.
- **Verdict:** **reference architecture for our Phase 2 relay** (client-held keys, server sees ciphertext). Consider interop for the human→agent leg instead of competing; our relay's unique job is authenticated agent→agent envelopes.

### 2.8 Omnara — the cautionary tale

[github.com/omnara-ai/omnara](https://github.com/omnara-ai/omnara) · YC S25

Phone/web/watch command center for Claude Code/Codex. Their original **CLI-wrapper/scraping approach was abandoned as unmaintainable** ("Claude Code's constant updates") and rebuilt on the Agent SDK.

- **Verdict:** the strongest argument for our hooks-first stall-signal design and for keeping all runtime-specific parsing behind the AgentRuntime seam where it's cheap to patch.

### 2.9 Conductor (conductor.build)

Closed-source Mac app (Melty Labs), Apple Silicon only. Parallel Claude Code/Codex/Cursor agents in worktrees with review-by-diff UX; used at Linear/Vercel/Notion.

- **Similar:** name (!), parallel agents, multi-runtime.
- **Different:** desktop review UX; no messaging, sentinel, or remote channel; closed source.
- **Verdict:** category-adjacent. **Naming collision is real — pick a distinct public name.**

### 2.10 Briefly noted

- **Crystal → Nimbalyst** — Electron parallel-session desktop app; Crystal deprecated Feb 2026. Session management category.
- **Vibe Kanban** — kanban-driven agent execution across 10+ runtimes; company shut down, community-maintained. Task-centric, not supervision-centric.
- **Telegram bridges** (claude-code-telegram, ccgram, telclaude, claude-telegram-remote) — single-agent remote control. Notable: **claude-telegram-remote's transcript-walking `Stop` hook** is a proven deterministic completion/stall signal — the pattern to adopt in our ClaudeCodeRuntime. ccgram's inline permission buttons are good ChannelAdapter UX prior art.
- **claude-flow / "Ruflo"** — huge marketing footprint; independent audits found ~97% of its 300+ MCP tools are stubs, plus a prompt-injection incident and a malicious preinstall script in some versions. **Avoid entirely.**

---

## 3. Comparison matrix

✅ has it · 🟡 partial · ❌ no

| Feature                                      | **agent-conductor**  | Gas Town         | amux             | claude-squad | Agent-MCP    | mcp_agent_mail | Happy                   | CC Agent Teams          | Codex subagents  |
| -------------------------------------------- | -------------------- | ---------------- | ---------------- | ------------ | ------------ | -------------- | ----------------------- | ----------------------- | ---------------- |
| Terminal pane orchestration                  | ✅ iTerm2 + tmux     | ✅ tmux          | ✅ tmux          | ✅ tmux      | ❌           | ❌             | ❌                      | 🟡 single-session panes | ❌               |
| Inter-agent messaging                        | ✅ MCP               | ✅ mailboxes     | ✅ channels      | ❌           | ✅ MCP       | ✅ MCP         | ❌                      | ✅ single-session       | 🟡 parent-routed |
| **Mechanical (unforgeable) identity**        | ✅ per-agent MCP URL | 🟡 self-declared | ❌               | —            | 🟡 tokens    | 🟡 registered  | —                       | 🟡 harness-managed      | —                |
| Stall detection                              | ✅ hooks + pane-diff | ✅ mechanical    | ✅ mechanical    | ❌           | ❌           | ❌             | ❌                      | ❌                      | ❌               |
| **Judgment-based stall response (sentinel)** | ✅                   | ❌               | ❌               | ❌           | ❌           | ❌             | ❌                      | ❌                      | ❌               |
| Operator chat channel (Telegram/Slack/…)     | ✅ adapters          | ❌               | 🟡 dashboard/iOS | ❌           | 🟡 dashboard | ❌             | ✅ mobile (human→agent) | 🟡 preview plugins      | ❌               |
| Multi-runtime (Claude + Codex)               | ✅                   | ✅               | ✅               | ✅           | 🟡           | ✅             | ✅                      | ❌                      | ❌               |
| Local cron scheduling                        | ✅                   | 🟡               | ✅               | ❌           | ❌           | ❌             | ❌                      | 🟡 session-scoped       | ❌               |
| Cross-machine agent→agent relay              | 🟡 Phase 2           | 🟡 experimental  | ❌               | ❌           | 🟡 LAN       | 🟡 handshake   | ❌ (human leg only)     | ❌                      | ❌               |

---

## 4. Are we reinventing the wheel? Build-vs-reuse per feature

| Feature                                     | Verdict                                | Rationale                                                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pane orchestration (iTerm/tmux)             | **Build** (thin)                       | No reusable library exists; every project hand-rolls it. Our TerminalBackend seam keeps each impl small.                                                                                                                             |
| Inter-agent messaging + mechanical identity | **Build**                              | The identity mechanism is our core differentiator; nobody offers it as a library. Borrow mcp_agent_mail's anti-spam stance for `broadcast`.                                                                                          |
| Stall _detection_                           | **Build, hooks-first**                 | Adopt Claude `Stop`/`Notification` hooks + Codex `notify` as primary signals (proven pattern in claude-telegram-remote); pane-diff only as fallback. Pure pane-scraping is the documented failure mode of this space.                |
| Stall _response_ (sentinel)                 | **Build**                              | Genuinely novel — no project or vendor does judgment-based stall handling with operator escalation.                                                                                                                                  |
| Operator channels                           | **Build the adapter seam**             | Existing Telegram bridges are single-agent and unreusable as deps, but ccgram/telclaude are good UX prior art. Claude's native Channels plugins may eventually serve single-session needs; our fleet-level channel remains distinct. |
| Scheduling                                  | **Reuse `croner`**                     | Cron parsing is commodity; only the fire-into-session glue is ours.                                                                                                                                                                  |
| Codex integration                           | **Reuse native surfaces**              | HTTP MCP config (identity works as-is), AGENTS.md injection, `codex resume`. Consider `codex exec`/`codex mcp-server` as a headless alternative if TUI-in-pane proves fragile.                                                       |
| Cross-machine relay (Phase 2)               | **Build, copy Happy's architecture**   | E2E design with client-held keys; consider interop with Happy for the human→agent leg and keep our relay focused on agent→agent envelopes.                                                                                           |
| Work ledger / task state                    | **Defer; borrow Beads' insight later** | Git-backed durable work state is a good future addition; SQLite session state suffices for v1.                                                                                                                                       |

## 5. Conclusion

**We are not reinventing the wheel — but only because of two specific features.** Parallel-session management is fully commoditized (claude-squad, Crystal, Conductor.build, and now native Agent Teams), and if that were the pitch, this project would be redundant. What no native or open-source option provides, alone or in combination:

1. **Unforgeable mechanical caller identity** for inter-agent messaging (and it extends to Codex unmodified via HTTP MCP).
2. **Judgment-based stall supervision** — a sentinel agent that sees every stall and decides, with operator escalation through chat channels.
3. The **runtime-agnostic supervision layer** as a whole: health + identity + operator control + scheduling across separate processes, runtimes, and (Phase 2) machines — positioned _above_ whatever intra-session teams Anthropic and OpenAI ship.

Main strategic risks: Anthropic's Agent Teams absorbing the pane-per-agent UX for Claude-only fleets (mitigation: supervise native teams rather than compete; stay runtime-agnostic), and pane-scraping fragility (mitigation: hooks-first stall signals, all parsing quarantined in runtime adapters). Plus the naming collision with conductor.build.

---

### Sources

Claude Code: [Agent Teams](https://code.claude.com/docs/en/agent-teams.md) · [Subagents](https://code.claude.com/docs/en/sub-agents.md) · [Agent View](https://code.claude.com/docs/en/agent-view.md) · [Headless](https://code.claude.com/docs/en/headless.md) · [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md) · [Channels](https://code.claude.com/docs/en/channels.md)
Codex: [MCP](https://developers.openai.com/codex/mcp) · [Config reference](https://developers.openai.com/codex/config-reference) · [Subagents](https://developers.openai.com/codex/subagents) · [AGENTS.md](https://developers.openai.com/codex/guides/agents-md) · [Agents SDK guide](https://developers.openai.com/codex/guides/agents-sdk)
Projects: [Gas Town](https://github.com/steveyegge/gastown) · [claude-squad](https://github.com/smtg-ai/claude-squad) · [amux](https://github.com/mixpeek/amux) · [Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) · [Agent-MCP](https://github.com/rinadelph/Agent-MCP) · [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) · [Happy](https://github.com/slopus/happy) · [Omnara](https://github.com/omnara-ai/omnara) · [Conductor](https://www.conductor.build/) · [Crystal](https://github.com/stravu/crystal) · [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) · [ruflo](https://github.com/ruvnet/ruflo) + [audit gist](https://gist.github.com/roman-rr/ed603b676af019b8740423d2bb8e4bf6) · [claude-telegram-remote](https://github.com/oscarsterling/claude-telegram-remote) · [ccgram](https://github.com/jsayubi/ccgram) · [telclaude](https://github.com/avivsinai/telclaude)
