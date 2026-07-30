import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { SessionConfig } from '../config/schema.js';
import type { SessionState } from './types.js';
import { currentBranch } from './worktree.js';
import type { ConductorEventJournalStatus } from '../events/types.js';
import type { IntegrationStatus } from '../integrations/types.js';
import type { LifecycleOperation, ProcessObservation } from './lifecycle.js';
import type { FleetWatchStatus } from './sentinel.js';

const ACTIVITY_ICONS: Record<SessionState['activity'], string> = {
  working: '🟢',
  idle: '🟡',
  stopped: '⚪',
};

const RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'CC',
  'codex': 'codex',
};

export const PR_SHEPHERD_ONLINE_STATUS = 'PR Shepherd Status Online';

/**
 * A running process pinned to one model while its config declares another.
 * Launch-time settings are frozen at launch, so this is not a failure to apply a
 * declaration — it is a declaration that has not been launched yet.
 */
export interface ModelDrift {
  declared: string;
  /** Undefined when the process predates launch recording: unknown, not equal. */
  launched: string | undefined;
  launchedAt?: string;
}

export interface StatusDeps {
  sessions(): Map<string, SessionConfig>;
  getState(codename: string): SessionState | undefined;
  runtimeFor(codename: string): SessionConfig['runtime'] | undefined;
  /** In force now: the recorded launch while running, the next launch's value while stopped. */
  modelFor(codename: string): string | undefined;
  /** What the config resolves to for the next launch. */
  declaredModelFor?(codename: string): string | undefined;
  modelDriftFor?(codename: string): ModelDrift | undefined;
  /** In force now: the launched value while running, the next launch's value while stopped. */
  effortFor(codename: string): string | undefined;
  /** What the config resolves to for the next launch. */
  declaredEffortFor?(codename: string): string | undefined;
  /** Whether the current effective configuration declares any Claude PreToolUse hooks. */
  hooksDeclaredFor?(codename: string): boolean;
  /** Null when no recorded launch exists; otherwise whether declaration and rendered launch differ. */
  hooksRenderingDriftFor?(codename: string): boolean | null;
  sentinelCodename(): string | undefined;
  processObservation(codename: string): ProcessObservation | undefined;
  /** Advisory: a lifecycle transition already owns this seat right now. */
  operationInFlight?(codename: string): LifecycleOperation | undefined;
}

export type RuntimeSettingDefaults = Record<string, string | undefined>;

/** Shorten paths inside the current user's home for human- and agent-facing status output. */
export function displayPath(value: string, homeDirectory = homedir()): string {
  if (value === homeDirectory) return '~';
  const homePrefix = homeDirectory.endsWith(sep) ? homeDirectory : `${homeDirectory}${sep}`;
  return value.startsWith(homePrefix) ? `~${value.slice(homeDirectory.length)}` : value;
}

/**
 * Return the model Conductor resolves for a session run. A per-session model only
 * applies to that session's configured runtime; runtime overrides use the selected
 * runtime's default instead. Undefined means the runtime chooses its own default.
 */
export function resolvedSessionModel(
  session: SessionConfig,
  runtime: SessionConfig['runtime'],
  defaults: RuntimeSettingDefaults,
): string | undefined {
  if (runtime === session.runtime && session.model !== undefined) return session.model;
  return defaults[runtime];
}

/** Resolve a stopped/configured session's effort using the same runtime portability rule as models. */
export function resolvedSessionEffort(
  session: SessionConfig,
  runtime: SessionConfig['runtime'],
  defaults: RuntimeSettingDefaults,
): string | undefined {
  if (runtime === session.runtime && session.effort !== undefined) return session.effort;
  return defaults[runtime];
}

/**
 * State the drift in one sentence that names the remedy. Null when a running
 * process matches its declaration, or when there is nothing to compare.
 */
