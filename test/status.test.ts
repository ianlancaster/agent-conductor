import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  displayPath,
  formatFleetStatusReport,
  formatFleetWatchStatus,
  formatSessionLine,
  resolvedSessionEffort,
  resolvedSessionModel,
} from '../src/core/status.js';
import type { SessionState } from '../src/core/types.js';
import type { FleetWatchStatus } from '../src/core/sentinel.js';

function fleetWatch(overrides: Partial<FleetWatchStatus> = {}): FleetWatchStatus {
  return { enabled: false, state: 'off', members: [], runningMembers: [], covers: [], ...overrides };
}

function sessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    auto: false,
    paused: false,
    running: true,
    ready: true,
    activity: 'working',
    isAgentProject: false,
    ...overrides,
  };
}

describe('displayPath', () => {
  it('uses a home alias for the home directory and its descendants', () => {
    const home = join('/Users', 'example');
    expect(displayPath(home, home)).toBe('~');
    expect(displayPath(join(home, 'Projects', 'alpha'), home)).toBe(join('~', 'Projects', 'alpha'));
  });

  it('does not abbreviate paths that merely share the home prefix', () => {
    const home = join('/Users', 'ian');
    expect(displayPath(join('/Users', 'ian-other', 'project'), home)).toBe(join('/Users', 'ian-other', 'project'));
  });
});

describe('formatSessionLine', () => {
  it('shows the Claude Code runtime and no mode text when auto is off', () => {
    expect(formatSessionLine('alpha', 'claude-code', sessionState(), false)).toBe('alpha - CC · 🟢 working');
  });

  it('shows the Codex runtime, auto setting, and tag', () => {
    const state = sessionState({ auto: true, activity: 'idle', tag: 'needs review' });
    expect(formatSessionLine('alpha', 'codex', state, false)).toBe('alpha - codex · 🟡 idle - auto 🔄 · needs review');
  });

  it('shows pause after auto without changing the setting', () => {
    const state = sessionState({
      auto: true,
      paused: true,
      tag: 'nightly',
    });
    expect(formatSessionLine('alpha', 'claude-code', state, false)).toBe(
      'alpha - CC · 🟢 working - auto 🔄 (paused) · nightly',
    );
  });

  it('advertises an in-flight recovery and who is already doing it', () => {
    // Two supervisors recovering one seat is normal; discovering it by
    // colliding is not. The marker is what a second caller reads first.
    expect(
      formatSessionLine('alpha', 'claude-code', sessionState({ activity: 'idle' }), false, false, {
        kind: 'restart',
        initiator: 'agent-stubbs',
        since: '2026-07-29T08:02:40.000Z',
      }),
    ).toBe('alpha - CC · 🟡 idle · ⏳ restart in progress since 2026-07-29T08:02:40.000Z (agent-stubbs)');
  });

  it('marks the PR Shepherd recipient and composes it with the sentinel marker', () => {
    expect(formatSessionLine('alpha', 'claude-code', sessionState(), false, true)).toBe('alpha - CC 🐑 · 🟢 working');
    expect(formatSessionLine('alpha', 'codex', sessionState(), true, true)).toBe('alpha - codex 🛡 🐑 · 🟢 working');
  });
});

