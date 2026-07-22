#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { validateConfig, loadSupervisorConfig } from '../config/loader.js';
import { Supervisor } from '../core/supervisor.js';
import { Store } from '../store/index.js';
import { installDaemon, uninstallDaemon } from './daemon.js';
import { initFleet } from './init.js';
import { configureStatusLines } from './statusline.js';
import { formatFeedPayload, formatTerminalReply } from './terminal-format.js';

const packageJson = JSON.parse(
  readFileSync(join(fileURLToPath(import.meta.url), '..', '..', '..', 'package.json'), 'utf8'),
) as { version: string };

const program = new Command();
const interactionId = randomUUID();
program
  .name('conductor')
  .description('Lightweight supervisor for terminal coding agents')
  .version(packageJson.version)
  .option('-C, --dir <path>', 'Fleet directory containing config/ (default: current directory)')
  .addHelpText(
    'after',
    '\nFleet controls use the shared operator command language. Run conductor start or conductor console, then /help; for one-shot use, run conductor cmd /help.',
  );

/** Resolve the fleet directory from --dir, else the current directory. */
function baseDir(): string {
  const dir = program.opts<{ dir?: string }>().dir;
  return dir !== undefined ? resolve(dir) : process.cwd();
}

/** Name this terminal's tab/window — otherwise it just shows "node". */
function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`]0;${title}`);
  }
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The tty this process runs in, or null (no controlling terminal). */
function ownTty(): string | null {
  try {
    const tty = execFileSync('tty', [], { stdio: ['inherit', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return tty.startsWith('/dev/') ? tty : null;
  } catch {
    return null;
  }
}

function cmdUrl(): string {
  const config = loadSupervisorConfig(baseDir());
  return `http://${config.mcp.host}:${config.mcp.port}`;
}

async function conductorUp(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** POST one command line to a running conductor's /cmd endpoint. */
async function sendCommand(line: string): Promise<string> {
  const url = `${cmdUrl()}/cmd`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: line, interactionId }),
    });
  } catch {
    throw new Error(
      `No conductor is running for this fleet (nothing listening on ${url}). Start one with: conductor start`,
    );
  }
  const payload = (await response.json()) as { reply?: string };
  return payload.reply ?? '';
}

/**
 * Subscribe to the conductor's operator feed (SSE on GET /feed) and hand every
 * message to onMessage. Reconnects quietly until the signal aborts, so a
 * conductor restart doesn't detach the console.
 */
