import type { SlackClientFactory, SlackClients, SlackSocketClient, SlackWebClient } from './types.js';
import { log } from '../../logger.js';

const REQUEST_TIMEOUT_MS = 15_000;

interface SocketModeModule {
  LogLevel: { ERROR: unknown };
  SocketModeClient: new (options: Record<string, unknown>) => SlackSocketClient;
}

interface WebApiModule {
  WebClient: new (token: string, options: Record<string, unknown>) => SlackWebClient;
}

export interface SlackSdkLoaders {
  socketMode(): Promise<SocketModeModule>;
  webApi(): Promise<WebApiModule>;
  undici(): Promise<unknown>;
}

/** Build a lazy client factory. The injectable loaders pin missing-peer behavior in tests. */
export function createSlackClientFactory(loaders: SlackSdkLoaders): SlackClientFactory {
  return {
    async create(config): Promise<SlackClients> {
      try {
        const [socketMode, webApi] = await Promise.all([loaders.socketMode(), loaders.webApi(), loaders.undici()]);
        const webOptions = {
          timeout: REQUEST_TIMEOUT_MS,
          maxRequestConcurrency: 1,
          rejectRateLimitedCalls: true,
          retryConfig: { retries: 2, factor: 2, minTimeout: 100, maxTimeout: 1_000, randomize: true },
          logger: sdkLogger(socketMode.LogLevel.ERROR),
        };
        return {
          web: new webApi.WebClient(config.botToken, webOptions),
          socket: new socketMode.SocketModeClient({
            appToken: config.appToken,
            autoReconnectEnabled: true,
            clientPingTimeout: 5_000,
            serverPingTimeout: 30_000,
            pingPongLoggingEnabled: false,
            logger: webOptions.logger,
            clientOptions: webOptions,
          }),
        };
      } catch (error) {
        if (isMissingPackage(error)) {
          throw Object.assign(
            new Error(
              'Slack is enabled but its optional packages are unavailable. Install @slack/socket-mode, ' +
                '@slack/web-api, and undici (or reinstall agent-conductor without --omit=optional).',
            ),
            { code: 'slack_dependencies_missing' },
          );
        }
        throw error;
      }
    },
  };
}

/** The SDK can include URLs and payloads in prose logs; bridge only severity. */
function sdkLogger(level: unknown): Record<string, unknown> {
  return {
    getLevel: () => level,
    setLevel: () => undefined,
    setName: () => undefined,
    debug: () => log().debug('slack-sdk', 'SDK debug event (details redacted)'),
    info: () => log().info('slack-sdk', 'SDK info event (details redacted)'),
    warn: () => log().warn('slack-sdk', 'SDK warning (details redacted)'),
    error: () => log().error('slack-sdk', 'SDK error (details redacted)'),
  };
}

/** Lazy factory: importing agent-conductor never loads optional Slack packages. */
export const defaultSlackClientFactory = createSlackClientFactory({
  socketMode: async () => (await import('@slack/socket-mode')) as unknown as SocketModeModule,
  webApi: async () => import('@slack/web-api'),
  // @slack/socket-mode requires this peer for its WebSocket heartbeat.
  undici: async () => import('undici'),
});

function isMissingPackage(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' ||
      (error as { code?: unknown }).code === 'MODULE_NOT_FOUND')
  );
}
