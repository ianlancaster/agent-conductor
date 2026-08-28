import { describe, expect, it } from 'vitest';
import {
  findInteractiveShell,
  foregroundJobsByTty,
  hasForegroundJob,
  parseProcessGroups,
  parseTtyProcessGroups,
} from '../src/terminals/process.js';

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

  it('groups the multi-tty ps shape without losing the tty or shell command', () => {
    expect(
      parseTtyProcessGroups(
        '17809 17808 17809 19000 ttys001 -zsh\n19000 17809 19000 19000 ttys001 claude\n22000 1 22000 22000 ttys002 /bin/zsh\n',
      ),
    ).toEqual([
      {
        pid: 17809,
        parentPid: 17808,
        processGroupId: 17809,
        foregroundProcessGroupId: 19000,
        tty: 'ttys001',
        command: '-zsh',
      },
      {
        pid: 19000,
        parentPid: 17809,
        processGroupId: 19000,
        foregroundProcessGroupId: 19000,
        tty: 'ttys001',
        command: 'claude',
      },
      {
        pid: 22000,
        parentPid: 1,
        processGroupId: 22000,
        foregroundProcessGroupId: 22000,
        tty: 'ttys002',
        command: '/bin/zsh',
      },
    ]);
  });

  it('classifies active, idle, and missing tty groups independently', () => {
    const rows = parseTtyProcessGroups(
      '100 1 100 200 ttys001 -zsh\n200 100 200 200 ttys001 codex\n300 1 300 300 ttys002 -zsh\n',
    );
    expect([...foregroundJobsByTty(rows, ['ttys001', 'ttys002', 'ttys003'])]).toEqual([
      ['ttys001', true],
      ['ttys002', false],
    ]);
  });
});
