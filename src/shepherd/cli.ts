#!/usr/bin/env node
import { Command } from 'commander';
import { loadShepherdConfig, type ConfigOverrides, type ShepherdConfig } from './config.js';
import { ShepherdEngine } from './engine.js';
import { GhGitHubProvider } from './github.js';
import { ConductorCoordinatorSink, StdoutCoordinatorSink } from './sinks.js';
import { ShepherdService } from './service.js';
import { SqliteShepherdStore } from './store.js';

interface CommonOptions {
  config: string;
  githubUser?: string;
  coordinatorSession?: string;
  conductorEndpoint?: string;
  databasePath?: string;
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
  return loadShepherdConfig(options.config, overrides(options));
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function common(command: Command): Command {
  return command
    .requiredOption('-c, --config <path>', 'Path to the strict V2 YAML profile')
    .option('--github-user <username>', 'Override profile.githubUser')
    .option('--coordinator-session <codename>', 'Override the Conductor recipient')
    .option('--conductor-endpoint <url>', 'Override the localhost Conductor endpoint')
    .option('--database-path <path>', 'Override the Shepherd SQLite path');
}

function build(options: CommonOptions): {
  service: ShepherdService;
  store: SqliteShepherdStore;
  engine: ShepherdEngine;
} {
  const resolved = config(options);
  const store = new SqliteShepherdStore(resolved.databasePath);
  const engine = new ShepherdEngine(resolved, new GhGitHubProvider(resolved), store);
  const sink =
    resolved.delivery.type === 'conductor'
      ? new ConductorCoordinatorSink(resolved.delivery.endpoint)
      : new StdoutCoordinatorSink();
  return { service: new ShepherdService(resolved, engine, store, sink), store, engine };
}

const program = new Command().name('pr-shepherd').description('PR Shepherd V2').version('2.0.0');

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
  const { service, store } = build(options);
  try {
    print(await service.pollAndDeliver());
  } finally {
    store.close();
  }
});

common(program.command('start').description('Run the serialized polling service')).action(
  async (options: CommonOptions) => {
    const { service, store } = build(options);
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
      authoredPRs: store.listEntities('authored').length,
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

await program.parseAsync();
