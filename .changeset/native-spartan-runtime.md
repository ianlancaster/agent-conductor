---
'agent-conductor': minor
---

Add SPARTAN as a built-in Codex-compatible runtime. `/spawn <name> -r spartan`, start and continue overrides, MCP schemas, doctor diagnostics, and generated fleet configuration preserve the full Codex-compatible process harness while launching through SPARTAN. SPARTAN owns its per-launch platform context and MCP tools in both direct and managed sessions; Conductor only supplies its normal protocol and isolated runtime home.
