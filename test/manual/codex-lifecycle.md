# Codex lifecycle manual shakedown

Run this only in a disposable fleet and disposable repository. Do not start, stop, restart, inspect,
or edit an existing operator fleet. Never copy credentials or environment-file values into results.

This test verifies the runtime boundary that unit tests cannot: Codex accepts the generated hooks,
`notify` remains the authoritative turn-completion signal, and long quiet reasoning is not mistaken
for a completed or silent turn.

## Setup

1. Build or install the candidate package, create a temporary fleet directory, and run
   `conductor start` there.
2. Spawn one disposable Codex session with the default `runtimes.codex.bypassHookTrust: true`.
   Whether `bypassPermissions` is true or false is irrelevant to hook trust. Confirm Codex does not
   stop for hook review and the generated home contains executable `notify.sh`,
   `lifecycle-hook.mjs`, and `protocol-reminder.mjs` plus `hooks.json`. Do not edit these files.
3. Before using the default lane, vet every hook Codex can discover from shared configuration, the
   repository, and enabled plugins. Confirm unattended lifecycle reporting works without `/hooks`;
   this broad trust switch is independent of approval and sandbox bypass.
4. Repeat with `runtimes.codex.bypassHookTrust: false`. Confirm Codex requires review, then open
   `/hooks` and explicitly trust the generated Conductor hooks. A rejected or untrusted hook is a
   failed lane, not evidence that pane silence should replace lifecycle reporting.

## Turn start and completion

1. Submit a prompt directly in the disposable Codex pane. Require `conductor status <session>` to
   report `working` after the trusted `UserPromptSubmit` event. Once an authoritative turn is
   complete, visible pane output alone deliberately cannot claim that a new turn started; final
   prompt redraws would otherwise create false starts. For Conductor-delivered prompts, lifecycle
   tracking captures the runtime-event boundary immediately before terminal submission and public
   activity changes to `working` after the backend confirms the write.
2. Use a prompt that causes at least two minutes of uninterrupted reasoning or a foreground command
   with little visible output. During that interval, require status to remain `working`; elapsed time,
   token counters, and unchanged pane bytes are not completion evidence.
3. Let the turn finish normally. Require the generated Codex `notify` callback to produce an
   `agent-turn-complete` event. Status may remain `working` during the 15-second debounce, then must
   become `idle` exactly once if no new turn begins.
4. Submit a second prompt during the debounce. Require the pending idle transition to be cancelled
   and status to remain `working`.
5. Stop and restart only the disposable Conductor while leaving the Codex pane at its input
   composer. Require the adopted session to initialize as `idle`. Repeat while a disposable turn is
   visibly working and require it to initialize as `working`.

## Compaction lifecycle

1. In the disposable session, trigger Codex compaction through its supported command or by reaching
   the test runtime's compaction boundary.
2. Require `PreCompact` to begin tracking without routing a stall while compaction is still active.
   Require compact `SessionStart` to restore the managed Conductor protocol and optional prepared
   session instructions as one labelled context payload. The local restoration must still print if
   the disposable Conductor endpoint is unavailable.
3. If Codex resumes work without showing its composer, require the session to remain `working` and
   emit no compaction stall. If it returns to a visible composer, require one `compaction` stall only
   after `health.idleConfirmMs`; the Sentinel may nudge it, but Conductor must not type directly.
4. Complete one post-compaction turn and require the normal notify-to-idle sequence again.

## Specific conversation continuation

1. Create two disposable conversations for the same registered Codex session and record their
   native IDs without copying any transcript content into the results.
2. Stop the disposable runtime and run `/continue <session> --session-id <older-id>`. Require the
   older conversation to open, with its own history, rather than the newest conversation selected
   by ordinary `/continue <session>`.
3. Repeat ordinary continuation and require it to retain the existing latest-conversation behavior.
4. Require `/continue all --session-id <id>` to fail before launching any runtime.

## Evidence and cleanup

Record candidate version, Codex version, bypass/trust lane, event order, and status transitions—never
prompt bodies, pane captures, paths, or secrets. Tear down only the disposable session and fleet.
Any missing completion callback, hook trust failure, duplicate idle report, or `silent` stall during
an active authoritative Codex turn is a failure.
