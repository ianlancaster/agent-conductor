import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  displayPath,
  formatFleetStatusReport,
  formatFleetWatchStatus,
  formatModelDrift,
  formatOperatorReach,
  formatSessionLine,
  launchTimeFieldEdits,
  resolvedSessionEffort,
  resolvedSessionModel,
  statusReport,
} from '../src/core/status.js';
import type { SessionConfig } from '../src/config/schema.js';
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

describe('launchTimeFieldEdits', () => {
  function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
    return {
      codename: 'alpha',
      repo: '/tmp/alpha',
      runtime: 'claude-code',
      additionalDirs: [],
      ephemeral: false,
      schedules: [],
      ...overrides,
    };
  }

  it('names each launch-time field that moved, with both values', () => {
    expect(launchTimeFieldEdits(config({ model: 'claude-opus-5' }), config({ model: 'opus[1m]' }))).toEqual([
      'model: claude-opus-5 → opus[1m]',
    ]);
    expect(launchTimeFieldEdits(config(), config({ model: 'opus[1m]', bypassPermissions: true }))).toEqual([
      'model: (unset) → opus[1m]',
      'bypassPermissions: (unset) → true',
    ]);
  });

  it('stays silent for fields that are genuinely read live', () => {
    // `auto` and `tag` take effect without a relaunch, so warning about them
    // would teach operators to ignore the warning that matters.
    expect(launchTimeFieldEdits(config({ auto: false }), config({ auto: true }))).toEqual([]);
    expect(launchTimeFieldEdits(config({ model: 'opus[1m]' }), config({ model: 'opus[1m]' }))).toEqual([]);
  });
});

describe('formatModelDrift', () => {
  it('names both values, when the process started, and the only remedy', () => {
    expect(
      formatModelDrift({ declared: 'opus[1m]', launched: 'claude-opus-5', launchedAt: '2026-07-29T07:48:13.577Z' }),
    ).toBe('opus[1m] declared, claude-opus-5 running since 2026-07-29T07:48:13.577Z — restart to apply');
  });

  it('reports an unrecorded launch as unknown rather than as agreement', () => {
    // A process adopted from before launch recording existed. Reporting the
    // declaration here is the substitution that hid a seat running the wrong
    // model for twenty hours.
    expect(formatModelDrift({ declared: 'opus[1m]', launched: undefined })).toBe(
      'opus[1m] declared, the running process predates launch recording, so what it is running is unknown — restart to apply',
    );
  });

  it('is silent when there is nothing to report', () => {
    expect(formatModelDrift(undefined)).toBeNull();
  });
});

describe('hook launch status', () => {
  const configuredSession: SessionConfig = {
    codename: 'alpha',
    repo: '/tmp/alpha',
    runtime: 'claude-code',
    additionalDirs: [],
    ephemeral: false,
    schedules: [],
  };

  function hookStatus(state: SessionState, drift: boolean | null, declared = true): Record<string, unknown> {
    return JSON.parse(
      statusReport(
        {
          sessions: () => new Map([['alpha', configuredSession]]),
          getState: () => state,
          runtimeFor: () => 'claude-code',
          modelFor: () => undefined,
          effortFor: () => undefined,
          hooksDeclaredFor: () => declared,
          hooksRenderingDriftFor: () => drift,
          sentinelCodename: () => undefined,
          processObservation: () => undefined,
        },
        'alpha',
      ),
    ) as Record<string, unknown>;
  }

  it('keeps declaration, launch rendering, and observed registration separate', () => {
    const digest = 'e'.repeat(64);
    const status = hookStatus(sessionState({ hooksRenderedDigest: digest }), false);
    expect(status).toMatchObject({
      hooksDeclared: true,
      hooksRenderedDigest: digest,
      hooksRenderingDrift: false,
      hooksRegistrationObserved: 'UNKNOWN',
    });
  });

  it('keeps adoption UNKNOWN and never derives a rendered digest from current config', () => {
    const status = hookStatus(sessionState({ launchedAt: undefined, hooksRenderedDigest: undefined }), null);
    expect(status).toMatchObject({
      hooksDeclared: true,
      hooksRenderedDigest: null,
      hooksRenderingDrift: null,
      hooksRegistrationObserved: 'UNKNOWN',
    });
  });
});

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
  });

  it('badges a running session whose model is not the one its config declares', () => {
    // Visible in the fleet list, not only in per-session detail: a wrong pin in
    // a fleet of pods is not something anyone thinks to go and ask about.
    expect(
      formatSessionLine('alpha', 'claude-code', sessionState(), false, false, undefined, {
        declared: 'opus[1m]',
        launched: 'claude-opus-5',
      }),
    ).toBe('alpha - CC · 🟢 working · ⚠ running claude-opus-5');
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

describe('operator reachability', () => {
  it('says nothing when the operator is actually reachable', () => {
    // Silence is only safe here because the state is good; the report stays terse
    // in the normal case and speaks up in the failing one.
    const report = formatFleetStatusReport('Sessions:\n  alpha - CC · 🟡 idle', {
      fleetWatch: fleetWatch(),
      shepherdOnline: false,
      operatorReach: { state: 'armed', channels: ['telegram'], consoles: 0, undelivered: 0 },
    });
    expect(report).not.toContain('Operator channel');
  });

  it('states that every alarm is ending in a log when no transport exists', () => {
    // The disease fleet watch had, in the mechanism built to report fleet watch:
    // a notification path that cannot reach anyone, reporting nothing.
    const report = formatFleetStatusReport('Sessions:\n  alpha - CC · 🟡 idle', {
      fleetWatch: fleetWatch({ enabled: true, state: 'armed', members: ['alpha', 'beta'], runningMembers: ['alpha'] }),
      shepherdOnline: false,
      operatorReach: {
        state: 'inert',
        reason: 'no operator channel is enabled and no console is attached',
        channels: [],
        consoles: 0,
        undelivered: 11,
        undeliveredSince: '2026-07-30T04:10:00.000Z',
      },
    });
    expect(report).toContain('Operator channel INERT');
    expect(report).toContain('11 notification(s) have reached nobody since 2026-07-30T04:10:00.000Z');
    expect(report).toContain('Every alarm this fleet raises is currently ending in a log file.');
  });

  it('separates a transport that is failing from one that is absent', () => {
    expect(
      formatOperatorReach({
        state: 'degraded',
        reason: 'every configured operator channel has failed to deliver this run',
        channels: ['slack'],
        consoles: 0,
        undelivered: 2,
      }),
    ).toContain('Operator channel DEGRADED');
    expect(formatOperatorReach({ state: 'armed', channels: ['slack'], consoles: 2, undelivered: 0 })).toBe(
      'Operator reachable via 2 console(s), slack.',
    );
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
