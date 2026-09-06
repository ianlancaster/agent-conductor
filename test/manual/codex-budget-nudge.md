# Codex budget reminder and stopped schedules

Use a disposable fleet/session, not an operator's active pane. Do not consume credits merely to
reach a threshold or weaken actual provider quota enforcement.

1. Build the changed Conductor and start a disposable fleet. With default
   `runtimes.codex.bareUi: true`, inspect the managed launch command: both new launches and
   resumes must contain `-c 'notice.hide_rate_limit_model_nudge=true'` and retain the configured
   model. If the account naturally approaches its budget limit, confirm no model-switch dialog
   interrupts the pane. An actual exhausted-credit error must still be visible.
2. With `bareUi: false`, confirm Conductor omits that override. Codex's existing notice preference
   remains effective; false does not forcibly re-enable a reminder the operator already dismissed.
3. Set a short test schedule with `wakeIfStopped: false`, start the test session, then stop it.
   Confirm subsequent ticks report `skipped-stopped` and do not launch a pane or accumulate prompts.
4. Explicitly opt the disposable schedule into `wakeIfStopped: true`; confirm a tick starts it.
   Pause the session and stop it; confirm subsequent ticks do not wake it.
5. Remove the disposable schedule and clean up only the test fleet's owned resources.

Reference: [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
`notice.hide_rate_limit_model_nudge` (checked 2026-09-06). Source inspection found the
matching TUI guard in `codex-rs/tui/src/chatwidget/rate_limits.rs`; this is distinct from hard
limit handling. The automated tests cover generated overrides and scheduler behavior without
real model calls. This manual scenario does not claim a live low-budget TUI test was performed.
