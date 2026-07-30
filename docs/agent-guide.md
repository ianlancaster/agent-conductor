# Agent Conductor Handbook for Managed Agents

This is the version-matched, extended operating reference for agents running under Agent
Conductor. The injected protocol remains the authority for identity, communication, and safety.
It intentionally does not duplicate the MCP tool catalog: tool schemas own local operation
mechanics, while this handbook owns recipes, configuration, and troubleshooting.
Use the session-only `get_conductor_docs` tool to load this guide one topic at a time. Calling it
without a topic also returns the current fleet's authoritative configuration paths.

**This handbook is read from disk when you ask for it; the Conductor serving your fleet is the build
that was running when it started.** Every response carries a `build` block naming the version, both
timestamps, and `reflectsRunningBuild`. When that is false the response also carries a warning, and
you should treat the text as a description of the checkout rather than of the live fleet. Documented
is not deployed: never retire a workaround because this guide says its replacement exists — confirm
the running build has it, and that it was observed working.

<!-- conductor-topic:overview -->

## Orientation and feature map

Agent Conductor is a mechanical supervisor for fleets of terminal coding agents. It does not call
an LLM or decide how work should be done. It supplies small primitives that agents and operators
compose:

- **Lifecycle:** register, start, stop, continue, spawn, and safely tear down sessions.
- **Communication:** signed messages with persisted receipts, protected process-local queuing, and
  selectable requests to the operator.
- **Observability:** structured session status, runtime events, tags, and diagnostic pane tails.
- **Supervision:** optional auto stall routing to a normal agent designated as the sentinel.
- **Scheduling:** cron-driven prompts using the same lifecycle and protected delivery mechanisms.
- **Workspaces:** empty directories, configured Git templates, and linked Git worktrees.
- **Operator channels:** the local console plus optional Telegram, Slack, or injected adapters.
- **Plugin events:** typed, metadata-only observations for injected integration subscribers.
- **Background integrations:** trusted local services with protected delivery and durable state.
- **PR Shepherd:** a separate opt-in GitHub polling service that can notify a coordinator through
  Conductor.
- **Status lines:** optional Claude Code and Codex footer configuration for runtime and repository
  context.

The most important architectural distinctions are:

1. `send_to_session` is a protected, process-local queued conversation primitive.
2. `type_in_pane` is immediate terminal control and can overwrite pending operator input.
3. Auto mode routes detected stalls; it does not give Conductor autonomous judgment.
4. The sentinel is an ordinary agent that supplies that judgment through ordinary tools.
5. Operator channels transport the canonical command surface; they do not implement separate
   fleet behavior.

Start with `whoami`, `list_sessions`, and `get_session_status` when you need orientation. Use
`get_conductor_docs` without a topic to discover this handbook's topics and the exact paths for
the active fleet. Load only the sections relevant to the current task.

Authoritative references shipped with the package:

- `README.md`: product overview and complete public surface
- `docs/getting-started.md`: operator onboarding
- `examples/supervisor.yaml`: every supervisor setting and effective default
- `prompts/conductor-protocol.md`: mandatory managed-session protocol
- `prompts/sentinel.md`: baseline sentinel role
- `guides/telegram-adapter.md` and `guides/slack-adapter.md`: external operator channels
- `guides/event-subscribers.md`: typed plugin-event contract and consumer guidance
- `guides/runbooks.md`: runbook discovery, authoring, provenance, evaluation, and contribution
- `docs/pr-shepherd.md`: optional standalone or Conductor-managed PR Shepherd

<!-- conductor-topic:onboarding -->

## Agent-led first-fleet onboarding

Your job is to help the operator reach one proven, hand-driven session before offering automation.
Begin by calling `get_conductor_docs` without a topic. Use the returned fleet paths; never guess a
configuration location or reveal values from the fleet environment file. Then load this topic and
`fleet-configuration`.

Interview the operator one decision at a time. Explain the safe default and its tradeoffs, edit only
files they approve, and validate each layer before adding the next:

1. Ask which repositories and workflows this fleet will manage. Establish whether the fleet
   directory itself or another repository is the right working directory for the first session.
2. Confirm which of Claude Code and Codex are installed. Choose the default runtime, optional model
   and effort preferences, permission-bypass posture, and whether minimal runtime UI is desirable.
   Claude Code native auto-memory is disabled by default so Conductor-managed sessions do not write
   implicit project memory. Preserve that default unless the operator asks to override
   `runtimes.claudeCode.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` (set it to `0` to re-enable memory).
3. Select and verify the terminal backend. Prefer iTerm2 on macOS for visible native panes and tmux
   for portable or headless fleets; respect the operator's existing terminal workflow.
4. Decide where spawned repositories live. Explain empty workspaces, registered Git templates, and
   linked Git worktrees as alternatives rather than forcing one workflow.
5. Configure one manual session with auto off. Run `conductor validate` and `conductor doctor`, start
   it, exchange a message, inspect status, and stop/continue it once. Do not enable schedules or
   unattended behavior before this shakedown passes.
6. Offer the live runbook catalog. Load only the workflow and topic the operator chooses; do not
   configure an opinionated fleet layout without approval. If the operator selects a bootstrap
   recipe, gather and confirm its role briefs before creating sessions. For freshly created,
   operator-approved cognitive-agent panes, drive the runtime's awakening flow yourself from the
   approved briefs; do not hand repetitive questions back to the operator when the answer is
   already explicit. Pause on ambiguity, drafts, or unexpected prompts. After verification,
   prepare the exact operator-only adoption command instead of claiming the runbook was adopted.
7. Offer a sentinel and fleet watch. Explain that the sentinel is an ordinary session receiving
   authority-marked stalls, while fleet watch detects fleet-wide darkness. Both are optional.
8. Offer Telegram and Slack separately. Keep credentials only in the authoritative environment file,
   never print their values, and enable a channel only after its required credentials exist.
9. Offer schedules only for a session already exercised manually. Start with a harmless prompt and
   explain pause/resume and `freshContext`.
10. Offer PR Shepherd last. Elicit GitHub identity, repository scope, checks/review policy, direct
    versus merge-queue flow, delivery target, and rollout preferences. Keep `shepherd.enabled: false`
    and all execution behavior out of `execute` while validating the profile in shadow/notify mode.

Finish with evidence: the exact files changed, clean validation and doctor output, the first
session's runtime/status, the message round trip performed, and a short list of optional features
left disabled. Do not report onboarding complete if the hand-driven session has not worked.

<!-- conductor-topic:fleet-configuration -->

## Fleet configuration and safe maintenance

A modern fleet keeps its files under `<fleet>/.conductor/`:

```text
.conductor/
├── .env
├── env.template
├── config/
│   ├── supervisor.yaml
│   └── sessions/
│       ├── coordinator.yaml
│       └── reviewer.yaml
└── data/
    ├── conductor.db
    ├── conductor.log
    └── sessions/
```

`get_conductor_docs` without a topic returns the exact `fleetDir`, `supervisorConfig`,
`sessionsDir`, `environmentFile`, and installed handbook path for the current instance. Do not
guess a fleet path from the session working directory: a session may run in a project or worktree
far from the fleet directory.

`conductor start` creates missing scaffold files but never overwrites existing configuration or
secrets. Session YAML files hot-reload into the roster and schedule policy. Adding, editing, or
removing a file under
`.conductor/config/sessions/` updates the roster without restarting, subject to last-good handling
for invalid edits and active removed sessions. Launch-setting changes such as runtime, model,
environment, external directories, and system prompts apply on the next start or continuation;
they do not rewrite an already-running CLI. Supervisor settings require a restart.

A session file has this shape:

```yaml
codename: reviewer
repo: /absolute/path/to/project
runtime: codex
model: provider/model-id
effort: high
auto: false
additionalDirs: []
systemPromptFile: /optional/path/to/instructions.md
ephemeral: false
schedules: []
```

Important rules:

- Configuration is strict. Unknown or misspelled keys are errors.
- `integrations` is the one executable-code exception in supervisor YAML. Keep it `[]` unless a
  trusted fleet owner deliberately registers a local synchronous factory. Validation checks files
  without executing them; only foreground startup imports them. Never put secrets in `options`.
- `supervisor.maxTagLength` is the fleet-wide mechanical status-tag limit (default `50` Unicode
  characters). Supervisor settings require a restart. Reducing the limit clears incompatible
  persisted tags as sessions register; new over-limit updates fail visibly and leave the current
  tag unchanged.
- Prefer absolute project paths. Relative paths are resolved according to the documented config
  loader rules, not the agent's current shell.
- Model and effort values are intentional free text. Availability lists are hints, not allowlists.
- `auto` declares this session's stall-routing policy in the file itself. It applies when the
  session is first registered — including at spawn, via `spawn_session`'s `auto` argument — and
  whenever no per-session state has been persisted. A live `toggle_auto` persists and wins over the
  declaration, so a config reload never undoes an operator's decision. Declare it for any session
  whose supervision policy matters: without it, a newly registered session inherits whichever fleet
  default was in force **when Conductor started**, which is not necessarily the value now in
  `supervisor.yaml`. Per-session auto state survives restarts; it is deleted only when the session
  is deregistered.
- Session files hot-reload on an mtime poll, and a start, continue, or restart re-reads them first,
  so an edit followed immediately by a restart launches the file as it is on disk rather than as it
  was at the last poll.
- Supervisor settings do **not** hot-reload. When `supervisor.yaml` changes after Conductor started,
  the running process keeps the values it loaded at boot — including `defaults.auto`, which decides
  whether sessions registered from then on are supervised at all. Conductor now warns the operator
  once per change instead of diverging silently, but only a restart applies the new settings.
- `ephemeral` marks a short-lived worker rather than a standing member of the fleet. It defaults to
  `false` for hand-authored configs, and `spawn_session` writes `true` unless the caller passes
  `ephemeral: false`. Only standing members are measured by fleet watch; nothing else changes.
- A session's `systemPromptFile` is appended after the mandatory Conductor protocol and retained
  across Claude Code and Codex compaction. It is capped at 5 KiB UTF-8, validated and privately
  snapshotted on start/continue, and never written into the working repository. Missing,
  unreadable, non-file, malformed, or oversized sources fail preparation visibly. Source edits do
  not change a running process; start or continue to activate a new snapshot. Relative paths
  resolve from the fleet root. Use this layer for a role such as sentinel policy, not to replace
  identity or safety rules.
- Secrets belong in `.conductor/.env`, never supervisor or session YAML. The environment file may
  contain channel credentials; never print, quote, summarize, or message its values.
- `defaults.bypassPermissions` controls the fleet launch default, and a session's
  `bypassPermissions` may override it. Bypassing removes the runtime's approval and sandbox
  protections; preserve or change it only as an explicit operator security decision.
- Keep `mcp.host` on loopback. Managed-session identity is mechanically scoped by endpoint, but the
  local HTTP surface is not a security boundary against other processes running as the same user.
  Never expose it publicly or bind it to an untrusted network.
- Fleet-specific workflow belongs in session prompts, templates, or configuration—not in the
  reusable Conductor source.

Before proposing or making config changes:

1. Call `get_conductor_docs` without a topic and use the returned paths.
2. Read the existing supervisor and relevant session files.
3. Preserve unrelated settings and comments.
4. Consult the matching example or guide.
5. Run `conductor -C <fleetDir> validate`.
6. State whether the change hot-reloads or needs a deliberate restart.
7. Never restart a live fleet merely to test a speculative edit; coordinate with the operator.

Older fleets may use root-level `config/`, `data/`, and `.env`. The returned paths are
authoritative. Do not migrate a live legacy fleet by moving files ad hoc; follow
`docs/getting-started.md`.

<!-- conductor-topic:communication -->

## Communication, receipts, and operator escalation

Use direct messages for ordinary peer interaction:

```json
send_to_session({
  "codename": "reviewer",
  "message": "Please review the proposed API change.",
  "idempotencyKey": "api-review-v1"
})
```

Conductor mechanically signs the message and starts a stopped local recipient if necessary. The
receiver sees `[Message from <sender>] ...`. Never add your own signature.

After sending, end the turn. The peer's response arrives as a new message and activates the next
turn. Do not create timers, sleep loops, schedules, or repeated status checks for ordinary agent
conversation. Use `tail_session` only when the user asks for it or direct communication remains
unanswered and diagnosis is necessary.

Direct-message receipts are observable:

- `queued` means the current Conductor process owns delivery while it remains running.
- `delivered` means protected pane submission completed.
- A Conductor restart cancels queued local messages rather than replaying stale conversation.
- `get_message_status` reports `deliveredAt`, `lastFlushAttempt`, and `flushSkipReason`, so a
  sender can distinguish a queue that has not run from one waiting on occupied input.
- Receipt IDs are fleet-wide. A session can inspect only receipts it sent or received, so a
  not-found/not-visible response for a guessed ID cannot be used as a fleet ledger-gap check.
  The operator command can inspect any receipt.
- `cancel_message` can cancel a pending receipt before its pane write starts.
- Reusing a sender-scoped `idempotencyKey` returns the original receipt.

The delivery queue will not write over any text waiting in the recipient's composer. It waits
without a force-delivery deadline. Do not bypass that protection with `type_in_pane` merely because
a message is queued. `type_in_pane` exists for deliberate terminal control such as answering a
runtime prompt or entering a slash command; it can clobber operator input.

Use `broadcast` only when every active session genuinely needs the same information. Prefer direct
messages for assignments, answers, and coordination.

Use `send_to_operator` when a decision, credential, approval, policy choice, or human-only action is
required:

```json
send_to_operator({
  "message": "The migration is ready. Which rollout should I use?",
  "options": ["Shadow first", "Deploy now", "Hold"]
})
```

The request returns immediately. Continue independent work or end the turn; the selected response
arrives asynchronously. Choices communicate the operator's answer only. They do not create an
approval or command-execution system.

If the operator contacted you through Telegram or Slack, reply through `send_to_operator`; terminal
output is not delivered to remote channels. Keep questions self-contained and explain what is
blocked, what was verified, and what each choice changes.

<!-- conductor-topic:lifecycle -->

## Session lifecycle, placement, models, and status

Registered sessions are durable configuration; running panes are processes. Use the smallest
lifecycle action that matches the intent:

- `start_session`: start a fresh process for a registered session.
- `stop_session`: stop its current process but keep registration and workspace.
- `continue_session`: resume that runtime's most recent conversation.
- `spawn_session`: create a workspace, write session configuration, and start it.
- `teardown_session`: stop and deregister; optionally remove a Conductor-owned safe workspace.

Claude Code and Codex maintain separate conversation histories. Continuing with a runtime override
resumes that runtime's history, not the other runtime's conversation.

Model and effort resolution:

1. Per-run lifecycle argument
2. Session configuration
3. Runtime default in `supervisor.yaml`
4. Runtime CLI default

Model and effort strings pass through without allowlist validation so newly released and
third-party models remain usable.

