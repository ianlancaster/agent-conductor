import type { RuntimeName, SessionConfig } from '../config/schema.js';
import { CONDUCTOR_DOC_TOPICS } from './documentation.js';
import type { Lifecycle } from './lifecycle.js';
import type { Messaging } from './messaging.js';
import type { MessageReceipt } from './messaging.js';
import type { OperatorRequests } from './operator-requests.js';
import type { StallSentinelRouter } from './sentinel.js';
import type { SessionStateManager } from './state.js';
import { InvalidRequestError } from './errors.js';
import type { Placement } from './types.js';
import {
  operationSchema as schema,
  optionalString,
  requireString,
  stringProperty,
  validateOperationInput,
  type JsonPropertySchema,
  type OperationInputSchema,
} from './operation-schema.js';

export type { JsonPropertySchema, OperationInputSchema } from './operation-schema.js';

export type OperationAudience = 'operator' | 'session';

export type OperationActor = { audience: 'operator'; id: string } | { audience: 'session'; codename: string };

export interface OperationDefinition {
  name: string;
  description: string;
  audiences: readonly OperationAudience[];
  inputSchema: OperationInputSchema;
  /** The actor's identity is applied mechanically to messages made by this operation. */
  signedIdentity?: boolean;
  /** Cross-fleet command exposure is default-deny. Messaging phases expose no core operation. */
  federation?: 'never' | 'exposable';
  handler(args: Record<string, unknown>, actor: OperationActor): Promise<string | MessageReceipt>;
}

export interface ConductorOperationDeps {
  lifecycle: Lifecycle;
  messaging: Messaging;
  operatorRequests: OperatorRequests;
  sentinel: StallSentinelRouter;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  modelHints: Record<RuntimeName, readonly string[]>;
  effortHints: Record<RuntimeName, readonly string[]>;
  statusReport(codename?: string): string;
  tail(codename: string, lines: number): Promise<string>;
  /** Deliberately bypass the protected delivery queue for terminal control input. */
  typeInPane(codename: string, text: string): Promise<string>;
  tailLimits: { defaultLines: number; maxLines: number };
  fleetStallDefaultSeconds: number;
  retitle(codename: string): Promise<void>;
  summon(codename: string): Promise<string>;
  banish(codename: string): Promise<string>;
  setSentinel(codename: string | undefined): void;
  getDocumentation(topic?: string): Promise<string>;
}

const BOTH = ['operator', 'session'] as const;
const SESSION_ONLY = ['session'] as const;
const OPERATOR_ONLY = ['operator'] as const;

const optionsProperty: JsonPropertySchema = {
  type: 'array',
  description: 'Optional choices for the operator to select (1–8 unique choices)',
  minItems: 1,
  maxItems: 8,
  items: { type: 'string', minLength: 1, maxLength: 80 },
};

const placementProperty: JsonPropertySchema = {
  type: 'string',
  enum: ['pane', 'tab', 'window'],
  description: 'Where to place the session (default: pane)',
};

const headlessProperty: JsonPropertySchema = {
  type: 'boolean',
  description: 'Create the pane in the detached fleet session (tmux only)',
};

const bypassPermissionsProperty: JsonPropertySchema = {
  type: 'boolean',
  description: 'Override the fleet approval/sandbox bypass default for the new session',
};

const runtimeProperty: JsonPropertySchema = {
  type: 'string',
  enum: ['claude-code', 'cc', 'codex'],
  description: "Runtime for this run; cc aliases claude-code (default: the session's configured runtime)",
};

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function runtime(args: Record<string, unknown>): SessionConfig['runtime'] | undefined {
  const value = optionalString(args, 'runtime');
  if (value === undefined) return undefined;
  return value === 'cc' ? 'claude-code' : (value as SessionConfig['runtime']);
}

function placement(args: Record<string, unknown>): Placement | undefined {
  const value = args.placement;
  return value === 'pane' || value === 'tab' || value === 'window' ? value : undefined;
}

function actorName(actor: OperationActor): string {
  return actor.audience === 'operator' ? 'operator' : actor.codename;
}

