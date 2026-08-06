import type { SessionConfig } from '../../src/config/schema.js';
import type { PaneActivityEvidence, RuntimeEvent } from '../../src/core/types.js';
import type {
  SessionRuntime,
  IdentityEndpoints,
  InputState,
  LaunchOptions,
  RuntimeCapabilities,
} from '../../src/runtimes/types.js';

const EVENT_TYPES = new Set([
  'turn-start',
  'stop',
  'notification',
  'compaction',
  'compaction-complete',
  'session-start',
  'session-end',
]);

/** In-memory SessionRuntime for tests. Events are accepted as plain JSON `{type, reason?, transcriptPath?}`. */
export class FakeRuntime implements SessionRuntime {
  readonly capabilities: RuntimeCapabilities = {
    lifecycleEvents: true,
    authoritativeTurnCompletion: true,
    contextProbe: false,
    styledCapture: false,
  };

  readonly prepared: { session: SessionConfig; identity: IdentityEndpoints }[] = [];
  readonly launches: { session: SessionConfig; opts: LaunchOptions }[] = [];
  /** Controls parseInputState; set to 'draft' to simulate occupied input. */
  inputState: InputState = 'clear';
  /** Controls execution-state observation independently from input readiness. */
  activityState: PaneActivityEvidence = 'unknown';
  readonly transcripts = new Map<string, string>();

  constructor(readonly name = 'fake') {}

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void> {
    this.prepared.push({ session, identity });
  }

  buildLaunchCommand(session: SessionConfig, _identity: IdentityEndpoints, opts: LaunchOptions): string {
    this.launches.push({ session, opts: { ...opts } });
    const parts = [`fake-launch ${session.codename}`];
    if (opts.continueSession) parts.push('--continue');
    if (opts.resumeSessionId !== undefined) parts.push(`--session-id ${JSON.stringify(opts.resumeSessionId)}`);
    if (opts.prompt !== undefined) parts.push(`--prompt ${JSON.stringify(opts.prompt)}`);
    return parts.join(' ');
  }

  parseInputState(_capture: string): InputState {
    return this.inputState;
  }

  parseActivityState(_capture: string): PaneActivityEvidence {
    return this.activityState;
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
