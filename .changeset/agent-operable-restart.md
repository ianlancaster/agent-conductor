---
'agent-conductor': minor
---

Add `conductor restart`. It replaces a fleet's Conductor from any non-interactive shell, including a managed session's own shell, and leaves session panes running. It refuses before stopping anything when the configuration or startup preflight fails. It waits until the new process owns the fleet lock and reports healthy, then prints the old and new PID, build and elapsed time. Service-managed fleets restart through launchd or systemd. A Conductor owned by a `conductor start` console is replaced by one that keeps using that console's window and stops when it closes. `/health` now reports `pid`, `version` and `build`, and builds record their source commit in `dist/build-info.json`.

`conductor cmd` now treats every token after `cmd` as command text, so `--session` and similar options no longer need `--`, and shell-quoted multi-word arguments keep their quoting. The handbook now states that operator-only means operator-decided: after the operator approves, an agent carries out the decision with `conductor cmd` or `conductor restart`.