function runtimeHintDescription(setting: 'model' | 'effort', hints: Record<RuntimeName, readonly string[]>): string {
  const runtimeHints = (['claude-code', 'codex'] as const)
    .map((runtime) => `${runtime}: ${hints[runtime].join(', ') || 'none configured'}`)
    .join('; ');
  return `Optional ${setting} override. Availability hints only (not exhaustive or validated): ${runtimeHints}.`;
}

function fleetSessions(args: Record<string, unknown>): string[] {
  const raw = requireString(args, 'sessions');
  return [
    ...new Set(
      raw
        .split(',')
        .map((session) => session.trim())
        .filter((session) => session.length > 0),
    ),
  ];
}

/**
 * Canonical conductor control plane. MCP and operator command adapters render
 * the definitions below; all behavior and validation ultimately passes through
 * invoke(), so surface drift is a testable contract rather than a convention.
 */
export class ConductorOperations {
  private readonly byName: Map<string, OperationDefinition>;

  constructor(private readonly deps: ConductorOperationDeps) {
    const definitions = this.buildDefinitions().map((definition) => ({
      ...definition,
      federation: definition.federation ?? ('never' as const),
    }));
    this.byName = new Map(definitions.map((definition) => [definition.name, definition]));
  }

  definitions(audience?: OperationAudience): OperationDefinition[] {
    const definitions = [...this.byName.values()];
    return audience === undefined
      ? definitions
      : definitions.filter((definition) => definition.audiences.includes(audience));
  }

  definition(name: string): OperationDefinition | undefined {
    return this.byName.get(name);
  }

  hasSession(codename: string): boolean {
    return this.deps.sessions().has(codename);
  }

  async invoke(name: string, args: Record<string, unknown>, actor: OperationActor): Promise<string | MessageReceipt> {
    const definition = this.byName.get(name);
    if (definition === undefined) throw new Error(`Unknown operation: ${name}`);
    if (!definition.audiences.includes(actor.audience)) {
      throw new Error(`${name} is not available to ${actor.audience} callers`);
    }
    validateOperationInput(definition.name, definition.inputSchema, args);
    return definition.handler(args, actor);
  }

