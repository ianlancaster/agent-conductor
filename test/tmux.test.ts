import { describe, expect, it } from 'vitest';
import {
  buildCreatePaneArgs,
  buildDeliveryCommands,
  hasShellPrompt,
  parseAgentPanes,
  parsePaneIds,
  pasteBufferName,
  trimToTrailingLines,
} from '../src/terminals/tmux/tmux.js';

describe('parsePaneIds', () => {
  it('parses one pane id per line', () => {
    expect(parsePaneIds('%0\n%3\n%12\n')).toEqual(['%0', '%3', '%12']);
  });

  it('ignores blank lines and non-pane noise', () => {
    expect(parsePaneIds('\n%1\n\nsome warning\n%2\n')).toEqual(['%1', '%2']);
  });

  it('returns empty for empty output', () => {
    expect(parsePaneIds('')).toEqual([]);
  });
});

describe('parseAgentPanes', () => {
  it('maps marked panes to codenames and skips unmarked panes', () => {
    const output = '%0 \n%1 midgard-1\n%2\n%3 pr-shepherd\n';
    const map = parseAgentPanes(output);
    expect(map.get('midgard-1')).toBe('%1');
    expect(map.get('pr-shepherd')).toBe('%3');
    expect(map.size).toBe(2);
  });

  it('lets the last pane win on duplicate codenames', () => {
    const map = parseAgentPanes('%1 alpha\n%2 alpha\n');
    expect(map.get('alpha')).toBe('%2');
    expect(map.size).toBe(1);
  });

  it('handles empty output and whitespace-only marker values', () => {
    expect(parseAgentPanes('').size).toBe(0);
    expect(parseAgentPanes('%5   \n').size).toBe(0);
  });
});

describe('buildCreatePaneArgs', () => {
  it("maps 'pane' to split-window on the session's first window", () => {
    const args = buildCreatePaneArgs({ placement: 'pane', sessionName: 'conductor', agent: 'alpha' });
    expect(args).toEqual(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', '=conductor:{start}']);
  });

  it("maps 'tab' to new-window named after the agent", () => {
    const args = buildCreatePaneArgs({ placement: 'tab', sessionName: 'conductor', agent: 'alpha' });
    expect(args).toEqual(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', '=conductor:', '-n', 'alpha']);
  });

  it('targets the session with an exact-match = prefix (M21)', () => {
    const args = buildCreatePaneArgs({ placement: 'pane', sessionName: 'conductor', agent: 'alpha' });
    expect(args).toContain('=conductor:{start}');
  });

  it("maps 'window' to new-window too (tmux has no separate OS windows)", () => {
    const windowArgs = buildCreatePaneArgs({ placement: 'window', sessionName: 'conductor', agent: 'alpha' });
    const tabArgs = buildCreatePaneArgs({ placement: 'tab', sessionName: 'conductor', agent: 'alpha' });
    expect(windowArgs).toEqual(tabArgs);
  });

  it('appends -c <cwd> when a cwd is provided', () => {
    const args = buildCreatePaneArgs({
      placement: 'pane',
      sessionName: 's',
      agent: 'alpha',
      cwd: '/tmp/repo',
    });
    expect(args.slice(-2)).toEqual(['-c', '/tmp/repo']);
    const noCwd = buildCreatePaneArgs({ placement: 'pane', sessionName: 's', agent: 'alpha' });
    expect(noCwd).not.toContain('-c');
  });
});

describe('buildDeliveryCommands', () => {
  it('sends single-line text literally, then Enter as a separate command', () => {
    expect(buildDeliveryCommands('%4', 'hello world')).toEqual([
      ['send-keys', '-t', '%4', '-l', '--', 'hello world'],
      ['send-keys', '-t', '%4', 'Enter'],
    ]);
  });

  it('protects text that looks like an option behind -- and the literal flag', () => {
    const [first] = buildDeliveryCommands('%4', '-rf --no-preserve-root');
    expect(first).toEqual(['send-keys', '-t', '%4', '-l', '--', '-rf --no-preserve-root']);
  });

  it('uses set-buffer + bracketed paste-buffer with a per-pane buffer for multiline text', () => {
    const text = 'line one\nline two';
    const buffer = pasteBufferName('%7');
    expect(buffer).toBe('conductor-paste-7');
    expect(buildDeliveryCommands('%7', text)).toEqual([
      ['set-buffer', '-b', buffer, '--', text],
      ['paste-buffer', '-d', '-p', '-b', buffer, '-t', '%7'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
  });

  it('gives distinct panes distinct paste buffers (no cross-agent clobber)', () => {
    expect(pasteBufferName('%7')).not.toBe(pasteBufferName('%12'));
  });

  it('treats carriage-return text as multiline so a raw CR cannot submit mid-message', () => {
    const [first] = buildDeliveryCommands('%2', 'line one\r\nline two');
    expect(first?.[0]).toBe('set-buffer');
  });

  it('always ends with a standalone Enter keystroke', () => {
    for (const text of ['x', 'a\nb']) {
      const commands = buildDeliveryCommands('%1', text);
      expect(commands[commands.length - 1]).toEqual(['send-keys', '-t', '%1', 'Enter']);
    }
  });
});

describe('hasShellPrompt', () => {
  it('detects common prompt endings on the last non-empty line', () => {
    expect(hasShellPrompt('Last login: Mon\nuser@host dir %')).toBe(true);
    expect(hasShellPrompt('bash-5.2$')).toBe(true);
    expect(hasShellPrompt('~/repo ❯')).toBe(true);
    expect(hasShellPrompt('root@box:~#')).toBe(true);
    expect(hasShellPrompt('cc-conductor ==>')).toBe(true);
    expect(hasShellPrompt('cc-conductor ==> ')).toBe(true);
  });

  it('ignores trailing blank lines from the capture', () => {
    expect(hasShellPrompt('user@host %\n\n\n')).toBe(true);
  });

  it('rejects output that is not at a prompt', () => {
    expect(hasShellPrompt('Cloning into repo...\nreceiving objects: 42%')).toBe(false);
    expect(hasShellPrompt('still booting')).toBe(false);
    expect(hasShellPrompt('')).toBe(false);
  });
});

describe('trimToTrailingLines', () => {
  it('keeps only the trailing N lines', () => {
    expect(trimToTrailingLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });

  it('returns everything when there are fewer lines than requested', () => {
    expect(trimToTrailingLines('a\nb', 10)).toBe('a\nb');
  });

  it('strips trailing blank lines before trimming', () => {
    expect(trimToTrailingLines('a\nb\nc\n\n  \n', 2)).toBe('b\nc');
  });
});
