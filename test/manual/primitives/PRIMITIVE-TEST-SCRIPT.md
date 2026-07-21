# Basic agent messaging primitive test

This is a self-running black-box test performed by the managed session `tester`. It tests only
the agent-facing primitives needed to create workers and exchange messages. The operator does
not participate after starting `tester` and providing the kickoff prompt.

## Hard boundaries

- Do not ask the operator to do or confirm anything.
- Do not call `send_to_operator`.
- Do not use the conductor CLI, direct HTTP, SQLite, terminal automation, or conductor source.
- Do not test auto mode, pause/resume, tags, schedules, sentinel or stall behavior, worktrees,
  raw pane input, restart/continue, terminal placement, or presentation.
- Do not modify the Agent Conductor implementation.

Use conductor MCP tools only. A sender-side `Delivered` response is not proof. A messaging
checkpoint passes only when the expected signed reply arrives at `tester`.

## Test workers

Choose a short four-digit run suffix and use it consistently:

- Claude Code worker: `msg-cc-<suffix>`
- Codex worker: `msg-codex-<suffix>`

Call `list_sessions` before spawning. If either chosen name appears, choose a different suffix.
Do not reuse, stop, tear down, or alter an existing session.

Record the chosen names in `PRIMITIVE-TEST-RESULTS.md`.

## M00 — tester identity

1. Call `whoami`.
2. Require `codename: tester`, `registered: true`, and `runtime: claude-code`.
3. Record the exact relevant fields.

If this fails, mark M00 `FAIL`, summarize the failure, and stop. Do not contact the operator.

## M01 — spawn Claude Code and Codex workers

1. Call `spawn_session` for the Claude Code name with `runtime: claude-code`.
2. Call `spawn_session` for the Codex name with `runtime: codex`.
3. For each worker, call `get_session_status`.
4. Require both status results to report a running session with the requested runtime.

Do not provide paths, models, worktrees, prompts, or placement options.

## M02 — direct round trip with each runtime

Send each worker its own instruction using `send_to_session`.

Claude Code instruction:

```text
Basic messaging test M02. Call whoami, then call send_to_session targeting tester with exactly:
BASIC-M02 CC <your-codename> <your-runtime>
Do not add your own signature or any other text.
```

Codex instruction:

```text
Basic messaging test M02. Call whoami, then call send_to_session targeting tester with exactly:
BASIC-M02 CODEX <your-codename> <your-runtime>
Do not add your own signature or any other text.
```

After sending the instructions, finish the current turn and wait for both replies. Require:

```text
[Message from <cc-name>] BASIC-M02 CC <cc-name> claude-code
[Message from <codex-name>] BASIC-M02 CODEX <codex-name> codex
```

This proves tester-to-worker delivery, worker MCP access, mechanical identity, and
worker-to-tester delivery for both runtimes.

## M03 — Claude Code sends directly to Codex

Send the Claude Code worker:

```text
Basic messaging test M03. Call send_to_session targeting <codex-name> with exactly this message:
Basic messaging test M03 from Claude Code. Call send_to_session targeting tester with exactly:
BASIC-M03 CODEX-RECEIVED-CC
```

The Codex worker will receive the first sentence as a signed message from the Claude Code
worker. Require this signed reply at `tester`:

```text
[Message from <codex-name>] BASIC-M03 CODEX-RECEIVED-CC
```

## M04 — Codex sends directly to Claude Code

Send the Codex worker:

```text
Basic messaging test M04. Call send_to_session targeting <cc-name> with exactly this message:
Basic messaging test M04 from Codex. Call send_to_session targeting tester with exactly:
BASIC-M04 CC-RECEIVED-CODEX
```

Require this signed reply at `tester`:

```text
[Message from <cc-name>] BASIC-M04 CC-RECEIVED-CODEX
```

## M05 — tester broadcast

Prepare each worker with a direct message before broadcasting.

Tell the Claude Code worker:

```text
On receipt of broadcast BASIC-M05 TESTER-BROADCAST, send_to_session tester exactly:
BASIC-M05 CC-RECEIVED-BROADCAST
```

Tell the Codex worker:

```text
On receipt of broadcast BASIC-M05 TESTER-BROADCAST, send_to_session tester exactly:
BASIC-M05 CODEX-RECEIVED-BROADCAST
```

Then call `broadcast` with exactly:

```text
BASIC-M05 TESTER-BROADCAST
```

Finish the current turn and wait. Require both signed acknowledgements at `tester`. Do not
require an exact broadcast delivery count because unrelated active sessions may exist. Confirm
that `tester` did not receive its own broadcast.

## M06 — broadcasts originating from both runtimes

First tell the Codex worker:

```text
On receipt of broadcast BASIC-M06 CC-BROADCAST, send_to_session tester exactly:
BASIC-M06 CODEX-RECEIVED-CC-BROADCAST
```

Then tell the Claude Code worker:

```text
Call broadcast with exactly: BASIC-M06 CC-BROADCAST
```

Require both of these at `tester`:

```text
[Broadcast from <cc-name>] BASIC-M06 CC-BROADCAST
[Message from <codex-name>] BASIC-M06 CODEX-RECEIVED-CC-BROADCAST
```

Next tell the Claude Code worker:

```text
On receipt of broadcast BASIC-M06 CODEX-BROADCAST, send_to_session tester exactly:
BASIC-M06 CC-RECEIVED-CODEX-BROADCAST
```

Then tell the Codex worker:

```text
Call broadcast with exactly: BASIC-M06 CODEX-BROADCAST
```

Require both of these at `tester`:

```text
[Broadcast from <codex-name>] BASIC-M06 CODEX-BROADCAST
[Message from <cc-name>] BASIC-M06 CC-RECEIVED-CODEX-BROADCAST
```

## M07 — cleanup

1. Call `teardown_session` for the Claude Code worker with `deleteDir: true`.
2. Call `teardown_session` for the Codex worker with `deleteDir: true`.
3. Call `list_sessions` and require both worker names to be absent.
4. Record both teardown results and the final session list check.

Cleanup must still be attempted if any checkpoint fails after either worker is spawned. Never
tear down `tester` or any session whose name does not exactly match the two names chosen for
this run.

## Finish

Set the overall result:

- `PASS` only if M00–M07 all pass.
- `FAIL` if any checkpoint fails.
- `BLOCKED` only if a required conductor tool is unavailable or a worker never becomes usable.

Complete `PRIMITIVE-TEST-RESULTS.md`. Your final terminal response must contain only the
overall result, failed or blocked checkpoint IDs, and confirmation that both test workers were
removed. Do not message the operator.
