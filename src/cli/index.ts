#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { validateConfig, loadSupervisorConfig } from '../config/loader.js';
import { Supervisor } from '../core/supervisor.js';
import { Store } from '../store/index.js';
import { installDaemon, uninstallDaemon } from './daemon.js';
import { initFleet } from './init.js';

const packageJson = JSON.parse(
  readFileSync(join(fileURLToPath(import.meta.url), '..', '..', '..', 'package.json'), 'utf8'),
) as { version: string };

const program = new Command();
program
  .name('conductor')
  .description('Lightweight supervisor for terminal coding agents')
  .version(packageJson.version)
  .option('-C, --dir <path>', 'Fleet directory containing config/ (default: current directory)');

/** Resolve the fleet directory from --dir, else the current directory. */
function baseDir(): string {
  const dir = program.opts<{ dir?: string }>().dir;
  return dir !== undefined ? resolve(dir) : process.cwd();
}

/** Name this terminal's tab/window — otherwise it just shows "node". */
function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\u001b]0;${title}\u0007`);
  }
}

program
  .command('init')
  .description('Scaffold a fleet directory (config/supervisor.yaml + config/sessions/)')
  .option('--session <codename>', 'Also create the first session config')
  .option('--repo <path>', "The session's project directory (required with --session)")
  .action((opts: { session?: string; repo?: string }) => {
    for (const line of initFleet(baseDir(), opts)) process.stdout.write(`${line}\n`);
  });

program
  .command('start')
  .description('Run the conductor process (headless log feed — attach with `conductor console`)')
  .option('--start-all', 'Start every configured session immediately')
  .action(async (opts: { startAll?: boolean }) => {
    // Backstop: the conductor's whole job is supervision, so a stray rejection
    // from a fire-and-forget path (a pane dying mid-write) must be logged, not
    // allowed to terminate the process and take down the whole fleet's oversight.
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(
        `[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
      );
    });

    setTerminalTitle(`conductor — ${basename(baseDir())}`);

    const supervisor = new Supervisor(baseDir());
    await supervisor.start({ startAll: opts.startAll ?? false });
    log('Operator console: run `conductor console` in another terminal.');

    const shutdown = async (): Promise<void> => {
      await supervisor.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** POST one command line to a running conductor's /cmd endpoint. */
async function sendCommand(line: string): Promise<string> {
  const config = loadSupervisorConfig(baseDir());
  const url = `http://${config.mcp.host}:${config.mcp.port}/cmd`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: line }),
    });
  } catch {
    throw new Error(
      `No conductor is running for this fleet (nothing listening on ${url}). Start one with: conductor start`,
    );
  }
  const payload = (await response.json()) as { reply?: string };
  return payload.reply ?? '';
}

program
  .command('console')
  .description('Interactive operator console attached to a running conductor')
  .action(async () => {
    setTerminalTitle(`console — ${basename(baseDir())}`);
    // Fail fast with a clear message when no conductor is up.
    await sendCommand('/status');

    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'conductor> ' });
    rl.prompt();
    rl.on('line', (line) => {
      if (line.trim().length === 0) {
        rl.prompt();
        return;
      }
      sendCommand(line)
        .then((reply) => {
          if (reply.length > 0) process.stdout.write(`${reply}\n`);
          rl.prompt();
        })
        .catch((err: unknown) => {
          process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          rl.prompt();
        });
    });
    rl.on('close', () => {
      process.exit(0);
    });
  });

program
  .command('cmd <line...>')
  .description('Send a single command to a running conductor')
  .action(async (line: string[]) => {
    process.stdout.write(`${await sendCommand(line.join(' '))}\n`);
  });

program
  .command('status')
  .description('Show active runs from the local store')
  .action(() => {
    const config = loadSupervisorConfig(baseDir());
    const store = new Store(join(baseDir(), config.paths.dataDir, 'conductor.db'));
    const runs = store.getActiveRuns();
    if (runs.length === 0) {
      process.stdout.write('No active runs.\n');
    } else {
      for (const run of runs) {
        process.stdout.write(`${run.session}  since ${run.started_at}  (${run.id.slice(0, 8)})\n`);
      }
    }
    store.close();
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
