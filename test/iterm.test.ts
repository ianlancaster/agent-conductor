import { describe, expect, it } from 'vitest';
import {
  SESSION_USER_VAR,
  buildCloseSessionScript,
  buildCreateSessionWindowScript,
  buildCreateTabScript,
  buildCreateWindowScript,
  buildFocusWindowScript,
  buildFocusedSessionScript,
  buildInSessionScript,
  buildListSessionIdsScript,
  buildRediscoverScript,
  buildSplitPaneScript,
  buildWindowExistsScript,
  containsPromptMarker,
  decodeSessionVar,
  encodeSessionVar,
  escapeAppleScript,
  parseRediscoveryOutput,
  parseWindowCreateResult,
  sessionSetup,
  shellQuote,
  shouldUseBracketedPaste,
  tailLines,
  wrapBracketedPaste,
} from '../src/terminals/iterm/applescript.js';

const ESC = '\u001b';

describe('escapeAppleScript', () => {
  it('escapes double quotes', () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
  });

  it('escapes backslashes before quotes so the result is unambiguous', () => {
    expect(escapeAppleScript('a\\b')).toBe('a\\\\b');
    expect(escapeAppleScript('\\"')).toBe('\\\\\\"');
  });

  it('leaves plain text untouched', () => {
    expect(escapeAppleScript('midgard-7')).toBe('midgard-7');
    expect(escapeAppleScript('')).toBe('');
  });

  it('handles unicode and newlines without mangling', () => {
    expect(escapeAppleScript('session — “tag” ❯')).toBe('session — “tag” ❯');
    expect(escapeAppleScript('a\nb')).toBe('a\nb');
  });
});

