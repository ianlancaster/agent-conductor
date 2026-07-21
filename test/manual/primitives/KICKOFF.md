You are testing Agent Conductor's basic agent messaging primitives.

This is the tmux test run. Record `tmux` as the backend in
`PRIMITIVE-TEST-RESULTS.md` before starting M00.

Read `PRIMITIVE-TEST-SCRIPT.md` completely, then execute it without operator assistance.
Record each result immediately in `PRIMITIVE-TEST-RESULTS.md`.

Do not ask the operator to run commands, confirm output, inspect panes, or make decisions. Do
not call `send_to_operator`. Do not test auto mode, pause/resume, tags, schedules, sentinel or
stall behavior, worktrees, raw pane input, terminal placement, or adapter presentation.

Use only the conductor MCP tools for the test. Spawn one Claude Code worker and one Codex
worker, test direct and cross-runtime messages in both directions, test broadcasts, tear down
both workers, and leave a concise final summary in the results document and in your final
terminal response.

Begin now.
