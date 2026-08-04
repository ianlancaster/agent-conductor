import { describe, expect, it } from 'vitest';
import { createOutstandingWorkProbe } from '../src/core/outstanding-work.js';
import { cpuDeltaCentiseconds, parseCpuCentiseconds, parseProcessCpuRows } from '../src/terminals/process.js';
import type { ProcessCpuRow } from '../src/terminals/process.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import type { TerminalBackend } from '../src/terminals/types.js';

const SHELL_PID = 100;

/** One process, described by how much CPU it burns per sample window. */
interface FakeProc {
  pid: number;
  parentPid: number;
  /** Cumulative CPU at the first sample, in centiseconds. */
  start: number;
  /** Centiseconds consumed between the two samples. */
  burn: number;
}

/**
 * A seat's process tree: the pane shell, the agent process beneath it, and
 * whatever the agent has spawned.
 */
function tree(...spawned: FakeProc[]): { before: ProcessCpuRow[]; after: ProcessCpuRow[] } {
  const base: FakeProc[] = [
    { pid: SHELL_PID, parentPid: 1, start: 40, burn: 0 },
    // The agent process itself is never at rest: timers and redraw cost a little
    // every second even at a bare prompt.
    { pid: 101, parentPid: SHELL_PID, start: 5_000, burn: 2 },
  ];
  const all = [...base, ...spawned];
  // Unrelated processes elsewhere on the machine must not leak into the reading.
  const noise: FakeProc[] = [{ pid: 900, parentPid: 1, start: 90_000, burn: 5_000 }];
  const rows = (pick: (proc: FakeProc) => number): ProcessCpuRow[] =>
    [...all, ...noise].map((proc) => ({ pid: proc.pid, parentPid: proc.parentPid, cpuCentiseconds: pick(proc) }));
  return { before: rows((proc) => proc.start), after: rows((proc) => proc.start + proc.burn) };
}

function probeFor(
  samples: { before: ProcessCpuRow[]; after: ProcessCpuRow[] },
  overrides: { backend?: TerminalBackend } = {},
) {
  const backend = overrides.backend ?? new FakeTerminalBackend();
  const withPid = Object.assign(backend, { paneShellPid: async () => SHELL_PID });
  let call = 0;
  return createOutstandingWorkProbe({
    backend: withPid,
    getPane: () => ({ backend: 'fake', id: 'pane-1' }),
    sample: async () => (call++ === 0 ? samples.before : samples.after),
    wait: async () => undefined,
  });
}

describe('outstanding-work probe', () => {
  // The two legs the design has to survive. Leg A alone is not an acceptance
  // test: a term that simply counted descendants would pass it and fail Leg B.
  it('Leg A: a seat sitting idle with busy subprocesses has work in flight', async () => {
    const probe = probeFor(
      tree(
        { pid: 200, parentPid: 101, start: 0, burn: 98 },
        { pid: 201, parentPid: 101, start: 0, burn: 96 },
        { pid: 202, parentPid: 200, start: 0, burn: 97 },
      ),
    );

    const result = await probe('alpha');

    expect(result.state).toBe('in-flight');
    expect(result.detail).toContain('cs across');
  });

  it('Leg B: a seat whose only descendants are an MCP server and caffeinate is quiet', async () => {
    // THE discriminator. These processes exist, hold pids, and never compute.
    // `descendants > 0` reports work here forever, which would suppress
    // fleet-stall permanently on any seat with an MCP server attached — an
    // instrument that can never fire.
    const probe = probeFor(
      tree(
        { pid: 300, parentPid: 101, start: 12, burn: 0 }, // caffeinate
        { pid: 301, parentPid: 101, start: 4_100, burn: 1 }, // node MCP server
        { pid: 302, parentPid: 101, start: 3_900, burn: 0 }, // uv MCP server
        { pid: 303, parentPid: 301, start: 250, burn: 0 },
      ),
    );

    const result = await probe('alpha');

    expect(result.state).toBe('quiet');
  });

  it('does not mistake the idle floor for work', async () => {
    // Measured on a live fleet: idle seats read 0-3 centiseconds per second,
    // not zero. A `delta > 0` term would fire on every one of them.
    const probe = probeFor(tree({ pid: 300, parentPid: 101, start: 900, burn: 1 }));

    expect((await probe('alpha')).state).toBe('quiet');
  });

  it('reports an unresolvable process tree as unknown rather than quiet', async () => {
    const backend = Object.assign(new FakeTerminalBackend(), {
      paneShellPid: async () => {
        throw new Error('iTerm session 9 has no tty');
      },
    });
    const probe = createOutstandingWorkProbe({
      backend,
      getPane: () => ({ backend: 'fake', id: 'pane-1' }),
      sample: async () => [],
      wait: async () => undefined,
    });

    const result = await probe('alpha');

    expect(result.state).toBe('unknown');
    expect(result.detail).toContain('no tty');
  });

  it('reports a backend that cannot expose a process tree as unknown', async () => {
    const probe = createOutstandingWorkProbe({
      backend: new FakeTerminalBackend(),
      getPane: () => ({ backend: 'fake', id: 'pane-1' }),
      sample: async () => [],
      wait: async () => undefined,
    });

    const result = await probe('alpha');

    expect(result.state).toBe('unknown');
    expect(result.detail).toContain('cannot expose a pane process tree');
  });

  it('reports a session with no pane as unknown', async () => {
    const probe = createOutstandingWorkProbe({
      backend: Object.assign(new FakeTerminalBackend(), { paneShellPid: async () => SHELL_PID }),
      getPane: () => undefined,
      sample: async () => [],
      wait: async () => undefined,
    });

    expect((await probe('alpha')).state).toBe('unknown');
  });

  it('reports a tree that vanished between samples as unknown, not quiet', async () => {
    const probe = probeFor({
      before: [{ pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 }],
      after: [{ pid: 900, parentPid: 1, cpuCentiseconds: 90_000 }],
    });

    expect((await probe('alpha')).state).toBe('unknown');
  });
});

