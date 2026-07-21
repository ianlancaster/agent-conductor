import { describe, expect, it } from 'vitest';
import { formatSessionLine, resolvedSessionModel } from '../src/core/status.js';
import type { SessionState } from '../src/core/types.js';

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

describe('formatSessionLine', () => {
  it('shows the Claude Code runtime and no mode text when auto is off', () => {
    expect(formatSessionLine('alpha', 'claude-code', sessionState(), false)).toBe('alpha - CC · 🟢 working');
  });

  it('shows the Codex runtime, auto setting, and tag', () => {
    const state = sessionState({ auto: true, activity: 'stalled', tag: 'needs review' });
    expect(formatSessionLine('alpha', 'codex', state, false)).toBe('alpha - codex · 🟠 stalled - auto · needs review');
  });

  it('shows pause after auto without changing the setting', () => {
    const state = sessionState({
      auto: true,
      paused: true,
      tag: 'nightly',
    });
    expect(formatSessionLine('alpha', 'claude-code', state, false)).toBe(
      'alpha - CC · 🟢 working - auto (paused) · nightly',
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