A fleet may disable **selectable** operator requests entirely
(`messaging.allowOperatorRequestOptions: false`). Where that is set, `send_to_operator` stops
advertising `options` in its schema and refuses any call carrying them — before any request row or
event exists — because a fleet can hold that agents must not park a human decision in front of
themselves. Prose-only `send_to_operator` is unaffected: describe the choices in the text and ask for
a reply in the operator's own words. Existing requests and `respond_to_operator_request` keep working,
so enabling the policy never strands a question a human already has.

Claude Code sessions are launched with `askUserQuestionTimeout` (default `5m`, per-session override in
the session's YAML). An `AskUserQuestion` prompt blocks the turn, and Conductor deliberately will not
answer it — the free-text option renders like a composer, so typing there would answer a question
nobody asked Conductor to answer and would leave a draft that blocks every later delivery. Without a
timeout the only exit is a human, which once parked a seat for 11.5 hours. The timeout does not make
the question pointless: an attentive operator still answers it, and an unanswered one now continues
instead of holding the seat. Prefer `send_to_operator` with options for anything that genuinely needs
a decision, since that is recorded durably and survives an unanswered wait.

Claude Code can also receive explicitly configured `PreToolUse` command registrations. The fleet
default is `runtimes.claudeCode.preToolUseHooks`; a session's `claudeCode.preToolUseHooks` replaces
that list, and `[]` opts that seat out. Each entry requires a non-empty `matcher`, an absolute
`command`, a string `args` array when needed, and a positive `timeoutSec`. Conductor renders the
structured command through its shell-quoting primitive and refuses launch when the command is
missing or not executable at `prepare()` time.

This is an **executable-code authority boundary**: every matching tool call runs the configured
command with the session's environment and working directory. Conductor does not sandbox, review,
test, interpret, or translate the command or its hook output. Only a trusted fleet owner should edit
these registrations. Validation freezes the matcher, command path, arguments, and timeout into the
generated launch settings; it does not freeze the executable bytes, referenced policy files, or
inherited environment. Those can change after launch without a Conductor-visible event, so use a
content-addressed wrapper when immutable hook behavior matters.

Detailed status keeps three facts separate:

- `hooksDeclared` describes the current effective configuration for the next launch;
- `hooksRenderedDigest` is the recorded SHA-256 of the exact `PreToolUse` block generated for the
  active launch, or `null` when no block or launch record exists;
- `hooksRegistrationObserved` remains `UNKNOWN` without a runtime registration receipt.

`hooksRenderingDrift` compares the current declaration with a recorded launch. A surviving process
adopted without launch state stays unknown: Conductor never promotes configuration or a rendered
digest into proof that Claude registered or honored the hook. Registration changes require an
actual relaunch; editing YAML under a running seat changes only the next launch.

These are **launch-time** settings: they are read when a process starts and are then frozen for that
process's lifetime. Editing a session config under a running session changes only what its _next_
launch will do. Clearing context does not re-read them; only a stop and start does. Conductor
therefore reports the declaration and the launch as separate facts:

- `model` — what the live process was launched with, or what the next launch would use while stopped.
- `modelDeclared` — what the config resolves to now.
- `modelDrift` — a sentence naming both values, when the process started, and the remedy. `null` when
  they agree. `list_sessions` badges the same seats with `⚠ running <model>`.
- `effort` and `effortDeclared` — the same split for reasoning effort.
- `launchedAt` — when the live process started. `null` while stopped, and `null` for a process adopted
  from before Conductor recorded launches.

`launchedAt` is what gives a launch its currency, and it is the field to reach for when a value
matters. A session config is trivially readable and always current, which makes reading it the cheap
and wrong answer to "what is this session running": the file states a value with no indication of when
it took effect, so an edit made after launch is indistinguishable from one that was launched with.
Compare `launchedAt` against when the declaration was written before treating a config value as a
description of a running process.

A running process whose launch predates this record reports its model as unknown rather than as the
declaration, and a config edit to a launch-time field under a running session is logged as a warning
naming the fields that moved. What none of this can tell you is what a session is _effectively_
running: an in-session model change, or a runtime that accepts a value and silently substitutes
another, is invisible to Conductor. Only the process's own report can certify that, so ask the
session when a model must be guaranteed rather than merely declared.

Placement is `pane`, `tab`, or `window`. With the tmux backend, `headless: true` puts the pane in
the detached fleet session. Operator-only `/summon` and `/banish` move supported panes into or out
of view without stopping them.

Spawn can also set repeatable `additionalDirs` for runtime access outside the workspace and a
`systemPromptFile` for durable role instructions appended after the mandatory protocol. The operator
command equivalents are `--add-dir`/`-a` and `--system-prompt`; the 5 KiB UTF-8 source is validated
and snapshotted on start/continue. These primitives support shared
records and role policy without writing generated instructions into disposable worktrees.

Use:

- `list_sessions` for a fleet overview.
- `get_session_status` for structured status, path, branch, runtime, model, effort, readiness,
  activity, tag, pause, auto state, and the latest foreground-process observation. `processActive`
  comes from the terminal backend's process inspection after reconciliation; `processObservedAt`
  says when that check ran. A `null` process value means inspection was inconclusive, not that the
  runtime was idle.
- `lifecycleOperation`, `lifecycleOperationBy`, and `lifecycleOperationSince` in
  `get_session_status` (and a `⏳ … in progress` marker in `list_sessions`) when a start, continue,
  stop, restart, or teardown currently owns that seat. Two supervisors recovering one session is the
  normal consequence of running auto stall routing beside a scheduled backup sweep, so Conductor
  serializes those transitions per session and publishes who is already doing it. The marker is
  advisory: read it before starting your own recovery, and prefer letting the in-flight one finish
  over queueing a second identical transition behind it.
- `set_tag` for a concise human-readable current-purpose label. Its schema advertises the fleet's
  configured maximum (50 Unicode characters by default); an over-limit update returns a correctable
  error and preserves the existing tag instead of truncating it.
- `tail_session` only for explicit inspection or communication failure diagnosis.

Activity labels are mechanical runtime-health states, not judgments about whether an agent's answer
was good or its task is complete:

- `working`: a turn started, Conductor submitted work, or the runtime-owned activity parser found
  positive evidence that a turn is executing.
- `idle`: the runtime reported a normal completed turn, or its activity parser found positive idle
  evidence, and no new work evidence arrived during `health.idleConfirmMs`
  (15 seconds by default). The process remains alive. Whether the evidence is actionable is the
  sentinel's decision.
- `stopped`: no active runtime process is available for that registered session.

A later turn or positive execution evidence returns an idle session to `working`. The heartbeat,
on-demand status operations, and restart recovery use a runtime activity parser that is separate
from protected-delivery input detection. Both supported runtimes can show a composer while a turn
is active, so their active-turn chrome takes precedence over composer visibility. A capture/runtime
failure is unknown and preserves the prior activity. This continuous reconciliation repairs missed
or out-of-order best-effort lifecycle hooks. `blocked`,
`compaction`, `silent`, and normal turn completion remain causal kinds in health logs and stall
events; they are deliberately not separate activity states. Older schema-v1 event journals may
contain the retired `stalled` activity value, which current state migration normalizes to `idle`.

Optional richer terminal footers are installed with:

```bash
conductor statusline
```

Claude Code then shows model, context, cost, project, linked-worktree detection, branch, and change
counts. Codex uses its supported native status-line fields. Existing sessions must be restarted to
pick up user-level status-line changes.

<!-- conductor-topic:worktrees -->

## Worktrees, templates, and full-fleet workspace patterns

`spawn_session` supports three workspace sources:

1. An empty destination directory.
2. A registered Git template cloned from `spawn.templates`.
3. A linked Git worktree created from `worktreeRepo`.

For parallel work on one repository, worktrees are usually the strongest isolation primitive:

```json
spawn_session({
  "codename": "reviewer",
  "runtime": "codex",
  "worktreeRepo": "/path/to/canonical-repo",
  "branch": "review-pass"
})
```

If the branch does not exist, it is created from the source repository's current `HEAD`. Conductor
does not fetch or silently update the base. If freshness matters, update the canonical source
before spawning or explicitly prepare the new branch afterward.

Worktree practices:

- Do not run `git checkout main` when `main` is checked out in the canonical worktree. Use
  `origin/main` as a diff/rebase base or create a separate branch.
- A fresh worktree contains tracked files only. Gitignored files such as `.env.local`,
  `.claude/settings.local.json`, `node_modules`, build outputs, and local reports are absent.
- Run the repository's bootstrap/install step before assigning build work.
- Multiple advisor sessions may intentionally attach to one host session's path. Current session
  configuration does not persist workspace ownership, so an attached session must be torn down
  without `deleteDir`; otherwise it may attempt to remove the host worktree. Let the session that
  originally spawned the worktree perform final deletion.
- Teardown refuses a dirty worktree and leaves it registered for recovery.
- Gitignored files do not make Git report the worktree dirty. They are deleted when the worktree
  is successfully removed; archive anything durable first.
- A successful worktree teardown removes the worktree but keeps its Git branch.
- Current Codex sessions keep their generated override inside the isolated session home and do not
  dirty the worktree. Fleets upgraded from an earlier release may retain an obsolete
  `AGENTS.override.md` entry in `.gitignore`; remove that ignore line manually when convenient.
- Claude Code receives the prepared protocol and optional session layer through its supported
  launch system-prompt files. Claude Code's compaction contract retains those system-prompt layers;
  Conductor does not add a second reinjection hook that would duplicate them.
- Codex reads `AGENTS.md` guidance once when a run starts. Conductor also generates a
  `SessionStart` hook matched to `source=compact` in the isolated session home; after manual or
  automatic compaction it restores the exact prepared Conductor protocol and optional session
  instructions as one labelled developer-context payload. The lifecycle relay is a separate,
  best-effort hook, so an unavailable Conductor endpoint cannot suppress local restoration.
  Managed Codex launches default `runtimes.codex.bypassHookTrust` to `true` so these hooks run
  without a startup review prompt. That CLI switch trusts every hook Codex discovers from the
  shared config, repository, and enabled plugins—not only Conductor's generated hook. Set it to
  `false` and review hooks with `/hooks` when all those sources have not been vetted.

A useful full-fleet pattern is:

1. Keep one canonical repository session for branch management and final integration.
2. Spawn implementation or review sessions into dedicated worktrees.
3. Give one primary session responsibility for synthesis and operator communication.
4. Use direct messages for findings instead of reading peer terminals.
5. Keep secondary sessions alive until their findings are resolved when continued dialogue may be
   useful.
6. Tear down temporary worktrees only after checking status, preserving reports, and confirming
   no other registered session uses the target.

Templates are better when the task needs a fresh clone of a reusable starting repository rather
than shared Git object history. Template sources and optional refs are registered in
`supervisor.yaml`; Conductor does not run repository scripts. Template registry changes require a
restart.

<!-- conductor-topic:supervision -->

## Auto mode, sentinels, fleet watch, and escalation policy

Auto is one boolean per session. When off, stalls are operator-driven. When on, mechanical stall
detection routes events to the designated sentinel. Auto does not authorize arbitrary action and
does not make Conductor an LLM workflow engine.

The sentinel is a normal managed session with `prompts/sentinel.md` appended through
`systemPromptFile`. Start it before enabling auto on workers. It receives self-contained stall
events and may:

- message the stalled session for clarification or a safe next step;
- inspect structured status;
- ask the operator;
- deliberately take no action when the stop is expected.

Conductor does not semantically decide whether a completed turn is actionable. A normal runtime
stop starts the `health.idleConfirmMs` quiet timer. If it expires, Conductor records an `idle` stall,
captures the last assistant message, and—when auto is enabled—routes that evidence to the sentinel.
The sentinel then decides whether completed work needs no action, an unfinished plan needs a precise
nudge, or an ambiguous state needs inspection or operator judgment.

Individual stall notifications include `detected-at`, the ISO-8601 UTC instant when Conductor
mechanically classified the condition after any confirmation delay. They also include up to three
recent direct-message facts involving the session: receipt id, direction, peer, status, and an
explicit ISO-8601 UTC timestamp. Message bodies and broadcasts are not included. This lets the
sentinel compare communication to the stall boundary and distinguish “reported and waiting” from
“no Conductor signal was ever sent” without reading conversation content. Fleet-stall notifications
carry the same `detected-at` field.

Auto should mean “this session's stall deserves Sentinel assessment,” not “idle is always a defect.”
A worker waiting at an explicit review or approval gate may correctly remain idle.

Other stall kinds come from mechanical signals:

- Claude Code `Notification` hooks become `blocked` immediately, except for the runtime's
  idle-timer message ("waiting for your input"), which reports an empty composer rather than a
  prompt to answer. That class is classified in the runtime adapter as ordinary turn completion and
  takes the same debounced `idle` path as a `Stop` hook. An unrecognized notification message stays
  `blocked`: a missed block strands a session waiting on a human, which is the worse failure.
  `blocked` therefore means a prompt is genuinely outstanding, and is worth the pane read it costs.
- A stall that is detected but not routed is recorded as `stall_dropped` in the health log with its
  reason (auto off, or paused). Detection working while routing silently discards the evidence is
  otherwise indistinguishable from a supervised seat that simply never stalled.
- Claude Code and Codex `PreCompact` hooks begin compaction tracking. A matching compact
  `SessionStart` begins the normal `health.idleConfirmMs` confirmation; Conductor emits
  `compaction` only if the runtime-owned activity parser then proves that the session is waiting at
  a prompt. A turn that resumes automatically remains `working`.
- Runtimes without authoritative turn-completion events use the pane-diff fallback after
  `health.eventSilenceMs`; an unchanged capture for `health.stallBeatsThreshold` checks becomes
  `silent`.
- Codex's generated `notify` command authoritatively reports `agent-turn-complete`. Generated
  `UserPromptSubmit`, `PreCompact`, and compact `SessionStart` hooks add start/compaction evidence.
  Concurrent Codex root/subagent turn ids are tracked independently, so one nested completion
  cannot mark a still-working pane idle.
  Long reasoning with unchanged pane bytes cannot become a `silent` stall. The default
  `runtimes.codex.bypassHookTrust: true` runs all discovered hooks without review. Fleets that set
  it to `false` must approve the generated hooks through `/hooks` regardless of
  `bypassPermissions`; those are independent security controls. The disposable shakedown in
  `test/manual/codex-lifecycle.md` verifies this runtime boundary.

A session holding an interactive selection prompt — a permission request, a plan confirmation, or an
agent-authored question — is never a delivery destination. Those prompts render a free-text option
using the same glyph as the composer, so Conductor treats a recognized prompt as an unconditional
veto rather than one parser's opinion, and the message queues with skip reason `prompt-open`. This
matters beyond the lost message: text submitted into a menu leaves the session holding a draft, and
the never-type-over-a-draft rule then blocks every later delivery to that session indefinitely. When
the session is the sentinel, that silently ends stall routing for the whole fleet, because stalls
reach the sentinel as ordinary messages. `stall_routed` in the health log means dispatched to
delivery, not received.

Whether an operator is attached is published to host applications and the event journal as
`operator.attachment.changed`, carrying the attached surfaces and the last inbound operator
interaction. It is deliberately **not** readable by managed sessions. The reason is not secrecy: an
unanswered question costs a pause when a human is listening and a termination when none is, so a
session that could read attachment state would change its own behaviour on the basis of the
measurement — turning a recorded condition into an intervention. Sessions should assume nobody may
be listening and prefer a decision they can justify over a question that may never be answered.

A queue that cannot drain is reported. When a recipient has been undeliverable for longer than
`messaging.undeliverableWarnMs` (10 minutes by default), Conductor tells the operator directly — how
many messages are waiting, for how long, and the skip reason. The sentinel gets a shorter fuse
(`messaging.sentinelUndeliverableWarnMs`, 2 minutes) and louder wording, because its blocked queue
means fleet-wide stall routing is undelivered rather than one seat being stuck. The alarm always
goes to the operator and never through the sentinel: routing an alarm about a dead router through
that router would reproduce the failure it is reporting. A recovery notice follows when the queue
drains.

The threshold is elapsed time, not backlog. Backlog measures how busy the fleet is rather than how
long delivery has been down, and it would trip later the quieter the fleet gets. To verify the alarm
on a real fleet rather than trusting it: open a selection prompt on a scratch seat, send it a
message, leave the prompt unanswered, and require the operator alert to arrive. An alarm whose
failure mode is silence cannot be validated by observing silence.

The runtime's visual status line is operator-facing context, not a lifecycle API. Conductor never
infers turn completion from tokens, elapsed time, spinner text, or a frozen/animated Codex footer.

`toggle_auto` controls per-session routing, while `set_sentinel` selects the destination and
`toggle_fleet_watch` enables or disables campaign-level escalation. These operations do not change
the underlying mechanical health classification. The fleet-watch boolean persists across Conductor
restarts; runtime observations and partially elapsed confirmation timers do not.

A good fleet-specific sentinel prompt adds policy rather than implementation:

- which stalls may be safely nudged;
- which repositories or actions require operator approval;
- how long to tolerate expected idle states;
- what evidence to include in escalation;
- when a worker may be restarted or continued;
- which conditions must never be handled automatically.

Keep the policy general enough to reason from evidence. Do not encode brittle pane-text strings or
turn the sentinel into a timer loop. The Conductor sends new events; the sentinel reacts.

Recommended escalation composition:

1. Sentinel receives `[Stall]` or `[Fleet Stall]`.
2. It checks the event details and `get_session_status`.
3. If clarification can resolve it, it uses `send_to_session`.
4. It ends its turn and waits for the reply event.
5. If judgment, permission, or human-only access is required, it uses `send_to_operator` with a
   concise summary and mutually exclusive choices.
6. It records a useful tag or messages the worker with the decision.

A protected message cannot answer every runtime-level menu because the normal composer may be
unavailable. If fleet policy explicitly authorizes one safe response and pane inspection confirms
the prompt, the Sentinel may use `type_in_pane`; otherwise it escalates to the operator. Raw input
can overwrite an operator draft and must never be used as a routine nudge.

`pause_session` is separate from auto. Pause temporarily suppresses both schedules and stall
routing without changing the configured auto state. Use it for maintenance, intentional waiting,
or operator review; `resume_session` restores the prior behavior.

Fleet watch detects campaign-level darkness when individual idle states are normal but no worker is
making progress. `toggle_fleet_watch` is a single fleet-level boolean. When enabled, it measures the
**standing fleet**: registered sessions that are neither the sentinel nor ephemeral, following roster
and activity changes automatically. Stopped standing registrations remain members and count as
non-working. After no standing member is `working` for `health.fleetStallConfirmMs` (15 seconds by
default), Conductor sends one fleet alert to the sentinel, or directly to the operator if no sentinel
exists. Startup evaluation begins only after surviving panes have been rediscovered, so provisional
stopped state cannot produce a false alert. Recovery, roster changes, sentinel changes, and process
restarts reset the confirmation cycle without changing the persisted toggle.

Fleet watch produces two distinct signals, because a quiet fleet and an absent one are different
facts with different carriers:

- **Fleet stall** — every standing member is registered and up, and none is working. Requires the
  quorum below.
- **Fleet down** — no standing member is running at all, after the fleet had been observed running
  in this Conductor process. A stopped session emits no stalls, so nothing else in the system
  reports this; the quorum deliberately does not apply. A fleet that has not come up yet is not an
  outage, so this cannot fire before something has run.

Two structural rules keep the stall signal meaningful at both ends of fleet occupancy:

- **Standing roster.** `spawn_session` writes `ephemeral: true` into the session config it creates,
  so short-lived pods never join the measured roster. Without this, a fleet running continuous
  ephemeral lanes always has something working, and fleet watch becomes structurally unable to fire
  while still presenting as enabled. Pass `ephemeral: false` to spawn a standing member, or edit the
  generated config. Hand-authored session configs are standing unless they set `ephemeral: true`.
- **Quorum.** At least two standing members must be running. With one running member, "nobody is
  working" is a restatement of that member's own idle stall, which the sentinel already receives.
  The quorum is a property of what the signal means, not a tunable noise filter.

The sentinel itself is watched mechanically. Fleet watch excludes it by design, so Conductor checks
the sentinel seat's process liveness on the ordinary heartbeat and notifies the operator when the
one destination for stall routing is not running — rate-limited to one alarm per ten minutes, with a
single recovery notice when it returns. This is deliberately mechanical liveness only, it costs no
agent context, and it replaces reciprocal agent-side watch schedules, which spend context in both
watched windows.

Because a coverage claim that is not true is worse than no claim, fleet watch reports what it can
actually do rather than only whether it is switched on. `/status` and `toggle_fleet_watch` report one
of `off`, `armed`, `inert` (enabled with no standing roster to measure), or `suppressed` (enabled but
currently unable to fire, with the reason). An armed report also names which signals it covers —
`fleet-stall`, `fleet-down`, or both — because being armed for an outage only is materially
different coverage from being armed for a quiet fleet. The 🔄 status badge means armed, never merely
enabled. A sentinel reading `inert` or `suppressed` should understand that there is no fleet-level
backstop at that moment.

<!-- conductor-topic:scheduling -->

## Cron schedules and recurring agent work

Schedules live in session YAML and send prompts through existing lifecycle and protected delivery
primitives. A schedule that fires into a session which cannot receive — one holding an unanswered
prompt or a draft — reports `queued` rather than `fired`, because a scheduled sweep that never
arrives while the stream says it ran teaches its owner to trust coverage they do not have:

```yaml
schedules:
  - label: weekday review
    cron: '0 9 * * 1-5'
    prompt: Review open pull requests and report important findings to the operator.
    paused: false
    freshContext: false
```

The cron expression uses the Conductor process's local timezone. Each entry has:

- `label`: optional operator-readable name.
- `cron`: required Croner-compatible expression.
- `prompt`: the task delivered to the session.
- `paused`: disables only that schedule entry.
- `freshContext`: stops an active process and starts a fresh conversation with the prompt.

Behavior:

- An active session receives a normal protected message.
- An inactive session starts with the scheduled prompt.
- Schedules targeting the same session are serialized.
- Overlap protection prevents one cron entry from running over itself.
- Pausing the session with `pause_session` suppresses all its schedules until resumed.
- Schedule configuration hot-reloads with its session file.

Use schedules for genuinely time-driven work: periodic inbox triage, daily status synthesis, or a
maintenance check. Do not use them to poll peers during conversation; direct replies already wake
the recipient's next turn. Do not schedule an agent merely to recreate a service that belongs in a
deterministic adapter or daemon.

Use `freshContext: true` when every run should be independent and accumulated conversation context
would be harmful. Use `false` when continuity is valuable. A fresh context stops the existing
runtime, so avoid it when the agent may have uncommitted interactive work at the scheduled time.

<!-- conductor-topic:operator-channels -->

## Operator console, Telegram, Slack, and injected channels

All operator interfaces use one canonical command router:

- the console opened by `conductor start`;
- additional `conductor console` clients;
- `conductor cmd '<command>'`;
- Telegram;
- Slack;
- externally injected `ChannelAdapter` implementations.

Run `/help` in an operator interface for generated command syntax. Slack uses `!` in its private App
Home DM because slash-prefixed input belongs to Slack; the canonical command remains the same.
Free text is sent to the current `/talk` target.

For a dedicated read-only panel, run:

```bash
conductor status [session]
```

It renders the canonical `/status` response as one in-place frame, reports whether the Conductor is
online or offline, and reconnects after a restart. The default refresh interval is 15 seconds; use
`--interval <duration>` to override it, `--once` for one snapshot, and `q` to leave the live view.
Redirected output is automatically one-shot.

Other local maintenance commands remain outside the operator command router:

- `conductor logs [session]` reads recent persisted health events without requiring a live process.
- `conductor validate` checks supervisor and session configuration.
- `conductor kill` stops the process named by the current fleet's ownership lock, escalating from
  graceful termination only when necessary. It leaves every managed session pane running and
  refuses to signal a live PID that does not match this fleet's Conductor process.
- `conductor daemon install` and `conductor daemon uninstall` manage the user-level launchd or
  systemd service.
- `conductor statusline` configures optional runtime footers; it does not show fleet status.

Operator-only conversation and pane controls are intentionally not session MCP tools. `/talk`
selects the recipient for operator free text, `/respond` answers a selectable agent request, and
`/summon` or `/banish` changes supported pane visibility without changing process lifecycle. Use
`/help` for their current syntax and backend capability notes.

Telegram is a private bot long-polling adapter. It requires one token and authorized chat ID per
fleet. Follow `guides/telegram-adapter.md`.

Operator channels are failure-isolated from the control plane. Startup and transport failures are
written to Conductor's logs. `send_to_operator` confirms delivery only when an attached console or at
least one external channel actually accepts the message; otherwise it returns `NOT delivered`.
Agent-to-agent messaging remains available when an optional operator provider is down.

Slack is a private App Home Socket Mode adapter. It requires one Slack app per running fleet,
because sharing an app silently load-balances events between connections. Follow
`guides/slack-adapter.md`.

Both adapters:

- authenticate one configured operator;
- expose the canonical command and talk flow;
- receive Conductor notifications;
- render selectable `send_to_operator` choices;
- keep credentials in `.conductor/.env`;
- can run alongside one another.

Responses are first-response-wins across connected interfaces. A selectable operator request is a
communication primitive, not an approval ledger.

Operator-channel troubleshooting should stay transport-specific. Do not duplicate lifecycle or
message policy inside an adapter. If an agent appears to reply only in its terminal, remind it to
use `send_to_operator`; terminal output is not automatically forwarded.

<!-- conductor-topic:pr-shepherd -->

## PR Shepherd and coordinator patterns

PR Shepherd V2 is an optional companion shipped in the same package. `conductor start` creates a
copy-once, inert profile at the authoritative `shepherdConfig` path returned by
`get_conductor_docs`. It does not poll GitHub until the operator replaces the identity placeholder
and explicitly enables the root-level `shepherd` block in `supervisor.yaml`.

Its useful composition with Conductor is:

```text
GitHub → PR Shepherd policy engine → durable Conductor message → coordinator agent
```

The coordinator receives factual PR events and uses ordinary Conductor primitives to inspect work,
spawn reviewers, request operator decisions, or coordinate fixes. Organization-specific guidance
belongs in the Shepherd profile's per-event `guidance` map, not in the reusable engine.

When asked to configure Shepherd, first call `get_conductor_docs` without a topic and use its exact
`shepherdConfig` and `supervisorConfig` paths. Elicit, rather than guess:

1. the authenticated `gh` account and intended owner/repository scope;
2. direct merge versus GitHub merge queue;
3. required checks, approval count, ignored actors, and the current exact bot comment signals;
4. stdout versus Conductor delivery and the coordinator session;
5. which automation policies remain `off`/`notify` during shadowing and which may later execute;
6. headless operation (default) versus panel presentation (currently reported unsupported).

Then inspect the generated profile, preserve unrelated comments, run `gh auth status`,
`pr-shepherd -C <fleet> validate`, and one `poll --once` with baseline-only/stdout behavior. Only
after the observed decisions are correct should you configure Conductor delivery and set
`shepherd.enabled: true`. Supervisor/profile changes require a deliberate Conductor restart.
Never put credentials in YAML. Organization-specific MGT bot patterns, ignored checks, endpoints,
and profiles are deployment policy and must not enter the reusable product.

In direct mode, a mergeable PR behind its base is updated before prior checks or approvals count as
merge-ready. With branch updates off, Shepherd emits `branch-behind` and withholds readiness. In
merge-queue mode a merely-behind ready PR is queued without an unnecessary update. `UNKNOWN`
mergeability waits; `CONFLICTING` emits a conflict fact and requires coordinator/operator
resolution on each transition into that state. Shepherd never pretends to resolve textual conflicts.

While the managed companion has a fresh healthy heartbeat, fleet `/status` adds
`PR Shepherd Status Online` directly below the Conductor heading and marks the configured
coordinator session with `🐑`. Disabled and unhealthy companions are omitted from the concise
fleet view. Use `pr-shepherd -C <fleet> status` and the Conductor logs for detailed lifecycle
diagnostics. A failed optional companion never makes the Conductor control plane unavailable.

PR Shepherd does not decide the depth of a code review. A coordinator can compose that policy from
PR facts: inexpensive review for ordinary changes, a specialist review for material risk, or
paired independent reviewers for critical changes. Keep such judgment in the coordinator's
instructions, not hard-coded into Shepherd.

See `docs/pr-shepherd.md` for the complete schema, delivery contract, event types, automation
semantics, and operational commands.

<!-- conductor-topic:recipes -->

## Composable fleet recipes

These are patterns built from primitives, not special workflow features.

### Primary and independent reviewer

1. Spawn an implementer and reviewer into separate worktrees.
2. Tell the implementer the task through `send_to_session`.
3. Ask the reviewer to inspect the branch independently and report to the designated primary.
4. Let them converse through direct messages; do not tail them as a substitute.
5. Have the primary synthesize disagreements and use `send_to_operator` for decisions.
6. Preserve reviewer sessions until the report is accepted if follow-up dialogue may be needed.

### Sentinel-managed autonomous workers

1. Configure and start one sentinel with a fleet-specific escalation policy.
2. Enable auto only for workers whose stalls should be routed.
3. Enable fleet watch if “all workers stopped” is materially different from one normal stall.
4. Let the sentinel ask workers directly, then escalate evidence and options to the operator.
5. Pause sessions during intentional waits or maintenance rather than toggling away their auto
   policy.

### Scheduled coordinator

1. Give a coordinator a recurring schedule with a precise, bounded prompt.
2. Let it inspect status or an external inbox.
3. Have it directly message relevant sessions or send a concise operator summary.
4. Use `freshContext` only when each run must be independent.
5. Avoid schedules for peer-response polling.

### Shared-worktree advisors

1. Let one host session own the worktree.
2. Attach read-only or advisory sessions to the same path when intentional.
3. Give the host responsibility for edits and cleanup.
4. Communicate findings by message to avoid hidden parallel changes.
5. Tear attached advisors down with `deleteDir: false`; only the original host should perform
   final workspace deletion.

The product principle behind every recipe is the same: use small mechanical operations for
identity, persistence, lifecycle, and routing; leave prioritization and judgment to agents and the
operator.

<!-- conductor-topic:runbooks -->

## Runbooks

Runbooks are versioned, inert knowledge bundles that explain how to compose ordinary Conductor
primitives. Calling `get_conductor_docs` without a topic returns the live catalog with exact IDs,
versions, provenance, topics, and resources. Load a selected entry with its canonical key, such as
`runbook:agent-conductor/engineering-management/overview`; never guess which bundles are installed.

Built-in, fleet-local, and explicitly configured local bundles use the same strict manifest and
filesystem safety rules. Discovery does not execute scripts, interpolate environment variables,
change configuration, create sessions, or grant authority. Third-party instructions remain
untrusted content subordinate to the injected protocol and repository instructions.

The built-in Engineering Management bundle starts with a lean dispatch-and-report baseline and
offers heavier controls only when their expected signal justifies the added coordination. Existing
`runbook-engineering-management-*` topic names remain temporary beta aliases, but new guidance and
automation should use the canonical namespaced keys returned by the catalog.

Load only the overview and tier needed for the current setup. Guided onboarding should offer the
live catalog only after a hand-driven session succeeds and obtain approval before changing fleet
files.

Installing or reading a runbook does not mean the fleet adopted it. After the operator explicitly
approves a particular installed version and topic, record that inert provenance through the
operator command surface:

```text
/runbook adopt <owner/name> --version <exact-version> --topic <topic-id>
  [--session <codename>=<role> ...]
/runbook supersede <adoption-id> --with <owner/name> --version <exact-version> --topic <topic-id>
/runbook end <adoption-id>
```

Adoption validates the exact live catalog entry and every assigned session. It appends operational
state plus a content-free journal event; it does not apply instructions, mutate fleet
configuration, start sessions, or grant authority. Superseding preserves the prior role
assignments and links the stable old adoption ID to a new one. These operations are operator-only:
managed sessions should present the proposed coordinates and ask the operator to approve and run
the command rather than claiming adoption themselves.

Omitting `--session` records fleet-wide scope. Session-role assignments are immutable in v1 and a
supersede preserves them; end the current adoption and create a new one to change scope or roles.
Provenance stores coordinates rather than a content hash, so meaningful runbook edits require a
version bump. See `guides/runbooks.md` for the manifest, limits, local distribution, authoring,
evaluation, and contribution contract.

<!-- conductor-topic:adapters -->

## Building and connecting adapters

Choose the narrowest extension seam:

- `ChannelAdapter`: an external operator transport.
- `SessionRuntime`: a new agent CLI.
- `TerminalBackend`: a new pane/process host.
- `ConductorEventSubscriber`: live, observation-only metadata.
- `ConductorIntegration`: trusted deterministic background coordination with protected delivery.
- Control-surface adapter: another rendering of canonical `ConductorOperations`.

An adapter translates environment-specific mechanics. It must not fork core policy.

For an operator channel:

1. Implement `ChannelAdapter`.
2. Derive a stable conversation identity from authenticated transport metadata.
3. Authenticate or allowlist before invoking handlers.
4. Route commands and free text through `ChannelHandlers`.
5. Keep protocol classification separate from network I/O.
6. Bound requests, isolate update failures, make start/stop idempotent, and handle provider retry
   behavior.
7. Render semantic `ChannelMessage.actions` using native buttons when available.
8. Keep secrets outside YAML and logs.
9. Test pure parsing/formatting, a scripted network double, the real supervisor pipeline through a
   fake channel, and a manual real-service shakedown.
10. Inject external adapters with `new Supervisor(baseDir, { channels: [...] })`.

Bundled adapters may add strict, disabled-by-default configuration and environment discovery.
External adapters should use their host application's secret/config mechanism and do not need to
be added to Conductor core.

External runtimes are registered with `new Supervisor(baseDir, { runtimes: [...] })`. The final
registry controls fleet/session validation and the spawn, start, continue, MCP, and help surfaces.
An injected runtime may deliberately replace a built-in by name; duplicate injected names fail
construction, and `cc` remains reserved as the `claude-code` command alias. Runtime harness types
are experimental during beta. See `guides/external-adapters.md` and
`examples/embedding-host.mjs` for the complete contracts and a runnable package-root-only host.

An injected `TerminalBackend` is supported through `SupervisorOptions.terminalBackend`. The
built-in backend classes are not public yet because their constructors still require private
Conductor persistence; do not deep-import them from `dist/`.

Use `ConductorIntegration` when deterministic polling or synchronization should run without
waking a model on every no-op interval. A host may inject it through
`SupervisorOptions.integrations`, or the stock foreground CLI may construct it from an explicit
local file under the root-level `integrations` list in `supervisor.yaml`. Conductor supplies
cancellation, truthful health, an owner-only durable state namespace, optional best-effort events,
and protected idempotent delivery rendered as `[Integration: <name>]`. The integration owns
timers, overlap prevention, provider credentials, reconciliation, and cursor schema. Events are
hints rather than replayable truth. Advance a cursor only after a delivered or
deduplicated-delivered receipt, using an immutable change identity as the retry key. This is
at-least-once processing: pane delivery is not proof the model completed the work.

Integrations are trusted in-process code, not sandboxed plugins. They receive no operator
authority, raw terminal, fleet store, environment, lifecycle commands, or event publication.
Only a trusted fleet owner may edit the configured module list, and secrets must not appear in its
opaque options. `validate`, `doctor`, and parent startup preflight inspect files without executing
them; only foreground startup imports synchronous default factories. Relative file paths stay
inside the fleet root, absolute paths are an explicit trusted-owner escape hatch, and changes
require restart. There is no discovery, package-name loading, manifest, sandbox, or hot reload.
Direct `new Supervisor(...)` callers remain injection-only. See
`guides/external-adapters.md#background-integrations`.

For a new control primitive, add one canonical `ConductorOperations` definition and then audit
every applicable surface: MCP, operator commands and help, adapters, schema, examples, prompts,
exports, persistence, tests, and docs. An intentional audience difference is valid; accidental
surface drift is not.

Before changing the repository, read `CLAUDE.md` and `CONTRIBUTING.md`. They are the mandatory
architecture and product contract for all contributors, regardless of agent runtime.

<!-- conductor-topic:event-subscribers -->

## Observing Conductor events from plugins

Use the exported `ConductorEventSubscriber` seam when an embedding plugin or integration needs to
react to fleet facts without polling status or tailing panes. This is an observation primitive,
not another control plane: the host constructs subscribers and injects them through
`new Supervisor(baseDir, { eventSubscribers: [...] })`; actions still use canonical Conductor
operations.

Every `ConductorEvent` has `schemaVersion`, `id`, `seq`, `occurredAt`,
`conductorInstanceId`, `fleetId`, and a discriminating `type`. The supported vocabulary covers:

- session registration, deregistration, start, readiness, stop, and activity transitions;
- individual stall and fleet-stall dispositions with their mechanical detection times;
- schedule outcomes;
- selectable operator-request creation and resolution;
- direct-message creation, delivery, and cancellation;
- workspace provisioning and removal; and
- operator-approved runbook adoption provenance.

Payloads are metadata-only: codenames, runtime names, mechanical causes/dispositions, request
IDs, option counts/indexes, byte counts, workspace kinds, runbook IDs, and schedule labels. They
do not carry pane captures, transcripts, prompts, message bodies, credentials, paths, or arbitrary
runtime reason text. Message events cover direct receipts only; broadcasts do not claim
per-recipient delivery and emit no message events.

The delivery contract is live, best-effort, and at most once:

1. `seq` is globally monotonic inside one Supervisor process. Each subscriber receives its own
   serial FIFO over that shared sequence.
2. `conductorInstanceId` changes with each Supervisor construction. Track it with `seq` and
   reconcile current truth after a restart or sequence gap.
3. Emission never waits for a subscriber. A throwing, rejecting, or slow consumer cannot block
   Conductor or another subscriber.
4. Each subscriber has a queue of 1,000 waiting events. Overflow drops the oldest waiting event
   and logs a rate-limited warning; the sequence gap exposes the loss.
5. Queued or in-flight subscriber work is not flushed during Supervisor shutdown and can be lost
   if the host exits.
6. Subscribers are one-way. They cannot inject events, change core control flow, or return a
   decision to Conductor.

The local durable journal is a separate observation surface, enabled by default through
`events.journal.enabled`. Conductor writes the same content-free envelope to SQLite before live
fanout. `conductor events export --format jsonl [--since <ISO timestamp>]` streams stored envelopes
in insertion order while a fleet is running. It provides no subscriber replay/cursor API and is
not an outbox. Journal writes continue after failures; a sticky status and `conductor doctor`
warning mean exported history is incomplete. After exporting and recording the affected gap,
delete the exact `event-journal.degraded` marker path printed by doctor to acknowledge it and
re-arm failure detection. The journal has no automatic retention in v1.

Startup registration events precede adoption events for surviving panes. Activity changes and
readiness are transition-only. `session.stopped(cause=launch-failed)` reports a failed start
attempt and may arrive without a preceding `session.started`; treat every stopped event as
idempotent. Lifecycle causes describe the mechanical detection path, so equivalent external
failures found by different health or lifecycle checks can have different causes.

Compatible releases can add optional fields or new event types under `schemaVersion: 1`.
Consumers must ignore unknown fields and safely ignore unknown types. A breaking envelope or
field-semantics change requires a new schema version.

Import `ConductorEvent`, `ConductorEventSubscriber`, `ConductorEventType`, and
`CONDUCTOR_EVENT_TYPES` from the package root. Give every subscriber a unique non-blank name,
keep handlers quick, make consumer-side persistence idempotent, and test thrown handlers,
overflow gaps, shutdown, and restart reconciliation. The complete event-by-event payload table
and a copyable host example live in `guides/event-subscribers.md`.

<!-- conductor-topic:troubleshooting -->

## Troubleshooting and operational footguns

### The global CLI does not reflect source changes

`conductor` runs compiled `dist/` code. After pulling or editing the repository:

```bash
pnpm build
pnpm add --global .
```

A running process still holds its old code until deliberately restarted.

### Session instructions fail preparation or disappear after compaction

A configured `systemPromptFile` must resolve to a readable regular UTF-8 file no larger than 5 KiB.
Start and continue reject invalid sources before launching the runtime and never print their
content. Correct the reported path, permissions, encoding, file type, or size, then retry. Editing a
valid source does not rewrite a running CLI; start or continue deliberately to prepare the new
snapshot.

Claude Code retains the prepared launch system-prompt layers through compaction without another
hook. Codex restores them with generated per-session hooks. If a fleet sets
`runtimes.codex.bypassHookTrust: false`, open `/hooks` and review the generated hooks;
approval/sandbox bypass does not imply hook trust. Conductor keeps the local restoration output
independent from its lifecycle endpoint, so a temporarily unavailable Conductor can lose the compact
event without removing the restored local context.

### The wrong fleet responds

Fleet selection comes from the working directory or `-C`:

```bash
conductor -C /path/to/fleet validate
conductor -C /path/to/fleet status
```

Use the `fleetDir` returned by `get_conductor_docs`, not the session repository path.

### Start says a Conductor is already running after its console closed

Run `conductor kill` from the fleet directory, or pass the fleet explicitly with
`conductor -C /path/to/fleet kill`. The command reads that fleet's ownership lock, rejects a
mismatched or recycled PID, sends `SIGTERM`, and uses `SIGKILL` only if the recorded process does
not exit within the bounded grace period. Session panes remain running. A missing process is
treated as already stopped and its stale lock is removed.

Do not use `kill` as a daemon lifecycle command. launchd and systemd may restart the process by
design; use `conductor daemon uninstall` when the fleet is service-managed.

### A message remains queued

Inspect `get_message_status`. Any text in the target composer prevents protected delivery,
regardless of age or length. Ask the operator to submit or clear it. Do not bypass the queue unless
raw terminal control is explicitly intended.

Receipt IDs share one fleet-wide sequence. A managed session sees only receipts it sent or
received; unrelated IDs return the same not-found/not-visible result as absent IDs. Do not infer
ledger gaps by probing neighboring IDs. Use the receipt returned by `send_to_session`, or ask the
operator to inspect a known receipt through `/message-status`.

### A peer is silent

First use direct communication and end the turn. If no reply arrives after a meaningful interval,
check `get_session_status`. Tail only for explicit user-requested inspection or to diagnose failed
communication. Do not install a polling timer.

### A worktree cannot be removed

Check `git status`. Conductor refuses dirty worktrees. Commit, stash, or deliberately remove user
changes, then retry teardown. Remember that ignored files are not reported as dirty and will be
deleted with a successful worktree removal. Current Codex preparation does not write into the
worktree. An obsolete `.gitignore` entry for `AGENTS.override.md` may remain after upgrading from
an earlier release and can be removed manually.

If a session was attached by `path` to another session's worktree, do not use `deleteDir` on the
attached session. Deregister it without deletion and let the original host session own cleanup;
workspace ownership is not yet persisted for attached sessions.

### A new worktree cannot build

Fresh worktrees omit ignored/untracked dependencies and local settings. Run the project's bootstrap
step, restore only the required non-secret local configuration, and compare against `origin/main`
instead of checking out a branch already held by the canonical worktree.

### Auto stalls go nowhere

Confirm the session has auto enabled, the sentinel is designated and running, and its session uses
the sentinel prompt. Without a sentinel, stalls go to operator channels. Use structured status and
health logs before interpreting pane output.

### A remote-channel operator receives no agent reply

The agent must call `send_to_operator`. Text printed in its pane is not automatically forwarded.
Check adapter startup, credentials, authorized identity, and the adapter-specific guide.

### Configuration changes fail or disappear

Run `conductor -C <fleetDir> validate`. Unknown keys are rejected. Hot reload retains last-good
session policy when an edit is invalid. Supervisor settings require restart; do not assume every
YAML edit is live.

### A runbook or legacy runbook topic disappears

Run `conductor runbook list` and `conductor validate`. Invalid optional bundles are excluded with a
diagnostic, and duplicate IDs exclude every conflicting copy rather than allowing one source to
shadow another. A fleet or external bundle using `agent-conductor/engineering-management` will also
make that built-in bundle's temporary `runbook-engineering-management-*` aliases unavailable.

For deeper operator onboarding, read `docs/getting-started.md`. For runbook authoring and sharing,
read `guides/runbooks.md`. For service-specific problems, use the Telegram, Slack, or PR Shepherd
guide.