describe('cpu delta accounting', () => {
  it('does not let an exiting process produce a negative delta', async () => {
    // The process took its whole accumulated total with it. Subtracting whole
    // snapshots would read that as large negative work.
    const before: ProcessCpuRow[] = [
      { pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: SHELL_PID, cpuCentiseconds: 5_000 },
      { pid: 200, parentPid: 101, cpuCentiseconds: 60_000 },
    ];
    const after: ProcessCpuRow[] = [
      { pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: SHELL_PID, cpuCentiseconds: 5_002 },
    ];

    expect(cpuDeltaCentiseconds(before, after, SHELL_PID).deltaCentiseconds).toBe(2);
  });

  it('does not let a newly appeared process import a lifetime of unrelated CPU', async () => {
    const before: ProcessCpuRow[] = [
      { pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: SHELL_PID, cpuCentiseconds: 5_000 },
    ];
    const after: ProcessCpuRow[] = [
      { pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: SHELL_PID, cpuCentiseconds: 5_001 },
      { pid: 200, parentPid: 101, cpuCentiseconds: 400_000 },
    ];

    expect(cpuDeltaCentiseconds(before, after, SHELL_PID).deltaCentiseconds).toBe(1);
  });

  it('clamps a per-process decrease from pid reuse to zero', async () => {
    const before: ProcessCpuRow[] = [
      { pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: SHELL_PID, cpuCentiseconds: 5_000 },
    ];
    const after: ProcessCpuRow[] = [
      { pid: SHELL_PID, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: SHELL_PID, cpuCentiseconds: 3 },
    ];

    expect(cpuDeltaCentiseconds(before, after, SHELL_PID).deltaCentiseconds).toBe(0);
  });
});

describe('ps cumulative CPU parsing', () => {
  it('reads macOS MM:SS.ss with unbounded minutes', () => {
    // `70:24.21` is seventy minutes, not an hour and ten.
    expect(parseCpuCentiseconds('70:24.21')).toBe(70 * 6_000 + 24 * 100 + 21);
    expect(parseCpuCentiseconds('0:00.01')).toBe(1);
  });

  it('reads GNU HH:MM:SS and day-prefixed forms', () => {
    expect(parseCpuCentiseconds('01:02:03')).toBe((3_600 + 2 * 60 + 3) * 100);
    expect(parseCpuCentiseconds('2-01:00:00')).toBe((2 * 86_400 + 3_600) * 100);
  });

  it('rejects unparseable time so a bad row cannot become a zero', () => {
    expect(parseCpuCentiseconds('-')).toBeUndefined();
    expect(parseCpuCentiseconds('')).toBeUndefined();
  });

  it('parses a ps table and skips rows it cannot read', () => {
    const rows = parseProcessCpuRows('  100     1  0:00.40\n  101   100  50:00.00\nbroken line\n  102   101  -\n');

    expect(rows).toEqual([
      { pid: 100, parentPid: 1, cpuCentiseconds: 40 },
      { pid: 101, parentPid: 100, cpuCentiseconds: 300_000 },
    ]);
  });
});