describe('formatFleetStatusReport', () => {
  it('omits PR Shepherd entirely when it is not online', () => {
    expect(
      formatFleetStatusReport('Sessions:\n  alpha - CC · 🟢 working', {
        fleetWatch: fleetWatch(),
        shepherdOnline: false,
      }),
    ).toBe('Agent Conductor Status\n\nSessions:\n  alpha - CC · 🟢 working');
  });

  it('places the simple online line immediately under the fleet heading', () => {
    expect(
      formatFleetStatusReport('Sessions:\n  alpha - CC 🐑 · 🟢 working', {
        fleetWatch: fleetWatch({
          enabled: true,
          state: 'armed',
          members: ['alpha', 'beta'],
          runningMembers: ['alpha', 'beta'],
          covers: ['fleet-stall'],
        }),
        shepherdOnline: true,
      }),
    ).toBe(
      'Agent Conductor Status 🔄\nFleet watch armed for fleet-stall — measuring 2 standing session(s), 2 running.\nPR Shepherd Status Online\n\nSessions:\n  alpha - CC 🐑 · 🟢 working',
    );
  });

  it('surfaces a degraded event journal without exposing its error text', () => {
    expect(
      formatFleetStatusReport('Sessions:\n  alpha - CC · 🟢 working', {
        fleetWatch: fleetWatch(),
        shepherdOnline: false,
        eventJournal: { enabled: true, degraded: true, failureCount: 2, lastError: 'secret disk path' },
      }),
    ).toContain(
      'Event journal DEGRADED — exported history is incomplete (2 failure(s) this run). Run conductor doctor.',
    );
  });

  it('renders configured integration health after the roster and omits it otherwise', () => {
    const status = formatFleetStatusReport('No sessions configured.', {
      fleetWatch: fleetWatch(),
      shepherdOnline: false,
      integrations: [
        {
          name: 'water-cooler',
          sender: 'integration:water-cooler',
          state: 'degraded',
          updatedAt: '2026-01-01T00:00:00.000Z',
          detail: 'remote fetch unavailable',
        },
      ],
    });
    expect(status).toBe(
      'Agent Conductor Status\n\nNo sessions configured.\n\nIntegrations:\n  water-cooler · 🟡 degraded · remote fetch unavailable',
    );
    expect(
      formatFleetStatusReport('No sessions configured.', {
        fleetWatch: fleetWatch(),
        shepherdOnline: false,
        integrations: [],
      }),
    ).not.toContain('Integrations:');
  });
});

describe('fleet watch coverage', () => {
  it('never badges an enabled-but-unfirable watch as armed', () => {
    // An instrument that reports itself armed while structurally incapable of
    // firing is worse than one switched off: its silence reads as an all-clear.
    const report = formatFleetStatusReport('Sessions:\n  alpha - CC · 🟡 idle', {
      fleetWatch: fleetWatch({
        enabled: true,
        state: 'suppressed',
        reason: 'quorum unmet — 1 of 3 standing session(s) running, 2 needed',
        members: ['alpha', 'beta', 'gamma'],
        runningMembers: ['alpha'],
      }),
      shepherdOnline: false,
    });
    expect(report).not.toContain('Agent Conductor Status 🔄');
    expect(report).toContain('Fleet watch on but SUPPRESSED — cannot fire: quorum unmet');
    expect(report).toContain('There is no fleet-level backstop right now.');
  });

  it('says inert when there is no standing roster to measure', () => {
    expect(
      formatFleetWatchStatus(
        fleetWatch({ enabled: true, state: 'inert', reason: 'no standing sessions are registered' }),
      ),
    ).toBe(
      'Fleet watch on but INERT — cannot fire: no standing sessions are registered (0 standing session(s), 0 running). There is no fleet-level backstop right now.',
    );
  });
});

describe('resolvedSessionModel', () => {
  const session = {
    codename: 'alpha',
    repo: '/tmp/alpha',
    runtime: 'claude-code',
    model: 'claude-private',
  } as const;

  it('uses the session model for its configured runtime', () => {
    expect(resolvedSessionModel(session, 'claude-code', { 'claude-code': 'claude-default' })).toBe('claude-private');
  });

  it('uses the selected runtime default for a cross-runtime override', () => {
    expect(resolvedSessionModel(session, 'codex', { codex: 'third-party/codex-model' })).toBe(
      'third-party/codex-model',
    );
  });

  it('leaves model selection to the runtime when no override is configured', () => {
    expect(resolvedSessionModel(session, 'codex', {})).toBeUndefined();
  });
});

describe('resolvedSessionEffort', () => {
  const session = {
    codename: 'alpha',
    repo: '/tmp/alpha',
    runtime: 'claude-code',
    effort: 'max',
  } as const;

  it('uses the session effort for its configured runtime', () => {
    expect(resolvedSessionEffort(session, 'claude-code', { 'claude-code': 'high' })).toBe('max');
  });

  it('does not carry a configured effort across runtime families', () => {
    expect(resolvedSessionEffort(session, 'codex', { codex: 'xhigh' })).toBe('xhigh');
  });

  it('leaves effort selection to the runtime when no override is configured', () => {
    expect(resolvedSessionEffort(session, 'codex', {})).toBeUndefined();
  });
});
