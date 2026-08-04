#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { Command } from 'commander';
import { validateConfig, loadSupervisorConfig } from '../config/loader.js';
import { resolveConductorInstance, resolveFleetDataDir } from '../config/paths.js';
import { Supervisor } from '../core/supervisor.js';
import { exportEventJournalJsonl, Store } from '../store/index.js';
import { PACKAGE_VERSION } from '../version.js';
import { configuredRunbookRegistry } from '../runbooks/registry.js';
import { initializeRunbook, validateRunbookPath } from '../runbooks/authoring.js';
import { installDaemon, uninstallDaemon } from './daemon.js';
import { formatPreflight, preflightFailures, runPreflight } from './doctor.js';
import { loadConfiguredIntegrations } from '../integrations/configured.js';
import { subscribeFeed } from './feed.js';
import { killFleetConductor } from './kill.js';
import { ensureFleetScaffold } from './scaffold.js';
import { DEFAULT_STATUS_INTERVAL, parseStatusInterval, runStatusDashboard } from './live-status.js';
import { configureStatusLines } from './statusline.js';
import { formatTerminalReply } from './terminal-format.js';

const program = new Command();
const interactionId = randomUUID();
const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
program
  .name('conductor')
  .description('Lightweight supervisor for terminal coding agents')
  .version(PACKAGE_VERSION)
  .option('-C, --dir <path>', 'Fleet directory containing .conductor/ (default: current directory)')
  .option('--instance <name>', 'Named Conductor instance under .conductor/instances/<name>')
  .addHelpText(
    'after',
    '\nFleet controls use the shared operator command language. Run conductor start or conductor console, then /help; for one-shot use, run conductor cmd /help.',
  );

/** Resolve the fleet directory from --dir, else the current directory. */
function baseDir(): string {
  const dir = program.opts<{ dir?: string }>().dir;
  return dir !== undefined ? resolve(dir) : process.cwd();
}

function instanceName(): string | undefined {
  return program.opts<{ instance?: string }>().instance;
}

function resolvedInstance(): ReturnType<typeof resolveConductorInstance> {
  return resolveConductorInstance(baseDir(), instanceName());
}

function instanceArgs(): string[] {
  const name = instanceName();
  return name === undefined ? [] : ['--instance', name];
}

function startHint(): string {
  return `conductor${instanceName() === undefined ? '' : ` --instance ${instanceName() ?? ''}`} start`;
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
  const config = loadSupervisorConfig(resolvedInstance());
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
async function sendCommand(line: string, signal?: AbortSignal): Promise<string> {
  const url = `${cmdUrl()}/cmd`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: line, interactionId }),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    throw new Error(
      `No conductor is running for this fleet instance (nothing listening on ${url}). Start one with: ${startHint()}`,
    );
  }
  const payload = (await response.json()) as { reply?: string };
  return payload.reply ?? '';
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

const runbook = program.command('runbook').description('Author and inspect inert local runbook bundles');
runbook
  .command('list')
  .description('List built-in, fleet-local, and configured local runbooks')
  .action(() => {
    const resolved = resolvedInstance();
    const config = loadSupervisorConfig(resolved);
    const snapshot = configuredRunbookRegistry(
      baseDir(),
      config,
      PACKAGE_VERSION,
      join(PACKAGE_ROOT, 'runbooks'),
      resolved.paths.runbooksDir,
    ).snapshot();
    if (snapshot.runbooks.length === 0) process.stdout.write('No valid runbooks discovered.\n');
    for (const item of snapshot.runbooks) {
      process.stdout.write(`${item.id}@${item.version}  ${item.source}  ${item.name}\n`);
    }
    for (const diagnostic of snapshot.diagnostics) {
      process.stderr.write(`! ${diagnostic.source} ${diagnostic.path}: ${diagnostic.message}\n`);
    }
  });

const events = program.command('events').description('Read the local durable Conductor event journal');
events
  .command('export')
  .description('Stream stored event envelopes in deterministic order')
  .option('--format <format>', 'Output format (jsonl)', 'jsonl')
  .option('--since <timestamp>', 'Include events at or after this ISO-8601 timestamp')
  .action((opts: { format: string; since?: string }) => {
    if (opts.format !== 'jsonl') throw new Error("events export currently supports only '--format jsonl'.");
    if (
      opts.since !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}T/u.test(opts.since) || Number.isNaN(Date.parse(opts.since)))
    ) {
      throw new Error('--since must be a valid ISO-8601 timestamp.');
    }
    const config = loadSupervisorConfig(resolvedInstance());
    const dbPath = join(resolveFleetDataDir(baseDir(), config.paths.dataDir), 'conductor.db');
    for (const line of exportEventJournalJsonl(dbPath, opts.since)) process.stdout.write(`${line}\n`);
  });
runbook
  .command('init <path>')
  .description('Create a minimal runbook bundle without overwriting an existing path')
  .action((path: string) => {
    process.stdout.write(`Initialized runbook at ${initializeRunbook(path)}\n`);
  });