export function formatModelDrift(drift: ModelDrift | undefined): string | null {
  if (drift === undefined) return null;
  const running =
    drift.launched === undefined
      ? 'the running process predates launch recording, so what it is running is unknown'
      : `${drift.launched} running`;
  const since = drift.launchedAt !== undefined ? ` since ${drift.launchedAt}` : '';
  return `${drift.declared} declared, ${running}${since} — restart to apply`;
}

/**
 * Session-config fields consumed when a process launches, and therefore frozen
 * for that process's lifetime. Deliberately not every field: `auto`, `tag` and
 * `schedules` are read live, and an edit to those really does take effect.
 */
const LAUNCH_TIME_FIELDS = ['runtime', 'model', 'effort', 'bypassPermissions', 'systemPromptFile'] as const;

/**
 * Describe launch-time fields that changed between two revisions of a session
 * config. Empty when nothing launch-relevant moved, so a caller can stay silent.
 */
export function launchTimeFieldEdits(previous: SessionConfig, next: SessionConfig): string[] {
  return LAUNCH_TIME_FIELDS.filter((field) => previous[field] !== next[field]).map(
    (field) => `${field}: ${describeFieldValue(previous[field])} → ${describeFieldValue(next[field])}`,
  );
}

function describeFieldValue(value: string | boolean | undefined): string {
  return value === undefined ? '(unset)' : String(value);
}

/**
 * Advisory recovery marker. A second supervisor that reads status before acting
 * can see that the seat is already being recovered, and by whom, instead of
 * discovering it by colliding with the first one.
 */
export function formatLifecycleOperation(operation: LifecycleOperation): string {
  return ` · ⏳ ${operation.kind} in progress since ${operation.since}${
    operation.initiator !== undefined ? ` (${operation.initiator})` : ''
  }`;
}

export function formatSessionLine(
  codename: string,
  runtime: SessionConfig['runtime'],
  state: SessionState | undefined,
  isSentinel: boolean,
  isShepherdRecipient = false,
  operation?: LifecycleOperation,
  modelDrift?: ModelDrift,
): string {
  const name = `${codename} - ${RUNTIME_LABELS[runtime] ?? runtime}${isSentinel ? ' 🛡' : ''}${isShepherdRecipient ? ' 🐑' : ''}`;
  if (state === undefined) return `${name} · ⚪ unregistered`;
  const tag = state.tag !== undefined ? ` · ${state.tag}` : '';
  const activity = state.running ? state.activity : 'stopped';
  const mode = state.auto ? ' - auto 🔄' : '';
  const paused = state.paused ? ' (paused)' : '';
  const recovering = operation !== undefined ? formatLifecycleOperation(operation) : '';
  // Visible in the fleet list, not only in per-session detail: nobody asks a
  // seat about its model until something has already gone wrong, and a fleet of
  // pods is exactly where one wrong pin hides.
  const drift = modelDrift !== undefined ? ` · ⚠ running ${modelDrift.launched ?? 'unrecorded'}` : '';
  return `${name} · ${ACTIVITY_ICONS[activity]} ${activity}${mode}${paused}${tag}${drift}${recovering}`;
}

export interface StatusMarkers {
  shepherdRecipient?: string;
}

