import type { SessionConfig } from '../config/schema.js';
import type { SessionState } from './types.js';

const ACTIVITY_ICONS: Record<SessionState['activity'], string> = {
  working: '🟢',
  idle: '🟡',
  stalled: '🟠',
  stopped: '⚪',
};

const RUNTIME_LABELS: Record<SessionConfig['runtime'], string> = {
  'claude-code': 'CC',
  'codex': 'codex',
};

export interface StatusDeps {
  sessions(): Map<string, SessionConfig>;
  getState(codename: string): SessionState | undefined;
  runtimeFor(codename: string): SessionConfig['runtime'] | undefined;
  sentinelCodename(): string | undefined;
}

export function formatSessionLine(
  codename: string,
  runtime: SessionConfig['runtime'],
  state: SessionState | undefined,
  isSentinel: boolean,
): string {
  const name = `${codename} - ${RUNTIME_LABELS[runtime]}${isSentinel ? ' 🛡' : ''}`;
  if (state === undefined) return `${name} · ⚪ unregistered`;
  const tag = state.tag !== undefined ? ` · ${state.tag}` : '';
  const activity = state.running ? state.activity : 'stopped';
  const mode = state.auto ? ' - auto' : '';
  const paused = state.paused ? ' (paused)' : '';
  return `${name} · ${ACTIVITY_ICONS[activity]} ${activity}${mode}${paused}${tag}`;
}

export function statusReport(deps: StatusDeps, codename?: string): string {
  const sentinel = deps.sentinelCodename();

  if (codename !== undefined) {
    const state = deps.getState(codename);
    if (state === undefined || !deps.sessions().has(codename)) return `Unknown session: ${codename}`;
    return JSON.stringify(
      {
        codename,
        runtime: deps.runtimeFor(codename) ?? null,
        auto: state.auto,
        paused: state.paused,
        tag: state.tag ?? null,
        running: state.running,
        ready: state.ready,
        activity: state.activity,
        agentProject: state.isAgentProject,
        isSentinel: codename === sentinel,
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
      if (runtime !== undefined)
        lines.push(`  ${formatSessionLine(name, runtime, deps.getState(name), name === sentinel)}`);
    }
  }
  return lines.join('\n');
}
