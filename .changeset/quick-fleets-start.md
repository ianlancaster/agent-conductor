---
'agent-conductor': minor
---

Make `conductor start` initialize missing fleet scaffold files automatically, including an owner-only,
gitignored `.conductor/.env` with organized operator-channel placeholders. Remove the separate
`conductor init` command and use `/spawn --path` to register the first agent from the operator console.
Generate a complete supervisor configuration with concrete effective defaults, fleet-derived values, and
disabled Telegram and Slack channel blocks instead of a commented override stub.
