# Internal Beta Certification Record

## Candidate

- Status: `READY FOR OPERATOR CERTIFICATION`
- Source commit:
- Target version: `0.2.0-beta.0`
- Tarball SHA-256:
- Platform / terminal:
- Node:
- Claude Code:
- Codex:

## Automated evidence

| Surface        | Status | Evidence                                                                                  |
| -------------- | ------ | ----------------------------------------------------------------------------------------- |
| Quality        | PASS   | Typecheck, lint, formatting, build, 51 test files / 725 tests                             |
| Terminal       | PASS   | Real tmux E2E plus 53 iTerm adapter tests                                                 |
| Messaging      | PASS   | Direct, queue, cancellation, operator, broadcast, sentinel, and protected-delivery suites |
| Extensibility  | PASS   | Packed external TypeScript/import consumer using only package exports                     |
| PR Shepherd    | PASS   | Engine, service, singleton, sinks, direct/queue policy, and profile suites                |
| Package        | PASS   | 271-entry allowlist; npm, pnpm, and Yarn Classic global installs; aligned binary versions |
| Fresh scaffold | PASS   | Packed doctor/start, copy-once onboarding prompt, no orphan child on preflight failure    |

## Operator-owned evidence

| Lane                                          | Status  | Evidence                                  |
| --------------------------------------------- | ------- | ----------------------------------------- |
| Claude Code / iTerm onboarding                | NOT RUN |                                           |
| Codex onboarding and managed home override    | NOT RUN |                                           |
| Ctrl-C ownership and restart                  | NOT RUN |                                           |
| Stable global daemon install/status/uninstall | NOT RUN |                                           |
| Final GitHub asset URL + checksum             | NOT RUN | Requires separately authorized prerelease |

## Decision

- Share with internal cohort: `NOT YET AUTHORIZED`
- Approver:
- Date:
- Known limitations / follow-ups:
