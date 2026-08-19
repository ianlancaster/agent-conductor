import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CLEAR_INPUT_LINE_OPERATIONS,
  SESSION_USER_VAR,
  SESSION_NOT_FOUND_RESULT,
  awaitLaunchReadiness,
  bracketedPastePayload,
  buildCloseSessionScript,
  buildCreateSessionWindowScript,
  buildFindTtyWindowScript,
  buildNameTtySessionScript,
  buildRevealSessionScript,
  buildCreateTabScript,
  buildCreateWindowScript,
  buildInSessionScript,
  buildUnchangedContentsGuard,
  buildListSessionIdsScript,
  buildRediscoverScript,
  buildSessionTtyScript,
  buildSplitPaneScript,
  buildTitleShellPrefix,
  buildWindowExistsScript,
  confirmLiveness,
  containsPromptMarker,
  decodeSessionVar,
  encodeSessionVar,
  escapeAppleScript,
  interpretLivenessResult,
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
    expect(escapeAppleScript('project-7')).toBe('project-7');
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

describe('bracketedPastePayload', () => {
  it('adds exactly one inert trailing newline inside the paste markers', () => {
    expect(bracketedPastePayload('hello')).toBe(`${ESC}[200~hello\n${ESC}[201~`);
    expect(bracketedPastePayload('hello\n')).toBe(`${ESC}[200~hello\n${ESC}[201~`);
  });
});

