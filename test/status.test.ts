import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayPath, formatSessionLine, resolvedSessionEffort, resolvedSessionModel } from '../src/core/status.js';
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
