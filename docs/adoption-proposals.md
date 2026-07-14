# Adoption Proposals — Native Integrations & Borrowed Patterns

Companion to `competitive-landscape.md`. For each candidate: the pitch, integration shape,
cost, and a verdict. Verdict tiers: **ADOPT v1** (build into the greenfield core),
**ADOPT v1.x** (fast-follow after core ships), **PHASE 2** (with the relay), **WATCH**
(re-evaluate on vendor movement), **DECLINE**.

> **Operator review (2026-07-14):** A1 ✓ adopted (event-driven health ratified). B2 modified —
> no rate limit, guidance-only. B3 ✓ adopted, with `tail_agent` explicitly retained so the
> sentinel can pull more context on demand. B5 ✓ adopted. B7 ✓ adopted. B6/B9 declines
> confirmed. **B1 ✓ and B4 ✓ adopted** (second review): worktrees get first-class lifecycle
> support — new MCP tools to spawn and destroy worktrees mirroring `spawn_agent` /
> `teardown_agent` — and file leases ship keyed by repo origin so they work across separate
> clones as well as worktrees. Product principle ratified: **lightweight CLI-only tool giving
> agents powerful communication primitives and protocols — avoid gold-plating.**

---

## A. Native tool integrations

### A1. Lifecycle hooks as the primary event bus — **ADOPT v1** ⭐ highest-impact item

**What:** Both runtimes can push deterministic lifecycle events to us instead of us inferring
everything from pane pixels:

- **Claude Code hooks** (settings-file configured, JSON payload on stdin including
  `session_id` and `transcript_path`):
  - `Stop` — agent finished its turn → deterministic "idle now" signal
  - `Notification` — agent is waiting on permission or idle-waiting for input → deterministic
    "blocked, needs a decision" signal, with the reason
  - `SessionStart` (source: `compact`) / `PreCompact` — deterministic compaction signal
    (replaces the cut post-compaction pane regex with a real event)
  - `SessionEnd` — clean death detection (vs. inferring from a dead pane)
- **Codex `notify`** (config.toml): fires a command with a JSON event on
  `agent-turn-complete` — the Codex equivalent of `Stop`.

**Integration shape:** the conductor already runs an HTTP server with per-agent URL identity.
Add an events endpoint (`POST /events/<codename>`); each runtime adapter injects hook config
at launch (Claude: a generated settings file passed via `--settings`; Codex: `notify` in the
generated config profile). The hook command is a one-line `curl` POST. Identity stays
mechanical — the hook config an agent was launched with determines its event URL, same trick
as the MCP URLs.

**What it buys:**

1. Stall detection stops being "pane text unchanged for a beat" and becomes
   _event-driven_: `Stop` + no new work = idle; `Notification` = blocked on a decision —
   each with the transcript path so the sentinel can read what the agent actually said,
   not just 40 lines of screen scrape.
2. Kills the #1 fragility risk in this space (Omnara abandoned pane-scraping; every
   Claude Code UI update threatens chrome regexes).
3. Pane-diff demotes to a fallback watchdog for truly wedged TUIs — which is the only
   thing it's actually reliable at.

**Cost:** S–M. One endpoint, hook-config generation in each runtime adapter, and the
HealthMonitor reworked to consume events with pane-diff fallback. Design N2/N4 around this
from day one — retrofitting event-driven health onto a polling architecture later is a rewrite.

### A2. Native session resume surfaces — **ADOPT v1** (trivial)

`claude -c` (already used) and `codex resume --last` map cleanly onto `continue_agent`.
No decision needed beyond confirming the CodexRuntime uses `codex resume` rather than
trying to replay context.

### A3. Claude background sessions (`claude --bg` / `claude attach`) — **ADOPT v1.x**

**What:** Claude Code sessions that run detached from any terminal, listed via a native
dashboard, attachable on demand.

