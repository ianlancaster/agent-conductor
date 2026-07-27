# Durable session instructions manual shakedown

Run this only with disposable repositories and disposable sessions. Do not start, stop, restart,
inspect, or edit an existing operator fleet. Use generic, non-sensitive marker text and never copy
credentials, paths, prompt bodies, or pane captures into results.

This shakedown verifies the provider boundary that generated-file tests cannot: the optional
`systemPromptFile` is model-visible at startup and after compaction without Conductor typing a
continuation prompt or mutating the working repository.

## Setup

1. Build or install the candidate package and create a disposable fleet and repository.
2. Create two instruction files with different generic markers, each below 5 KiB UTF-8. Configure
   two sessions against the same repository, one Claude Code and one Codex, with different files.
3. Start both through the normal Conductor lifecycle. Confirm each private session config directory
   contains `conductor-protocol.md` and `session-instructions.md`, both mode `0600` where supported.
4. Confirm neither source repository nor its ignore files changed.
5. For Codex, keep `runtimes.codex.bypassHookTrust: false`, review the generated hooks with `/hooks`,
   and record whether review was required. Permission bypass and hook trust are separate controls.

## Startup and compaction

For each runtime:

1. Ask the session to report only its marker. Require the correct marker and no marker from the
   other session.
2. Trigger manual `/compact`. Require the compact lifecycle event and an empty composer without any
   Conductor-submitted `continue` or other input.
3. Ask for the marker again. Require the same correct marker exactly once. Claude Code should retain
   its launch system-prompt layers; Codex should receive one compact-only `SessionStart` restoration
   containing labelled protocol and session layers.
4. Trigger deterministic automatic compaction when the tested runtime/version exposes a safe test
   path. Record “not available” rather than inferring success when it does not.
5. For Codex, repeat compaction while the disposable Conductor endpoint is unavailable. Local
   restoration must still succeed; the lifecycle POST may be absent.

## Snapshot activation and limits

1. Edit one source marker while its session remains running, then compact again. Require the old
   prepared marker: source edits do not hot-rewrite a live CLI.
2. Stop and start or continue that disposable session. Require the new marker at startup and after
   compaction.
3. Repeat with a near-limit file of exactly 5,120 UTF-8 bytes including its final newline. Require
   preparation and compaction restoration to succeed.
4. Try missing, directory, unreadable, malformed UTF-8, and 5,121-byte sources. Each start/continue
   must fail before launch with a path-aware error that contains no instruction text. The previous
   prepared snapshot must remain intact after validation failure.

## Evidence and cleanup

Record the candidate version, runtime versions, manual/automatic result, Codex trust path, marker
pass/fail, repository-diff result, and whether the endpoint-down Codex check passed. Never record
the actual marker or instruction text. Tear down only the disposable sessions and fleet.
