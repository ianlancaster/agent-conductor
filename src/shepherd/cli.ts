#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureShepherdScaffold } from '../cli/scaffold.js';
import { resolveFleetPaths } from '../config/paths.js';
import { PACKAGE_VERSION } from '../version.js';
import { assertShepherdProfileReady, loadShepherdConfig, type ConfigOverrides, type ShepherdConfig } from './config.js';
import { MAX_TRACKED_EVIDENCE_BYTES, TrackedPullRequestControl } from './control.js';
import { ShepherdEngine } from './engine.js';
import { GhGitHubProvider } from './github.js';
import { ConductorCoordinatorSink, StdoutCoordinatorSink } from './sinks.js';
import { ShepherdService } from './service.js';
import { SqliteShepherdStore } from './store.js';
import { ShepherdRuntimeReporter, ShepherdServiceLock, serviceLockPath } from './runtime.js';

interface CommonOptions {
  config?: string;
  githubUser?: string;
  coordinatorSession?: string;
  conductorEndpoint?: string;
  databasePath?: string;
}

interface TrackedControlOptions extends CommonOptions {
  repo: string;
  pr: string;
  actor: string;
  evidenceFile: string;
  idempotencyKey: string;
}

const program = new Command()
  .name('pr-shepherd')
  .description('PR Shepherd V2')
  .version(PACKAGE_VERSION)
  .option('-C, --dir <path>', 'Fleet directory (default: current directory)');

function fleetDir(): string {
  const directory = program.opts<{ dir?: string }>().dir;
  return directory === undefined ? process.cwd() : resolve(directory);
}

function configPath(options: CommonOptions): string {
  return options.config === undefined ? resolveFleetPaths(fleetDir()).shepherdConfigFile : resolve(options.config);
}

function overrides(options: CommonOptions): ConfigOverrides {
  return {
    ...(options.githubUser !== undefined ? { githubUser: options.githubUser } : {}),
    ...(options.coordinatorSession !== undefined ? { coordinatorSession: options.coordinatorSession } : {}),
    ...(options.conductorEndpoint !== undefined ? { conductorEndpoint: options.conductorEndpoint } : {}),
    ...(options.databasePath !== undefined ? { databasePath: options.databasePath } : {}),
  };
}

