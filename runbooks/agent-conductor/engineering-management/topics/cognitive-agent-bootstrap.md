# Cognitive-agent bootstrap

This optional recipe uses a cognitive-agent workspace template for the persistent Engineering
Manager and Stall Sentinel. A template named `agent` is a common starting point, but it is fleet
configuration—not a runbook guarantee. First inspect `spawn.templates`; register or select the
operator's preferred template before spawning either role.

## Gather two approved briefs

Interview the operator separately for each role. Record its mission, scope, priorities, decision
boundaries, escalation policy, communication style, peer relationships, and whether it should join
any optional asynchronous social channel. Do not infer personal or organizational preferences.

The manager brief should describe how work is decomposed, when a worker or reviewer is warranted,
what evidence constitutes completion, and which decisions return to the operator. The sentinel
brief should describe mechanical stall classes, safe nudges, escalation boundaries, and how it
helps scope autonomous goals without becoming a second manager.

## Create and awaken

After the operator approves both briefs:

1. Spawn each persistent role into a separate workspace using the selected registered template.
2. Confirm each new pane is idle and contains no operator draft. Invoke `/awaken` in Claude Code or
   `$awaken` in Codex with `type_in_pane`; these are terminal commands, not peer messages.
3. Drive the interactive questions yourself. Inspect each newly rendered question, answer it from
   the approved brief, and state when relevant that you are acting as the operator's delegated
   onboarding assistant rather than impersonating the human. Do not ask the operator to repeat an
   answer already present in the brief.
4. If a question is not answered by the brief, a proposed answer changes authority or scope, or the
   runtimes present materially different choices, stop and ask the operator. Never invent personal,
   organizational, security, or approval preferences to keep the flow moving.
5. Use `type_in_pane` only for the fresh, operator-approved awakening interaction. A bounded pane
   read after each submitted answer is permitted because the operator explicitly delegated this
   terminal onboarding; do not turn it into a timer or general peer-monitoring loop. Stop if the pane
   contains a draft, an unrelated conversation, an unexpected command, or any sign another person
   is using it. Ordinary communication after awakening must use protected messages.
6. Review the generated identity and context with the operator before accepting the awakening
   commit. Verify that template markers are removed, the approved role and boundaries are recorded,
   and the commit contains no credentials or fleet-specific material outside that role's workspace.
7. Have each role call `whoami`, exchange one direct message, exercise start/stop/continue, and run a
   hand-driven stall response. Only then offer auto mode or fleet watch.

Bootstrap does not adopt the runbook, grant ongoing authority, or make later destructive and
external actions pre-approved. The onboarding agent should prepare the exact operator-only adoption
command only after the arrangement has passed its manual shakedown. If the operator declines
delegated awakening, leave the panes idle and hand over the two approved briefs without partially
answering either flow.
