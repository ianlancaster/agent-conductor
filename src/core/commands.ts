import type { AgentConfig } from '../config/schema.js';
import type { DeliveryQueue } from './delivery.js';
import type { HumanInputBroker } from './human-input.js';
import type { Lifecycle } from './lifecycle.js';
import type { Messaging } from './messaging.js';
import type { AgentStateManager } from './state.js';
import type { Placement } from './types.js';

export interface CommandDeps {
  lifecycle: Lifecycle;
  messaging: Messaging;
  humanInput: HumanInputBroker;
  states: AgentStateManager;
  delivery: DeliveryQueue;
  agents(): Map<string, AgentConfig>;
  statusReport(codename?: string): string;
  tail(codename: string, lines: number): Promise<string>;
  tailLimits: { defaultLines: number; maxLines: number };
  autoPause: { enabled(): boolean; setEnabled(on: boolean): void } | undefined;
}

/** Tokenize a command line, honoring double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? '');
  }
  return tokens;
}

function parsePlacement(args: string[]): { placement: Placement | undefined; rest: string[] } {
  let placement: Placement | undefined;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === '--pane') placement = 'pane';
    else if (arg === '--tab') placement = 'tab';
    else if (arg === '--window') placement = 'window';
    else rest.push(arg);
  }
  return { placement, rest };
}

const HELP = [
  '*Sessions*',
  '`/status [agent]` — fleet overview or one agent as JSON',
  '`/start <agent|all> [--tab|--window|--pane]` — start session(s)',
  '`/continue <agent|all> [placement]` — resume the last session',
  '`/stop <agent|all>` — stop session(s)',
  '`/tail <agent> [lines]` — read trailing pane output',
  '',
  '*Conversation*',
  '`/talk <agent>` — set the talk target (bare text routes there)',
  '`/tell <agent> <msg>` — one-off message (starts the agent if needed)',
  '`/broadcast <msg>` — message all active agents',
  '`/<agent> [msg]` — shortcut: talk + optional message',
  '`/answer <id> <text>` — answer a pending human-input question',
  '',
  '*Modes*',
  '`/auto <agent|all>` — autonomous (stalls route to the sentinel)',
  '`/facilitated <agent|all>` — operator drives',
  '`/pause <agent|all>` / `/resume <agent|all>` — temporary facilitated, remembers the mode',
  '`/autopause [on|off]` — pause agents whose pane you focus (iTerm only)',
  '`/tag <agent> [text]` — set/clear a status label',
  '',
  '*Lifecycle*',
  '`/spawn <name> [--path p] [--model m] [--prompt "…"] [placement]`',
  '`/teardown <name> [--delete]`',
].join('\n');

/**
 * Operator command router — shared by the CLI client (POST /cmd) and every
 * channel adapter, so all surfaces speak the same command language.
 */
export class CommandRouter {
  private talkTarget: string | undefined;

  constructor(private readonly deps: CommandDeps) {}

  /** Route one input line (with or without leading slash). */
  async route(line: string): Promise<string> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return '';
    if (!trimmed.startsWith('/')) return this.freeText(trimmed);

    const tokens = tokenize(trimmed);
    const command = (tokens[0] ?? '').slice(1).toLowerCase();
    const args = tokens.slice(1);

