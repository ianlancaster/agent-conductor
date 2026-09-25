---
'agent-conductor': patch
---

Start and continue now re-read changed session files before launching, so a session whose `repo:` was just edited starts in the new folder instead of the one from the roster's last poll. While a session's file fails to load or selects an unknown runtime, starting it is refused with the file named instead of launching from the held last-good registration. The agent guide now names the per-runtime `defaultModel` and `defaultEffort` keys that spawns inherit.