function config(options: CommonOptions): ShepherdConfig {
  return loadShepherdConfig(configPath(options), overrides(options));
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function common(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Path to the strict V2 YAML profile (default: fleet profile)')
    .option('--github-user <username>', 'Override profile.githubUser')
    .option('--coordinator-session <codename>', 'Override the Conductor recipient')
    .option('--conductor-endpoint <url>', 'Override the localhost Conductor endpoint')
    .option('--database-path <path>', 'Override the Shepherd SQLite path');
}

function build(options: CommonOptions): {
  service: ShepherdService;
  store: SqliteShepherdStore;
  engine: ShepherdEngine;
  lock: ShepherdServiceLock;
} {
  const path = configPath(options);
  assertShepherdProfileReady(path);
  const resolved = config(options);
  mkdirSync(dirname(resolved.databasePath), { recursive: true });
  const token = process.env.PR_SHEPHERD_LAUNCH_TOKEN ?? `standalone-${String(process.pid)}`;
  const lock = new ShepherdServiceLock(serviceLockPath(resolved.databasePath), path, process.pid, token);
  lock.acquire();
  let store: SqliteShepherdStore | undefined;
  try {
    store = new SqliteShepherdStore(resolved.databasePath);
    const engine = new ShepherdEngine(resolved, new GhGitHubProvider(resolved), store);
    const sink =
      resolved.delivery.type === 'conductor'
        ? new ConductorCoordinatorSink(resolved.delivery.endpoint)
        : new StdoutCoordinatorSink();
    const reporter = new ShepherdRuntimeReporter(resolved.databasePath, path, token);
    return {
      service: new ShepherdService(resolved, engine, store, sink, reporter, () => lock.assertOwned()),
      store,
      engine,
      lock,
    };
  } catch (error) {
    lock.release();
    store?.close();
    throw error;
  }
}

function buildTrackedControl(options: CommonOptions): {
  control: TrackedPullRequestControl;
  store: SqliteShepherdStore;
} {
  const path = configPath(options);
  assertShepherdProfileReady(path);
  const resolved = config(options);
  mkdirSync(dirname(resolved.databasePath), { recursive: true });
  const store = new SqliteShepherdStore(resolved.databasePath);
  return { control: new TrackedPullRequestControl(resolved, new GhGitHubProvider(resolved), store), store };
}

function parsePrNumber(raw: string): number {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('--pr must be a positive integer.');
  return number;
}

function readEvidence(path: string): unknown {
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_TRACKED_EVIDENCE_BYTES) {
    throw new Error(`--evidence-file must not exceed ${String(MAX_TRACKED_EVIDENCE_BYTES)} bytes.`);
  }
  try {
    return JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to parse --evidence-file as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function trackedControlCommand(command: Command): Command {
  return common(command)
    .requiredOption('--repo <owner/name>', 'Pull request repository')
    .requiredOption('--pr <number>', 'Pull request number')
    .requiredOption('--actor <identity>', 'Caller-asserted local audit identity')
    .requiredOption('--evidence-file <path>', 'Path to a JSON evidence value (maximum 16 KiB)')
    .requiredOption('--idempotency-key <key>', 'Stable caller-supplied operation key');
}

program
  .command('init')
  .description('Create the fleet PR Shepherd profile without replacing an existing file')
  .action(() => {
    const created = ensureShepherdScaffold(fleetDir());
    print(created === undefined ? 'PR Shepherd profile already exists; left unchanged.' : `Created ${created}`);
  });

common(program.command('validate').description('Validate a V2 YAML profile')).action((options: CommonOptions) => {
  const resolved = config(options);
  print(`Valid V2 profile for @${resolved.profile.githubUser}.`);
});

common(
  program
    .command('poll')
    .description('Run one serialized poll cycle')
    .option('--once', 'Required for explicit one-shot polling'),
).action(async (options: CommonOptions & { once?: boolean }) => {
  if (options.once !== true) throw new Error('Use pr-shepherd poll --once for one-shot polling.');
  const { service, store, lock } = build(options);
  try {
    print(await service.pollAndDeliver());
  } finally {
    lock.release();
    store.close();
  }
});

common(program.command('start').description('Run the serialized polling service')).action(
  async (options: CommonOptions) => {
    const { service, store, lock } = build(options);
    const abort = new AbortController();
    const shutdown = (): void => {
      service.stop();
      abort.abort();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await service.start(abort.signal);
    } finally {
      lock.release();
      store.close();
    }
  },
);

common(program.command('status').description('Show persisted Shepherd status')).action((options: CommonOptions) => {
  const resolved = config(options);
  const store = new SqliteShepherdStore(resolved.databasePath);
  try {
    print({
      profile: resolved.profile.githubUser,
      authoredPRs: store
        .listEntities<{ sources?: { authored?: boolean } }>('authored')
        .filter((entity) => entity.value.sources?.authored !== false).length,
      trackedPRs: store.listTrackedPullRequests('active').length,
      reviewInbox: store.listEntities('review-inbox').length,
      followUps: store.listEntities('review-follow-up').length,
      reviewerNudges: store.listEntities('nudge').length,
      pendingOutbox: store.listOutbox().length,
    });
  } finally {
    store.close();
  }
});

common(
  program
    .command('events')
    .description('Print recent Shepherd events')
    .option('--limit <count>', 'Maximum events', '100'),
).action((options: CommonOptions & { limit: string }) => {
  const resolved = config(options);
  const store = new SqliteShepherdStore(resolved.databasePath);
  try {
    const limit = Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer.');
    print(store.listEvents(limit));
  } finally {
    store.close();
  }
});

common(program.command('inbox').description('Print active review-inbox state')).action((options: CommonOptions) => {
  const resolved = config(options);
  const store = new SqliteShepherdStore(resolved.databasePath);
  try {
    print(store.listEntities('review-inbox'));
  } finally {
    store.close();
  }
});

trackedControlCommand(
  program.command('claim').description('Persistently claim an open pull request for tracking'),
).action(async (options: TrackedControlOptions) => {
  const { control, store } = buildTrackedControl(options);
  try {
    print(
      await control.claim({
        repo: options.repo,
        number: parsePrNumber(options.pr),
        actor: options.actor,
        evidence: readEvidence(options.evidenceFile),
        idempotencyKey: options.idempotencyKey,
      }),
    );
  } finally {
    store.close();
  }
});

trackedControlCommand(
  program.command('unclaim').description('Stop tracking a persistently claimed pull request'),
).action((options: TrackedControlOptions) => {
  const { control, store } = buildTrackedControl(options);
  try {
    print(
      control.unclaim({
        repo: options.repo,
        number: parsePrNumber(options.pr),
        actor: options.actor,
        evidence: readEvidence(options.evidenceFile),
        idempotencyKey: options.idempotencyKey,
      }),
    );
  } finally {
    store.close();
  }
});

common(
  program
    .command('tracked')
    .description('Print durable tracked pull-request claims')
    .option('--audit', 'Include the durable claim/unclaim audit log'),
).action((options: CommonOptions & { audit?: boolean }) => {
  const resolved = config(options);
  const store = new SqliteShepherdStore(resolved.databasePath);
  try {
    const claims = store.listTrackedPullRequests();
    print(options.audit === true ? { claims, operations: store.listTrackedControlOperations() } : claims);
  } finally {
    store.close();
  }
});

await program.parseAsync();
