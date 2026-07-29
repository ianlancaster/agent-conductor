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

export interface StatusDeps {
  sessions(): Map<string, SessionConfig>;
  getState(codename: string): SessionState | undefined;
  runtimeFor(codename: string): SessionConfig['runtime'] | undefined;
  modelFor(codename: string): string | undefined;
  effortFor(codename: string): string | undefined;
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
): string {
  const name = `${codename} - ${RUNTIME_LABELS[runtime] ?? runtime}${isSentinel ? ' 🛡' : ''}${isShepherdRecipient ? ' 🐑' : ''}`;
  if (state === undefined) return `${name} · ⚪ unregistered`;
  const tag = state.tag !== undefined ? ` · ${state.tag}` : '';
  const activity = state.running ? state.activity : 'stopped';
  const mode = state.auto ? ' - auto 🔄' : '';
  const paused = state.paused ? ' (paused)' : '';
  const recovering = operation !== undefined ? formatLifecycleOperation(operation) : '';
  return `${name} · ${ACTIVITY_ICONS[activity]} ${activity}${mode}${paused}${tag}${recovering}`;
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
        model: deps.modelFor(codename) ?? null,
        effort: deps.effortFor(codename) ?? null,
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
export function formatFleetStatusReport(
  report: string,
  options: {
    fleetWatch: FleetWatchStatus;
    shepherdOnline: boolean;
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
