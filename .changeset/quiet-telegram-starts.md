---
'agent-conductor': patch
---

Validate Telegram bot credentials before reporting the channel connected, and make Telegram's bare
`/start` handshake return fleet status plus command help while preserving targeted lifecycle starts.
