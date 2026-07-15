# agent-conductor — Adversarial Code Review

**Date:** 2026-07-15
**Scope:** Full `src/` tree (5,761 LOC) reviewed fresh-context across six subsystems, findings verified against source.
**Method:** Six parallel subsystem reviews (core event/timing, orchestration/lifecycle, MCP/identity security, terminal backends, agent runtimes, store/config/channels/CLI), then direct source verification of every High/Critical claim.

---

## Executive summary

The architecture is genuinely good: the three-seam design (terminals / runtimes / channels) is real and testable, the mechanical-identity URL scheme is implemented correctly (no `from` params anywhere), autonomy invariants hold, SQL is fully parameterized, and AppleScript/tmux escaping is disciplined. The code reads like it was written by someone who understood the problem.

The problems cluster in three areas:

1. **No authentication on the HTTP surface.** The identity _mechanism_ is right, but nothing authenticates it. Any local process can assume any codename (including the sentinel's) or drive the whole fleet via `/cmd`. This is the single most important issue.
2. **Two process-crash paths.** A failed stall delivery becomes an unhandled promise rejection; a stale idle-timer fires into a deregistered agent and throws inside a `setTimeout`. Either kills the conductor and takes down all supervision.
3. **Message-loss and audit-integrity gaps.** Several paths report "delivered" when a message was queued, dropped, or sent to a dead pane — and mark it delivered in the durable store, so post-incident audit lies.

Counts: **1 critical, ~9 high, ~18 medium, ~30 low.** Deduplicated below (many findings were independently reported by 2–3 reviewers, which raises confidence).

---

## Critical

### C1 — No authentication anywhere on the HTTP surface; identity is asserted, not proven

`src/mcp/server.ts:100-127`, `src/core/identity.ts:12-13`

The entire surface (`/mcp/<codename>`, `/events/<codename>`, `/cmd`) has zero auth — no token, no shared secret, no per-agent credential. `caller` is taken verbatim from the URL path. The comment at `identity.ts:12-13` ("agents cannot impersonate each other") is **false**: the path is 100% client-controlled and codenames are not secret (they're listed by `list_agents`, `get_agent_status`, status output).

Concrete exploits, all from any process that can reach `127.0.0.1:3456`:

- **Assume the sentinel.** `isSentinel(caller)` is a plain string compare (`sentinel.ts:44-45`), so a POST to `/mcp/<sentinelCodename>` passes the `sentinelOnly` gate (`server.ts:173`) and can call `resolve_stall` (type text into any agent's pane), `get_stall_queue`, `answer_human_input`.
- **Impersonate any peer** for `send_to_agent`, `set_autonomy`, `teardown_agent`, `stop_agent`. The `noSelf` guard is worthless since `caller` is attacker-chosen.
- **Drive the fleet as the operator via `/cmd`** (see H2) — no gate at all.
- **Forge health/lifecycle events** via `/events/<victim>` (see H3).

Because invariant #4 makes health event-driven-first, forged events can also suppress genuine stall detection.

**Fix:** generate a per-agent bearer secret at startup, bake it into each agent's MCP/events URL config, require it on `/cmd`. Closes C1/H2/H3 and the `0.0.0.0` exposure (M-bind) at once. Reported independently by the security and store/CLI reviewers.

---

## High

### H1 — Unhandled promise rejection on failed stall delivery crashes the conductor

`src/core/supervisor.ts:152`, `src/core/sentinel.ts:103`, `src/core/delivery.ts:42`

`onStall` does `void this.sentinel.handleStall(...)` (fire-and-forget). `handleStall` awaits `deliver(sentinel, …)` → `deliverOrQueue`'s **direct** path `await this.deps.backend.run(pane, text)` (delivery.ts:42) is the one backend call with no try/catch. There is no `process.on('unhandledRejection')` anywhere in `src/` (verified). If the sentinel's pane errors on write (closed iTerm window, tmux gone), the rejection is discarded → Node ≥15 terminates the process → **all fleet supervision lost.** The `heartbeat()` per-agent try/catch (health.ts:88) cannot catch a rejection from a `void`ed promise. Reported by both the core and orchestration reviewers.

### H2 — `/cmd` grants full operator control with no auth and bypasses all tool gating

`src/mcp/server.ts:111-123`, `src/cli/index.ts:57-66`

Any POST `{"command":"/tell victim <prompt>"}` to `/cmd` runs the operator command router as identity `'operator'` — `/start`, `/stop`, `/tell`, `/broadcast`, `/auto`, `/pause`. No sentinel gate, no `noSelf`. `readBody` JSON-parses regardless of `Content-Type`, so it's a CSRF-able `text/plain` simple request: **any webpage the operator visits** can `fetch('http://127.0.0.1:3456/cmd', …)` and drive the fleet (→ prompt injection → code execution in agent repos).

### H3 — Unauthenticated `/events/<agent>` lets any client forge lifecycle/health events

`src/mcp/server.ts:100-108`, `src/core/supervisor.ts:335-342`

No binding between poster and `<agent>`; body validated only by the runtime `parseEvent`. A malicious agent POSTs fabricated `Stop`/activity events to `/events/<victim>` to keep a hung agent looking alive (suppress stall detection) or synthesize a stall. Also (`L3` from runtimes) `transcript_path` is trusted verbatim from this body and later read from disk by the sentinel → arbitrary local-file read of any JSONL-parseable file.

### H4 — `codex resume --last` resumes whichever session is globally newest, not this agent's

`src/runtimes/codex/index.ts:151`, design comment `index.ts:104-107`

Codex deliberately never sets `CODEX_HOME`, so all codex agents _and the operator's personal codex use_ share `~/.codex/sessions`. `resume --last` picks the newest rollout in that shared store with no cwd/agent scoping. Scenario: `alpha` and `beta` both run codex; `beta` crashes; conductor issues `continue beta` → `codex resume --last` in beta's pane **resumes alpha's session**, now wired to beta's MCP identity. Beta continues alpha's task under beta's identity. Claude Code's `-c` is cwd-scoped, so it's safe there — a silent contract divergence. Auto-continue paths in `lifecycle.restart`/`start` are agent-agnostic and hit this.

### H5 — Stale idle-confirm timer survives stop/teardown and throws inside `setTimeout` → crash

`src/core/health.ts:59-64`, `src/core/lifecycle.ts:127-140,216-227`

`lifecycle.stop()`/`clearSession()` never call `healthReset` (only `start()` does). An armed idle timer (default 15s) survives an operator `/stop`. If the agent is also deregistered (teardown or roster reload), the timer fires → `onStall` → `states.setActivity(agent,…)` → `mustGet` throws `Unknown agent` (state.ts:112) → **uncaught synchronous exception inside a timer callback → process exit.** Repro: agent emits `stop`, operator tears it down within 15s → crash at +15s. Even without deregistration (H5b/F3) it overwrites `stopped` with `idle` and routes a phantom stall for a deliberately stopped agent.

### H6 — `lifecycle.start` has no concurrency guard → duplicate panes + orphaned session

`src/core/lifecycle.ts:74-121`

The "already running" check (79-85) and the commit (`panes.set` 97, `sessions.set` 107) are separated by seconds of awaits (`prepare`, `createPane` on AppleScript). Two near-simultaneous starts (cron fire + operator `/start`, or auto-start via `sendToAgent`) both pass the check → two panes for one identity; the maps overwrite → the first pane is never tracked, never killed by `/stop`, and its SQLite session row stays `active` forever.

### H7 — `spawn` writes files from an unvalidated codename; `spawn_agent`/`create_worktree` are not sentinel-gated → path traversal + YAML injection reachable by any agent

`src/core/lifecycle.ts:157-169`, `src/mcp/tools.ts:184-228`

The codename regex is enforced only at config _load_, never before writing. `spawn` does `mkdirSync(spawnDirPattern.replace('{codename}', codename))` and `writeFileSync(join(agentConfigDir, \`${codename}.yaml\`), …)`. Neither `spawn_agent`nor`create_worktree`has`sentinelOnly: true`— **every agent can call them.** Exploits: codename`../../../../Users/ian/x`writes a`.yaml`and mkdirs outside the config dir; the`model`arg (or a quoted CLI token, since`tokenize`'s `"([^"]*)"`matches newlines) containing`\n` injects arbitrary YAML keys (`runtime:`, `schedules:`) into the generated config, giving the spawned agent attacker-chosen runtime and cron jobs.

### H8 — Shared tmux paste buffer enables cross-agent message misdelivery

`src/terminals/tmux/tmux.ts:115,127-137`

All multiline deliveries share one named buffer `conductor-paste` with no lock. Two concurrent `run()` calls interleave: `set-buffer(A)` → `set-buffer(B)` (overwrites) → `paste-buffer -d -t paneA` pastes **B into A's pane** and deletes the buffer → `paste-buffer -t paneB` fails "no buffer". Agent A executes B's instructions; B's message is lost. Reachable via two concurrent MCP `send_message` calls, or a broadcast racing a sentinel nudge — `deliverOrQueue`'s direct path has no cross-agent serialization. **Fix:** per-pane buffer names or a delivery mutex.

### H9 — No timeout on `osascript` + unguarded interval re-entrancy → process pileup / permanently wedged loops

`src/terminals/iterm/applescript.ts:23-26`, `src/core/supervisor.ts:264-266`, `src/core/focus-autopause.ts:42-44`

`runOsa` sets `maxBuffer` but no `timeout`. When iTerm2 is showing a modal / beachballing / waiting on a TCC automation prompt, osascript blocks indefinitely. Both `heartbeat` and `check` intervals are `void`ed with no overlap guard, so a fresh stuck osascript spawns every interval — dozens of zombie children per minute; `drainNow`'s in-flight promise never resolves, so the delivery queue is permanently stuck even after iTerm recovers. tmux has the same missing timeout (lower likelihood).

### H10 — No timeout on Telegram `send()`; a hung send freezes the entire operator pipeline

`src/channels/telegram/index.ts:268-274,223-239`

`send()` calls `api('sendMessage', …)` with **no** abort signal (only `getUpdates` passes one). `handleUpdate` awaits `send()` inline in the single poll loop. On a half-open TCP (laptop sleep), undici's ~300s default timeout blocks the loop — no operator commands processed for up to 5 minutes, and `stop()`'s abort doesn't cover it, so shutdown also hangs. **Fix:** `AbortSignal.any([controller.signal, AbortSignal.timeout(...)])` on every fetch.

---

## Medium

### Message loss & audit integrity

- **M1 — Messages marked delivered in the store when only queued.** `messaging.ts:29-32` calls `markMessageDelivered(id)` for both `'delivered'` and `'queued'`. A queued message later dropped (pane death, run failure, restart) is lost while the durable record claims delivery — audit lies. (core F5)
- **M2 — Mid-drain failure drops the message _and_ the whole queue.** `delivery.ts:90-97`: a `backend.run` throw on message 2 of 3 is logged at debug and iteration continues, then `queues.delete(agent)` discards everything. Contradicts the "so nothing is silently lost" doc comment (delivery.ts:23-27). `stop()` also abandons queued messages at shutdown with no drain/log. (core F4)
- **M3 — `no-pane` messages are stored then never delivered.** `deliverPendingNotifications` filters `type !== 'notification'` (messaging.ts:69) and is the only caller of `getPendingMessages`, so a `type='message'` row that hit the no-pane path is dead forever despite being persisted for redelivery. (core F6)
- **M4 — iTerm `deliver` to a vanished session silently "succeeds".** `applescript.ts:188-205` returns empty (no error) when the session-search finds nothing; `deliver` ignores the return (iterm/index.ts:330-344). Operator sees "Delivered", message went nowhere. tmux _throws_ in the same case — contract divergence with real loss. (terminals M2)
- **M5 — `channelSend` / `broadcast` report success when every send failed.** `supervisor.ts:359-375` returns `true` whenever `channels.length > 0` regardless of per-channel errors; `broadcast` increments `delivered` regardless of `DeliveryResult` (messaging.ts:43-53). A `humanInput.request` question believed delivered but never seen blocks the asking agent's MCP call forever. (orchestration M4, core F17)

### Timers, races, restart reconciliation

- **M6 — Failed human-input dispatch leaks the pending entry; no timeout ever.** `human-input.ts:36-66`: entry registered before `await deliver`; if deliver throws the entry stays forever. Nothing expires an unanswered question → asking agent hangs indefinitely; restart silently discards all pending. (core F8)
- **M7 — `resolve`/nudge removes the stall before the action succeeds.** `sentinel.ts:118` splices the queue before awaiting deliver; a nudge to a just-died pane returns the literal `"Nudge no-pane to alpha."` and the stall is gone, unrecoverable via `get_stall_queue`. (core F7)
- **M8 — Persisted `auto-focus` pause survives restart, never auto-resumes.** `state.ts:22-30` rehydrates `pause` including `pausedBy:'auto-focus'`; `FocusAutoPause` starts `focused=null` and only schedules resume when it _observes_ focus leaving. Restart while an auto-paused pane was focused → agent wedged in facilitated indefinitely, operator believes it's autonomous. (core F11, orchestration M6)
- **M9 — Disabling autopause while an agent is auto-paused wedges it.** `focus-autopause.ts:56` early-returns when `!on`, so the focus-leave resume never runs; `setEnabled(false)` neither resumes nor lets the loop resume. (core F10)
- **M10 — Dedup TOCTOU: concurrent stalls both pass suppression.** `sentinel.ts:64-85` reads `lastRouted` then awaits capture+transcript before writing it; two near-simultaneous stalls interleave → two queue entries + two sentinel deliveries for one incident. (core F9)

### Scheduler / lifecycle / config

- **M11 — croner `protect:true` is a no-op.** `scheduler.ts:30-32` passes a _sync_ callback `() => { void this.fire(...) }`; croner clears `blocking` the instant the sync fn returns, so overlap protection never engages. A fast cron overlaps its own `FRESH_SESSION_SETTLE_MS` sleep → stop/start interleave → duplicate panes (with H6). **Fix:** `async () => this.fire(...)`. (orchestration M2)
- **M12 — Shutdown doesn't quiesce in-flight scheduler fires.** `scheduler.stop()` doesn't await in-flight `fire`; a `freshSession` fire mid-`sleep(3000)` during `supervisor.stop()` calls `createPane` _after_ shutdown (real pane spawns), then `insertSession` throws on the closed DB (swallowed) → orphan pane. (orchestration M3)
- **M13 — Transient config-load failure permanently deletes persisted agent state.** `supervisor.ts:385-395` + `state.ts:33-36`: the tolerant loader skips a momentarily-invalid YAML (editor atomic save caught by the mtime poller) → agent dropped from `fresh` → `deregister` → `agent_state` row (autonomy/tag/pause) deleted → re-registers with defaults. Operator's autonomous agent silently reverts to facilitated. (orchestration M1)
- **M14 — ConfigWatcher marks change consumed before listeners run, and doesn't guard listener throws.** `watcher.ts:47-51`: a throwing listener escapes the interval callback → `uncaughtException` → process dies; and the mtime snapshot already advanced so the reload is never retried. (store/config M5)
- **M15 — Worktree branch fallback masks errors and permits git-option injection.** `worktree.ts:41-45`: bare `catch` retries with the branch as a **positional** arg, so `branch=--detach`/`--force` is interpreted as a flag (detached/forced worktree instead of an error); any non-branch failure (dir exists, repo locked) is swallowed and replaced by a confusing second error. **Fix:** `--end-of-options` or an explicit branch-exists check. (orchestration M7)
- **M16 — Launch failure leaks a live pane.** `lifecycle.ts:96-104`: `createPane` + `panes.set` succeed but a throw in `rename`/`buildLaunchCommand`/`launch` skips `setSession`; next start sees inactive state, calls `createPane` again, overwrites → first pane orphaned. (orchestration M5)

### Runtimes / backends

- **M17 — Codex `AGENTS.override.md` written into the user's repo and never cleaned up.** `codex/index.ts:132,145`; no teardown removes it, no `.gitignore` entry. A worktree agent that `git add -A && git commit` puts the conductor protocol text (sentinel/operator instructions) into the user's PR; after teardown the file persists and its embedded `AGENTS.md` snapshot goes stale. (runtimes M4)
- **M18 — Codex transcript reader loads the whole rollout into memory.** `codex/index.ts:225` `readFile` + `split('\n')` (~2-3× file size in RAM) in the sentinel hot path; Claude's reader streams. Long rollouts (hundreds of MB) spike RSS. (runtimes M6)
- **M19 — `stripClaudeChrome` can't strip the boxed composer.** `chrome.ts:8-9`: `❯` (U+276F) isn't in the box-drawing range, and stripping _breaks_ at the first non-match, so the composer box, placeholder, and top border leak into stall content used for dedup and sent to the sentinel. Test only exercises an unboxed `❯`. (runtimes M7)
- **M20 — Claude silently drops the prompt on `continue`; Codex honors it.** `claude-code/index.ts:71-72` vs `codex/index.ts:167`. `LaunchOptions` gives no hint `{prompt, continueSession:true}` is a claude no-op, and no warning is logged. (runtimes M3)
- **M21 — tmux `send-keys` prompt detection / session targeting uses prefix match.** `has-session -t conductor` prefix-matches a user's `conductor-dev` session → agent panes injected into the user's personal session. `sessionName` is an unvalidated `z.string()`. Use `=name` exact match. (terminals M1)
- **M22 — CR (`\r`) in "single-line" text submits mid-message.** Both backends test only `\n` for the multiline path (`tmux.ts:128`, `applescript.ts:49-51`); a message with CR line endings takes the literal path and the raw `\r` is Enter. Also no sanitization of ESC/control sequences in inbound message text → terminal-control-sequence injection into the agent pane. (terminals M4)
- **M23 — Daemon bakes `process.argv[1]` into the service.** `daemon.ts:17-19,30-31,57`: `pnpm cli -- daemon install` bakes `.../src/cli/index.ts`; launchd/systemd then run `node src/cli/index.ts` (Node can't run TS) and `KeepAlive`+`ThrottleInterval 10` respawn it forever every 10s. Same on repo move. Also re-install doesn't `unload` first (macOS `load` errors), and plist/systemd values aren't XML/shell-escaped. (store/CLI M2/M3, L9)
- **M24 — Telegram updates re-delivered after crash (offset never persisted).** `telegram/index.ts:114,196-198`: `offset` starts at 0 and lives only in memory. Crash after handling a batch but before the next `getUpdates` round-trip → restart re-delivers and re-executes it (duplicate `/start-all`, duplicate prompts). No `update_id` dedup; the store's KV is available and unused. (store/channels M1)
- **M25 — Chunked Telegram send aborts on first non-400 error, dropping the tail.** `telegram/index.ts:137-171`: a 429 on chunk 3 of 7 abandons chunks 3-7 _and the approval buttons_ (attached only to the last chunk). No `retry_after` handling. Operator sees a truncated report with no way to approve. (store/channels M4)
- **M26 — Pending-message order not deterministic within one second.** `store/index.ts:160-164`: `ORDER BY created_at` (second granularity, no `id` tiebreaker); dependent messages ("apply patch" then "run tests") can be delivered swapped. (store/channels M6)

---

## Low (grouped)

**Consistency / cross-implementation divergence**

- Three separate `shellQuote` definitions (`core/shell.ts`, `iterm/applescript.ts`, `codex/config-gen.ts`) — drift risk in the most security-sensitive helper. (runtimes L10, terminals L6)
- Claude binary interpolated **unquoted** (`claude-code/index.ts:70`) while Codex quotes it; prompt piped via `echo` (zsh interprets `\n`, eats leading `-n`/`-e`) — `printf '%s\n'` is correct; env-var **keys** interpolated unquoted. (runtimes M1/M2/L1)
- iTerm vs tmux error contracts diverge on every failure path (capture/kill/rename: iterm swallows, tmux throws) with nothing documented on the interface; `lifecycle.ts:98` calls `rename` unguarded. (terminals L1)
- `additionalDirs` relative-path base differs between runtimes (repo vs baseDir) — switching `runtime:` changes which dirs an agent can touch. (runtimes M5)
- Codex launches with hardcoded `--dangerously-bypass-approvals-and-sandbox` (no config knob), unlike Claude's `skipPermissions` toggle.

**Case-insensitive codename collisions** — regex `/i` makes `Alpha`≠`alpha`, but they share one APFS directory (identity configDir, spawn dir) → interleaved `prepare` makes one agent read another's `mcp.json` and assume its identity. `/<Codename>` shortcut also broken by `command.toLowerCase()` (commands.ts:88). (runtimes L2, orchestration L1, store L5)

**Health/watchdog edges** — pane death undetected for up to `eventSilenceMs` (120s) while events flow (health.ts:114); watchdog state not reset when events resume → stale-capture diffing + suppressed genuine stalls (health.ts:128-139); overlapping heartbeats double-count `stillBeats`; unbounded stall queue while sentinel is down; iTerm capture >10MB silently returns `''` → false silent-stall spam. (core F13-F16, terminals L2)

**Robustness / validation** — `mcp.port` accepts 99999 and `cron` is an unvalidated string, so `conductor validate` gives false "OK"; first-start migration race between daemon and `conductor status` (both run migration 1, loser throws); migration loop `continue` advances `version` without bumping `user_version` (append-only trap); double-SIGINT runs `stop()` concurrently; `conductor status`/`logs` create `./data/conductor.db` in any cwd; early log lines dropped (logger initialized before dataDir exists). (store L4/L6/L7/L8/L10, cli L8)

**Telegram** — hard split can cut a UTF-16 surrogate pair / markdown entity (split.ts:23-26); markdown-fallback retry resends `reply_markup` so a button-caused 400 fails twice; `/status@BotName` group syntax unhandled; `callback_data` length (64-byte limit) unvalidated; persistent 401 retries every 5s forever with only a warn while startup reported "connected". (store/channels L1/L2/L3/L11)

**Dead / misc** — `StallKind` `'session-end'` never emitted (types.ts:42); `scheduler.reloadIntervalBeats` is dead config (schema.ts:147); `truncate(text,0)` returns `'…'` (utils.ts:40); `spawn('all')` is legal but shadowed by the `all` keyword; `setActivity` persists the full row on every activity flip (write amplification) despite activity being documented runtime-only; Claude transcript reader keys only on `type==='assistant'` and can return a subagent's reply; hook/notify transport failures (`>/dev/null || true`) are permanently invisible. (core F18, orchestration L3/L5/L8, runtimes L6/L9)

---

## Verified non-issues (checked, not bugs)

- **SQL injection:** none. Every query uses bound parameters; the only interpolation is a PRAGMA `user_version` with a loop counter (PRAGMAs can't bind).
- **SQLite concurrency:** WAL enabled, better-sqlite3's default 5s busy timeout, migrations transactional including the `user_version` bump — daemon + CLI reader coexist safely.
- **Chat-id authorization is real:** Telegram drops any update whose chat id ≠ configured id _before_ classification; offset still advances so spam can't wedge the queue. Token never logged.
- **AppleScript escaping:** every dynamic string interpolated into AppleScript passes through `escapeAppleScript` (backslash-before-quote order correct); the codename is base64-encoded for the user variable. tmux uses execFile arg arrays with `-l --` throughout. **No `execSync` anywhere** in `src/`.
- **Codename regex** blocks `/`, `.`, `:`, whitespace, leading `-`, so the URL identity scheme and tmux targeting can't be traversal-attacked _via a valid codename_ (the holes are the pre-validation `spawn` path H7 and the unvalidated `sessionName` M21).
- **js-yaml v4** is safe-schema by default; tolerant reload quarantines bad files deterministically.
- **Prototype pollution** via JSON body is inert (args read by key, never spread/merged).
- `sentinelOnly` is enforced at **call time**, not just visibility.

---

## Genuinely good patterns worth preserving

- Three-seam architecture is real: `commands.test.ts` assembles a mini-conductor from production modules + fakes.
- Mechanical identity from URL path, `encodeURIComponent`, no `from` fields anywhere — the _mechanism_ is correct (it just needs the auth of C1).
- `DeliveryQueue.drainNow`'s in-flight join cleanly prevents double-delivery from overlapping ticks; every timer is `unref()`'d and the queue self-stops when empty.
- Autonomy invariant is airtight: exactly two modes, pause is a typed memory cell, explicit mode change clears it, `pause()` refuses when already facilitated.
- `removeWorktree` deliberately omits `--force` with a helpful operator message; append-only `MIGRATIONS` with transactional `user_version`.
- Per-agent error isolation in `heartbeat`/`broadcast`; base64 codename sidesteps AppleScript quoting; iTerm temp-file delivery dodges the `write text` truncation limit; `mkdtemp` 0700 for temp files.
- Both transcript readers tolerate partial/corrupt JSONL (skip-on-parse-failure); Codex `notify` passes JSON as `$1` to a generated script, sidestepping JSON-in-TOML-in-shell quoting.

---

## Suggested triage order

1. **C1 + H2 + H3** — add a per-agent bearer secret; this is one fix closing the whole auth class. Highest leverage.
2. **H1 + H5 + H9** — the three crash paths: add `process.on('unhandledRejection')` as a backstop, `try/catch` the direct-deliver path, call `healthReset` on stop/teardown, add `timeout` to `runOsa` + overlap guards on the intervals.
3. **H4 + H7 + H8** — correctness/isolation: scope codex sessions (per-agent `CODEX_HOME`), validate codename before `spawn` writes + gate the spawn tools, per-pane tmux buffers.
4. **M1–M5** — message-loss/audit: stop marking queued/failed/no-pane sends as delivered.
5. **H10 + M11 + M23 + M24** — operability: Telegram send timeout, real `protect`, daemon binary path, offset persistence.
6. Low tier: unify the three `shellQuote`s, document the backend error contract, add the missing failure-path tests listed per subsystem.