    switch (command) {
      case 'help':
        return HELP;
      case 'status':
        return this.deps.statusReport(args[0]);
      case 'start':
      case 'continue':
      case 'stop':
        return this.sessionCommand(command, args);
      case 'talk':
      case 'speak': {
        const target = args[0];
        if (target === undefined) return 'Usage: /talk <agent>';
        if (!this.deps.agents().has(target)) return `Unknown agent: ${target}`;
        this.talkTarget = target;
        return `Talking to ${target} — bare text routes there.`;
      }
      case 'tell': {
        const target = args[0];
        const message = args.slice(1).join(' ');
        if (target === undefined || message.length === 0) return 'Usage: /tell <agent> <message>';
        return this.deps.messaging.sendToAgent('operator', target, message);
      }
      case 'broadcast': {
        const message = args.join(' ');
        if (message.length === 0) return 'Usage: /broadcast <message>';
        return this.deps.messaging.broadcast('operator', message);
      }
      case 'auto':
        return this.modeCommand(args, 'autonomous');
      case 'facilitated':
        return this.modeCommand(args, 'facilitated');
      case 'pause':
        return this.forEachTarget(args[0], (agent) =>
          this.deps.states.pause(agent, 'manual') ? `${agent}: paused` : `${agent}: already paused or facilitated`,
        );
      case 'resume':
        return this.forEachTarget(args[0], (agent) =>
          this.deps.states.resume(agent) ? `${agent}: resumed` : `${agent}: not paused`,
        );
      case 'autopause': {
        if (this.deps.autoPause === undefined) return 'Focus auto-pause is not supported by this terminal backend.';
        const arg = args[0]?.toLowerCase();
        if (arg === 'on') this.deps.autoPause.setEnabled(true);
        else if (arg === 'off') this.deps.autoPause.setEnabled(false);
        return `Focus auto-pause is ${this.deps.autoPause.enabled() ? 'on' : 'off'}.`;
      }
      case 'tag': {
        const target = args[0];
        if (target === undefined) return 'Usage: /tag <agent> [text]';
        if (!this.deps.states.has(target)) return `Unknown agent: ${target}`;
        const tag = args.slice(1).join(' ');
        this.deps.states.setTag(target, tag.length > 0 ? tag : undefined);
        return tag.length > 0 ? `${target} tagged '${tag}'.` : `Tag cleared for ${target}.`;
      }
      case 'tail': {
        const target = args[0];
        if (target === undefined) return 'Usage: /tail <agent> [lines]';
        const requested = args[1] !== undefined ? Number.parseInt(args[1], 10) : this.deps.tailLimits.defaultLines;
        const lines = Math.min(
          Math.max(Number.isNaN(requested) ? this.deps.tailLimits.defaultLines : requested, 1),
          this.deps.tailLimits.maxLines,
        );
        return this.deps.tail(target, lines);
      }
      case 'answer': {
        const id = args[0] !== undefined ? Number.parseInt(args[0], 10) : Number.NaN;
        const text = args.slice(1).join(' ');
        if (Number.isNaN(id) || text.length === 0) return 'Usage: /answer <id> <text>';
        const agent = this.deps.humanInput.answer(id, text);
        return agent === undefined ? `No pending question #${id}.` : `Answer delivered to ${agent}.`;
      }
      case 'spawn':
        return this.spawnCommand(args);
      case 'teardown': {
        const target = args[0];
        if (target === undefined) return 'Usage: /teardown <name> [--delete]';
        return this.deps.lifecycle.teardown(target, args.includes('--delete'));
      }
      default: {
        // /<codename> [message] shortcut
        if (this.deps.agents().has(command)) {
          this.talkTarget = command;
          const message = args.join(' ');
          if (message.length === 0) return `Talking to ${command}.`;
          return this.deps.messaging.sendToAgent('operator', command, message);
        }
        return `Unknown command: /${command}. Try /help.`;
      }
    }
  }

  /** Button callbacks from channel adapters. */
  async callback(data: string): Promise<string | undefined> {
    const humanInput = /^hi:(\d+):(\d+)$/.exec(data);
    if (humanInput !== null) {
      const id = Number.parseInt(humanInput[1] ?? '', 10);
      const option = Number.parseInt(humanInput[2] ?? '', 10);
      const agent = this.deps.humanInput.answerByOption(id, option);
      return agent === undefined ? `Question #${id} is no longer pending.` : `Answer delivered to ${agent}.`;
    }
    return `Unrecognized action: ${data}`;
  }

  async freeText(text: string): Promise<string> {
    if (this.talkTarget === undefined) {
      return 'No active conversation. Use /talk <agent> or /<agent> <message>.';
    }
    return this.deps.messaging.sendToAgent('operator', this.talkTarget, text);
  }

  private async sessionCommand(verb: 'start' | 'continue' | 'stop', rawArgs: string[]): Promise<string> {
    const { placement, rest } = parsePlacement(rawArgs);
    const target = rest[0];
    if (target === undefined) return `Usage: /${verb} <agent|all>`;
    const run = (agent: string): Promise<string> => {
      switch (verb) {
        case 'start':
          return this.deps.lifecycle.start(agent, { placement });
        case 'continue':
          return this.deps.lifecycle.continue(agent, { placement });
        case 'stop':
          return this.deps.lifecycle.stop(agent);
      }
    };
    if (target === 'all') {
      const results: string[] = [];
      for (const agent of this.deps.agents().keys()) {
        results.push(await run(agent));
      }
      return results.join('\n');
    }
    return run(target);
  }

  private modeCommand(args: string[], mode: 'autonomous' | 'facilitated'): string {
    return this.forEachTargetSync(args[0], (agent) => {
      this.deps.states.setAutonomy(agent, mode);
      return `${agent} set to ${mode}.`;
    });
  }

  private forEachTargetSync(target: string | undefined, fn: (agent: string) => string): string {
    if (target === undefined) return 'Usage: <command> <agent|all>';
    if (target === 'all') {
      return [...this.deps.agents().keys()].map(fn).join('\n');
    }
    if (!this.deps.states.has(target)) return `Unknown agent: ${target}`;
    return fn(target);
  }

  private forEachTarget(target: string | undefined, fn: (agent: string) => string): string {
    return this.forEachTargetSync(target, fn);
  }

  private async spawnCommand(args: string[]): Promise<string> {
    const { placement, rest } = parsePlacement(args);
    const codename = rest[0];
    if (codename === undefined) return 'Usage: /spawn <name> [--path p] [--model m] [--prompt "…"] [placement]';
    let path: string | undefined;
    let model: string | undefined;
    let prompt: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (value === undefined) break;
      if (flag === '--path') path = value;
      else if (flag === '--model') model = value;
      else if (flag === '--prompt') prompt = value;
      else continue;
      i += 1;
    }
    return this.deps.lifecycle.spawn(codename, { path, model, prompt, placement });
  }
}
