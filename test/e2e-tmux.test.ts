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
      backend = new TmuxBackend({
        store,
        config: { sessionName: SESSION, windowName: 'e2e', fleetId: 'e2e', paneBorders: true },
      });
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
      const fresh = new TmuxBackend({
        store,
        config: { sessionName: SESSION, windowName: 'e2e', fleetId: 'e2e', paneBorders: true },
      });
      const found = await fresh.rediscover();
      expect(found.get('gamma')?.id).toBe(pane.id);
    });

    it('enables pane border titles on the window it creates panes in', async () => {
      const pane = await backend.createPane('iota', 'pane', workDir);
      const status = execFileSync('tmux', ['show-options', '-w', '-t', pane.id, 'pane-border-status'], {
        encoding: 'utf8',
      }).trim();
      expect(status).toBe('pane-border-status top');
    });

    it('kills panes and reports death', async () => {
      const pane = await backend.createPane('delta', 'pane', workDir);
      expect(await backend.isAlive(pane)).toBe(true);
      await backend.kill(pane);
      expect(await backend.isAlive(pane)).toBe(false);
    });

    it('captureStyled retains ANSI styling that plain capture drops', async () => {
      const pane = await backend.createPane('theta', 'pane', workDir);
      await backend.launch(pane, String.raw`printf '\033[2mDIM_MARKER\033[0m\n'`);
      await until(async () => (await backend.capture(pane, 20)).includes('DIM_MARKER'));
      const plain = await backend.capture(pane, 20);
      expect(plain).not.toContain('\u001b[');
      const styled = await backend.captureStyled(pane, 20);
      expect(styled).toContain('\u001b[2mDIM_MARKER');
    });

    it('attach mode: joins the window that contains the console pane', async () => {
      // Simulate an operator session: a pre-existing tmux session whose first
      // pane stands in for the conductor console ($TMUX_PANE).
      const operatorSession = `${SESSION}-op`;
      const consolePane = execFileSync(
        'tmux',
        ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', operatorSession, '-n', 'console'],
        { encoding: 'utf8' },
      ).trim();
      try {
        const attached = new TmuxBackend({
          store,
          config: {
            sessionName: SESSION,
            windowName: 'e2e',
            fleetId: 'e2e',
            paneBorders: true,
            attachPane: consolePane,
          },
        });
        const pane = await attached.createPane('epsilon', 'pane', workDir);
        const where = execFileSync('tmux', ['display-message', '-p', '-t', pane.id, '#{session_name} #{window_id}'], {
          encoding: 'utf8',
        }).trim();
        const consoleWhere = execFileSync(
          'tmux',
          ['display-message', '-p', '-t', consolePane, '#{session_name} #{window_id}'],
          { encoding: 'utf8' },
        ).trim();
        // Same session AND same window — a split next to the console, not a
        // pane in the detached conductor session.
        expect(where).toBe(consoleWhere);
        expect(where.startsWith(operatorSession)).toBe(true);

        // 'tab' lands as a new window in the operator's session.
        const tabPane = await attached.createPane('zeta', 'tab', workDir);
        const tabSession = execFileSync('tmux', ['display-message', '-p', '-t', tabPane.id, '#{session_name}'], {
          encoding: 'utf8',
        }).trim();
        expect(tabSession).toBe(operatorSession);
      } finally {
        execFileSync('tmux', ['kill-session', '-t', operatorSession], { stdio: 'pipe' });
      }
    });

    it('headless create → summon → banish round-trips a pane between fleet session and operator window', async () => {
      const operatorSession = `${SESSION}-sum`;
      const consolePane = execFileSync(
        'tmux',
        ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', operatorSession, '-n', 'console'],
        { encoding: 'utf8' },
      ).trim();
      const sessionOf = (paneId: string): string =>
        execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}'], {
          encoding: 'utf8',
        }).trim();
      try {
        const attached = new TmuxBackend({
          store,
          config: {
            sessionName: SESSION,
            windowName: 'e2e',
            fleetId: 'e2e',
            paneBorders: true,
            attachPane: consolePane,
          },
        });
        // --headless overrides attach mode: pane lands in the detached fleet session.
        const pane = await attached.createPane('omega', 'pane', workDir, { headless: true });
        expect(sessionOf(pane.id)).toBe(SESSION);

        // Summon pulls it into the operator's window.
        expect(await attached.summon(pane, 'omega')).toContain('summoned');
        expect(sessionOf(pane.id)).toBe(operatorSession);

        // Summoning again just focuses it.
        expect(await attached.summon(pane, 'omega')).toContain('already in your window');

        // Banish sends it back to the fleet session (recreated on demand —
        // tmux killed it when its last pane was summoned out).
        expect(await attached.banish(pane, 'omega')).toContain('banished');
        expect(sessionOf(pane.id)).toBe(SESSION);
        expect(await attached.banish(pane, 'omega')).toContain('already banished');
        expect(await attached.isAlive(pane)).toBe(true);
      } finally {
        execFileSync('tmux', ['kill-session', '-t', operatorSession], { stdio: 'pipe' });
      }
    });

    it('attach mode: falls back to the detached session when the console pane is gone', async () => {
      const attached = new TmuxBackend({
        store,
        config: { sessionName: SESSION, windowName: 'e2e', fleetId: 'e2e', paneBorders: true, attachPane: '%99999' },
      });
      const pane = await attached.createPane('eta', 'pane', workDir);
      const sessionName = execFileSync('tmux', ['display-message', '-p', '-t', pane.id, '#{session_name}'], {
        encoding: 'utf8',
      }).trim();
      expect(sessionName).toBe(SESSION);
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
          // Keep e2e panes out of the developer's own tmux window when the
          // test suite itself runs inside tmux.
          '    attachToCurrent: false',
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
      expect(status).toContain('  alpha · 🟢 working');

      expect(await supervisor.command('/stop alpha')).toBe('alpha stopped.');
      expect(supervisor.statusReport()).toContain('  alpha · ⚪ stopped');
    }, 30_000);

    it('marks sessions stopped when their panes died while the conductor was down', async () => {
      // Operator closes the whole tmux window/terminal: panes die with it.
      // A restarted conductor must reconcile the persisted "running" state to
      // stopped — not report ghosts as working/stalled.
      await supervisor.start();
      await supervisor.command('/start alpha');
      expect(supervisor.statusReport()).toContain('alpha · 🟢 working');
      await supervisor.stop();
      killSession();

      supervisor = new Supervisor(baseDir);
      await supervisor.start();
      expect(supervisor.statusReport()).toContain('alpha · ⚪ stopped');
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
