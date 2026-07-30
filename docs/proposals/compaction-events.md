# Proposal: compaction as a first-class Conductor event

**Status: proposal. Nothing here is built.** This document exists to be argued with before code is
written, per the requirement that the shape — including what it cannot tell anyone — is agreed
first.

## Why Conductor is still a useful producer

**Evidence correction (Claude Code 2.1.220):** the original premise that OpenTelemetry has no
compaction carrier is false. A live OTLP/HTTP JSON capture observed `claude_code.compaction` three
times on the `com.anthropic.claude_code.events` logs scope. The name
`gen_ai.conversation.compacted` was not emitted on that tested path and is not documented, but that
does not make Conductor the only component that can see the boundary. Evidence and limits are frozen
at fleet records `c7d6151` and telemetry commit `23d3989`.

Conductor remains useful because it receives lifecycle signals from both supported runtimes, can
publish one cross-runtime shape, and already runs a state machine over start, completion, and
post-boundary resumption. Runtime OTel and Conductor hooks are independent observation paths with
different gaps; neither should be described as the sole authority.

Consumers care about compaction because it is where instructions, constraints, and context are at
risk of being dropped. A consumer measuring whether a rule survived needs to know when the boundary
happened, and whether the session came back to a prompt or carried straight on working.

## What Conductor observes today

Both runtimes report the boundary through best-effort hooks that POST to `/events/<codename>`:

| Runtime     | Compaction start                    | Compaction end                                  |
| ----------- | ----------------------------------- | ----------------------------------------------- |
| Claude Code | `PreCompact` hook                   | `SessionStart` hook with `source: "compact"`     |
| Codex       | generated `PreCompact` hook         | generated compact-boundary `SessionStart` hook   |

`HealthMonitor` (`src/core/health.ts`) already turns those into a three-way outcome, and the
existing `compaction` stall depends on the distinction this proposal needs to expose:

1. `compaction` event → the turn is marked interrupted and the compaction is recorded as pending.
2. `compaction-complete` event → per-session tracking resets and the `health.idleConfirmMs` debounce
   starts.
3. When it expires, the runtime-owned activity parser decides the outcome:
   - **idle** → the session came to rest at a prompt; a `compaction` stall is reported.
   - **working** → the turn resumed automatically; the session goes back to working and no stall is
     reported.
   - **unknown** → capture could not be classified; deliberately nothing changes.

So the distinction between *compaction occurred* and *compaction occurred and the session came to
rest at a prompt* is already computed. It is simply not published: today it survives only as the
presence or absence of a stall, which a consumer would have to re-derive by inference.

## Proposed events

Two facts, published on the existing `ConductorEventPublisher`, metadata only — consistent with the
event-subscriber privacy contract (no pane captures, no conversation content).

```ts
| {
    readonly type: 'session.compaction.started';
    readonly session: string;
    /** Runtime-reported cause where available; `unknown` when the hook omits it. */
    readonly trigger: 'auto' | 'manual' | 'unknown';
    readonly detectedAt: string;
  }
| {
    readonly type: 'session.compaction.completed';
    readonly session: string;
    /** How the session behaved after the boundary, once the idle debounce resolved. */
    readonly resumption: 'idle-at-prompt' | 'resumed-working' | 'unknown';
    /** Start of the matching `session.compaction.started`, when one was observed. */
    readonly startedAt: string | null;
    readonly detectedAt: string;
  }
```

Notes on the shape:

- **Two events, not one with a boolean.** A boundary that starts and never completes is a distinct,
  informative state; collapsing it loses exactly the case a denominator has to account for.
- `resumption` is resolved by the same debounce and the same runtime-owned parser the `compaction`
  stall already uses. It is not a new heuristic and adds no new pane parsing to core.
- `startedAt` is `null` when the completion hook arrives without a matching start — which is how a
  lost start hook becomes visible rather than silent.
- `trigger` requires capturing a field the Claude adapter currently discards (`PreCompact` carries a
  trigger distinguishing automatic from operator-invoked `/compact`). Codex's generated hook may not
  supply one; `unknown` is the honest value there rather than a guess.
- **`trigger: 'auto'` is not a health classification.** Claude Code uses `"auto"` for both the normal
  threshold path and reactive `prompt_too_long` recovery. In the OTel lane's wording: *"anyone scoring
  context hygiene off this conflates a healthy threshold compaction with a seat that ran out of
  room."* Conductor may preserve the runtime value, but consumers must not infer which automatic path
  occurred without an independent discriminator.

## Delivery guarantee, stated in the contract

**These events are derived from best-effort runtime hooks. A hook that is never delivered produces
no event. The stream is therefore silently short rather than wrong: every record it contains is
accurate, and the count is low by an unknown amount.**

