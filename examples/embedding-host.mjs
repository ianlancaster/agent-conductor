import { Supervisor, renderChannelMessage } from 'agent-conductor';
import process from 'node:process';

/**
 * Minimal external operator channel. A real adapter would authenticate an
 * inbound transport and call these handlers from its receive loop.
 */
class ExampleChannel {
  name = 'example';
  handlers;

  async start(handlers) {
    this.handlers = handlers;
  }

  async send(message) {
    process.stdout.write(`${renderChannelMessage(message)}\n`);
  }

  async stop() {
    this.handlers = undefined;
  }
}

const fleetDir = process.argv[2] ?? process.cwd();
const channel = new ExampleChannel();
const eventLog = {
  name: 'example-event-log',
  onEvent(event) {
    process.stdout.write(`[event ${event.id}] ${event.type}\n`);
  },
};
const backgroundIntegration = {
  name: 'example-background',
  context: undefined,
  start(context) {
    this.context = context;
    context.reportHealth({ state: 'healthy' });
  },
  stop() {
    this.context = undefined;
  },
  onEvent(event) {
    if (event.type === 'session.activity.changed') {
      // Real integrations should coalesce this hint and reconcile outside the callback.
      process.stdout.write(`[integration hint ${event.id}] ${event.session} is ${event.activity}\n`);
    }
  },
};
const supervisor = new Supervisor(fleetDir, {
  channels: [channel],
  eventSubscribers: [eventLog],
  integrations: [backgroundIntegration],
  includeConfiguredChannels: false,
});

const shutdown = async () => {
  await supervisor.stop();
  process.exitCode = 0;
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await supervisor.start();
process.stdout.write('Embedding host started. Press Ctrl-C to stop.\n');