runbook
  .command('validate <path>')
  .description('Validate one runbook with the production manifest and filesystem rules')
  .action((path: string) => {
    validateRunbookPath(path, PACKAGE_VERSION);
    process.stdout.write('Runbook OK.\n');
  });

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

  // This is the single configured-code execution boundary. The non-foreground
  // parent performs only schema/stat preflight before spawning this process.
  const config = loadSupervisorConfig(resolvedInstance());
  const integrations = await loadConfiguredIntegrations(baseDir(), config.integrations);
  const supervisor = new Supervisor(baseDir(), { integrations, instance: instanceName() });
  await supervisor.start({ startAll });

  const shutdown = async (): Promise<void> => {
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

program
  .command('statusline')
  .description('Configure richer status lines for Claude Code and Codex (optional)')
  .action(() => {
    for (const line of configureStatusLines()) process.stdout.write(`${line}\n`);
  });

program
  .command('start')
  .description('Initialize missing fleet files, launch the conductor, and open the operator console')
  .option('-a, --start-all', 'Start every configured session immediately')
  .option('-f, --foreground', 'Run the conductor process in this terminal instead (visible log feed, no console)')
  .action(async (opts: { startAll?: boolean; foreground?: boolean }) => {
    const created = ensureFleetScaffold(baseDir(), instanceName());
    if (created.length > 0) {
      log('Initialized missing fleet files:');
      for (const file of created) log(`  ${file}`);
    }

    // Ownership takes precedence over host prerequisites. `start` must never
    // look like a valid way to attach to an existing conductor merely because
    // this shell is missing one of the configured runtime binaries.
    if (opts.foreground !== true) {
      const config = loadSupervisorConfig(resolvedInstance());
      const base = `http://${config.mcp.host}:${config.mcp.port}`;
      if (await conductorUp(base)) {
        throw new Error(
          'A conductor is already running for this fleet. `conductor start` only opens a console that owns and stops its conductor. Use `conductor console` for a non-owning attachment. If the owning console is gone, run `conductor kill` before starting again.',
        );
      }
    }

    const checks = await runPreflight(baseDir(), {}, instanceName());
    const failures = preflightFailures(checks);
    for (const check of checks.filter((item) => item.level === 'warn')) log(`! ${check.label}: ${check.detail}`);
    if (failures.length > 0) {
      throw new Error(
        `Startup preflight failed:\n${formatPreflight(failures)}\nRun conductor doctor for the full report.`,
      );
    }

    if (opts.foreground === true) {
      await runForeground(opts.startAll ?? false);
      return;
    }

    setTerminalTitle(`conductor — ${basename(baseDir())}`);
    const config = loadSupervisorConfig(resolvedInstance());
    const base = `http://${config.mcp.host}:${config.mcp.port}`;

    // Spawn the supervisor as a hidden, headless child. Its terminal output
    // goes to a file; the structured log shares the configured data directory.
    const dataDir = resolveFleetDataDir(baseDir(), config.paths.dataDir);
    mkdirSync(dataDir, { recursive: true });
    const outPath = join(dataDir, 'conductor.out.log');
    const out = openSync(outPath, 'a');
    const args = [
      '-C',
      baseDir(),
      ...instanceArgs(),
      'start',
      '--foreground',
      ...(opts.startAll === true ? ['--start-all'] : []),
    ];
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
    const childPid = child.pid;

    // Wait for the /health endpoint so the console's first command works.
    const deadline = Date.now() + 15_000;
    while (!(await conductorUp(base))) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`The conductor process failed to start — see ${outPath} and ${join(dataDir, 'conductor.log')}`);
      }
      await sleep(250);
    }
    log(`Conductor running (pid ${String(childPid)}, logs: ${outPath}).`);
    log('This terminal is the operator console — closing it stops the conductor. Type /help.');

    // This console owns the conductor it spawned: when the console dies (exit,
    // Ctrl-C, terminal closed), take the conductor down with it.
    const killChild = (): void => {
      if (childPid === undefined || child.exitCode !== null || child.signalCode !== null) return;
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
  .command('doctor')
  .description('Check fleet configuration and local prerequisites')
  .action(async () => {
    const results = await runPreflight(baseDir(), {}, instanceName());
    process.stdout.write(`${formatPreflight(results)}\n`);
    if (preflightFailures(results).length > 0) process.exitCode = 1;
  });

program
  .command('kill')
  .description('Stop the Conductor process owned by this fleet, leaving session panes running')
  .action(async () => {
    const config = loadSupervisorConfig(resolvedInstance());
    const dataDir = resolveFleetDataDir(baseDir(), config.paths.dataDir);
    const result = await killFleetConductor(baseDir(), join(dataDir, 'conductor.lock'));
    process.stdout.write(`${result.message}\n`);
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
  .description('Show a live fleet status view from the running conductor')
  .option('--once', 'Print one status snapshot and exit')
  .option('-i, --interval <duration>', 'Live refresh interval (for example 15s or 500ms)', DEFAULT_STATUS_INTERVAL)
  .action(async (session: string | undefined, opts: { once?: boolean; interval: string }) => {
    const command = session === undefined ? '/status' : `/status ${session}`;
    if (opts.once === true || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      const reply = await sendCommand(command);
      process.stdout.write(`${formatTerminalReply(command, reply, process.stdout.isTTY === true)}\n`);
      return;
    }

    setTerminalTitle(`status — ${basename(baseDir())}`);
    await runStatusDashboard({
      command,
      fleetDir: baseDir(),
      intervalMs: parseStatusInterval(opts.interval),
      fetchStatus: (signal) => sendCommand(command, signal),
    });
  });

program
  .command('logs [session]')
  .description('Show recent health events')
  .option('-n, --count <count>', 'Number of events', '20')
  .action((session: string | undefined, opts: { count: string }) => {
    const config = loadSupervisorConfig(resolvedInstance());
    const store = new Store(join(resolveFleetDataDir(baseDir(), config.paths.dataDir), 'conductor.db'));
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
    const problems = validateConfig(baseDir(), { instance: instanceName() });
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
    process.stdout.write(`${installDaemon(baseDir(), instanceName())}\n`);
  });
daemon
  .command('uninstall')
  .description('Remove the service')
  .action(() => {
    process.stdout.write(`${uninstallDaemon(baseDir(), instanceName())}\n`);
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
