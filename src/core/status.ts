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
  pendingStallCount(): number;
}

export function formatSessionLine(codename: string, state: SessionState | undefined, isSentinel: boolean): string {
  if (state === undefined) return `⚪ ${codename} — unregistered`;
  const icon = state.running ? ACTIVITY_ICONS[state.activity] : ACTIVITY_ICONS.stopped;
  const mode = state.pause !== undefined ? `paused→${state.pause.previousAutonomy}` : state.autonomy;
  const markers = [isSentinel ? '🛡' : '', state.isAgentProject ? '🤖' : ''].filter((m) => m.length > 0).join('');
  const tag = state.tag !== undefined ? ` — ${state.tag}` : '';
  return `${icon} ${codename}${markers.length > 0 ? ` ${markers}` : ''} [${mode}]${tag}`;
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

  const lines: string[] = [];
  for (const name of [...deps.sessions().keys()].sort()) {
    lines.push(formatSessionLine(name, deps.getState(name), name === sentinel));
  }
  if (lines.length === 0) lines.push('No sessions configured.');
  if (sentinel === undefined) {
    lines.push('', '⚠️ No sentinel configured — autonomous sessions are unsupervised.');
  }
  const stalls = deps.pendingStallCount();
  if (stalls > 0) lines.push('', `📥 ${stalls} unresolved stall(s) in the sentinel queue.`);
  return lines.join('\n');
}
