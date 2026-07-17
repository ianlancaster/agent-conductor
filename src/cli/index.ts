#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { validateConfig, loadSupervisorConfig } from '../config/loader.js';
import { Supervisor } from '../core/supervisor.js';
import { Store } from '../store/index.js';
import { installDaemon, uninstallDaemon } from './daemon.js';

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

program
  .command('start')
  .description('Start the conductor (foreground, with an interactive console)')
  .option('--start-all', 'Start every configured agent immediately')
  .option('--no-console', 'Run without the interactive console')
  .action(async (opts: { startAll?: boolean; console?: boolean }) => {
    // Backstop: the conductor's whole job is supervision, so a stray rejection
    // from a fire-and-forget path (a pane dying mid-write) must be logged, not
    // allowed to terminate the process and take down the whole fleet's oversight.
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(
        `[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
      );
    });

    const supervisor = new Supervisor(baseDir());
    await supervisor.start({ startAll: opts.startAll ?? false });

    const shutdown = async (): Promise<void> => {
      await supervisor.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    if (opts.console !== false) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'conductor> ' });
      rl.prompt();
      rl.on('line', (line) => {
        void supervisor
          .command(line)
          .then((reply) => {
            if (reply.length > 0) process.stdout.write(`${reply}\n`);
            rl.prompt();
          })
          .catch((err: unknown) => {
            process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
            rl.prompt();
          });
      });
      rl.on('close', () => void shutdown());
    }
  });

program
  .command('cmd <line...>')
  .description('Send a command to a running conductor (via its /cmd endpoint)')
  .action(async (line: string[]) => {
    const config = loadSupervisorConfig(baseDir());
    const response = await fetch(`http://${config.mcp.host}:${config.mcp.port}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: line.join(' ') }),
    });
    const payload = (await response.json()) as { reply?: string };
    process.stdout.write(`${payload.reply ?? ''}\n`);
  });

program
  .command('status')
  .description('Show agent and session status from the local store')
  .action(() => {
    const config = loadSupervisorConfig(baseDir());
    const store = new Store(join(baseDir(), config.paths.dataDir, 'conductor.db'));
    const sessions = store.getActiveSessions();
    if (sessions.length === 0) {
      process.stdout.write('No active sessions.\n');
    } else {
      for (const session of sessions) {
        process.stdout.write(`${session.agent}  since ${session.started_at}  (${session.id.slice(0, 8)})\n`);
      }
    }
    store.close();
  });

program
  .command('logs [agent]')
  .description('Show recent health events')
  .option('-n, --count <count>', 'Number of events', '20')
  .action((agent: string | undefined, opts: { count: string }) => {
    const config = loadSupervisorConfig(baseDir());
    const store = new Store(join(baseDir(), config.paths.dataDir, 'conductor.db'));
    for (const row of store.getHealthLog(agent, Number.parseInt(opts.count, 10)).reverse()) {
      process.stdout.write(
        `${row.created_at}  ${row.agent}  ${row.event}${row.detail !== null ? `  ${row.detail}` : ''}\n`,
      );
    }
    store.close();
  });

program
  .command('validate')
  .description('Validate supervisor and agent configs')
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
