import type { SessionConfig } from '../config/schema.js';
import type { SessionState } from './types.js';

const ACTIVITY_ICONS: Record<SessionState['activity'], string> = {
  working: '🟢',
  idle: '🟡',
  stalled: '🟠',
  stopped: '⚪',
};

export interface StatusDeps {
  sessions(): Map<string, SessionConfig>;
  getState(codename: string): SessionState | undefined;
  sentinelCodename(): string | undefined;
}

export function formatSessionLine(codename: string, state: SessionState | undefined, isSentinel: boolean): string {
  if (state === undefined) return `⚪ unregistered · ${codename}`;
  const name = `${codename}${isSentinel ? ' 🛡' : ''}`;
  const tag = state.tag !== undefined ? ` · ${state.tag}` : '';
  if (state.pause !== undefined) return `⏸ paused · ${name}${tag}`;
  const activity = state.running ? state.activity : 'stopped';
  return `${ACTIVITY_ICONS[activity]} ${activity} · ${name}${tag}`;
}

export function statusReport(deps: StatusDeps, codename?: string): string {
  const sentinel = deps.sentinelCodename();

  if (codename !== undefined) {
    const state = deps.getState(codename);
    if (state === undefined || !deps.sessions().has(codename)) return `Unknown session: ${codename}`;
    return JSON.stringify(
      {
        codename,
        runtime: deps.sessions().get(codename)?.runtime ?? null,
        autonomy: state.autonomy,
        paused: state.pause !== undefined,
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
      lines.push(formatSessionLine(name, deps.getState(name), name === sentinel));
    }
  }
  return lines.join('\n');
}