export function statusReport(deps: StatusDeps, codename?: string, markers: StatusMarkers = {}): string {
  const sentinel = deps.sentinelCodename();

  if (codename !== undefined) {
    const state = deps.getState(codename);
    const session = deps.sessions().get(codename);
    if (state === undefined || session === undefined) return `Unknown session: ${codename}`;
    const process = deps.processObservation(codename);
    const operation = deps.operationInFlight?.(codename);
    return JSON.stringify(
      {
        codename,
        path: displayPath(session.repo),
        branch: currentBranch(session.repo),
        runtime: deps.runtimeFor(codename) ?? null,
        // `model` is what this session is running (or would run if started).
        // `modelDeclared` is what its config says. They differ whenever a
        // launch-time field was edited under a live process, and only a restart
        // closes the gap — so the drift is stated rather than left to be
        // inferred from two fields that look interchangeable.
        model: deps.modelFor(codename) ?? null,
        modelDeclared: deps.declaredModelFor?.(codename) ?? null,
        modelDrift: formatModelDrift(deps.modelDriftFor?.(codename)),
        effort: deps.effortFor(codename) ?? null,
        effortDeclared: deps.declaredEffortFor?.(codename) ?? null,
        hooksDeclared: deps.hooksDeclaredFor?.(codename) ?? false,
        hooksRenderedDigest: state.running ? (state.hooksRenderedDigest ?? null) : null,
        hooksRenderingDrift: deps.hooksRenderingDriftFor?.(codename) ?? null,
        // Registration is a runtime fact. Configuration and a rendered digest
        // cannot promote it; this feature deliberately consumes no hook receipt.
        hooksRegistrationObserved: 'UNKNOWN',
        // When the live process started. Null while stopped, and null for a
        // process adopted from before Conductor recorded launches. It is the
        // field that gives the launch a currency: a declaration edited after
        // this instant has not reached the running process, and without the
        // timestamp the config is the only dated record in sight — which is why
        // reading the config has been the cheap and wrong read all along.
        launchedAt: state.running ? (state.launchedAt ?? null) : null,
        auto: state.auto,
        paused: state.paused,
        tag: state.tag ?? null,
        running: state.running,
        processActive: process?.active ?? null,
        processObservedAt: process?.observedAt ?? null,
        ready: state.ready,
        activity: state.activity,
        agentProject: state.isAgentProject,
        isSentinel: codename === sentinel,
        isShepherdRecipient: codename === markers.shepherdRecipient,
        // Advisory only: another caller is already recovering this seat. Acting
        // anyway is not blocked, it just duplicates work that is under way.
        lifecycleOperation: operation?.kind ?? null,
        lifecycleOperationBy: operation?.initiator ?? null,
        lifecycleOperationSince: operation?.since ?? null,
      },
      null,
      2,
    );
  }

  const names = [...deps.sessions().keys()].sort();
  if (names.length === 0) return 'No sessions configured.';

  // Agent projects (repos with the marker file) get their own section.
  const agents = names.filter((name) => deps.getState(name)?.isAgentProject === true);
  const sessions = names.filter((name) => deps.getState(name)?.isAgentProject !== true);

  const lines: string[] = [];
  for (const [header, group] of [
    ['Agents:', agents],
    ['Sessions:', sessions],
  ] as const) {
    if (group.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(header);
    for (const name of group) {
      const runtime = deps.runtimeFor(name);
      if (runtime !== undefined) {
        lines.push(
          `  ${formatSessionLine(
            name,
            runtime,
            deps.getState(name),
            name === sentinel,
            name === markers.shepherdRecipient,
            deps.operationInFlight?.(name),
            deps.modelDriftFor?.(name),
          )}`,
        );
        const session = deps.sessions().get(name);
        if (session !== undefined) {
          const branch = currentBranch(session.repo);
          lines.push(`    path: ${displayPath(session.repo)} · branch: ${branch ?? 'none'}`);
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * State the instrument's real coverage in one line. "On" is a setting; armed,
 * inert, and suppressed are what it can actually do, and a reader that cannot
 * tell them apart will treat structural silence as an all-clear.
 */
export function formatFleetWatchStatus(status: FleetWatchStatus): string {
  const measured = `${String(status.members.length)} standing session(s), ${String(status.runningMembers.length)} running`;
  switch (status.state) {
    case 'off':
      return 'Fleet watch off.';
    case 'armed':
      // Name the signals it can produce: armed for an outage only is a real and
      // materially different kind of coverage from armed for a quiet fleet.
      return `Fleet watch armed for ${status.covers.join(' and ')} — measuring ${measured}.`;
    default:
      return `Fleet watch on but ${status.state.toUpperCase()} — cannot fire: ${status.reason ?? 'reason unavailable'} (${measured}). There is no fleet-level backstop right now.`;
  }
}

/** Add the canonical fleet heading and optional companion-health summary. */
/**
 * Whether anything Conductor raises can actually reach a human right now.
 *
 * `armed` — at least one operator channel is started, or a console is attached.
 * `inert` — no channel and no console: every alarm terminates in a log file.
 * `degraded` — a transport exists but notifications are failing to land.
 *
 * This is the same distinction fleet watch needs and for the same reason. An
 * alarm path that reports itself present while structurally incapable of
 * reaching anyone is worse than an absent one, because its silence reads as
 * nothing being wrong.
 */
export interface OperatorReach {
  state: 'armed' | 'inert' | 'degraded';
  reason?: string;
  /** Started operator channels, by name. */
  channels: readonly string[];
  /** Attached consoles (`conductor start`, `conductor console`). */
  consoles: number;
  /** Operator notifications this run that reached nobody. */
  undelivered: number;
  /** ISO-8601 instant of the oldest such notification, if any. */
  undeliveredSince?: string;
}

export function formatOperatorReach(reach: OperatorReach): string {
  if (reach.state === 'armed') {
    const where = [...(reach.consoles > 0 ? [`${String(reach.consoles)} console(s)`] : []), ...reach.channels].join(
      ', ',
    );
    return `Operator reachable via ${where}.`;
  }
  const label = reach.state === 'inert' ? 'INERT' : 'DEGRADED';
  const backlog =
    reach.undelivered > 0
      ? ` ${String(reach.undelivered)} notification(s) have reached nobody${
          reach.undeliveredSince !== undefined ? ` since ${reach.undeliveredSince}` : ''
        }.`
      : '';
  return (
    `Operator channel ${label} — ${reach.reason ?? 'notifications cannot be delivered'}.` +
    `${backlog} Every alarm this fleet raises is currently ending in a log file.`
  );
}

export function formatFleetStatusReport(
  report: string,
  options: {
    fleetWatch: FleetWatchStatus;
    shepherdOnline: boolean;
    operatorReach?: OperatorReach;
    eventJournal?: ConductorEventJournalStatus;
    integrations?: readonly IntegrationStatus[];
  },
): string {
  // The 🔄 badge means armed, never merely enabled.
  const heading = `Agent Conductor Status${options.fleetWatch.state === 'armed' ? ' 🔄' : ''}`;
  const integrations = options.integrations ?? [];
  return [
    heading,
    ...(options.fleetWatch.state === 'off' ? [] : [formatFleetWatchStatus(options.fleetWatch)]),
    // Before fleet watch's own state, an unreachable operator makes every other
    // alarm on this report undeliverable, including fleet watch's.
    ...(options.operatorReach !== undefined && options.operatorReach.state !== 'armed'
      ? [formatOperatorReach(options.operatorReach)]
      : []),
    ...(options.shepherdOnline ? [PR_SHEPHERD_ONLINE_STATUS] : []),
    ...(options.eventJournal?.degraded === true
      ? [
          `Event journal DEGRADED — exported history is incomplete (${String(options.eventJournal.failureCount)} failure(s) this run). Run conductor doctor.`,
        ]
      : []),
    '',
    report,
    ...(integrations.length === 0
      ? []
      : [
          '',
          'Integrations:',
          ...integrations.map((integration) => {
            const marker =
              integration.state === 'healthy'
                ? '🟢'
                : integration.state === 'failed'
                  ? '🔴'
                  : integration.state === 'stopped'
                    ? '⚪'
                    : '🟡';
            const detail =
              integration.state !== 'healthy' && integration.detail !== undefined ? ` · ${integration.detail}` : '';
            return `  ${integration.name} · ${marker} ${integration.state}${detail}`;
          }),
        ]),
  ].join('\n');
}
