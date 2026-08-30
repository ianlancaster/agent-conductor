# Fresh continuity state manual shakedown

Run only with disposable repositories, files, fleets, and runtime conversations. Never inspect,
stop, restart, continue, or modify an operator fleet. Use generic marker text and record runtime
versions, lifecycle sources, outcomes, and byte counts only—never state contents, paths, prompts,
pane captures, hashes, or credentials.

This shakedown verifies the provider boundary beyond generated-reader tests: a configured
`continuityStateFile` is read fresh without terminal input at startup, native resume, and each
confirmed manual or automatic compaction.

## Setup

1. Build or install the candidate package and create one disposable fleet and repository.
2. Create separate Claude Code and Codex session YAML files. Give each a distinct static
   `systemPromptFile` and dynamic `continuityStateFile`, all generic and below 5 KiB UTF-8.
3. Start both through normal Conductor lifecycle. Confirm generated state readers are private and
   session-specific, while no generated file or ignore change appears in the repository.
4. Record Claude Code and Codex versions. For Codex, vet all discovered hook sources before using
   the default broad hook-trust bypass, or set it false and approve the generated hooks with
   `/hooks`.

## Freshness, ordering, and isolation

1. Before the first user prompt, ask each disposable session to report its generic state marker.
   Require its own latest marker and no marker from the other session.
2. Atomically replace each dynamic file with a second version. Trigger manual `/compact`. Require
   exactly one restoration attempt at `source=compact`, the second dynamic marker, and no terminal
   text submitted by Conductor.
3. For Codex, require one ordered compact context containing protocol, prepared static session
   instructions, then fresh dynamic state. For Claude Code, require only the dynamic hook layer;
   its static system-prompt layers remain provider-retained.
4. Change the static source and dynamic source again without re-preparing. Compact. Require the old
   static snapshot and newest dynamic state. Start or continue the disposable session, then require
   the new static snapshot plus newest dynamic state.
5. Repeat three successive atomic dynamic-file replacements and compactions. Require one reader
   execution per boundary and the corresponding latest version each time.
6. Exercise native conversation resume and require `source=resume` to inject the latest dynamic
   state before substantive resumed work. If deterministic automatic compaction is unavailable,
   record that limitation rather than inferring success.

## Limits and degraded continuity

1. Use a valid state of exactly 5,120 UTF-8 bytes, including any final newline. Require exact local
   restoration on both runtimes. For Codex, run
   `node test/manual/continuity-provider-probe.mjs zero` and require `result: exact` with one
   developer copy; the probe must use generic data only.
2. Try missing, directory, unreadable, final-symlink, malformed UTF-8, and 5,121-byte sources before
   launch. Require a path-aware, content-free preparation error and no runtime launch.
3. After a valid launch, repeat each invalid replacement before compact. Require one explicit
   degraded context with its stable reason, no stale marker, and content-free operator metadata.
4. Repeat one valid and one degraded compact while the disposable Conductor endpoint is down.
   Local output must still succeed; no retrospective telemetry is expected.
5. Remove `continuityStateFile`, deliberately re-prepare the disposable session, and confirm the
   provider config no longer references a state reader and stale generations are cleaned.

## Evidence and cleanup

Record candidate and runtime versions, tested sources, exact/degraded outcomes, byte counts,
ordering, isolation, endpoint-down behavior, and automatic-compaction availability. Never record
model-visible content or filesystem paths. Tear down only the disposable sessions and fleet.
