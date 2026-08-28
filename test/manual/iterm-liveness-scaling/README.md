# Isolated iTerm liveness scaling shakedown

This neutral runner compares built artifacts without loading fleet configuration or controlling a
running Conductor. It creates a uniquely named disposable iTerm window, uses temporary SQLite and
shim resources, launches only `sleep 900` in its panes, and closes every pane in `finally`.

Run the same copied `runner.mjs` against separately built baseline and candidate `dist`
directories. Use `--variant baseline` for an artifact without `snapshotLiveness` and
`--variant candidate` for one with it. The planned matrix uses counts 1, 5, 10, and 20, five ABBA
paired repeats, 30 non-overlapping reconciliations, a 60-second 1 Hz iTerm2 CPU/RSS sample, and a
maximum 300-second RSS settling interval.

Example:

```bash
node runner.mjs \
  --artifact /absolute/baseline/dist \
  --variant baseline \
  --count 10 \
  --cycles 30 \
  --sample-seconds 60 \
  --settle-max-seconds 300 \
  --output /absolute/results/baseline-n10-r1.json
```

For a long matrix, the optional `--window-id` may point at a dedicated, minimized disposable
iTerm window created for the shakedown. Each cell then creates and removes only its own panes in
that window while leaving the anchor session for the next cell. The orchestrator must close the
anchor window after the matrix. The runner also restores the application that was frontmost before
each pane creation, so measurement setup does not take the operator's working focus.

The `osascript` and scalar `ps` shims log only timestamp, cycle id, parent pid, category, and an
argv hash. They never retain raw AppleScript, session UUIDs, tty values, command lines, pane
contents, or environment values. Candidate activity sampling intentionally invokes the production
absolute `/bin/ps`; the output therefore records that one process as an inference and calls out the
limitation. iTerm2 RSS is contextual only. Classify stable growth only from the full five-repeat
matrix using the monotonicity, Theil-Sen slope, and three-times-MAD rule in the approved plan.

For CPU comparisons, pass `--cycle-start-interval-seconds` and use the same interval, cycle count,
and sample window for both artifacts. Choose an interval above baseline p95 reconciliation latency
so cycles never overlap. Completion-relative runs prove latency and exact call counts but do not
compare CPU fairly when the artifacts complete different numbers of cycles inside the sample
window. Each successful run also writes a `.cleanup.json` assertion proving that every harness tty
has zero remaining processes after its `sleep 900`, shell, and pane are terminated.
