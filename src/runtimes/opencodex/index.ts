import type { SessionConfig, SupervisorConfig } from '../../config/schema.js';
import type { IdentityEndpoints, LaunchOptions } from '../types.js';
import { ClaudeCodeRuntime, type ClaudeCodeRuntimeOptions } from '../claude-code/index.js';
import { CodexRuntime, type CodexRuntimeOptions } from '../codex/index.js';
import { shellQuote, tomlString } from '../codex/config-gen.js';

type OpenCodexConfig = SupervisorConfig['runtimes']['openCodex'];

function requiredModel(session: SessionConfig): void {
  if (session.model === undefined || session.model.trim().length === 0) {
    throw new Error(`OpenCodex session '${session.codename}' needs an explicit model in its session configuration.`);
  }
}

function proxyHealthCommand(origin: string): string {
  return `curl -fsS --max-time 2 --output /dev/null ${shellQuote(`${origin}/healthz`)}`;
}

/** A separate, opt-in name over the native Codex lifecycle and pane integration. */
export class OpenCodexRuntime extends CodexRuntime {
  override readonly name = 'opencodex';

  constructor(
    options: CodexRuntimeOptions,
    private readonly proxyOrigin: string,
  ) {
    super(options);
  }

  override buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, options: LaunchOptions): string {
    requiredModel(session);
    return `${proxyHealthCommand(this.proxyOrigin)} && ${super.buildLaunchCommand(session, identity, options)}`;
  }

  protected override additionalConfigOverrides(_session: SessionConfig): string[] {
    return [
      `model_provider=${tomlString('opencodex')}`,
      `model_providers.opencodex.name=${tomlString('OpenCodex proxy')}`,
      `model_providers.opencodex.base_url=${tomlString(`${this.proxyOrigin}/v1`)}`,
      'model_providers.opencodex.wire_api="responses"',
      'model_providers.opencodex.requires_openai_auth=false',
    ];
  }
}

const CLAUDE_PROVIDER_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
] as const;

/**
 * Direct Claude Code proxy wiring. The `ocx claude` wrapper is unsuitable here:
 * it may intentionally fall back to native Claude when proxy routing is off.
 */
export class OpenCodexClaudeRuntime extends ClaudeCodeRuntime {
  override readonly name = 'opencodex-claude';

  constructor(
    options: ClaudeCodeRuntimeOptions,
    private readonly proxyOrigin: string,
  ) {
    super({
      ...options,
      config: {
        ...options.config,
        // Provider/auth settings may not be inherited from the ordinary Claude runtime.
        env: {
          ...Object.fromEntries(
            Object.entries(options.config.env).filter(
              ([key]) => !CLAUDE_PROVIDER_ENV.includes(key as (typeof CLAUDE_PROVIDER_ENV)[number]),
            ),
          ),
          ANTHROPIC_BASE_URL: proxyOrigin,
          // A non-secret placeholder forces gateway mode rather than native OAuth.
          ANTHROPIC_AUTH_TOKEN: 'opencodex-proxy',
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        },
      },
    });
  }

  override buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, options: LaunchOptions): string {
    requiredModel(session);
    return `unset ${CLAUDE_PROVIDER_ENV.join(' ')} && ${proxyHealthCommand(this.proxyOrigin)} && ${super.buildLaunchCommand(session, identity, options)}`;
  }
}

/** Resolve the mandatory URL once at supervisor construction. */
export function openCodexProxyOrigin(config: OpenCodexConfig): string {
  if (!config.enabled || config.proxyOrigin === null) throw new Error('OpenCodex runtime is not enabled.');
  return config.proxyOrigin.replace(/\/$/u, '');
}
