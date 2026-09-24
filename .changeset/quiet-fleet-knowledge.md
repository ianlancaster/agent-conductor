---
'agent-conductor': minor
---

Add the `fleet-knowledge` handbook topic. When the fleet directory contains `knowledge-index.toml`, managed sessions also get one protocol line pointing to it. The file is checked at every session start. Runtime `protocolNotice` options now accept a function, evaluated each time a session's protocol is prepared.
