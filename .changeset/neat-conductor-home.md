---
'agent-conductor': minor
---

Keep new fleet configuration, secrets, runtime state, and logs under `.conductor/` instead of creating
generic root-level `config/` and `data/` directories. Preserve legacy fleet discovery and reject ambiguous
mixed layouts.
