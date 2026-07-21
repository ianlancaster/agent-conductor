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

  it('does not style ordinary command replies', () => {
    expect(formatTerminalReply('/status', 'Sessions:\n  alpha · 🟢 working', true)).toBe(
      'Sessions:\n  alpha · 🟢 working',
    );
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
