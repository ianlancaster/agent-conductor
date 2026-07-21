import type { ConductorOperations, OperationActor } from './operations.js';
import { renderMessageReceipt } from './messaging.js';
import type { Placement } from './types.js';

/** Tokenize a command line, honoring double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) tokens.push(match[1] ?? match[2] ?? '');
  return tokens;
}

type CommandGroup = 'Sessions' | 'Conversation' | 'Modes' | 'Lifecycle';

export interface OperatorCommandDefinition {
  command: string;
  aliases?: readonly string[];
  operations: readonly string[];
  group: CommandGroup;
  usage: string;
  description: string;
  details?: readonly string[];
  invoke(args: string[], actor: OperationActor): Promise<string>;
}

interface ParsedPlacement {
  placement?: Placement;
  headless?: boolean;
  rest: string[];
}

function parseSessionLaunch(args: string[], command: 'start' | 'continue'): Record<string, unknown> {
  const parsed = parsePlacement(args);
  const rest: string[] = [];
  let runtime: string | undefined;
  for (let index = 0; index < parsed.rest.length; index += 1) {
    const arg = parsed.rest[index];
    if (arg === '--runtime' || arg === '-r') {
      runtime = parsed.rest[index + 1];
      if (runtime === undefined) usage(`/${command} <session|all> [-r runtime] [placement]`);
      index += 1;
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  if (rest.length !== 1 || rest[0] === undefined) {
    usage(`/${command} <session|all> [-r runtime] [placement]`);
  }
  return {
    codename: rest[0],
    ...(runtime !== undefined ? { runtime } : {}),
    ...(parsed.placement !== undefined ? { placement: parsed.placement } : {}),
    ...(parsed.headless === true ? { headless: true } : {}),
  };
}

function usage(message: string): never {
  throw new Error(`Usage: ${message}`);
}

function parsePlacement(args: string[]): ParsedPlacement {
  let placement: Placement | undefined;
  let headless = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === '--pane' || arg === '-P') placement = 'pane';
    else if (arg === '--tab' || arg === '-T') placement = 'tab';
    else if (arg === '--window' || arg === '-W') placement = 'window';
    else if (arg === '--headless' || arg === '-H') headless = true;
    else rest.push(arg);
  }
  return { placement, ...(headless ? { headless: true } : {}), rest };
}

function oneTarget(args: string[], command: string): string {
  if (args.length !== 1 || args[0] === undefined) usage(`/${command} <session|all>`);
  return args[0];
}

function operationDescription(operations: ConductorOperations, name: string): string {
  const definition = operations.definition(name);
  if (definition === undefined) throw new Error(`Missing operation definition: ${name}`);
  return definition.description;
}

/**
 * Operator command metadata and parsing. Help is rendered from this registry,
 * and each entry invokes a named canonical operation rather than core modules.
 */
