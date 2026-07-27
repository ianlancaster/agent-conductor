import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/index.js';
import { Supervisor } from '../src/core/supervisor.js';
import { FakeChannel } from './fakes/fake-channel.js';
import { TmuxBackend } from '../src/terminals/tmux/index.js';
import { hasShellPrompt } from '../src/terminals/tmux/tmux.js';
import {
  SlackAdapter,
  type SlackClientFactory,
  type SlackSocketClient,
  type SlackWebClient,
} from '../src/channels/slack/index.js';

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

    it('distinguishes an active foreground job from an idle shell in a live pane', async () => {
      const pane = await backend.createPane('process-check', 'pane', workDir);
      expect(await backend.isSessionActive(pane)).toBe(false);

      await backend.launch(pane, 'sleep 30');
      await until(async () => backend.isSessionActive(pane));
      execFileSync('tmux', ['send-keys', '-t', pane.id, 'C-c']);
      await until(async () => !(await backend.isSessionActive(pane)));

      expect(await backend.isAlive(pane)).toBe(true);
    });

    it('interrupts a stale foreground job before delivering a launch command', async () => {
      const recoveryBackend = new TmuxBackend({
        store,
        config: { sessionName: SESSION, windowName: 'e2e', fleetId: 'e2e', paneBorders: true },
        launchTimeoutMs: 100,
        launchPollMs: 20,
        launchRecoveryTimeoutMs: 1_000,
      });
      const pane = await recoveryBackend.createPane('launch-recovery', 'pane', workDir);
      await until(async () => hasShellPrompt(await recoveryBackend.capture(pane, 20)));
      await recoveryBackend.run(pane, 'sleep 30');
      await until(async () => recoveryBackend.isSessionActive(pane));

      await recoveryBackend.launch(pane, 'echo LAUNCH_RECOVERED');

      await until(async () => (await recoveryBackend.capture(pane, 20)).includes('LAUNCH_RECOVERED'));
      expect(await recoveryBackend.isSessionActive(pane)).toBe(false);
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

    it('submits a delivery only while the pane still matches its capture token', async () => {
      const pane = await backend.createPane('protected-delivery', 'pane', workDir);
      await until(async () => hasShellPrompt(await backend.capture(pane, 20)));

      const stale = await backend.captureForDelivery(pane, 20);
      execFileSync('tmux', ['send-keys', '-t', pane.id, '-l', '--', 'operator draft']);
      expect(await backend.submitIfUnchanged(pane, 'must wait', stale.token)).toBe(false);

      const current = await backend.captureForDelivery(pane, 20);
      expect(await backend.submitIfUnchanged(pane, ' delivered safely', current.token)).toBe(true);
      await until(async () => (await backend.capture(pane, 20)).includes('operator draft delivered safely'));
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
        // …and makes the title visible there: the operator's window never
        // hosted a conductor-created pane, so border status was off.
        const borders = execFileSync('tmux', ['show-options', '-w', '-t', pane.id, 'pane-border-status'], {
          encoding: 'utf8',
        }).trim();
        expect(borders).toBe('pane-border-status top');

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
    let channel: FakeChannel;
    let secondChannel: FakeChannel;
    let slack: E2eSlackTransport;

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
          `    binary: ${FAKE_BINARY}`,
          '',
        ].join('\n'),
      );
      writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), `codename: alpha\nrepo: ${repo}\n`);
      channel = new FakeChannel();
      secondChannel = new FakeChannel();
      slack = new E2eSlackTransport();
      const slackAdapter = new SlackAdapter(
        { appToken: 'xapp-e2e', botToken: 'xoxb-e2e', operatorUserId: 'U1' },
        { clientFactory: slack.factory, sleep: async () => undefined },
      );
      supervisor = new Supervisor(baseDir, {
        channels: [channel, secondChannel, slackAdapter],
        includeConfiguredChannels: false,
        claudeJsonPath: join(baseDir, 'claude.json'),
      });
    });

    afterEach(async () => {
      await supervisor.stop();
      rmSync(baseDir, { recursive: true, force: true });
      killSession();
    });

    it('starts a session, delivers an operator message, and reads it back', async () => {
      await supervisor.start();

      expect(await channel.command('status')).toContain('alpha');
      slack.message('!status');
      await until(async () => slack.posts.some((post) => String(post.text).includes('alpha')));

      const startReply = await supervisor.command('/start alpha');
      expect(startReply).toBe('alpha started.');

      const tail = async (): Promise<string> => supervisor.command('/tail alpha 60');
      await until(async () => (await tail()).includes('FAKE SESSION START'));

      slack.message('!talk alpha');
      await until(async () => slack.posts.some((post) => String(post.text).includes('Talking to alpha')));
      slack.message('hello through Slack');
      await until(async () => (await tail()).includes('GOT: [Message from operator] hello through Slack'));

      const tellReply = await supervisor.command('/tell alpha hello from the operator');
      expect(tellReply).toContain('alpha');
      await until(async () => (await tail()).includes('GOT: [Message from operator] hello from the operator'));

      const requestResponse = await fetch('http://127.0.0.1:43399/mcp/alpha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'send_to_operator',
            arguments: { message: 'Deploy where?', options: ['Staging', 'Production'] },
          },
        }),
      });
      const requestPayload = (await requestResponse.json()) as {
        result: { content: { text: string }[] };
      };
      expect(requestPayload.result.content[0]?.text).toBe('Request #1 sent to the operator.');
      expect(channel.lastSent()).toEqual(secondChannel.lastSent());
      expect(channel.lastSent()?.actions?.[1]).toEqual({ label: 'Production', command: '/respond 1 2' });
      await until(async () => slack.posts.some((post) => Array.isArray(post.blocks)));
      slack.action('/respond 1 2');
      await until(async () => (await tail()).includes('Response to request #1'));
      expect(await channel.command('respond', ['1', '2'])).toContain('already answered');

      const status = supervisor.statusReport();
      expect(status).toContain('  alpha - CC · 🟢 working');

      expect(await supervisor.command('/stop alpha')).toBe('alpha stopped.');
      expect(supervisor.statusReport()).toContain('  alpha - CC · ⚪ stopped');
    }, 30_000);

    it('detects Ctrl-C and restarts or continues in the same pane', async () => {
      await supervisor.start();
      expect(await supervisor.command('/start alpha')).toBe('alpha started.');
      await until(async () => (await supervisor.command('/tail alpha 30')).includes('FAKE SESSION START'));

      const paneId = execFileSync('tmux', ['list-panes', '-t', `=${SESSION}`, '-F', '#{pane_id}'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
      await until(async () => (await supervisor.command('/status alpha')).includes('"running": false'));
      expect(await supervisor.command('/start alpha')).toBe('alpha started.');
      expect(
        execFileSync('tmux', ['list-panes', '-t', `=${SESSION}`, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim(),
      ).toBe(paneId);

      execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
      await until(async () => (await supervisor.command('/status alpha')).includes('"running": false'));
      expect(await supervisor.command('/continue alpha')).toBe('alpha continued.');
      expect(
        execFileSync('tmux', ['list-panes', '-t', `=${SESSION}`, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim(),
      ).toBe(paneId);
    }, 30_000);

    it('marks sessions stopped when their panes died while the conductor was down', async () => {
      // Operator closes the whole tmux window/terminal: panes die with it.
      // A restarted conductor must reconcile the persisted "running" state to
      // stopped — not report ghosts as working or idle.
      await supervisor.start();
      await supervisor.command('/start alpha');
      expect(supervisor.statusReport()).toContain('alpha - CC · 🟢 working');
      await supervisor.stop();
      killSession();

      supervisor = new Supervisor(baseDir, {
        includeConfiguredChannels: false,
        claudeJsonPath: join(baseDir, 'claude.json'),
      });
      await supervisor.start();
      expect(supervisor.statusReport()).toContain('alpha - CC · ⚪ stopped');
    }, 30_000);

    it('delivers a piped initial prompt through the runtime launch command', async () => {
      await supervisor.start();
      await supervisor.command('/tell alpha do the morning checklist');
      const tail = async (): Promise<string> => supervisor.command('/tail alpha 60');
      // Session was not running: /tell starts it with the message as the prompt.
      await until(async () => (await tail()).includes('PROMPT: [Message from operator] do the morning checklist'));
    }, 30_000);

    it('spawns and safely tears down a real git worktree without orphaning dirty work', async () => {
      const repo = join(baseDir, 'main-repo');
      mkdirSync(repo);
      const gitEnv = { ...process.env };
      for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
        delete gitEnv[key];
      }
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
          encoding: 'utf8',
          env: gitEnv,
        });
      git(repo, 'init', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'main\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'initial');

      await supervisor.start();
      expect(await supervisor.command(`/spawn worker --worktree ${repo} --branch worker-branch`)).toContain(
        'Spawned worker',
      );
      const worktree = join(baseDir, 'worker');
      await until(async () => (await supervisor.command('/tail worker 40')).includes('FAKE SESSION START'));
      const canonicalWorktree = realpathSync(worktree);
      expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('worker-branch');
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${canonicalWorktree}`);

      writeFileSync(join(worktree, 'unfinished.txt'), 'keep this\n');
      const refused = await supervisor.command('/teardown worker --delete');
      expect(refused).toContain('NOT deregistered');
      expect(supervisor.statusReport()).toContain('worker - CC · ⚪ stopped');
      expect(existsSync(join(baseDir, 'config', 'sessions', 'worker.yaml'))).toBe(true);
      expect(existsSync(join(worktree, 'unfinished.txt'))).toBe(true);

      rmSync(join(worktree, 'unfinished.txt'));
      const removed = await supervisor.command('/teardown worker --delete');
      expect(removed).toContain('Worktree removed');
      expect(existsSync(worktree)).toBe(false);
      expect(existsSync(join(baseDir, 'config', 'sessions', 'worker.yaml'))).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(canonicalWorktree);
      expect(git(repo, 'show-ref', '--verify', 'refs/heads/worker-branch')).toContain('refs/heads/worker-branch');
      expect(git(repo, 'status', '--porcelain')).toBe('');
    }, 30_000);

    it('runs cron prompts, restarts a Ctrl-C session, honors pause, and hot-reloads schedules', async () => {
      // Reconstruct with a one-second config poll just for this timing test.
      await supervisor.stop();
      const supervisorFile = join(baseDir, 'config', 'supervisor.yaml');
      writeFileSync(
        supervisorFile,
        `supervisor:\n  heartbeatIntervalSeconds: 1\n${readFileSync(supervisorFile, 'utf8')}`,
      );
      const cronRepo = join(baseDir, 'cron-repo');
      mkdirSync(cronRepo);
      const cronFile = join(baseDir, 'config', 'sessions', 'cron.yaml');
      const scheduleConfig = (prompt?: string): string =>
        [
          'codename: cron',
          `repo: ${cronRepo}`,
          ...(prompt === undefined
            ? []
            : ['schedules:', '  - label: heartbeat', '    cron: "*/2 * * * * *"', `    prompt: ${prompt}`]),
          '',
        ].join('\n');
      writeFileSync(cronFile, scheduleConfig('cron-tick'));

      supervisor = new Supervisor(baseDir, {
        channels: [channel],
        includeConfiguredChannels: false,
        claudeJsonPath: join(baseDir, 'claude.json'),
      });
      await supervisor.start();
      const tail = async (): Promise<string> => supervisor.command('/tail cron 200');
      const count = (text: string, marker: string): number => text.split(marker).length - 1;

      // Inactive target: cron starts it with the scheduled prompt. Later ticks
      // go through the active-session delivery path.
      await until(async () => (await tail()).includes('PROMPT: cron-tick'));
      await until(async () => (await tail()).includes('GOT: cron-tick'));

      // Kill only the runtime, leaving its pane/shell. The next cron fire must
      // inspect process liveness and restart; typing into the shell would yield
      // "command not found" and this assertion would time out.
      const paneId = execFileSync('tmux', ['list-panes', '-t', `=${SESSION}`, '-F', '#{pane_id}'], {
        encoding: 'utf8',
      }).trim();
      if (paneId === '') throw new Error('cron pane not found');
      execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
      await until(async () => count(await tail(), 'FAKE SESSION START') >= 2);
      expect(await tail()).not.toContain('command not found');

      await supervisor.command('/pause cron');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pausedCount = count(await tail(), 'cron-tick');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(count(await tail(), 'cron-tick')).toBe(pausedCount);

      await supervisor.command('/resume cron');
      await until(async () => count(await tail(), 'cron-tick') > pausedCount);

      // Automatic watcher reload replaces the old job rather than double-arming.
      writeFileSync(cronFile, scheduleConfig('cron-updated'));
      await until(async () => (await tail()).includes('GOT: cron-updated'));

      // Removing the schedule and rebuilding prevents any later delivery.
      writeFileSync(cronFile, scheduleConfig());
      supervisor.reloadSessionsForTest();
      const removedCount = count(await tail(), 'cron-updated');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(count(await tail(), 'cron-updated')).toBe(removedCount);
    }, 45_000);
  });

  class E2eSlackTransport {
    readonly posts: Record<string, unknown>[] = [];
    private listener:
      | ((request: Parameters<SlackSocketClient['on']>[1] extends (value: infer T) => void ? T : never) => void)
      | undefined;

    readonly socket: SlackSocketClient = {
      on: (_event, listener) => {
        this.listener = listener;
        return this.socket;
      },
      off: (_event, listener) => {
        if (this.listener === listener) this.listener = undefined;
        return this.socket;
      },
      start: async () => ({}),
      disconnect: async () => undefined,
    };

    readonly web: SlackWebClient = {
      auth: { test: async () => ({ team_id: 'T1', user_id: 'UBOT' }) },
      conversations: { open: async () => ({ channel: { id: 'D1' } }) },
      chat: {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      },
    };

    readonly factory: SlackClientFactory = { create: async () => ({ socket: this.socket, web: this.web }) };

    message(text: string): void {
      const id = `e${String(this.posts.length)}-${text}`;
      this.listener?.({
        ack: async () => undefined,
        envelope_id: `env-${id}`,
        type: 'events_api',
        body: {
          team_id: 'T1',
          event_id: id,
          event: { type: 'message', user: 'U1', channel: 'D1', channel_type: 'im', text },
        },
      });
    }

    action(value: string): void {
      this.listener?.({
        ack: async () => undefined,
        envelope_id: `action-${String(this.posts.length)}`,
        type: 'interactive',
        body: {
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D1' },
          actions: [{ action_id: 'conductor_action_0', value }],
        },
      });
    }
  }
});
