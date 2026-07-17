import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/index.js';
import { Supervisor } from '../src/core/supervisor.js';
import { TmuxBackend } from '../src/terminals/tmux/index.js';

/**
 * End-to-end tests against a REAL tmux server. The "session" is a shell script
 * (test/fixtures/fake-session.sh) that echoes its prompt and any delivered input,
 * so the full stack — config → supervisor → lifecycle → runtime launch command
 * → tmux pane → typing-aware delivery → capture — runs for real with only the
 * LLM faked. Skipped when tmux is not installed (CI installs it).
 */
const hasTmux = ((): boolean => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const SESSION = `conductor-e2e-${process.pid}`;
const FAKE_BINARY = join(import.meta.dirname, 'fixtures', 'fake-session.sh');

function killSession(): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'pipe' });
  } catch {
    // Session already gone.
  }
}

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!hasTmux)('tmux E2E', () => {
  afterAll(killSession);

  describe('TmuxBackend against a live server', () => {
    let store: Store;
    let backend: TmuxBackend;
    let workDir: string;

    beforeEach(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'conductor-e2e-'));
      store = new Store(':memory:');
      backend = new TmuxBackend({ store, config: { sessionName: SESSION, windowName: 'e2e', fleetId: 'e2e' } });
      await backend.init();
    });

    afterEach(() => {
      store.close();
      rmSync(workDir, { recursive: true, force: true });
      killSession();
    });

    it('creates a pane in a cwd, launches a command, and captures output', async () => {
      const pane = await backend.createPane('alpha', 'pane', workDir);
      await backend.launch(pane, 'echo "MARKER_$((40 + 2))" && pwd');
      await until(async () => (await backend.capture(pane, 50)).includes('MARKER_42'));
      const capture = await backend.capture(pane, 50);
      expect(capture).toContain(workDir);
      expect(await backend.isAlive(pane)).toBe(true);
    });

    it('delivers multiline input via bracketed paste as a single unit', async () => {
      const pane = await backend.createPane('beta', 'pane', workDir);
      await backend.launch(pane, `cat > ${join(workDir, 'received.txt')}`);
      await backend.run(pane, 'line one\nline two\nline three');
      await until(async () => (await backend.capture(pane, 30)).includes('line three'));
      // All three lines went to cat as one paste, not three submitted commands.
      const capture = await backend.capture(pane, 30);
      expect(capture).toContain('line one');
      expect(capture).not.toContain('command not found');
    });

    it('rediscovers panes from a fresh backend instance via pane options', async () => {
      const pane = await backend.createPane('gamma', 'tab', workDir);
      const fresh = new TmuxBackend({ store, config: { sessionName: SESSION, windowName: 'e2e', fleetId: 'e2e' } });
      const found = await fresh.rediscover();
      expect(found.get('gamma')?.id).toBe(pane.id);
    });

    it('kills panes and reports death', async () => {
      const pane = await backend.createPane('delta', 'pane', workDir);
      expect(await backend.isAlive(pane)).toBe(true);
      await backend.kill(pane);
      expect(await backend.isAlive(pane)).toBe(false);
    });
  });

  describe('full stack: Supervisor + tmux + fake session binary', () => {
    let baseDir: string;
    let supervisor: Supervisor;

    beforeEach(() => {
      chmodSync(FAKE_BINARY, 0o755);
      baseDir = mkdtempSync(join(tmpdir(), 'conductor-e2e-sup-'));
      const repo = join(baseDir, 'alpha-repo');
      mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(baseDir, 'config', 'supervisor.yaml'),
        [
          'terminal:',
          '  backend: tmux',
          '  tmux:',
          `    sessionName: ${SESSION}`,
          'mcp:',
          '  port: 43399',
          'runtimes:',
          '  claudeCode:',
          `    claudeJsonPath: ${join(baseDir, 'claude.json')}`,
          `    binary: ${FAKE_BINARY}`,
          '',
        ].join('\n'),
      );
      writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), `codename: alpha\nrepo: ${repo}\n`);
      supervisor = new Supervisor(baseDir);
    });

    afterEach(async () => {
      await supervisor.stop();
      rmSync(baseDir, { recursive: true, force: true });
      killSession();
    });

    it('starts a session, delivers an operator message, and reads it back', async () => {
      await supervisor.start();

      const startReply = await supervisor.command('/start alpha');
      expect(startReply).toBe('alpha started.');

      const tail = async (): Promise<string> => supervisor.command('/tail alpha 60');
      await until(async () => (await tail()).includes('FAKE SESSION START'));

      const tellReply = await supervisor.command('/tell alpha hello from the operator');
      expect(tellReply).toContain('alpha');
      await until(async () => (await tail()).includes('GOT: [Message from operator] hello from the operator'));

      const status = supervisor.statusReport();
      expect(status).toContain('🟢 alpha');

      expect(await supervisor.command('/stop alpha')).toBe('alpha stopped.');
      expect(supervisor.statusReport()).toContain('⚪ alpha');
    }, 30_000);

    it('delivers a piped initial prompt through the runtime launch command', async () => {
      await supervisor.start();
      await supervisor.command('/tell alpha do the morning checklist');
      const tail = async (): Promise<string> => supervisor.command('/tail alpha 60');
      // Session was not running: /tell starts it with the message as the prompt.
      await until(async () => (await tail()).includes('PROMPT: [Message from operator] do the morning checklist'));
    }, 30_000);
  });
});