describe('buildUnchangedContentsGuard', () => {
  it('reads captured pane snapshots explicitly as UTF-8', () => {
    const script = buildUnchangedContentsGuard('/tmp/pane snapshot', 'CHANGED');
    expect(script).toContain('read POSIX file "/tmp/pane snapshot" as «class utf8»');
    expect(script).toContain('return "CHANGED"');
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

  it('cannot recognize a prompt a stray keystroke has typed into', () => {
    // Not a defect in the marker — a prompt with characters after it is
    // genuinely not ready. It is why awaitLaunchReadiness needs the tty.
    expect(containsPromptMarker('ian@mac ~/repo ❯ he')).toBe(false);
    expect(containsPromptMarker('bash-5.2$ hel')).toBe(false);
  });
});

describe('CLEAR_INPUT_LINE_OPERATIONS', () => {
  it('sends ^E then ^U as edits, never as a submitted line', () => {
    // ^E first so bash's backwards-only unix-line-discard still clears the
    // whole line; `newline false` so nothing is executed.
    expect(CLEAR_INPUT_LINE_OPERATIONS).toContain('ASCII character 5');
    expect(CLEAR_INPUT_LINE_OPERATIONS).toContain('ASCII character 21');
    expect(CLEAR_INPUT_LINE_OPERATIONS).toContain('newline false');
    expect(CLEAR_INPUT_LINE_OPERATIONS).not.toContain('ASCII character 13');
  });
});

describe('awaitLaunchReadiness', () => {
  const CLEAN_PROMPT = 'ian@mac ~/repo ❯ ';

  /**
   * Probe over a pane that keeps showing `line` until the input line is
   * cleared. `clearReveals` says whether clearing exposes a prompt the marker
   * can read — true for a contaminated prompt, false for one it never could.
   */
  function harness(options: { line: string; shellIdle: boolean; polls: number; clearReveals?: boolean }) {
    let visible = options.line;
    let remaining = options.polls;
    const calls = { contents: 0, shellIdle: 0, clears: 0, pauses: 0 };
    const probe = {
      contents: async () => {
        calls.contents += 1;
        return visible;
      },
      shellIdle: async () => {
        calls.shellIdle += 1;
        return options.shellIdle;
      },
      clearInputLine: async () => {
        calls.clears += 1;
        // Stands in for the shell redrawing its prompt after ^E^U.
        if (options.clearReveals !== false) visible = CLEAN_PROMPT;
      },
      expired: () => {
        remaining -= 1;
        return remaining <= 0;
      },
      pause: async () => {
        calls.pauses += 1;
      },
    };
    return { probe, calls };
  }

  it('returns on the first clean prompt without touching the tty', async () => {
    const { probe, calls } = harness({ line: CLEAN_PROMPT, shellIdle: true, polls: 8 });
    await expect(awaitLaunchReadiness(probe)).resolves.toBe(true);
    // The happy path must not pay for the tty lookup or a needless clear.
    expect(calls).toMatchObject({ contents: 1, shellIdle: 0, clears: 0, pauses: 0 });
  });

  it('clears a contaminated prompt and launches instead of waiting out the timeout', async () => {
    // The reported bug: a keystroke landed during pane creation, so the marker
    // never matched and the launch command spliced onto the operator's text.
    const { probe, calls } = harness({ line: 'ian@mac ~/repo ❯ he', shellIdle: true, polls: 32 });
    await expect(awaitLaunchReadiness(probe)).resolves.toBe(true);
    expect(calls.clears).toBe(1);
    // Recovered on the very next poll rather than at the 8s deadline.
    expect(calls.pauses).toBe(1);
  });

  it('never sends control characters into a pane running a foreground job', async () => {
    const { probe, calls } = harness({ line: 'building...', shellIdle: false, polls: 4 });
    await expect(awaitLaunchReadiness(probe)).resolves.toBe(false);
    expect(calls.clears).toBe(0);
    expect(calls.contents).toBe(4);
  });

  it('clears at most once when the prompt stays unrecognizable', async () => {
    // An exotic PS1 the marker cannot parse must degrade to the old
    // submit-anyway timeout, not to an osascript per poll.
    const { probe, calls } = harness({ line: 'ian@mac ~/repo »', shellIdle: true, polls: 6, clearReveals: false });
    await expect(awaitLaunchReadiness(probe)).resolves.toBe(false);
    expect(calls.clears).toBe(1);
  });

  it('does not clear a pane it could not observe', async () => {
    let clears = 0;
    await expect(
      awaitLaunchReadiness({
        contents: async () => 'still booting',
        // What the backend reports when the tty or `ps` cannot be read.
        shellIdle: async () => false,
        clearInputLine: async () => {
          clears += 1;
        },
        expired: () => true,
        pause: async () => undefined,
      }),
    ).resolves.toBe(false);
    expect(clears).toBe(0);
  });

  it('propagates an unobservable pane instead of reporting it ready', async () => {
    await expect(
      awaitLaunchReadiness({
        contents: async () => {
          throw new Error('iTerm unavailable');
        },
        shellIdle: async () => true,
        clearInputLine: async () => undefined,
        expired: () => false,
        pause: async () => undefined,
      }),
    ).rejects.toThrow('iTerm unavailable');
  });
});

describe('tailLines', () => {
  it('returns the trailing N lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });

  it('returns everything when fewer lines exist than requested', () => {
    expect(tailLines('a\nb', 10)).toBe('a\nb');
  });

  it('ignores trailing empty viewport rows before taking the tail', () => {
    expect(tailLines('boot banner\n› Codex composer\n\n   \n\n', 2)).toBe('boot banner\n› Codex composer');
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
    expect(decodeSessionVar(encodeSessionVar('fleet-1', 'project-12'), 'fleet-1')).toBe('project-12');
  });

  it("rejects another fleet's marker", () => {
    expect(decodeSessionVar(encodeSessionVar('fleet-1', 'alpha'), 'fleet-2')).toBeNull();
  });

  it('rejects a legacy bare-codename marker (cc-conductor uses the same variable)', () => {
    expect(decodeSessionVar(Buffer.from('project-3').toString('base64'), 'fleet-1')).toBeNull();
  });

  it('returns null for an empty value', () => {
    expect(decodeSessionVar('', 'fleet-1')).toBeNull();
    expect(decodeSessionVar(Buffer.from('fleet-1:').toString('base64'), 'fleet-1')).toBeNull();
  });
});

describe('buildTitleShellPrefix', () => {
  it('emits an OSC 0 title printf (badge off)', () => {
    const prefix = buildTitleShellPrefix('tester', false);
    expect(prefix).toBe(`printf '\\033]0;%s\\a' 'tester'`);
  });

  it('adds the base64 badge printf when the badge is enabled', () => {
    const prefix = buildTitleShellPrefix('tester — self-test', true, 'tester');
    expect(prefix).toContain(`printf '\\033]0;%s\\a' 'tester — self-test'`);
    expect(prefix).toContain(`printf '\\033]1337;SetBadgeFormat=%s\\a' '${Buffer.from('tester').toString('base64')}'`);
    expect(prefix).not.toContain(Buffer.from('tester — self-test').toString('base64'));
  });

  it('escapes single quotes in the display name', () => {
    expect(buildTitleShellPrefix("it's", false)).toBe(`printf '\\033]0;%s\\a' 'it'\\''s'`);
  });

  it('treats percentages in the display name as literal data', () => {
    const prefix = buildTitleShellPrefix('reviewing (61%, clean boundary)', false);
    expect(prefix).toBe(`printf '\\033]0;%s\\a' 'reviewing (61%, clean boundary)'`);
    expect(() => execFileSync('/bin/sh', ['-c', prefix], { stdio: 'pipe' })).not.toThrow();
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
      `SESSION-C|${Buffer.from('project-3').toString('base64')}`, // legacy cc-conductor marker
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

describe('interpretLivenessResult', () => {
  it('answers only when the scan actually answered', () => {
    expect(interpretLivenessResult('S', 'ALIVE\n')).toBe(true);
    expect(interpretLivenessResult('S', `${SESSION_NOT_FOUND_RESULT}\n`)).toBe(false);
  });

  it('refuses to report an unobservable terminal as an absent pane', () => {
    // This is the whole defect: osascript timing out, iTerm erroring, or output
    // arriving truncated used to read as "the pane is gone", which marks a live
    // session stopped and drops its pane mapping — and reconcile only visits
    // mapped panes, so nothing ever revisits the seat. Throwing instead lets
    // lifecycle record an unknown and try again on the next tick.
    for (const inconclusive of ['', '   ', 'ALIV', 'execution error: iTerm got an error (-1728)']) {
      expect(() => interpretLivenessResult('S', inconclusive)).toThrow(/unrecognized liveness result/);
    }
  });
});

describe('confirmLiveness', () => {
  it('keeps a live pane when a transiently skipped iTerm element appears missing once', async () => {
    const results = [`${SESSION_NOT_FOUND_RESULT}\n`, 'ALIVE\n'];
    let pauses = 0;

    await expect(
      confirmLiveness(
        'S',
        async () => results.shift() ?? '',
        async () => {
          pauses += 1;
        },
      ),
    ).resolves.toBe(true);
    expect(pauses).toBe(1);
    expect(results).toEqual([]);
  });

  it('reports a truly closed pane only after two independent missing scans', async () => {
    let probes = 0;
    await expect(
      confirmLiveness(
        'S',
        async () => {
          probes += 1;
          return SESSION_NOT_FOUND_RESULT;
        },
        async () => undefined,
      ),
    ).resolves.toBe(false);
    expect(probes).toBe(2);
  });

  it('does not delay an alive result or convert an observation error into absence', async () => {
    let pauses = 0;
    await expect(
      confirmLiveness(
        'S',
        async () => 'ALIVE',
        async () => {
          pauses += 1;
        },
      ),
    ).resolves.toBe(true);
    expect(pauses).toBe(0);

    await expect(
      confirmLiveness(
        'S',
        async () => {
          throw new Error('iTerm unavailable');
        },
        async () => undefined,
      ),
    ).rejects.toThrow('iTerm unavailable');
  });
});

describe('enumeration tolerates panes that vanish mid-scan', () => {
  // Every scan walks ALL of iTerm — one process cannot enumerate only its own
  // panes. So a pane closing anywhere, including in another fleet's window,
  // lands mid-scan. Untolerated it aborts the whole enumeration, and that
  // failure is indistinguishable from "your session is gone": one fleet
  // spawning tabs marked another fleet's live, working sessions stopped.
  const scans: [string, string][] = [
    ['buildInSessionScript', buildInSessionScript('uuid', '')],
    ['buildSessionTtyScript', buildSessionTtyScript('uuid')],
    ['buildRevealSessionScript', buildRevealSessionScript('uuid')],
    ['buildCloseSessionScript', buildCloseSessionScript('uuid')],
    ['buildListSessionIdsScript', buildListSessionIdsScript()],
    ['buildRediscoverScript', buildRediscoverScript()],
    ['buildNameTtySessionScript', buildNameTtySessionScript('/dev/ttys001', 'name')],
    ['buildFindTtyWindowScript', buildFindTtyWindowScript('/dev/ttys001')],
  ];

  it.each(scans)('%s guards every window, tab and session level', (_name, script) => {
    // Windows and tabs disappear too — a closed window makes `tabs of w` raise
    // the same error as a closed pane makes `id of s` raise.
    const guards = script.match(/\{-1719, -1728\} contains errorNumber/g) ?? [];
    expect(guards).toHaveLength(3);
    expect(script).toContain('set sessionList to every session of t');
  });

  it.skipIf(process.platform !== 'darwin')('skips vanished elements and keeps scanning', () => {
    // The guard's semantics, verified against the real AppleScript interpreter
    // rather than asserted from the generated text.
    const out = execFileSync(
      'osascript',
      [
        '-e',
        `set out to ""
         set n to 0
         repeat with i in {1, 2, 3, 4}
           set n to n + 1
           try
             if n is 2 then error "gone" number -1728
             if n is 3 then error "lazy" number -1719
             set out to out & n
           on error errorMessage number errorNumber
             if not ({-1719, -1728} contains errorNumber) then error errorMessage number errorNumber
           end try
         end repeat
         return out`,
      ],
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe('14');
  });

  it.skipIf(process.platform !== 'darwin')('still propagates errors that are not a vanished element', () => {
    expect(() =>
      execFileSync(
        'osascript',
        [
          '-e',
          `try
             error "genuine failure" number -1700
           on error errorMessage number errorNumber
             if not ({-1719, -1728} contains errorNumber) then error errorMessage number errorNumber
           end try
           return "swallowed"`,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrow();
  });
});

describe('script builders', () => {
  it('buildWindowExistsScript targets the window id', () => {
    expect(buildWindowExistsScript(42)).toContain('exists window id 42');
  });

  it('reports a missing session instead of returning an ambiguous empty success', () => {
    expect(buildInSessionScript('missing', 'write text "x"')).toContain(`return "${SESSION_NOT_FOUND_RESULT}"`);
  });

  it('buildCreateWindowScript escapes the window name', () => {
    const script = buildCreateWindowScript('Session "Conductor"');
    expect(script).toContain('set name to "Session \\"Conductor\\""');
    expect(script).toContain('create window with default profile');
  });

  it('buildCreateSessionWindowScript sets name and the conductor_session user var', () => {
    const script = buildCreateSessionWindowScript('alpha', encodeSessionVar('f1', 'alpha'));
    expect(script).toContain('set name to "alpha"');
    // No badge at creation: rename() applies the configured badge once the runtime is up.
    expect(script).not.toContain('set badge');
    expect(script).toContain(`set variable named "${SESSION_USER_VAR}" to "${encodeSessionVar('f1', 'alpha')}"`);
  });

  it('sessionSetup escapes quotes in the display name across name and var', () => {
    const ops = sessionSetup('x "y"', 'QUJD');
    expect(ops).toContain('set name to "x \\"y\\""');
    expect(ops).not.toContain('set badge');
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

  it('leaves creation selecting the new pane by default', () => {
    // The historical behavior, kept as the default so upgrading changes nothing.
    for (const script of [
      buildCreateSessionWindowScript('alpha', encodeSessionVar('f1', 'alpha')),
      buildCreateTabScript(7, 'beta', encodeSessionVar('f1', 'beta')),
      buildSplitPaneScript(7, 'gamma', encodeSessionVar('f1', 'gamma')),
    ]) {
      expect(script).not.toContain('priorWindow');
      expect(script).not.toContain('select priorSession');
    }
    expect(buildCreateWindowScript('W')).toContain('activate');
  });

  it('restores the operator selection after every creation verb when focus is preserved', () => {
    // iTerm has no create-without-selecting verb: window, tab and split all
    // select what they make. Restoring afterwards is the only way not to pull
    // the cursor out of whatever the operator was typing in.
    for (const script of [
      buildCreateSessionWindowScript('alpha', encodeSessionVar('f1', 'alpha'), true),
      buildCreateTabScript(7, 'beta', encodeSessionVar('f1', 'beta'), true),
      buildSplitPaneScript(7, 'gamma', encodeSessionVar('f1', 'gamma'), true),
    ]) {
      // All three, outermost first. Selecting the session alone does not bring
      // its window back — measured against live iTerm, a session-only restore
      // left the newly created pane's window current.
      expect(script).toContain('set priorWindow to current window');
      expect(script).toContain('set priorTab to current tab of priorWindow');
      expect(script).toContain('set priorSession to current session of priorTab');
      const created = script.indexOf('with default profile');
      for (const target of ['priorWindow', 'priorTab', 'priorSession']) {
        expect(script).toContain(`select ${target}`);
        // Remembering must precede creating, or it captures the new pane instead.
        expect(script.indexOf(`set ${target} to`)).toBeLessThan(created);
        expect(script.lastIndexOf(`select ${target}`)).toBeGreaterThan(created);
      }
      expect(script.indexOf('select priorWindow')).toBeLessThan(script.indexOf('select priorTab'));
      expect(script.indexOf('select priorTab')).toBeLessThan(script.indexOf('select priorSession'));
    }
  });

  it('does not fail a created pane because the remembered one has gone', () => {
    // Opening the first pane of a fleet has no previous selection to restore,
    // and the operator may close a pane mid-creation. Neither may throw away a
    // session that was created successfully.
    const script = buildCreateTabScript(7, 'beta', encodeSessionVar('f1', 'beta'), true);
    expect(script).toContain('set priorWindow to missing value');
    expect(script).toContain('if priorWindow is not missing value then');
    expect(script).toContain('if priorSession is not missing value then');
    expect(script.match(/try/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it('does not activate iTerm when creating the workspace window with focus preserved', () => {
    // `activate` raises the whole application, which no amount of in-iTerm
    // restoration can undo.
    expect(buildCreateWindowScript('W', true)).not.toContain('activate');
    expect(buildCreateWindowScript('W', true)).toContain('create window with default profile');
  });

  it('buildInSessionScript embeds operations and the return expression', () => {
    const script = buildInSessionScript('SESSION-X', 'set name to "n"', '(contents as string)');
    expect(script).toContain('if (id of s) is "SESSION-X" then');
    expect(script).toContain('set name to "n"');
    expect(script).toContain('return (contents as string)');
    expect(script).toContain('set sessionList to every session of t');
    expect(script).toContain('if not ({-1719, -1728} contains errorNumber) then error errorMessage number errorNumber');
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

  it('buildSessionTtyScript reads the tty from the selected iTerm session', () => {
    const script = buildSessionTtyScript('SESSION-X');
    expect(script).toContain('if (id of s) is "SESSION-X" then');
    expect(script).toContain('return (tty as string)');
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
});
