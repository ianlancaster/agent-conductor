import { describe, expect, it } from 'vitest';
import { findInteractiveShell, hasForegroundJob, parseProcessGroups } from '../src/terminals/process.js';

describe('terminal foreground process detection', () => {
  it('parses ps process-group output', () => {
    expect(parseProcessGroups('  120   1  120  405\n  405 120  405  405\n')).toEqual([
      { pid: 120, parentPid: 1, processGroupId: 120, foregroundProcessGroupId: 405 },
      { pid: 405, parentPid: 120, processGroupId: 405, foregroundProcessGroupId: 405 },
    ]);
  });

  it('reports an idle shell when it owns the tty foreground group', () => {
    expect(hasForegroundJob({ pid: 120, parentPid: 1, processGroupId: 120, foregroundProcessGroupId: 120 })).toBe(
      false,
    );
  });

  it('reports an active job when Claude or Codex owns the foreground group', () => {
    expect(hasForegroundJob({ pid: 120, parentPid: 1, processGroupId: 120, foregroundProcessGroupId: 405 })).toBe(true);
  });

  it('does not call an unattached tty active', () => {
    expect(hasForegroundJob({ pid: 120, parentPid: 1, processGroupId: 120, foregroundProcessGroupId: -1 })).toBe(false);
  });

  it('selects zsh beneath the macOS login wrapper in an idle iTerm pane', () => {
    // Captured from a real conductor iTerm pane after Ctrl-C. The login
    // wrapper has a different PGID and caused the original false positive.
    const rows = parseProcessGroups('17808 31321 17808 17809 /usr/bin/login\n17809 17808 17809 17809 -zsh\n');
    const shell = findInteractiveShell(rows);
    expect(shell?.pid).toBe(17809);
    expect(shell === undefined ? undefined : hasForegroundJob(shell)).toBe(false);
  });

  it('still reports active when Claude owns the iTerm tty foreground group', () => {
    const rows = parseProcessGroups(
      '17808 31321 17808 19000 /usr/bin/login\n17809 17808 17809 19000 -zsh\n19000 17809 19000 19000 claude\n',
    );
    const shell = findInteractiveShell(rows);
    expect(shell?.pid).toBe(17809);
    expect(shell === undefined ? undefined : hasForegroundJob(shell)).toBe(true);
  });
});
