import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { OsaRunner } from '../src/terminals/iterm/osa-worker.js';

// A real pipe peer exercises framing, child exit, FIFO dispatch and deadlines
// without requiring macOS automation permissions or touching terminal panes.
const PEER = String.raw`
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.script === 'hang') return;
  if (request.script === 'crash') process.exit(1);
  if (request.script === 'malformed') return process.stdout.write('not json\n');
  if (request.script === 'overflow') return process.stdout.write('x'.repeat(10000));
  if (request.script === 'stderr') return process.stderr.write('x'.repeat(10000));
  if (request.script === 'error') return process.stdout.write(JSON.stringify({error:'expected (-600)'})+'\n');
  const response = JSON.stringify({stdout:JSON.stringify({pid:process.pid,...request})})+'\n';
  if (request.script === 'split') {
    const data=Buffer.from(response);const index=data.indexOf(Buffer.from('❯'))+1;
    process.stdout.write(data.subarray(0,index));
    setTimeout(()=>process.stdout.write(data.subarray(index)),5);
  } else process.stdout.write(response);
});
`;

const runners: OsaRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
});

function setup(options: ConstructorParameters<typeof OsaRunner>[0] = {}): {
  runner: OsaRunner;
  children: ChildProcessWithoutNullStreams[];
} {
  const children: ChildProcessWithoutNullStreams[] = [];
  const runner = new OsaRunner({
    timeoutMs: 2_000,
    cooldownMs: 0,
    spawnWorker: () => {
      const child = spawn(process.execPath, ['-e', PEER]);
      children.push(child);
      return child;
    },
    ...options,
  });
  runners.push(runner);
  return { runner, children };
}

describe('persistent AppleScript interpreter', () => {
  it('reuses one process and preserves ordered requests and argv data', async () => {
    const { runner, children } = setup();
    const scripts = ['one', 'two', 'three'];
    const args = ['quotes " \\', 'line\nline', '❯ café 😀', '--'];
    const results = await Promise.all(scripts.map((script) => runner.run(script, args)));
    expect(children).toHaveLength(1);
    expect(results).toEqual(scripts.map((script) => JSON.stringify({ pid: children[0]!.pid, script, args })));
  });

  it('decodes UTF-8 split across pipe chunks', async () => {
    const { runner, children } = setup();
    expect(await runner.run('split', ['❯ café 😀'])).toBe(
      JSON.stringify({ pid: children[0]!.pid, script: 'split', args: ['❯ café 😀'] }),
    );
  });

  it('recycles between completed requests to bound native interpreter memory', async () => {
    const { runner, children } = setup({ maxRequests: 2 });
    const results = await Promise.all(['one', 'two', 'three'].map((script) => runner.run(script)));
    expect(children).toHaveLength(2);
    expect(results).toEqual([
      JSON.stringify({ pid: children[0]!.pid, script: 'one', args: [] }),
      JSON.stringify({ pid: children[0]!.pid, script: 'two', args: [] }),
      JSON.stringify({ pid: children[1]!.pid, script: 'three', args: [] }),
    ]);
    expect(children[0]!.killed).toBe(true);
  });

  it('keeps a healthy interpreter after an AppleScript error', async () => {
    const { runner, children } = setup();
    await expect(runner.run('error')).rejects.toThrow('expected (-600)');
    await expect(runner.run('next')).resolves.toContain('next');
    expect(children).toHaveLength(1);
  });

  it.each(['crash', 'malformed', 'overflow', 'stderr'])(
    'rejects pending work on %s without replaying it',
    async (script) => {
      const { runner, children } = setup({ maxBufferBytes: 512 });
      const results = await Promise.allSettled([runner.run(script), runner.run('must not execute')]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(children).toHaveLength(1);
      await expect(runner.run('new request')).resolves.toContain('new request');
      expect(children).toHaveLength(2);
    },
  );

  it('kills a stuck worker and fails queued requests without replay', async () => {
    const { runner, children } = setup({ timeoutMs: 200 });
    const results = await Promise.allSettled([runner.run('hang'), runner.run('queued')]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(true);
  });

  it('limits pending requests and suppresses respawn storms during failure', async () => {
    const { runner, children } = setup({ timeoutMs: 200, cooldownMs: 10_000, maxPending: 1 });
    const hung = expect(runner.run('hang')).rejects.toThrow('timed out');
    await expect(runner.run('overflow queue')).rejects.toThrow('queue is full');
    await hung;
    await expect(runner.run('cooldown')).rejects.toThrow('cooling down');
    expect(children).toHaveLength(1);
  });

  it('fails and cleans up on dispose, including subsequent requests', async () => {
    const { runner, children } = setup();
    const pending = expect(runner.run('hang')).rejects.toThrow('closed');
    runner.dispose();
    await pending;
    expect(children[0]!.killed).toBe(true);
    await expect(runner.run('after dispose')).rejects.toThrow('closed');
  });

  it('rejects a spawn failure without leaving requests pending', async () => {
    const { runner } = setup({ spawnWorker: () => spawn('/nonexistent-conductor-test-interpreter', []) });
    await expect(runner.run('test')).rejects.toThrow('ENOENT');
  });
});
