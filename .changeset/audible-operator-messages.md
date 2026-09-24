---
'agent-conductor': minor
---

Add an optional audible alert, `channels.operatorSound`, for delivered `send_to_operator` messages. It is off by default and plays through `afplay` on macOS hosts. A burst of messages plays at most one sound every 5 seconds, and a player failure never affects delivery. Messages with choices can use a separate sound.
