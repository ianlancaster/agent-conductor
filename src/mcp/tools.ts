import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue } from '../core/delivery.js';
import type { HumanInputBroker } from '../core/human-input.js';
import type { Lifecycle } from '../core/lifecycle.js';
import type { Messaging } from '../core/messaging.js';
import type { StallSentinelRouter } from '../core/sentinel.js';
import type { SessionStateManager } from '../core/state.js';
import type { Placement, StallResolution } from '../core/types.js';
import { sleep } from '../core/utils.js';
import { isWorktree } from '../core/worktree.js';
import type { McpToolDefinition } from './server.js';

export interface McpToolDeps {
  lifecycle: Lifecycle;
  messaging: Messaging;
  humanInput: HumanInputBroker;
  sentinel: StallSentinelRouter;
  states: SessionStateManager;
  delivery: DeliveryQueue;
  sessions(): Map<string, SessionConfig>;
  statusReport(codename?: string): string;
  tail(codename: string, lines: number): Promise<string>;
  tailLimits: { defaultLines: number; maxLines: number };
}

const IDENTITY_NOTE = 'Your identity is determined automatically by the conductor.';

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`'${name}' is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalPlacement(args: Record<string, unknown>): Placement | undefined {
  const value = args.placement;
  return value === 'pane' || value === 'tab' || value === 'window' ? value : undefined;
}

const placementSchema = {
  type: 'string',
  enum: ['pane', 'tab', 'window'],
  description: 'Where to place the session (default: pane)',
};

export function buildMcpTools(deps: McpToolDeps): McpToolDefinition[] {
  const noSelf = (caller: string, target: string, verb: string): void => {
    if (caller === target) throw new Error(`You cannot ${verb} yourself.`);
  };

  return [
    {
      name: 'send_to_session',
      description: `Send a message to another session's pane. Starts the session if it is not running. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string', description: 'Target session codename' },
          message: { type: 'string', description: 'Message text' },
        },
        required: ['codename', 'message'],
      },
      handler: (args, caller) =>
        deps.messaging.sendToSession(caller, requireString(args, 'codename'), requireString(args, 'message')),
    },
    {
      name: 'broadcast',
      description: `Send a message to ALL active sessions. Use carefully and sparingly — prefer send_to_session or notify_sessions with explicit recipients. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Message text' } },
        required: ['message'],
      },
      handler: (args, caller) => deps.messaging.broadcast(caller, requireString(args, 'message')),
    },
    {
      name: 'notify_sessions',
      description: `Queue a notification for sessions, delivered when they next start a session. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          recipients: { type: 'array', items: { type: 'string' }, description: 'Codenames (default: all sessions)' },
        },
        required: ['message'],
      },
      handler: (args, caller) => {
        const recipients = Array.isArray(args.recipients)
          ? args.recipients.filter((r): r is string => typeof r === 'string')
          : undefined;
        return Promise.resolve(deps.messaging.notify(caller, requireString(args, 'message'), recipients));
      },
    },
    {
      name: 'respond_to_user',
      description: `Send a message to the human operator over the connected channel. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      handler: (args, caller) => deps.messaging.respondToUser(caller, requireString(args, 'message')),
    },
    {
      name: 'request_human_input',
      description: `Ask for a decision that needs human judgment. Blocks until answered. In autonomous mode the sentinel answers or escalates; otherwise the question goes to the operator. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context: { type: 'string', description: 'Optional background for the decision' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional preset answers' },
        },
        required: ['question'],
      },
      handler: (args, caller) => {
        const options = Array.isArray(args.options)
          ? args.options.filter((o): o is string => typeof o === 'string')
          : undefined;
        return deps.humanInput.request(
          caller,
          requireString(args, 'question'),
          optionalString(args, 'context'),
          options,
        );
      },
    },
    {
      name: 'start_session',
      description: `Start another session's session. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string' },
          prompt: { type: 'string', description: 'Optional initial prompt' },
          placement: placementSchema,
        },
        required: ['codename'],
      },
      handler: (args, caller) => {
        const codename = requireString(args, 'codename');
        noSelf(caller, codename, 'start');
        return deps.lifecycle.start(codename, {
          prompt: optionalString(args, 'prompt'),
          placement: optionalPlacement(args),
        });
      },
    },
    {
      name: 'stop_session',
      description: `Stop another session's session. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' } },
        required: ['codename'],
      },
      handler: (args, caller) => {
        const codename = requireString(args, 'codename');
        noSelf(caller, codename, 'stop');
        return deps.lifecycle.stop(codename);
      },
    },
    {
      name: 'continue_session',
      description: `Resume another session's most recent session. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' }, placement: placementSchema },
        required: ['codename'],
      },
      handler: (args, caller) => {
        const codename = requireString(args, 'codename');
        noSelf(caller, codename, 'continue');
        return deps.lifecycle.continue(codename, { placement: optionalPlacement(args) });
      },
    },
    {
      name: 'spawn_session',
      description: `Create and start a new session: makes a directory, registers a config, starts a session. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string' },
          path: { type: 'string', description: 'Working directory (default: spawn.dirPattern)' },
          model: { type: 'string' },
          prompt: { type: 'string' },
          placement: placementSchema,
        },
        required: ['codename'],
      },
      handler: (args, _caller) =>
        deps.lifecycle.spawn(requireString(args, 'codename'), {
          path: optionalString(args, 'path'),
          model: optionalString(args, 'model'),
          prompt: optionalString(args, 'prompt'),
          placement: optionalPlacement(args),
        }),
    },
    {
      name: 'create_worktree',
      description: `Create a new session whose working directory is a git worktree of an existing repository — parallel work on one repo with full file isolation. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string', description: 'New session codename' },
          repo: { type: 'string', description: 'Path to the existing git repository' },
          branch: { type: 'string', description: 'Branch to create/check out (default: the codename)' },
          model: { type: 'string' },
          prompt: { type: 'string' },
          placement: placementSchema,
        },
        required: ['codename', 'repo'],
      },
      handler: (args, _caller) =>
        deps.lifecycle.spawn(requireString(args, 'codename'), {
          worktreeRepo: requireString(args, 'repo'),
          branch: optionalString(args, 'branch'),
          model: optionalString(args, 'model'),
          prompt: optionalString(args, 'prompt'),
          placement: optionalPlacement(args),
        }),
    },
    {
      name: 'remove_worktree',
      description: `Stop a worktree session, deregister it, and remove its git worktree (refuses dirty worktrees). ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' } },
        required: ['codename'],
      },
      handler: (args, caller) => {
        const codename = requireString(args, 'codename');
        noSelf(caller, codename, 'remove');
        const session = deps.sessions().get(codename);
        if (session === undefined) throw new Error(`Unknown session: ${codename}`);
        if (!isWorktree(session.repo))
          throw new Error(`${codename}'s directory is not a git worktree — use teardown_session.`);
        return deps.lifecycle.teardown(codename, true);
      },
    },
    {
      name: 'teardown_session',
      description: `Stop and deregister a session. Refuses to delete directories containing a git repo or session marker. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string' },
          deleteDir: { type: 'boolean', description: 'Also delete the working directory (guarded)' },
        },
        required: ['codename'],
      },
      handler: (args, caller) => {
        const codename = requireString(args, 'codename');
        noSelf(caller, codename, 'tear down');
        return deps.lifecycle.teardown(codename, args.deleteDir === true);
      },
    },
    {
      name: 'set_autonomy',
      description: `Set another session's autonomy mode: 'autonomous' routes stalls to the sentinel; 'facilitated' means the operator drives. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string' },
          mode: { type: 'string', enum: ['facilitated', 'autonomous'] },
        },
        required: ['codename', 'mode'],
      },
      handler: (args, caller) => {
        const codename = requireString(args, 'codename');
        noSelf(caller, codename, 'set autonomy for');
        const mode = args.mode;
        if (mode !== 'facilitated' && mode !== 'autonomous') {
          throw new Error("mode must be 'facilitated' or 'autonomous'");
        }
        if (!deps.states.has(codename)) throw new Error(`Unknown session: ${codename}`);
        deps.states.setAutonomy(codename, mode);
        return Promise.resolve(`${codename} set to ${mode}.`);
      },
    },
    {
      name: 'set_tag',
      description: `Set or clear a short status label on a session (shown in status output). ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' }, tag: { type: 'string', description: 'Omit to clear' } },
        required: ['codename'],
      },
      handler: (args, _caller) => {
        const codename = requireString(args, 'codename');
        if (!deps.states.has(codename)) throw new Error(`Unknown session: ${codename}`);
        const tag = optionalString(args, 'tag');
        deps.states.setTag(codename, tag);
        return Promise.resolve(tag === undefined ? `Tag cleared for ${codename}.` : `${codename} tagged '${tag}'.`);
      },
    },
    {
      name: 'get_tag',
      description: "Get a session's current tag.",
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' } },
        required: ['codename'],
      },
      handler: (args, _caller) => {
        const codename = requireString(args, 'codename');
        return Promise.resolve(deps.states.getTag(codename) ?? '(no tag)');
      },
    },
    {
      name: 'whoami',
      description:
        'Return your own codename and status. Your identity is mechanical — the conductor derives it from the connection, so this is authoritative.',
      inputSchema: { type: 'object', properties: {} },
      handler: (_args, caller) => {
        const state = deps.states.get(caller);
        return Promise.resolve(
          JSON.stringify(
            {
              codename: caller,
              registered: deps.sessions().has(caller),
              isSentinel: deps.sentinel.isSentinel(caller),
              autonomy: state?.autonomy ?? null,
              activity: state?.activity ?? null,
              running: state?.running ?? false,
              ready: state?.ready ?? false,
              tag: state?.tag ?? null,
            },
            null,
            2,
          ),
        );
      },
    },
    {
      name: 'list_sessions',
      description: 'List all sessions with their status.',
      inputSchema: { type: 'object', properties: {} },
      handler: (_args, _caller) => Promise.resolve(deps.statusReport()),
    },
    {
      name: 'get_session_status',
      description: 'Detailed status for one session as JSON.',
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' } },
        required: ['codename'],
      },
      handler: (args, _caller) => Promise.resolve(deps.statusReport(requireString(args, 'codename'))),
    },
    {
      name: 'session_exists',
      description: 'Whether a session with this codename is registered.',
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' } },
        required: ['codename'],
      },
      handler: (args, _caller) => Promise.resolve(String(deps.sessions().has(requireString(args, 'codename')))),
    },
    {
      name: 'tail_session',
      description: `Read the trailing pane output of another session (default ${String(deps.tailLimits.defaultLines)} lines, max ${String(deps.tailLimits.maxLines)}).`,
      inputSchema: {
        type: 'object',
        properties: {
          codename: { type: 'string' },
          lines: { type: 'number', minimum: 1, maximum: deps.tailLimits.maxLines },
        },
        required: ['codename'],
      },
      handler: (args, _caller) => {
        const codename = requireString(args, 'codename');
        const requested = typeof args.lines === 'number' ? Math.floor(args.lines) : deps.tailLimits.defaultLines;
        const lines = Math.min(Math.max(requested, 1), deps.tailLimits.maxLines);
        return deps.tail(codename, lines);
      },
    },
    {
      name: 'type_in_pane',
      description: `Type raw text into another session's pane with no envelope — for answering prompts or slash commands. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { codename: { type: 'string' }, text: { type: 'string' } },
        required: ['codename', 'text'],
      },
      handler: async (args, _caller) => {
        const codename = requireString(args, 'codename');
        const result = await deps.delivery.deliverOrQueue(codename, requireString(args, 'text'));
        return result === 'no-pane' ? `${codename} has no active pane.` : `Text ${result}.`;
      },
    },
    {
      name: 'request_restart',
      description: `Request a full restart of your own session (fresh context). Happens a few seconds after your turn ends. ${IDENTITY_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
      handler: (args, caller) => {
        const reason = requireString(args, 'reason');
        void (async () => {
          await sleep(3000);
          await deps.lifecycle.restart(caller, {});
        })();
        return Promise.resolve(`Restart scheduled (${reason}). Wrap up now — your session restarts shortly.`);
      },
    },
    // ── sentinel-gated ────────────────────────────────────────────────────────
    {
      name: 'get_stall_queue',
      description: 'SENTINEL: list unresolved stall events with pane captures and transcript excerpts.',
      sentinelOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: (_args, _caller) => Promise.resolve(JSON.stringify(deps.sentinel.pendingStalls(), null, 2)),
    },
    {
      name: 'resolve_stall',
      description:
        "SENTINEL: resolve a stall. action 'nudge' types text into the stalled session's session; 'suppress' dismisses it; 'escalate' asks the operator.",
      sentinelOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          action: { type: 'string', enum: ['nudge', 'suppress', 'escalate'] },
          text: { type: 'string', description: "Nudge text (action 'nudge')" },
          note: { type: 'string', description: "Optional note (action 'suppress')" },
          question: { type: 'string', description: "Question for the operator (action 'escalate')" },
        },
        required: ['id', 'action'],
      },
      handler: (args, caller) => {
        const id = typeof args.id === 'number' ? args.id : Number.NaN;
        if (!Number.isInteger(id)) throw new Error("'id' must be an integer");
        let resolution: StallResolution;
        switch (args.action) {
          case 'nudge':
            resolution = { action: 'nudge', text: requireString(args, 'text') };
            break;
          case 'suppress':
            resolution = { action: 'suppress', note: optionalString(args, 'note') };
            break;
          case 'escalate':
            resolution = { action: 'escalate', question: requireString(args, 'question') };
            break;
          default:
            throw new Error("action must be 'nudge', 'suppress', or 'escalate'");
        }
        return deps.sentinel.resolve(id, resolution, caller);
      },
    },
    {
      name: 'answer_human_input',
      description: 'SENTINEL: answer a pending human-input request on behalf of the operator.',
      sentinelOnly: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, answer: { type: 'string' } },
        required: ['id', 'answer'],
      },
      handler: (args, _caller) => {
        const id = typeof args.id === 'number' ? args.id : Number.NaN;
        if (!Number.isInteger(id)) throw new Error("'id' must be an integer");
        const session = deps.humanInput.answer(id, requireString(args, 'answer'));
        return Promise.resolve(
          session === undefined ? `No pending question #${String(id)}.` : `Answer delivered to ${session}.`,
        );
      },
    },
  ];
}