export function buildOperatorCommands(operations: ConductorOperations): OperatorCommandDefinition[] {
  const invoke = (name: string, args: Record<string, unknown>, actor: OperationActor): Promise<string> =>
    operations
      .invoke(name, args, actor)
      .then((result) => (typeof result === 'string' ? result : renderMessageReceipt(result)));

  const targetCommand = (
    command: string,
    operation: string,
    group: CommandGroup,
    description = operationDescription(operations, operation),
  ): OperatorCommandDefinition => ({
    command,
    operations: [operation],
    group,
    usage: `/${command} <session|all>`,
    description,
    invoke: (args, actor) => invoke(operation, { codename: oneTarget(args, command) }, actor),
  });

  return [
    {
      command: 'status',
      operations: ['list_sessions', 'get_session_status'],
      group: 'Sessions',
      usage: '/status [session]',
      description: 'Show the fleet overview or detailed status for one session.',
      invoke: (args, actor) => {
        if (args.length > 1) usage('/status [session]');
        return args[0] === undefined
          ? invoke('list_sessions', {}, actor)
          : invoke('get_session_status', { codename: args[0] }, actor);
      },
    },
    {
      command: 'start',
      operations: ['start_session'],
      group: 'Sessions',
      usage: '/start <session|all> [-r|--runtime cc|claude-code|codex] [placement]',
      description: operationDescription(operations, 'start_session'),
      invoke: (args, actor) => invoke('start_session', parseSessionLaunch(args, 'start'), actor),
    },
    {
      command: 'continue',
      operations: ['continue_session'],
      group: 'Sessions',
      usage: '/continue <session|all> [-r|--runtime cc|claude-code|codex] [placement]',
      description: operationDescription(operations, 'continue_session'),
      invoke: (args, actor) => invoke('continue_session', parseSessionLaunch(args, 'continue'), actor),
    },
    targetCommand('stop', 'stop_session', 'Sessions'),
    {
      command: 'tail',
      operations: ['tail_session'],
      group: 'Sessions',
      usage: '/tail <session> [lines]',
      description: operationDescription(operations, 'tail_session'),
      invoke: (args, actor) => {
        const codename = args[0];
        if (codename === undefined || args.length > 2) usage('/tail <session> [lines]');
        const requested = args[1] === undefined ? undefined : Number(args[1]);
        if (requested !== undefined && (!Number.isFinite(requested) || requested < 1)) {
          throw new Error('lines must be a positive number');
        }
        return invoke('tail_session', { codename, ...(requested !== undefined ? { lines: requested } : {}) }, actor);
      },
    },
    {
      command: 'summon',
      operations: ['summon_session'],
      group: 'Sessions',
      usage: '/summon <session>',
      description: operationDescription(operations, 'summon_session'),
      invoke: (args, actor) => {
        if (args.length !== 1 || args[0] === undefined) usage('/summon <session>');
        return invoke('summon_session', { codename: args[0] }, actor);
      },
    },
    {
      command: 'banish',
      operations: ['banish_session'],
      group: 'Sessions',
      usage: '/banish <session>',
      description: operationDescription(operations, 'banish_session'),
      invoke: (args, actor) => {
        if (args.length !== 1 || args[0] === undefined) usage('/banish <session>');
        return invoke('banish_session', { codename: args[0] }, actor);
      },
    },
    {
      command: 'tell',
      operations: ['send_to_session'],
      group: 'Conversation',
      usage: '/tell <session> <message>',
      description: operationDescription(operations, 'send_to_session'),
      invoke: (args, actor) => {
        const codename = args[0];
        const message = args.slice(1).join(' ');
        if (codename === undefined || message.length === 0) usage('/tell <session> <message>');
        return invoke('send_to_session', { codename, message }, actor);
      },
    },
    {
      command: 'broadcast',
      operations: ['broadcast'],
      group: 'Conversation',
      usage: '/broadcast <message>',
      description: operationDescription(operations, 'broadcast'),
      invoke: (args, actor) => {
        const message = args.join(' ');
        if (message.length === 0) usage('/broadcast <message>');
        return invoke('broadcast', { message }, actor);
      },
    },
    {
      command: 'respond',
      operations: ['respond_to_operator_request'],
      group: 'Conversation',
      usage: '/respond <request-id> <option-number>',
      description: operationDescription(operations, 'respond_to_operator_request'),
      invoke: (args, actor) => {
        if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
          usage('/respond <request-id> <option-number>');
        }
        const requestId = Number(args[0]);
        const option = Number(args[1]);
        if (!Number.isInteger(requestId) || requestId < 1 || !Number.isInteger(option) || option < 1) {
          usage('/respond <request-id> <option-number>');
        }
        return invoke('respond_to_operator_request', { requestId, option }, actor);
      },
    },
    {
      command: 'type',
      operations: ['type_in_pane'],
      group: 'Conversation',
      usage: '/type <session> <text>',
      description: operationDescription(operations, 'type_in_pane'),
      invoke: (args, actor) => {
        const codename = args[0];
        const text = args.slice(1).join(' ');
        if (codename === undefined || text.length === 0) usage('/type <session> <text>');
        return invoke('type_in_pane', { codename, text }, actor);
      },
    },
    {
      command: 'message-status',
      operations: ['get_message_status'],
      group: 'Conversation',
      usage: '/message-status <message-id>',
      description: operationDescription(operations, 'get_message_status'),
      invoke: (args, actor) => {
        const messageId = Number(args[0]);
        if (args.length !== 1 || !Number.isInteger(messageId) || messageId < 1) {
          usage('/message-status <message-id>');
        }
        return invoke('get_message_status', { messageId }, actor);
      },
    },
    {
      command: 'auto',
      operations: ['toggle_auto'],
      group: 'Modes',
      usage: '/auto <session|all>',
      description: operationDescription(operations, 'toggle_auto'),
      invoke: (args, actor) => invoke('toggle_auto', { codename: oneTarget(args, 'auto') }, actor),
    },
    targetCommand('pause', 'pause_session', 'Modes'),
    targetCommand('resume', 'resume_session', 'Modes'),
    {
      command: 'sentinel',
      operations: ['set_sentinel'],
      group: 'Modes',
      usage: '/sentinel [session]',
      description: operationDescription(operations, 'set_sentinel'),
      invoke: (args, actor) => {
        if (args.length > 1) usage('/sentinel [session]');
        return invoke('set_sentinel', args[0] === undefined ? {} : { codename: args[0] }, actor);
      },
    },
    {
      command: 'fleet-watch',
      operations: ['arm_fleet_watch', 'disarm_fleet_watch', 'list_fleet_watches'],
      group: 'Modes',
      usage: '/fleet-watch <arm|disarm|list> ...',
      description: 'Arm, disarm, or inspect fleet-wide stall detection.',
      details: [
        '    /fleet-watch arm <name> <session,session> [confirmation-seconds]',
        '    /fleet-watch disarm <name> · /fleet-watch list',
      ],
      invoke: (args, actor) => {
        const action = args[0];
        if (action === 'list' && args.length === 1) return invoke('list_fleet_watches', {}, actor);
        if (action === 'disarm' && args.length === 2 && args[1] !== undefined) {
          return invoke('disarm_fleet_watch', { name: args[1] }, actor);
        }
        if (action === 'arm' && (args.length === 3 || args.length === 4)) {
          const name = args[1];
          const sessions = args[2];
          if (name === undefined || sessions === undefined) {
            usage('/fleet-watch arm <name> <session,session> [confirmation-seconds]');
          }
          const thresholdSeconds = args[3] === undefined ? undefined : Number(args[3]);
          if (thresholdSeconds !== undefined && (!Number.isFinite(thresholdSeconds) || thresholdSeconds < 0)) {
            throw new Error('confirmation-seconds must be zero or a positive number');
          }
          return invoke(
            'arm_fleet_watch',
            { name, sessions, ...(thresholdSeconds !== undefined ? { thresholdSeconds } : {}) },
            actor,
          );
        }
        usage('/fleet-watch <arm <name> <session,session> [seconds]|disarm <name>|list>');
      },
    },
    {
      command: 'tag',
      operations: ['set_tag'],
      group: 'Modes',
      usage: '/tag <session> [text]',
      description: operationDescription(operations, 'set_tag'),
      invoke: (args, actor) => {
        const codename = args[0];
        if (codename === undefined) usage('/tag <session> [text]');
        const tag = args.slice(1).join(' ');
        return invoke('set_tag', { codename, ...(tag.length > 0 ? { tag } : {}) }, actor);
      },
    },
    {
      command: 'spawn',
      operations: ['spawn_session'],
      group: 'Lifecycle',
      usage: '/spawn <name> [flags] [placement]',
      description: operationDescription(operations, 'spawn_session'),
      details: [
        '    -r/--runtime cc|claude-code|codex · -m/--model <model> · -d/--path <dir>',
        '    -w/--worktree <repo> · -b/--branch <name>',
        '    --bypass-permissions · --require-permissions',
      ],
      invoke: (args, actor) => invoke('spawn_session', parseSpawn(args), actor),
    },
    {
      command: 'teardown',
      operations: ['teardown_session'],
      group: 'Lifecycle',
      usage: '/teardown <name> [-D|--delete]',
      description: operationDescription(operations, 'teardown_session'),
      invoke: (args, actor) => {
        const codename = args[0];
        if (codename === undefined || args.length > 2) usage('/teardown <name> [-D|--delete]');
        const flag = args[1];
        if (flag !== undefined && flag !== '--delete' && flag !== '-D') usage('/teardown <name> [-D|--delete]');
        return invoke('teardown_session', { codename, ...(flag !== undefined ? { deleteDir: true } : {}) }, actor);
      },
    },
  ];
}

