---
'agent-conductor': minor
---

Declared MCP for Codex gains two narrow, fail-closed seams. Streamable-HTTP servers may declare
`httpHeaders`, a strict map of bounded, explicitly non-secret literal header values (for request
selectors such as `X-Datadog-MCP-Toolsets: 'core,apm'`) translated to Codex `http_headers`;
credential-like header names, credential-shaped or interpolated values, oversized entries, and
case-colliding names are rejected, and values never appear in readiness output. Fleet-owned
declared-MCP profiles may list `preserveSharedServers`, per-profile shared connector IDs (such as
a stored-OAuth Linear server) whose operator-owned Codex configuration survives session isolation
verbatim; all other shared and project MCP servers remain stripped or disabled, preservation
cannot be granted by a declaration or project, and reserved or declared-conflicting IDs fail
preparation. Readiness now reports `preservedSharedServerIds` by name only.
