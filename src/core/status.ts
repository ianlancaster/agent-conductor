import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { SessionConfig } from '../config/schema.js';
import type { SessionState } from './types.js';
import { currentBranch } from './worktree.js';

const ACTIVITY_ICONS: Record<SessionState['activity'], string> = {
  working: '🟢',
  idle: '🟡',
  stalled: '🟠',
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

export function formatSessionLine(
  codename: string,
  runtime: SessionConfig['runtime'],
  state: SessionState | undefined,
  isSentinel: boolean,
  isShepherdRecipient = false,
): string {
  const name = `${codename} - ${RUNTIME_LABELS[runtime] ?? runtime}${isSentinel ? ' 🛡' : ''}${isShepherdRecipient ? ' 🐑' : ''}`;
  if (state === undefined) return `${name} · ⚪ unregistered`;
  const tag = state.tag !== undefined ? ` · ${state.tag}` : '';
  const activity = state.running ? state.activity : 'stopped';
  const mode = state.auto ? ' - auto 🔄' : '';
  const paused = state.paused ? ' (paused)' : '';
  return `${name} · ${ACTIVITY_ICONS[activity]} ${activity}${mode}${paused}${tag}`;
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
        ready: state.ready,
        activity: state.activity,
        agentProject: state.isAgentProject,
        isSentinel: codename === sentinel,
        isShepherdRecipient: codename === markers.shepherdRecipient,
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
          `  ${formatSessionLine(name, runtime, deps.getState(name), name === sentinel, name === markers.shepherdRecipient)}`,
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

/** Add the canonical fleet heading and optional companion-health summary. */
export function formatFleetStatusReport(
  report: string,
  options: { fleetWatchActive: boolean; shepherdOnline: boolean },
): string {
  const heading = `Agent Conductor Status${options.fleetWatchActive ? ' 🔄' : ''}`;
  return [heading, ...(options.shepherdOnline ? [PR_SHEPHERD_ONLINE_STATUS] : []), '', report].join('\n');
}