function parseSpawn(args: string[]): Record<string, unknown> {
  const parsed = parsePlacement(args);
  const codename = parsed.rest[0];
  if (codename === undefined) usage('/spawn <name> [flags] [placement]');
  const output: Record<string, unknown> = {
    codename,
    ...(parsed.placement !== undefined ? { placement: parsed.placement } : {}),
    ...(parsed.headless === true ? { headless: true } : {}),
  };
  const flags: Record<string, string> = {
    '--path': 'path',
    '-d': 'path',
    '--runtime': 'runtime',
    '-r': 'runtime',
    '--model': 'model',
    '-m': 'model',
    '--worktree': 'worktreeRepo',
    '-w': 'worktreeRepo',
    '--branch': 'branch',
    '-b': 'branch',
  };
  for (let index = 1; index < parsed.rest.length;) {
    const flag = parsed.rest[index];
    if (flag === '--bypass-permissions' || flag === '--require-permissions') {
      if (output.bypassPermissions !== undefined) {
        usage('/spawn <name> [--bypass-permissions|--require-permissions] [flags] [placement]');
      }
      output.bypassPermissions = flag === '--bypass-permissions';
      index += 1;
      continue;
    }
    const value = parsed.rest[index + 1];
    if (flag === undefined || value === undefined || flags[flag] === undefined) {
      usage('/spawn <name> [-r runtime] [-d path] [-m model] [-w repo] [-b branch] [placement]');
    }
    output[flags[flag]] = value;
    index += 2;
  }
  return output;
}

