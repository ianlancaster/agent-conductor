# OpenCodex runtime acceptance

This is an operator-run test. It intentionally makes real model requests, so run it only after
the proxy is configured, a suitable credential is present, and the operator has approved the
chosen model and cost. Use a disposable repository/worktree and record actual observed routes;
do not infer success from a healthy proxy or catalog listing.

1. Confirm the separate proxy is bound to loopback and healthy, and inspect its live model
   catalog. Confirm the model under test is available. Keep credentials inside the proxy's secret
   mechanism. Do not print their values.
2. Enable `runtimes.openCodex.enabled`, set its exact `proxyOrigin`, optionally configure an
   absolute `proxyEnsureCommand` for an operator-owned startup wrapper, run `conductor validate`,
   and restart only the intended Conductor instance. Call `get_conductor_docs` without a topic:
   `opencodex` should appear and `opencodex-claude` should not appear unless its separate flag
   was enabled. Read the `opencodex` topic and inspect the live spawn runtime choices.
3. Start a disposable `runtime: opencodex` session with an explicit proxy model. Give it a tiny
   verifiable coding task. Confirm the proxy recorded that model and the CLI completed a turn.
   Have the worker reply through `send_to_session`, verify the receipt reached `delivered`, then
   stop and continue the session and repeat the exchange. Observe that a down proxy blocks a
   subsequent start/continue before the CLI starts; restore the proxy separately.
4. In a separate disposable `runtime: codex` session, confirm an ordinary native Codex launch
   contains no OpenCodex provider override. Do not send a paid native request solely for this
   comparison unless approved.
5. For a native Codex child-model test, explicitly select a different proxy catalog model for
   the child. If a native ChatGPT parent routes to a non-ChatGPT child, first check the live
   `/v1/catalog`, the session's isolated `models_cache.json`, and the **fresh conversation's**
   native multi-agent tool surface as described in the
   [V1 transport setup](opencodex.md#routed-codex-children-and-the-v1-transport).
   `/continue` is not a fresh-session test. An accepted spawn followed by
   `unreadable_encrypted_agent_task` is a failed transport gate even if the proxy is healthy;
   do not try to rescue it with a follow-up or silently fall back to a native model. Give the
   child a tiny verifiable tool task, send one distinct follow-up, and inspect the proxy's
   actual upstream route and successful response for both turns. Confirm the child shares the
   parent's Conductor identity; use a second Conductor session if independent addressing is
   needed. Record any child, tool, effort, or compaction mismatch.
6. To qualify Claude Code, enable its route in the proxy first. Then set
   `runtimes.openCodex.claudeCodeEnabled: true`, validate, and restart the intended Conductor
   instance. Confirm `opencodex-claude` now appears in the live runtime choices. Start a
   disposable session with an explicit proxy model, including with an inherited native
   `ANTHROPIC_API_KEY` or Claude login in the launching environment. Confirm the proxy records
   the request and no native provider receives it. Check a completed turn, Conductor messaging,
   stop/continue, and proxy-down failure. Test one generated `ocx-*` child type with a different
   model, verifying the proxy's selected model rather than trusting the Agent tool's tier alias.
   A 403 from the proxy's Claude route is a failed gate.
7. Stop disposable sessions, preserve any work worth keeping, set the feature flags back to the
   intended state, and restart deliberately if changing them. Record the Conductor version,
   proxy and CLI versions, model IDs, route evidence, and each pass/failure.

Do not call either substrate qualified until the corresponding live checks pass. Offline tests
cover command construction and registration; they cannot prove authentication, inference,
provider routing, native child behavior, or provider-specific tool compatibility.