describe('shellQuote', () => {
  it('wraps plain paths in single quotes', () => {
    expect(shellQuote('/tmp/repo')).toBe("'/tmp/repo'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });

  it('neutralizes shell metacharacters', () => {
    expect(shellQuote('$(rm -rf /) && echo "x"')).toBe(`'$(rm -rf /) && echo "x"'`);
  });
});

describe('shouldUseBracketedPaste', () => {
  it('is false for short single-line text', () => {
    expect(shouldUseBracketedPaste('hello', 512)).toBe(false);
  });

  it('is true for any multi-line text', () => {
    expect(shouldUseBracketedPaste('a\nb', 512)).toBe(true);
  });

  it('is true only strictly above the threshold', () => {
    expect(shouldUseBracketedPaste('x'.repeat(512), 512)).toBe(false);
    expect(shouldUseBracketedPaste('x'.repeat(513), 512)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(shouldUseBracketedPaste('x'.repeat(11), 10)).toBe(true);
    expect(shouldUseBracketedPaste('x'.repeat(10), 10)).toBe(false);
  });
});

describe('wrapBracketedPaste', () => {
  it('wraps text in ESC[200~ ... ESC[201~ markers', () => {
    expect(wrapBracketedPaste('line1\nline2')).toBe(`${ESC}[200~line1\nline2${ESC}[201~`);
  });

  it('wraps empty text', () => {
    expect(wrapBracketedPaste('')).toBe(`${ESC}[200~${ESC}[201~`);
  });
});

describe('containsPromptMarker', () => {
  it('detects each known prompt marker', () => {
    expect(containsPromptMarker('ian@mac ~/repo ==> ')).toBe(true);
    expect(containsPromptMarker('bash-5.2$ ')).toBe(true);
    expect(containsPromptMarker('mac% ')).toBe(true);
    expect(containsPromptMarker('❯')).toBe(true);
  });

  it('is false while the shell is still initializing', () => {
    expect(containsPromptMarker('Loading nvm...')).toBe(false);
    expect(containsPromptMarker('')).toBe(false);
  });

  it('ignores stale prompts in scrollback — only the LAST line counts', () => {
    // The launch-corruption bug: a prompt higher up satisfied the whole-capture
    // check while the shell was still executing, and the launch command was
    // typed into raw canonical-mode input (literal ^[[200~, 1024-byte cutoff).
    expect(containsPromptMarker('ian@mac ~ ==> cd /tmp/repo\nCloning into repo...')).toBe(false);
    expect(containsPromptMarker('~ ==> \nrunning launch command')).toBe(false);
    expect(containsPromptMarker('scrollback text\nian@mac repo ==> ')).toBe(true);
  });

  it('ignores trailing blank lines from the capture', () => {
    expect(containsPromptMarker('user@host %\n\n\n')).toBe(true);
  });

  it('does not mistake progress percentages for a zsh prompt', () => {
    expect(containsPromptMarker('receiving objects: 42%')).toBe(false);
  });
});

describe('tailLines', () => {
  it('returns the trailing N lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });

  it('returns everything when fewer lines exist than requested', () => {
    expect(tailLines('a\nb', 10)).toBe('a\nb');
  });

  it('ignores a single trailing newline', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
  });

  it('preserves interior blank lines', () => {
    expect(tailLines('a\n\nb', 3)).toBe('a\n\nb');
  });

  it('returns empty for non-positive line counts', () => {
    expect(tailLines('a\nb', 0)).toBe('');
    expect(tailLines('a\nb', -1)).toBe('');
  });
});

describe('session user-variable encoding', () => {
  it('round-trips a codename through base64, scoped by fleet id', () => {
    expect(encodeSessionVar('fleet-1', 'alpha')).toBe(Buffer.from('fleet-1:alpha').toString('base64'));
    expect(decodeSessionVar(encodeSessionVar('fleet-1', 'midgard-12'), 'fleet-1')).toBe('midgard-12');
  });

  it("rejects another fleet's marker", () => {
    expect(decodeSessionVar(encodeSessionVar('fleet-1', 'alpha'), 'fleet-2')).toBeNull();
  });

  it('rejects a legacy bare-codename marker (cc-conductor uses the same variable)', () => {
    expect(decodeSessionVar(Buffer.from('midgard-3').toString('base64'), 'fleet-1')).toBeNull();
  });

  it('returns null for an empty value', () => {
    expect(decodeSessionVar('', 'fleet-1')).toBeNull();
    expect(decodeSessionVar(Buffer.from('fleet-1:').toString('base64'), 'fleet-1')).toBeNull();
  });
});

describe('parseWindowCreateResult', () => {
  it('parses windowId|sessionId with surrounding whitespace', () => {
    expect(parseWindowCreateResult('3199|D2F97D9E-95C6-4C46-9E70-1D9D17E1DD5B\n')).toEqual({
      windowId: 3199,
      sessionId: 'D2F97D9E-95C6-4C46-9E70-1D9D17E1DD5B',
    });
  });

  it('rejects malformed output', () => {
    expect(parseWindowCreateResult('')).toBeNull();
    expect(parseWindowCreateResult('no-pipe-here')).toBeNull();
    expect(parseWindowCreateResult('abc|uuid')).toBeNull();
    expect(parseWindowCreateResult('42|')).toBeNull();
  });
});

describe('parseRediscoveryOutput', () => {
  it('maps decoded codenames to session ids', () => {
    const raw = [
      `SESSION-A|${encodeSessionVar('f1', 'alpha')}`,
      `SESSION-B|${encodeSessionVar('f1', 'beta')}`,
      '',
    ].join('\n');
    const result = parseRediscoveryOutput(raw, 'f1');
    expect(result.size).toBe(2);
    expect(result.get('alpha')).toBe('SESSION-A');
    expect(result.get('beta')).toBe('SESSION-B');
  });

  it("skips other fleets' panes — two conductors share one iTerm instance", () => {
    const raw = [
      `SESSION-A|${encodeSessionVar('f1', 'alpha')}`,
      `SESSION-B|${encodeSessionVar('f2', 'alpha')}`, // same codename, other fleet
      `SESSION-C|${Buffer.from('midgard-3').toString('base64')}`, // legacy cc-conductor marker
    ].join('\n');
    const result = parseRediscoveryOutput(raw, 'f1');
    expect(result.size).toBe(1);
    expect(result.get('alpha')).toBe('SESSION-A');
  });

  it('skips malformed and empty lines', () => {
    const raw = ['garbage-without-pipe', '|', 'SESSION-C|', `SESSION-D|${encodeSessionVar('f1', 'gamma')}`].join('\n');
    const result = parseRediscoveryOutput(raw, 'f1');
    expect(result.size).toBe(1);
    expect(result.get('gamma')).toBe('SESSION-D');
  });

  it('returns an empty map for empty input', () => {
    expect(parseRediscoveryOutput('', 'f1').size).toBe(0);
    expect(parseRediscoveryOutput('\n\n', 'f1').size).toBe(0);
  });
});

describe('script builders', () => {
  it('buildWindowExistsScript targets the window id', () => {
    expect(buildWindowExistsScript(42)).toContain('exists window id 42');
  });

  it('buildCreateWindowScript escapes the window name', () => {
    const script = buildCreateWindowScript('Session "Conductor"');
    expect(script).toContain('set name to "Session \\"Conductor\\""');
    expect(script).toContain('create window with default profile');
  });

  it('buildCreateSessionWindowScript sets name, badge, and the conductor_session user var', () => {
    const script = buildCreateSessionWindowScript('alpha', encodeSessionVar('f1', 'alpha'));
    expect(script).toContain('set name to "alpha"');
    // Badge is the durable label: iTerm job detection overwrites the NAME with
    // the running process ("node"), but nothing overwrites the badge.
    expect(script).toContain('set badge to "alpha"');
    expect(script).toContain(`set variable named "${SESSION_USER_VAR}" to "${encodeSessionVar('f1', 'alpha')}"`);
  });

  it('sessionSetup escapes quotes in the display name across name, badge, and var', () => {
    const ops = sessionSetup('x "y"', 'QUJD');
    expect(ops).toContain('set name to "x \\"y\\""');
    expect(ops).toContain('set badge to "x \\"y\\""');
    expect(ops).toContain(`set variable named "${SESSION_USER_VAR}" to "QUJD"`);
  });

  it('buildCreateTabScript targets the conductor window and sets the user var', () => {
    const script = buildCreateTabScript(7, 'beta', encodeSessionVar('f1', 'beta'));
    expect(script).toContain('tell window id 7');
    expect(script).toContain('create tab with default profile');
    expect(script).toContain(`set variable named "${SESSION_USER_VAR}"`);
  });

  it('buildSplitPaneScript splits the first tab vertically', () => {
    const script = buildSplitPaneScript(7, 'gamma', encodeSessionVar('f1', 'gamma'));
    expect(script).toContain('tell window id 7');
    expect(script).toContain('current session of first tab');
    expect(script).toContain('split vertically with default profile');
  });

  it('buildInSessionScript embeds operations and the return expression', () => {
    const script = buildInSessionScript('SESSION-X', 'set name to "n"', '(contents as string)');
    expect(script).toContain('if (id of s) is "SESSION-X" then');
    expect(script).toContain('set name to "n"');
    expect(script).toContain('return (contents as string)');
  });

  it('buildInSessionScript defaults to returning "OK" and escapes the session id', () => {
    const script = buildInSessionScript('bad"id', '');
    expect(script).toContain('if (id of s) is "bad\\"id" then');
    expect(script).toContain('return "OK"');
  });

  it('buildInSessionScript searches all windows, not just the conductor window', () => {
    const script = buildInSessionScript('SESSION-X', '');
    expect(script).toContain('repeat with w in windows');
  });

  it('buildCloseSessionScript escapes the session id and searches all windows', () => {
    const script = buildCloseSessionScript('evil" -- injection');
    expect(script).toContain('"evil\\" -- injection"');
    expect(script).toContain('repeat with w in windows');
    expect(script).toContain('close s');
  });

  it('buildRediscoverScript reads the conductor_session user variable everywhere', () => {
    const script = buildRediscoverScript();
    expect(script).toContain(`variable named "${SESSION_USER_VAR}"`);
    expect(script).toContain('repeat with w in windows');
  });

  it('buildListSessionIdsScript emits one id per line', () => {
    const script = buildListSessionIdsScript();
    expect(script).toContain('(id of s) & linefeed');
  });

  it('focus scripts target the conductor window', () => {
    expect(buildFocusWindowScript(9)).toContain('select window id 9');
    expect(buildFocusedSessionScript(9)).toContain('tell window id 9');
    expect(buildFocusedSessionScript(9)).toContain('id of current session of current tab');
  });
});
