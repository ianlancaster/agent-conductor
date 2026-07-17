import type { SessionConfig } from '../../src/config/schema.js';
import type { RuntimeEvent } from '../../src/core/types.js';
import type {
  SessionRuntime,
  IdentityEndpoints,
  LaunchOptions,
  RuntimeCapabilities,
} from '../../src/runtimes/types.js';

const EVENT_TYPES = new Set(['stop', 'notification', 'compaction', 'session-start', 'session-end']);

/** In-memory SessionRuntime for tests. Events are accepted as plain JSON `{type, reason?, transcriptPath?}`. */
export class FakeRuntime implements SessionRuntime {
  readonly name = 'fake';
  readonly capabilities: RuntimeCapabilities = { lifecycleEvents: true, contextProbe: false };

  readonly prepared: { session: SessionConfig; identity: IdentityEndpoints }[] = [];
  /** Controls parseInputClear; set to false to simulate the operator typing. */
  inputClear: boolean | null = true;
  readonly transcripts = new Map<string, string>();

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void> {
    this.prepared.push({ session, identity });
  }

  buildLaunchCommand(session: SessionConfig, _identity: IdentityEndpoints, opts: LaunchOptions): string {
    const parts = [`fake-launch ${session.codename}`];
    if (opts.continueSession) parts.push('--continue');
    if (opts.prompt !== undefined) parts.push(`--prompt ${JSON.stringify(opts.prompt)}`);
    return parts.join(' ');
  }

  parseInputClear(_capture: string): boolean | null {
    return this.inputClear;
  }

  stripChrome(capture: string): string {
    return capture;
  }

  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null {
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null;
    return {
      type: type as RuntimeEvent['type'],
      reason: typeof record.reason === 'string' ? record.reason : undefined,
      transcriptPath: typeof record.transcriptPath === 'string' ? record.transcriptPath : undefined,
    };
  }

  async readLastAssistantMessage(transcriptPath: string): Promise<string | null> {
    return this.transcripts.get(transcriptPath) ?? null;
  }
}