export function renderOperatorHelp(commands: readonly OperatorCommandDefinition[]): string {
  const lines: string[] = [];
  const groups: CommandGroup[] = ['Sessions', 'Conversation', 'Modes', 'Lifecycle'];
  for (const group of groups) {
    if (lines.length > 0) lines.push('');
    lines.push(`${group}:`);
    for (const command of commands.filter((candidate) => candidate.group === group)) {
      lines.push(`  ${command.usage} — ${command.description}`);
      lines.push(...(command.details ?? []));
    }
  }
  lines.push(
    '',
    'Placement:',
    '  -P/--pane · -T/--tab · -W/--window',
    '  -H/--headless — detached tmux pane',
    '',
    'Conversation shortcuts:',
    '  /talk <session> — set the target for bare text',
    '  /<session> [message] — set the target and optionally send a message',
    '',
    'Console only:',
    '  /clear (or /c) — clear the console screen',
  );
  return lines.join('\n');
}

/** Operator text adapter over the canonical conductor operation registry. */
export class CommandRouter {
  private readonly commands: OperatorCommandDefinition[];
  private readonly commandIndex = new Map<string, OperatorCommandDefinition>();
  private readonly talkTargets = new Map<string, string>();

  constructor(private readonly operations: ConductorOperations) {
    this.commands = buildOperatorCommands(operations);
    for (const command of this.commands) {
      this.commandIndex.set(command.command, command);
      for (const alias of command.aliases ?? []) this.commandIndex.set(alias, command);
    }
  }

  /** Route one operator input line. interactionId isolates conversation state across adapters/users. */
  async route(line: string, interactionId = 'operator'): Promise<string> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return '';
    if (!trimmed.startsWith('/')) return this.freeText(trimmed, interactionId);

    const tokens = tokenize(trimmed);
    const commandName = (tokens[0] ?? '').slice(1).toLowerCase();
    const args = tokens.slice(1);
    if (commandName === 'help') return renderOperatorHelp(this.commands);
    if (commandName === 'talk') return this.setTalkTarget(args, interactionId);

    const command = this.commandIndex.get(commandName);
    const actor: OperationActor = { audience: 'operator', id: interactionId };
    try {
      if (command !== undefined) return await command.invoke(args, actor);

      // /<codename> [message] is an operator-adapter convenience, not a core operation.
      if (this.operations.hasSession(commandName)) {
        this.talkTargets.set(interactionId, commandName);
        const message = args.join(' ');
        if (message.length === 0) return `Talking to ${commandName}.`;
        const result = await this.operations.invoke('send_to_session', { codename: commandName, message }, actor);
        return typeof result === 'string' ? result : renderMessageReceipt(result);
      }
      return `Unknown command: /${commandName}. Try /help.`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  freeText(text: string, interactionId = 'operator'): Promise<string> {
    const target = this.talkTargets.get(interactionId);
    if (target === undefined) {
      return Promise.resolve('No active conversation. Use /talk <session> or /<session> <message>.');
    }
    return this.operations
      .invoke('send_to_session', { codename: target, message: text }, { audience: 'operator', id: interactionId })
      .then((result) => (typeof result === 'string' ? result : renderMessageReceipt(result)));
  }

  definitions(): readonly OperatorCommandDefinition[] {
    return this.commands;
  }

  private setTalkTarget(args: string[], interactionId: string): string {
    const target = args[0];
    if (target === undefined || args.length !== 1) return 'Usage: /talk <session>';
    if (!this.operations.hasSession(target)) return `Unknown session: ${target}`;
    this.talkTargets.set(interactionId, target);
    return `Talking to ${target} — bare text routes there.`;
  }
}