async function subscribeFeed(base: string, onMessage: (text: string) => void, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/feed`, { signal });
      if (!response.ok || response.body === null) throw new Error(`feed unavailable (${String(response.status)})`);
      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let frameEnd = buffer.indexOf('\n\n');
        while (frameEnd !== -1) {
          for (const line of buffer.slice(0, frameEnd).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const payload = JSON.parse(line.slice('data: '.length)) as unknown;
              const formatted = formatFeedPayload(payload);
              if (formatted !== undefined) onMessage(formatted);
            } catch {
              // Malformed frame — skip it rather than kill the stream.
            }
          }
          buffer = buffer.slice(frameEnd + 2);
          frameEnd = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Conductor down or restarting — retry below.
    }
    if (!signal.aborted) await sleep(2000);
  }
}

/** The interactive conductor> REPL. Resolves when the operator exits. */
function runConsole(): Promise<void> {
  return new Promise((resolveDone) => {
    // Red prompt (Node's readline strips VT escapes when measuring width, so
    // ANSI in the prompt does not break cursor math). Plain when not a TTY.
    const prompt = process.stdout.isTTY ? '[31mconductor>[39m ' : 'conductor> ';
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt });

    // Live operator feed: session messages (send_to_operator, stall reports)
    // print above the prompt without disturbing what the operator is typing.
    const feedAbort = new AbortController();
    void subscribeFeed(
      cmdUrl(),
      (text) => {
        // Cyan signature (the leading [Message from x] envelope) so operator-bound
        // messages stand out from command replies without drowning the text.
        const line = process.stdout.isTTY ? text.replace(/^\[[^\]]+\]/, (sig) => `[36m${sig}[39m`) : text;
        process.stdout.write(`\r[2K${line}\n`);
        rl.prompt(true);
      },
      feedAbort.signal,
    );

    rl.prompt();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        rl.prompt();
        return;
      }
      // Console-local: clear screen + scrollback (never sent to the conductor).
      if (trimmed === '/clear' || trimmed === '/c') {
        process.stdout.write('[2J[3J[H');
        rl.prompt();
        return;
      }
      sendCommand(line)
        .then((reply) => {
          if (reply.length > 0) {
            process.stdout.write(`${formatTerminalReply(trimmed, reply, process.stdout.isTTY === true)}\n`);
          }
          rl.prompt();
        })
        .catch((err: unknown) => {
          process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          rl.prompt();
        });
    });
    rl.on('close', () => {
      feedAbort.abort();
      resolveDone();
    });
  });
}

/** Run the supervisor in THIS process (visible log feed). Used by --foreground and daemons. */
async function runForeground(startAll: boolean): Promise<void> {
  // Backstop: the conductor's whole job is supervision, so a stray rejection
  // from a fire-and-forget path (a pane dying mid-write) must be logged, not
  // allowed to terminate the process and take down the whole fleet's oversight.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
  });

  setTerminalTitle(`conductor feed — ${basename(baseDir())}`);

  const supervisor = new Supervisor(baseDir());
  await supervisor.start({ startAll });

  const shutdown = async (): Promise<void> => {
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

program
  .command('init')
  .description('Scaffold a fleet directory (config, sessions, and env.template)')
  .option('-s, --session <codename>', 'Also create the first session config')
  .option('-r, --repo <path>', "The session's project directory (required with --session)")
  .action((opts: { session?: string; repo?: string }) => {
    for (const line of initFleet(baseDir(), opts)) process.stdout.write(`${line}\n`);
  });

program
  .command('statusline')
  .description('Configure richer status lines for Claude Code and Codex (optional)')
  .action(() => {
    for (const line of configureStatusLines()) process.stdout.write(`${line}\n`);
  });

program
  .command('start')
  .description('Launch the conductor and turn this terminal into the operator console')
  .option('-a, --start-all', 'Start every configured session immediately')
  .option('-f, --foreground', 'Run the conductor process in this terminal instead (visible log feed, no console)')
  .action(async (opts: { startAll?: boolean; foreground?: boolean }) => {
    if (opts.foreground === true) {
      await runForeground(opts.startAll ?? false);
      return;
    }

    setTerminalTitle(`conductor — ${basename(baseDir())}`);
    const config = loadSupervisorConfig(baseDir());
    const base = `http://${config.mcp.host}:${config.mcp.port}`;

    let childPid: number | undefined;
    if (await conductorUp(base)) {
      log('Attached to the already-running conductor (it will keep running when this console exits).');
    } else {
      // Spawn the supervisor as a hidden, headless child. Its terminal output
      // goes to a file; the structured log is data/conductor.log as always.
      const dataDir = join(baseDir(), config.paths.dataDir);
      mkdirSync(dataDir, { recursive: true });
      const outPath = join(dataDir, 'conductor.out.log');
      const out = openSync(outPath, 'a');
      const args = ['-C', baseDir(), 'start', '--foreground', ...(opts.startAll === true ? ['--start-all'] : [])];
      const child = spawn(process.execPath, [process.argv[1] ?? 'conductor', ...args], {
        detached: true,
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          // Panes open in THIS terminal's window: the backend adopts the
          // window owning this tty instead of the (tty-less) child's.
          ...(ownTty() !== null ? { CONDUCTOR_CONSOLE_TTY: ownTty() ?? '' } : {}),
        },
      });
      child.unref();
      childPid = child.pid;

      // Wait for the /health endpoint so the console's first command works.
      const deadline = Date.now() + 15_000;
      while (!(await conductorUp(base))) {
        if (Date.now() > deadline || child.exitCode !== null) {
          throw new Error(`The conductor process failed to start — see ${outPath} and data/conductor.log`);
        }
        await sleep(250);
      }
      log(`Conductor running (pid ${String(childPid)}, logs: ${outPath}).`);
      log('This terminal is the operator console — closing it stops the conductor. Type /help.');
    }

    // This console owns the conductor it spawned: when the console dies (exit,
    // Ctrl-C, terminal closed), take the conductor down with it.
    const killChild = (): void => {
      if (childPid === undefined) return;
      try {
        process.kill(childPid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    };
    process.on('exit', killChild);
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        process.exit(0); // triggers the exit handler above
      });
    }

    await runConsole();
    process.exit(0);
  });

program
  .command('console')
  .description('Attach an operator console to a running conductor (does not stop it on exit)')
  .action(async () => {
    setTerminalTitle(`console — ${basename(baseDir())}`);
    // Fail fast with a clear message when no conductor is up.
    await sendCommand('/status');
    await runConsole();
    process.exit(0);
  });

program
  .command('cmd <line...>')
  .description('Send a single command to a running conductor')
  .action(async (line: string[]) => {
    const command = line.join(' ');
    const reply = await sendCommand(command);
    process.stdout.write(`${formatTerminalReply(command, reply, process.stdout.isTTY === true)}\n`);
  });

program
  .command('status [session]')
  .description('Show fleet status from the running conductor')
  .action(async (session: string | undefined) => {
    const command = session === undefined ? '/status' : `/status ${session}`;
    const reply = await sendCommand(command);
    process.stdout.write(`${formatTerminalReply(command, reply, process.stdout.isTTY === true)}\n`);
  });

program
  .command('logs [session]')
  .description('Show recent health events')
  .option('-n, --count <count>', 'Number of events', '20')
  .action((session: string | undefined, opts: { count: string }) => {
    const config = loadSupervisorConfig(baseDir());
    const store = new Store(join(baseDir(), config.paths.dataDir, 'conductor.db'));
    for (const row of store.getHealthLog(session, Number.parseInt(opts.count, 10)).reverse()) {
      process.stdout.write(
        `${row.created_at}  ${row.session}  ${row.event}${row.detail !== null ? `  ${row.detail}` : ''}\n`,
      );
    }
    store.close();
  });

program
  .command('validate')
  .description('Validate supervisor and session configs')
  .action(() => {
    const problems = validateConfig(baseDir());
    if (problems.length === 0) {
      process.stdout.write('Config OK.\n');
      return;
    }
    for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);
    process.exitCode = 1;
  });

const daemon = program.command('daemon').description('Manage the conductor as a system service');
daemon
  .command('install')
  .description('Install a launchd (macOS) or systemd (Linux) service')
  .action(() => {
    process.stdout.write(`${installDaemon(baseDir())}\n`);
  });
daemon
  .command('uninstall')
  .description('Remove the service')
  .action(() => {
    process.stdout.write(`${uninstallDaemon(baseDir())}\n`);
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