**Pitch:** a fourth placement type — `background` — alongside pane/tab/window. For big
fleets, most agents don't need a visible pane most of the time; the operator attaches one
into a pane only when they want to watch. Pairs beautifully with hooks (A1): a background
agent's health comes entirely from events, no pane to capture. Codex has no equivalent, so
it's a capability-flagged Claude-only placement.

**Cost:** M (placement plumbing + attach flow). Not v1 because pane-first is the proven
workflow; but keep `placement` an open enum so this slots in without schema churn.

### A4. Claude Channels plugins (native Telegram/Discord/iMessage) — **WATCH / DECLINE for core**

Research preview, single-session scope. It solves "talk to _one_ session from Telegram,"
not "operate a fleet." Our ChannelAdapter is fleet-scoped (status, start/stop, sentinel
escalations across all agents). Don't build on it; don't block users from enabling it on
individual agents. Re-evaluate if Anthropic ships fleet-level channels.

### A5. Agent Teams (experimental) — **WATCH, design for it**

One team per session, Claude-only, env-flag-gated — not a foundation to build on today.
But its trajectory is the biggest strategic overlap we have. Cheap insurance now: keep the
conductor's model of "an agent" abstract enough that a future `AgentTeamsRuntime` could
register a whole native team as one supervised unit (identity + sentinel + operator channel
on top of their mailbox). No code in v1; an explicit note in the AgentRuntime interface docs.

### A6. `codex exec` / `codex mcp-server` as a headless Codex path — **WATCH (contingency)**

If Codex's TUI proves hostile to pane supervision (chrome churn, input quirks), the
documented orchestration surface — `codex exec` for one-shots, `codex mcp-server` for
structured back-and-forth — is the escape hatch. Keep the CodexRuntime's internals private
to the adapter so swapping TUI-driving for exec-driving is not a breaking change.

---

## B. Patterns to pull in from open-source projects

### B1. Advisory file leases (from mcp_agent_mail) — **ADOPT v1.x** ⭐ best borrowed idea

**What:** agents reserve file paths before editing (`reserve_files` / `release_files` MCP
tools); reservations are visible to peers; an optional git pre-commit hook blocks commits
touching paths another agent holds.

**Pitch:** the single most common real failure in multi-agent coding is two agents editing
the same files and producing merge wreckage. Orchestration deny-lists (which we cut) tried
to prevent agents from stepping on each other's _sessions_; leases prevent them stepping on
each other's _work_ — which is the collision that actually happens. It's advisory, so no
workflow is forced: well-behaved agents check leases (the conductor protocol prompt tells
them to), and the git hook is opt-in per repo for hard enforcement.

**Cost:** S–M. One SQLite table (path glob, holder, expiry), two MCP tools, lease info in
`get_agent_status`, an optional hook script. TTL-based expiry so a dead agent can't hold a
lease forever.

**Why not v1:** it's additive and independent — perfect first post-launch feature; keeps v1
core lean.

### B2. Broadcast guidance (from mcp_agent_mail) — **ADOPT v1 (guidance-only, per operator)**

Operator call: no rate limiting — broadcast has not been a problem in practice. Instead,
the `broadcast` tool description and the conductor protocol prompt instruct agents to use
it carefully and sparingly, preferring explicit-recipient `send_to_agent` / `notify_agents`.

### B3. Transcript-aware stall context (from claude-telegram-remote) — **ADOPT v1** (rider on A1)

**What:** their Stop hook walks the session transcript to decide completion state
deterministically.

**Pitch:** since Claude's hook payload hands us `transcript_path`, the stall event we route
to the sentinel should include the agent's _last assistant message_ alongside the pane
capture. The sentinel then judges "agent stopped after saying it finished task X" vs.
"agent stopped mid-sentence" from ground truth rather than terminal chrome. Small parsing
utility in the ClaudeCodeRuntime; large quality lift for every sentinel decision.