That sentence belongs in the published contract, not only in this proposal, because the two readings
a consumer might take — *no compaction occurred* and *no compaction was observed* — must not
collapse. Concretely:

- A missing `started` with a present `completed` is detectable (`startedAt: null`).
- A missing `completed` after a present `started` is detectable (an unterminated boundary).
- **A boundary where both hooks are lost is undetectable from the event stream alone.** Nothing
  inside Conductor can distinguish it from a session that never compacted. A consumer needing a
  trustworthy denominator must corroborate against a source outside this path — the runtime's own
  session transcript is written unconditionally and independently of hook delivery.

## What this cannot tell you

- **Whether compaction happened when both hooks were lost.** See above. This is the load-bearing
  limitation.
- **What was dropped.** Conductor never reads conversation content into events. Whether a specific
  instruction survived a boundary is measurable only by a consumer that can read the transcript;
  Conductor can say when to look, not what to find.
- **Token or context accounting.** Neither hook carries before/after context size, and Conductor
  does not parse transcripts for usage. Any accrual measure has to come from elsewhere.
- **Whether an automatic compaction was threshold-driven or reactive recovery.** Both surface as
  `trigger: 'auto'` in Claude Code. The proposed event can report that value but cannot turn it into a
  health verdict.
- **Sub-session or subagent compaction**, if a runtime performs it without emitting a session-level
  hook.
- **Ordering against a turn.** The events carry `detectedAt`, which is Conductor's mechanical
  classification time; it is not a claim about when the runtime began compacting internally.
- **`resumption: 'unknown'` is a real outcome, not a placeholder.** A capture that cannot be
  classified deliberately changes nothing, and the event says so rather than defaulting to a value.

## Canary requirements

The check is designed in, not retrofitted, and must be **shown failing before it is trusted to
pass**:

1. Suppress the compaction hooks for one session (point its events endpoint at a black hole) and
   assert the canary reports a gap rather than reporting health. A canary that cannot be made to
   fail is not evidence.
2. Assert that a completion without a start surfaces as `startedAt: null` rather than being dropped.
3. Assert that `resumption` distinguishes the resumed-working path from the idle-at-prompt path,
   using the existing fake-runtime activity evidence.

## Evidence from the dogfooding fleet

**Current status:** the runtime path is no longer unexercised. The OTel lane induced and captured
three real Claude Code 2.1.220 compactions. What remains unbuilt and therefore unexercised is this
proposal's Conductor event publication and cross-runtime resumption shape. The paragraph below is
retained as the earlier fleet-store snapshot, not as current evidence that no compaction occurs.

At the time this proposal was written, the path was unexercised in the measured fleet snapshot.
Across two nights of use with `runtimes.claudeCode.autocompactPct: 70`, the fleet store contained
**no compaction records** — 215 stalls, of which 180 `idle` and 35 `blocked`, and zero `compaction`.
The then-searched runtime transcripts also contained no compaction marker. That historical snapshot
established only that no compaction was observed in that interval; the later three-event capture
supersedes any present-tense zero claim.

That is the argument for building the canary alongside the event rather than after it. The first
real compaction on this fleet will be the first time any of this code runs in anger, and a signal
whose failure mode is silence cannot be validated by waiting to see whether it stays quiet.

**Read that number narrowly.** The fleet it came from runs deliberate consolidation practice —
sessions are cleared and restarted at context boundaries by policy, and a context ladder intervenes
well before the runtime's own compaction threshold. Those rituals are an intervention that suppresses
compaction, so the observation is a fact about a fleet that manages context on purpose, not about
coding agents in general. It supports "this code path is unexercised here", which is a statement
about test coverage. It does not support any claim about how often the population of interest
compacts, in either direction, and a consumer sizing a study from it would be reading a selection
effect the fleet authored itself.

Whether the target population compacts at all is a prior question, answerable from transcripts and
literature rather than from this proposal. It does not block the event — Conductor is the only
producer that can see the boundary, and the observation is worth publishing regardless — but it may
change what a consumer should do with it.

## Open decisions

1. **Event names.** `session.compaction.started` / `.completed` follows the existing
   `session.activity.changed` convention. Alternative: a single `session.compaction` with a phase
   field, which is more compact and less self-describing.
2. **Whether `resumption` should delay the completion event.** Publishing after the debounce keeps
   one row per fact; publishing immediately with a follow-up gets the boundary out sooner. This
   proposal takes the former.
3. **Whether the `compaction` stall should be left exactly as it is.** It should — this proposal
   publishes an existing observation and deliberately changes no supervision behaviour.
