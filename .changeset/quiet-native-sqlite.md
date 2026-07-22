---
'agent-conductor': patch
---

Replace the native `better-sqlite3` dependency with Node's built-in SQLite API, eliminating native addon ABI mismatches across supported Node versions. The minimum supported Node version is now 22.13 (or 23.4 on the non-LTS Node 23 line).
