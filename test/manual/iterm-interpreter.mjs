// Run from a built checkout: node test/manual/iterm-interpreter.mjs
// Read-only iTerm probe. Does not capture or write to any session pane.
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { OsaRunner, OSA_WORKER_SCRIPT } from '../../dist/terminals/iterm/osa-worker.js';

assert.equal(process.platform, 'darwin', 'This probe requires macOS and iTerm2');
let spawned = 0;
const runner = new OsaRunner({
  spawnWorker: () => {
    spawned += 1;
    return spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', OSA_WORKER_SCRIPT]);
  },
});
try {
  for (let index = 0; index < 100; index += 1) {
    const value = `request ${index}: ❯ café 😀 " \\ \nsecond line`;
    assert.equal(await runner.run('on run argv\nreturn item 1 of argv\nend run', [value]), `${value}\n`);
  }
  const version = await runner.run('tell application id "com.googlecode.iterm2" to return version');
  assert.match(version, /^\d+\.\d+/);
  assert.equal(spawned, 1);
  process.stdout.write(`101 requests succeeded through one interpreter; iTerm2 ${version.trim()}\n`);
  // Compile errors should remain local to the request, without replacing the worker.
  await assert.rejects(runner.run('on run\nthis is not valid syntax @@@\nend run'));
  assert.equal(await runner.run('return "after error"'), 'after error\n');
  assert.equal(spawned, 1);
  process.stdout.write('Script error recovery succeeded without replacing the interpreter\n');
  await assert.rejects(runner.run('error "expected" number 123'), /expected \(123\)/);
  assert.equal(await runner.run('return "after runtime error"'), 'after runtime error\n');
  assert.equal(spawned, 1);
  process.stdout.write('Runtime error recovery succeeded without replacing the interpreter\n');
} finally {
  runner.dispose();
}