Operator addendum: `tail_agent` stays in the sentinel's toolset regardless — the transcript
excerpt is the default context, and the sentinel pulls more (deeper tail, fresh capture)
on demand.

### B4. Git worktree spawning (from claude-squad / Conductor / Crystal) — **ADOPT v1.x**

**What:** the commoditized-but-good idea from the session managers: spawn agents into git
worktrees of the same repo so N agents work one codebase in parallel without collisions.

**Pitch:** `spawn <name> --worktree <repo> [--branch <b>]` creates a worktree and registers
the agent there. Today spawn assumes a fresh or existing directory; worktrees are what
teams actually want for parallel feature work, and they compose with file leases (B1) for
the shared-files edge. Cost: S (a `git worktree add` in the spawn path + teardown cleanup).

### B5. Per-agent monitor + fleet supervisor split (from Gas Town's Witness/Deacon) — **ADOPT v1 (conceptually)**

Gas Town independently converged on our design: something watches each agent, and something
watches the watchers. Adopt the _pattern_ explicitly in N4: the conductor's mechanical
watchdog is the layer beneath the sentinel and monitors the sentinel too (sentinel stalled /
absent → escalate straight to operator via ChannelAdapter). This is validation, not new
scope — it's already in the registry; this pins it as deliberate.

### B6. Git-backed work ledger (from Gas Town's Beads) — **DECLINE for now, revisit post-v1**

**What:** persistent, git-tracked issue/task state as the unit of agent work and cross-restart
memory.

**Honest pitch and honest pushback:** it would give the sentinel real objective context
("this agent's claimed task is X, it stalled at step Y") and survive restarts beautifully.
But it drags the conductor toward being an opinionated workflow system — the exact
heavyweight trap that makes Gas Town a lifestyle. Our `auto` objective string + session
history covers the v1 need. Revisit only if real usage shows the sentinel starving for
task context.

### B7. Buttons as a first-class ChannelAdapter capability (from ccgram) — **ADOPT v1 (design detail)**

The best Telegram bridges put approve/deny/option buttons on everything. Bake into the
ChannelAdapter interface: adapters declare `supportsButtons`; the conductor expresses
choices abstractly (question + options) and adapters render them as inline buttons
(Telegram/Slack/Discord all support this) or fall back to numbered-reply parsing. This is
exactly the shape `request_human_input` and sentinel escalations need.

### B8. E2E-encrypted relay architecture (from Happy) — **PHASE 2 (already recorded)**

Client-held keys, server sees ciphertext, outbound-only connections from local conductors.
Additionally: evaluate _interop_ with Happy for the human→agent leg (22k★ of mobile-client
mindshare) so our relay stays focused on the unserved leg — authenticated agent→agent
envelopes.

### B9. amux-style fleet dashboard / iOS app — **DECLINE**

The ChannelAdapter + CLI covers operator needs for v1; a web dashboard is a product
expansion, not a gap. Revisit with the relay server (which needs monitoring endpoints
anyway — they can later feed a dashboard).

---

## Priority summary

| Verdict        | Items                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADOPT v1**   | A1 hooks event bus ⭐ · A2 native resume · B2 broadcast rate-limit · B3 transcript-aware stall context · B5 watchdog-over-sentinel · B7 buttons-capable ChannelAdapter |
| **ADOPT v1.x** | B1 advisory file leases ⭐ · B4 worktree spawning · A3 background placement                                                                                            |
| **PHASE 2**    | B8 E2E relay (+ possible Happy interop)                                                                                                                                |
| **WATCH**      | A5 Agent Teams (design AgentRuntime to allow a future team-as-unit) · A6 headless Codex contingency · A4 native Channels                                               |
| **DECLINE**    | B6 work ledger (revisit post-v1) · B9 dashboard                                                                                                                        |

The v1 adoptions change the architecture in one important way: **the health system becomes
event-driven with polling fallback** (A1+B3), rather than polling-first. That decision has
to be made before N2/N4 are designed, which is why this doc exists now.