  private buildDefinitions(): OperationDefinition[] {
    const templateNames = this.deps.lifecycle.templateNames();
    return [
      {
        name: 'send_to_session',
        description: "Send a message to another session's pane, starting it if needed.",
        audiences: BOTH,
        signedIdentity: true,
        inputSchema: schema(
          {
            codename: stringProperty('Target session codename'),
            message: stringProperty('Message text'),
            idempotencyKey: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'Optional sender-scoped key for durable deduplication',
            },
          },
          ['codename', 'message'],
        ),
        handler: (args, actor) =>
          this.deps.messaging.sendToSession(
            actorName(actor),
            requireString(args, 'codename'),
            requireString(args, 'message'),
            optionalString(args, 'idempotencyKey'),
          ),
      },
      {
        name: 'broadcast',
        description: 'Send a message to every active session except the sender. Use sparingly.',
        audiences: BOTH,
        signedIdentity: true,
        inputSchema: schema({ message: stringProperty('Message text') }, ['message']),
        handler: (args, actor) => this.deps.messaging.broadcast(actorName(actor), requireString(args, 'message')),
      },
      {
        name: 'send_to_operator',
        description: 'Send a message, optionally with selectable choices, to the operator.',
        audiences: SESSION_ONLY,
        signedIdentity: true,
        inputSchema: schema({ message: stringProperty('Message text'), options: optionsProperty }, ['message']),
        handler: (args, actor) =>
          this.deps.operatorRequests.send(
            actorName(actor),
            requireString(args, 'message'),
            optionalStringArray(args, 'options'),
          ),
      },
      {
        name: 'respond_to_operator_request',
        description: 'Answer one pending selectable request from a session.',
        audiences: OPERATOR_ONLY,
        inputSchema: schema(
          {
            requestId: { type: 'number', minimum: 1, description: 'Operator request ID' },
            option: { type: 'number', minimum: 1, description: 'One-based option number' },
          },
          ['requestId', 'option'],
        ),
        handler: (args) => this.deps.operatorRequests.respond(args.requestId as number, args.option as number),
      },
      {
        name: 'start_session',
        description:
          'Start one registered session, or all registered sessions, with optional runtime and effort overrides.',
        audiences: BOTH,
        inputSchema: schema(
          {
            codename: stringProperty("Session codename or 'all'"),
            runtime: runtimeProperty,
            effort: stringProperty(runtimeHintDescription('effort', this.deps.effortHints)),
            placement: placementProperty,
            headless: headlessProperty,
          },
          ['codename'],
        ),
        handler: (args, actor) =>
          this.forTargets(args, actor, 'start', (codename) =>
            this.deps.lifecycle.start(codename, {
              runtime: runtime(args),
              effort: optionalString(args, 'effort'),
              placement: placement(args),
              headless: args.headless === true,
            }),
          ),
      },
      {
        name: 'stop_session',
        description: 'Stop one running session, or all running sessions.',
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty("Session codename or 'all'") }, ['codename']),
        handler: (args, actor) =>
          this.forTargets(args, actor, 'stop', (codename) => this.deps.lifecycle.stop(codename)),
      },
      {
        name: 'continue_session',
        description:
          "Continue one session's most recent conversation, or all sessions, with optional runtime and effort overrides.",
        audiences: BOTH,
        inputSchema: schema(
          {
            codename: stringProperty("Session codename or 'all'"),
            runtime: runtimeProperty,
            effort: stringProperty(runtimeHintDescription('effort', this.deps.effortHints)),
            placement: placementProperty,
            headless: headlessProperty,
          },
          ['codename'],
        ),
        handler: (args, actor) =>
          this.forTargets(args, actor, 'continue', (codename) =>
            this.deps.lifecycle.continue(codename, {
              runtime: runtime(args),
              effort: optionalString(args, 'effort'),
              placement: placement(args),
              headless: args.headless === true,
            }),
          ),
      },
      {
        name: 'spawn_session',
        description:
          "Create, register, and start a session from an empty directory, registered template, or Git worktree. The destination is path or spawn.dirPattern; relative destinations resolve from the fleet directory. A new worktree branch starts at the source repository's current HEAD; existing branches are checked out as-is.",
        audiences: BOTH,
        inputSchema: schema(
          {
            codename: stringProperty('New session codename'),
            path: stringProperty(
              'Destination working directory (default: spawn.dirPattern with {codename} substituted)',
            ),
            runtime: {
              ...runtimeProperty,
              description: 'Agent runtime (default: supervisor defaults.runtime)',
            },
            bypassPermissions: bypassPermissionsProperty,
            model: stringProperty(runtimeHintDescription('model', this.deps.modelHints)),
            effort: stringProperty(runtimeHintDescription('effort', this.deps.effortHints)),
            template: {
              ...stringProperty(
                `Registered Git template${templateNames.length > 0 ? ` (${templateNames.join(', ')})` : ' (none configured)'}`,
              ),
              ...(templateNames.length > 0 ? { enum: templateNames } : {}),
            },
            worktreeRepo: stringProperty('Existing source repository from which to create a linked worktree'),
            branch: stringProperty(
              "Worktree branch (default: codename); a missing branch is created at the source repository's current HEAD",
            ),
            placement: placementProperty,
            headless: headlessProperty,
          },
          ['codename'],
        ),
        handler: (args) =>
          this.deps.lifecycle.spawn(requireString(args, 'codename'), {
            path: optionalString(args, 'path'),
            runtime: runtime(args),
            bypassPermissions: typeof args.bypassPermissions === 'boolean' ? args.bypassPermissions : undefined,
            model: optionalString(args, 'model'),
            effort: optionalString(args, 'effort'),
            template: optionalString(args, 'template'),
            worktreeRepo: optionalString(args, 'worktreeRepo'),
            branch: optionalString(args, 'branch'),
            placement: placement(args),
            headless: args.headless === true,
          }),
      },
      {
        name: 'teardown_session',
        description:
          'Stop and deregister a session, optionally removing its guarded working directory. Git-ignored files do not make a worktree dirty and are deleted with it.',
        audiences: BOTH,
        inputSchema: schema(
          {
            codename: stringProperty('Session codename'),
            deleteDir: {
              type: 'boolean',
              description: 'Also remove the working directory when safe; ignored files do not block removal',
            },
          },
          ['codename'],
        ),
        handler: (args, actor) => {
          const codename = requireString(args, 'codename');
          this.noSelf(actor, codename, 'tear down');
          return this.deps.lifecycle.teardown(codename, args.deleteDir === true);
        },
      },
      {
        name: 'get_message_status',
        description: 'Inspect a direct-message receipt, including delivery time and the latest flush decision.',
        audiences: BOTH,
        inputSchema: schema({ messageId: { type: 'number', minimum: 1, description: 'Message receipt id' } }, [
          'messageId',
        ]),
        handler: async (args, actor) => {
          const messageId = args.messageId;
          if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 1) {
            throw new InvalidRequestError("'messageId' is required and must be a positive integer");
          }
          return this.deps.messaging.messageStatus(
            messageId,
            actor.audience === 'session' ? actor.codename : undefined,
          );
        },
      },
      {
        name: 'cancel_message',
        description: 'Cancel a pending direct message by receipt id before it begins writing to the recipient pane.',
        audiences: BOTH,
        inputSchema: schema({ messageId: { type: 'number', minimum: 1, description: 'Message receipt id' } }, [
          'messageId',
        ]),
        handler: async (args, actor) => {
          const messageId = args.messageId;
          if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 1) {
            throw new InvalidRequestError("'messageId' is required and must be a positive integer");
          }
          return this.deps.messaging.cancelMessage(
            messageId,
            actor.audience === 'session' ? actor.codename : undefined,
          );
        },
      },
      {
        name: 'toggle_auto',
        description: 'Toggle auto stall handling for one session, or all sessions.',
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty("Session codename or 'all'") }, ['codename']),
        handler: (args, actor) =>
          this.forTargets(args, actor, 'toggle auto for', (codename) => {
            const auto = this.deps.states.toggleAuto(codename);
            this.deps.sentinel.reset(codename);
            return Promise.resolve(`${codename}: auto ${auto ? 'on' : 'off'}`);
          }),
      },
      {
        name: 'pause_session',
        description: 'Pause one session, or all sessions: suppress schedules and stall routing.',
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty("Session codename or 'all'") }, ['codename']),
        handler: (args, actor) =>
          this.forTargets(args, actor, 'pause', (codename) => {
            const paused = this.deps.states.pause(codename);
            if (paused) this.deps.sentinel.reset(codename);
            return Promise.resolve(paused ? `${codename}: paused` : `${codename}: already paused`);
          }),
      },
      {
        name: 'resume_session',
        description: 'Resume one paused session, or all paused sessions.',
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty("Session codename or 'all'") }, ['codename']),
        handler: (args, actor) =>
          this.forTargets(args, actor, 'resume', (codename) => {
            const resumed = this.deps.states.resume(codename);
            if (resumed) this.deps.sentinel.reset(codename);
            return Promise.resolve(resumed ? `${codename}: resumed` : `${codename}: not paused`);
          }),
      },
      {
        name: 'set_sentinel',
        description: 'Designate a registered session as the stall sentinel, or omit codename to clear it.',
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty('Session codename; omit to clear') }),
        handler: (args) => {
          const codename = optionalString(args, 'codename');
          this.deps.setSentinel(codename);
          return Promise.resolve(
            codename === undefined ? 'Stall sentinel cleared.' : `${codename} set as stall sentinel.`,
          );
        },
      },
      {
        name: 'arm_fleet_watch',
        description: `Watch a session group and alert the sentinel—or the operator when none is designated—when every member remains stalled (default confirmation: ${String(this.deps.fleetStallDefaultSeconds)}s).`,
        audiences: BOTH,
        inputSchema: schema(
          {
            name: stringProperty('Short name for this fleet watch'),
            sessions: stringProperty('Comma-separated session codenames (at least two; do not include the sentinel)'),
            thresholdSeconds: {
              type: 'number',
              minimum: 0,
              description: `Seconds all members must remain stalled (default: ${String(this.deps.fleetStallDefaultSeconds)})`,
            },
          },
          ['name', 'sessions'],
        ),
        handler: (args) => {
          const name = requireString(args, 'name');
          const sessions = fleetSessions(args);
          if (sessions.length < 2) throw new InvalidRequestError('A fleet watch needs at least two distinct sessions.');
          for (const codename of sessions) {
            if (!this.deps.sessions().has(codename)) throw new InvalidRequestError(`Unknown session: ${codename}`);
          }
          const thresholdSeconds =
            typeof args.thresholdSeconds === 'number'
              ? Math.floor(args.thresholdSeconds)
              : this.deps.fleetStallDefaultSeconds;
          this.deps.sentinel.armFleetWatch({ name, sessions, thresholdSeconds });
          const noSentinelNote =
            this.deps.sentinel.sentinelCodename() === undefined
              ? ' No sentinel is designated; alerts will go to the operator.'
              : '';
          return Promise.resolve(
            `Fleet watch '${name}' armed for ${sessions.join(', ')} (${String(thresholdSeconds)}s confirmation).${noSentinelNote}`,
          );
        },
      },
      {
        name: 'disarm_fleet_watch',
        description: 'Disarm one fleet stall watch.',
        audiences: BOTH,
        inputSchema: schema({ name: stringProperty('Fleet watch name') }, ['name']),
        handler: (args) => {
          const name = requireString(args, 'name');
          return Promise.resolve(
            this.deps.sentinel.disarmFleetWatch(name)
              ? `Fleet watch '${name}' disarmed.`
              : `No fleet watch named '${name}'.`,
          );
        },
      },
      {
        name: 'list_fleet_watches',
        description: 'List armed fleet stall watches and their current state.',
        audiences: BOTH,
        inputSchema: schema(),
        handler: () => {
          const watches = this.deps.sentinel.listFleetWatches();
          if (watches.length === 0) return Promise.resolve('No fleet watches armed.');
          return Promise.resolve(
            watches
              .map((watch) => {
                const stalled = watch.stalledSessions.length > 0 ? watch.stalledSessions.join(',') : 'none';
                return `${watch.name} · ${watch.state} · sessions ${watch.sessions.join(',')} · stalled ${stalled} · ${String(watch.thresholdSeconds)}s`;
              })
              .join('\n'),
          );
        },
      },
      {
        name: 'set_tag',
        description: 'Set or clear a short status label on a session.',
        audiences: BOTH,
        inputSchema: schema(
          { codename: stringProperty('Session codename'), tag: stringProperty('Status label; omit to clear') },
          ['codename'],
        ),
        handler: async (args) => {
          const codename = requireString(args, 'codename');
          if (!this.deps.states.has(codename)) throw new InvalidRequestError(`Unknown session: ${codename}`);
          const tag = optionalString(args, 'tag');
          this.deps.states.setTag(codename, tag);
          await this.deps.retitle(codename);
          return tag === undefined ? `Tag cleared for ${codename}.` : `${codename} tagged '${tag}'.`;
        },
      },
      {
        name: 'whoami',
        description: 'Return the calling session identity and status derived from its MCP connection.',
        audiences: SESSION_ONLY,
        inputSchema: schema(),
        handler: (_args, actor) => {
          if (actor.audience !== 'session') throw new InvalidRequestError('whoami requires a session caller');
          const state = this.deps.states.get(actor.codename);
          return Promise.resolve(
            JSON.stringify(
              {
                codename: actor.codename,
                registered: this.deps.sessions().has(actor.codename),
                runtime: this.deps.lifecycle.runtimeNameFor(actor.codename) ?? null,
                isSentinel: this.deps.sentinel.isSentinel(actor.codename),
                auto: state?.auto ?? null,
                activity: state?.activity ?? null,
                running: state?.running ?? false,
                ready: state?.ready ?? false,
                tag: state?.tag ?? null,
                paused: state?.paused ?? false,
              },
              null,
              2,
            ),
          );
        },
      },
      {
        name: 'get_conductor_docs',
        description:
          'List or lazily read the version-matched Agent Conductor handbook, including fleet recipes, configuration paths, adapters, worktrees, scheduling, supervision, federation, and troubleshooting.',
        audiences: SESSION_ONLY,
        inputSchema: schema({
          topic: {
            type: 'string',
            enum: CONDUCTOR_DOC_TOPICS,
            description: 'Optional handbook topic; omit to list topics and authoritative fleet paths',
          },
        }),
        handler: (args) => this.deps.getDocumentation(optionalString(args, 'topic')),
      },
      {
        name: 'list_sessions',
        description:
          'List all registered sessions with runtime status, working-directory path, and current Git branch.',
        audiences: BOTH,
        inputSchema: schema(),
        handler: async () => {
          await this.deps.lifecycle.reconcile();
          return this.deps.statusReport();
        },
      },
      {
        name: 'get_session_status',
        description:
          'Return detailed status for one session as JSON, including its working-directory path, branch, and Conductor-resolved model and effort.',
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty('Session codename') }, ['codename']),
        handler: async (args) => {
          const codename = requireString(args, 'codename');
          await this.deps.lifecycle.reconcile(codename);
          return this.deps.statusReport(codename);
        },
      },
      {
        name: 'tail_session',
        description: `Read trailing pane output (default ${String(this.deps.tailLimits.defaultLines)} lines, maximum ${String(this.deps.tailLimits.maxLines)}). Reserve this for user-requested inspection or diagnosing unanswered/failed peer communication; use send_to_session for normal agent conversation and status requests.`,
        audiences: BOTH,
        inputSchema: schema(
          {
            codename: stringProperty('Session codename'),
            lines: { type: 'number', minimum: 1, description: 'Number of trailing lines' },
          },
          ['codename'],
        ),
        handler: (args) => {
          const requested = typeof args.lines === 'number' ? Math.floor(args.lines) : this.deps.tailLimits.defaultLines;
          const lines = Math.min(Math.max(requested, 1), this.deps.tailLimits.maxLines);
          return this.deps.tail(requireString(args, 'codename'), lines);
        },
      },
      {
        name: 'type_in_pane',
        description:
          "Type raw text immediately into a session's pane without a message envelope or delivery queue. This can overwrite terminal input; use it deliberately for prompts and slash commands.",
        audiences: BOTH,
        inputSchema: schema({ codename: stringProperty('Session codename'), text: stringProperty('Raw text') }, [
          'codename',
          'text',
        ]),
        handler: async (args) => {
          const codename = requireString(args, 'codename');
          return this.deps.typeInPane(codename, requireString(args, 'text'));
        },
      },
      {
        name: 'summon_session',
        description: "Bring a session's pane into the operator's current view.",
        audiences: OPERATOR_ONLY,
        inputSchema: schema({ codename: stringProperty('Session codename') }, ['codename']),
        handler: (args) => {
          const codename = requireString(args, 'codename');
          if (!this.deps.states.has(codename)) return Promise.resolve(`Unknown session: ${codename}`);
          return this.deps.summon(codename);
        },
      },
      {
        name: 'banish_session',
        description: "Move a session's pane into the detached fleet session while it keeps running.",
        audiences: OPERATOR_ONLY,
        inputSchema: schema({ codename: stringProperty('Session codename') }, ['codename']),
        handler: (args) => {
          const codename = requireString(args, 'codename');
          if (!this.deps.states.has(codename)) return Promise.resolve(`Unknown session: ${codename}`);
          return this.deps.banish(codename);
        },
      },
    ];
  }

  private async forTargets(
    args: Record<string, unknown>,
    actor: OperationActor,
    verb: string,
    action: (codename: string) => Promise<string>,
  ): Promise<string> {
    const target = requireString(args, 'codename');
    if (target !== 'all') {
      this.noSelf(actor, target, verb);
      if (!this.deps.states.has(target)) return `Unknown session: ${target}`;
      return action(target);
    }

    const results: string[] = [];
    for (const codename of this.deps.sessions().keys()) {
      if (actor.audience === 'session' && codename === actor.codename) continue;
      results.push(await action(codename));
    }
    return results.join('\n');
  }

  private noSelf(actor: OperationActor, codename: string, verb: string): void {
    if (actor.audience === 'session' && actor.codename === codename) {
      throw new InvalidRequestError(`You cannot ${verb} yourself.`);
    }
  }
}
