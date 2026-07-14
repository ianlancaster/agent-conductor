import type { AgentConfig } from '../config/schema.js';
import type { AgentState } from './types.js';

const ACTIVITY_ICONS: Record<AgentState['activity'], string> = {
  working: '🟢',
  idle: '🟡',
  stalled: '🟠',
  stopped: '⚪',
};

export interface StatusDeps {
  agents(): Map<string, AgentConfig>;
  getState(codename: string): AgentState | undefined;
  sentinelCodename(): string | undefined;
  pendingStallCount(): number;
}

export function formatAgentLine(codename: string, state: AgentState | undefined, isSentinel: boolean): string {
  if (state === undefined) return `⚪ ${codename} — unregistered`;
  const icon = state.sessionActive ? ACTIVITY_ICONS[state.activity] : ACTIVITY_ICONS.stopped;
  const mode = state.pause !== undefined ? `paused→${state.pause.previousAutonomy}` : state.autonomy;
  const markers = [isSentinel ? '🛡' : '', state.isAgentProject ? '🤖' : ''].filter((m) => m.length > 0).join('');
  const tag = state.tag !== undefined ? ` — ${state.tag}` : '';
  return `${icon} ${codename}${markers.length > 0 ? ` ${markers}` : ''} [${mode}]${tag}`;
}

export function statusReport(deps: StatusDeps, codename?: string): string {
  const sentinel = deps.sentinelCodename();

  if (codename !== undefined) {
    const state = deps.getState(codename);
    if (state === undefined || !deps.agents().has(codename)) return `Unknown agent: ${codename}`;
    return JSON.stringify(
      {
        codename,
        autonomy: state.autonomy,
        paused: state.pause !== undefined,
        tag: state.tag ?? null,
        sessionActive: state.sessionActive,
        activity: state.activity,
        agentProject: state.isAgentProject,
        isSentinel: codename === sentinel,
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  for (const name of [...deps.agents().keys()].sort()) {
    lines.push(formatAgentLine(name, deps.getState(name), name === sentinel));
  }
  if (lines.length === 0) lines.push('No agents configured.');
  if (sentinel === undefined) {
    lines.push('', '⚠️ No sentinel configured — autonomous agents are unsupervised.');
  }
  const stalls = deps.pendingStallCount();
  if (stalls > 0) lines.push('', `📥 ${stalls} unresolved stall(s) in the sentinel queue.`);
  return lines.join('\n');
}
