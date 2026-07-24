import { describe, expect, it } from 'vitest';
import { formatFeedPayload, formatTerminalReply } from '../src/cli/terminal-format.js';

describe('formatTerminalReply', () => {
  const help = [
    'Sessions:',
    '  /status [session] — Show status.',
    '',
    'Lifecycle:',
    '  /spawn <name> [flags] — Spawn a session.',
    '    -r/--runtime claude-code|codex · -d/--path <dir>',
  ].join('\n');

  it('colors help commands green while leaving headers and descriptions plain', () => {
    expect(formatTerminalReply('/help', help, true)).toBe(
      [
        'Sessions:',
        '  \u001b[32m/status [session]\u001b[39m — Show status.',
        '',
        'Lifecycle:',
        '  \u001b[32m/spawn <name> [flags]\u001b[39m — Spawn a session.',
        '    \u001b[32m-r/--runtime claude-code|codex · -d/--path <dir>\u001b[39m',
      ].join('\n'),
    );
  });

  it('keeps help plain when stdout is not a terminal', () => {
    expect(formatTerminalReply('/help', help, false)).toBe(help);
  });

  it('bolds session names in fleet status only for terminals', () => {
    const status = 'Sessions:\n  alpha - CC · 🟢 working\n    path: ~/Projects/alpha · branch: main';
    expect(formatTerminalReply('/status', status, true)).toBe(
      'Sessions:\n  \u001b[1malpha\u001b[22m - CC · 🟢 working\n    path: ~/Projects/alpha · branch: main',
    );
    expect(formatTerminalReply('/status', status, false)).toBe(status);
  });

  it('uses the same bold styling for the Conductor and online Shepherd headings', () => {
    const status = 'Agent Conductor Status\nPR Shepherd Status Online\n\nSessions:\n  alpha - CC 🐑 · 🟢 working';
    expect(formatTerminalReply('/status', status, true)).toBe(
      '\u001b[1mAgent Conductor Status\u001b[22m\n' +
        '\u001b[1mPR Shepherd Status Online\u001b[22m\n\n' +
        'Sessions:\n  \u001b[1malpha\u001b[22m - CC 🐑 · 🟢 working',
    );
  });

  it('bolds the codename value in detailed terminal status', () => {
    const status = '{\n  "codename": "alpha",\n  "path": "~/Projects/alpha"\n}';
    expect(formatTerminalReply('/status alpha', status, true)).toBe(
      '{\n  "codename": \u001b[1m"alpha"\u001b[22m,\n  "path": "~/Projects/alpha"\n}',
    );
  });

  it('does not style other ordinary command replies', () => {
    expect(formatTerminalReply('/start alpha', 'alpha started.', true)).toBe('alpha started.');
  });
});

describe('formatFeedPayload', () => {
  it('accepts legacy string frames during the semantic-message transition', () => {
    expect(formatFeedPayload('[Message from alpha] hello')).toBe('[Message from alpha] hello');
  });

  it('renders semantic actions for the text-only console', () => {
    expect(
      formatFeedPayload({
        text: '[Message from alpha] Choose',
        actions: [{ label: 'One', command: '/respond 1 1' }],
      }),
    ).toContain('1. One — /respond 1 1');
  });

  it('ignores malformed feed frames', () => {
    expect(formatFeedPayload({ actions: [] })).toBeUndefined();
  });
});
