import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue } from './delivery.js';
import type { Lifecycle } from './lifecycle.js';
import type { Messaging } from './messaging.js';
import type { SessionStateManager } from './state.js';
import type { Placement } from './types.js';

export interface CommandDeps {
  lifecycle: Lifecycle;
  messaging: Messaging;
  states: SessionStateManager;
  delivery: DeliveryQueue;
  sessions(): Map<string, SessionConfig>;
  statusReport(codename?: string): string;
  tail(codename: string, lines: number): Promise<string>;
  tailLimits: { defaultLines: number; maxLines: number };
  autoPause: { enabled(): boolean; setEnabled(on: boolean): void } | undefined;
  /** Re-apply a session's pane title (codename — tag). */
  retitle(codename: string): Promise<void>;
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

// Placement shorts are capitalized (-P/-T/-W) so they can never collide with
// /spawn's value-flag shorts (-p prompt, -w worktree).
function parsePlacement(args: string[]): { placement: Placement | undefined; rest: string[] } {
  let placement: Placement | undefined;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === '--pane' || arg === '-P') placement = 'pane';
    else if (arg === '--tab' || arg === '-T') placement = 'tab';
    else if (arg === '--window' || arg === '-W') placement = 'window';
    else rest.push(arg);
  }
  return { placement, rest };
}

const HELP = [
  '*Sessions*',
  '`/status [session]` — fleet overview or one session as JSON',
  '`/start <session|all> [placement]` — start session(s)',
  '`/continue <session|all> [placement]` — resume the last session',
  '`/stop <session|all>` — stop session(s)',
  '`/tail <session> [lines]` — read trailing pane output',
  '',
  '*Conversation*',
  '`/talk <session>` — set the talk target (bare text routes there)',
  '`/tell <session> <msg>` — one-off message (starts the session if needed)',
  '`/broadcast <msg>` — message all active sessions',
  '`/<session> [msg]` — shortcut: talk + optional message',
  '',
  '*Modes*',
  '`/auto <session|all>` — autonomous (stalls route to the sentinel)',
  '`/facilitated <session|all>` — operator drives',
  '`/pause <session|all>` / `/resume <session|all>` — temporary facilitated, remembers the mode',
  '`/autopause [on|off]` — pause sessions whose pane you focus (iTerm only)',
  '`/tag <session> [text]` — set/clear a status label',
  '',
  '*Lifecycle*',
  '`/spawn <name> [flags] [placement]` — create + start a new session:',
  '  `-r/--runtime claude-code|codex` · `-m/--model <model>` · `-p/--prompt "…"`',
  '  `-d/--path <dir>` · `-w/--worktree <repo>` · `-b/--branch <name>`',
  '`/teardown <name> [-D/--delete]` — deregister (and optionally delete its directory)',
  '',
  '*Placement* (accepted wherever `[placement]` appears)',
  '`-P/--pane` (default) · `-T/--tab` · `-W/--window`',
  '',
  '*Console*',
  '`/clear` (or `/c`) — clear the console screen (console-only)',
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
        if (target === undefined) return 'Usage: /talk <session>';
        if (!this.deps.sessions().has(target)) return `Unknown session: ${target}`;
        this.talkTarget = target;
        return `Talking to ${target} — bare text routes there.`;
      }
      case 'tell': {
        const target = args[0];
        const message = args.slice(1).join(' ');
        if (target === undefined || message.length === 0) return 'Usage: /tell <session> <message>';
        return this.deps.messaging.sendToSession('operator', target, message);
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
        return this.forEachTarget(args[0], (session) =>
          this.deps.states.pause(session, 'manual')
            ? `${session}: paused`
            : `${session}: already paused or facilitated`,
        );
      case 'resume':
        return this.forEachTarget(args[0], (session) =>
          this.deps.states.resume(session) ? `${session}: resumed` : `${session}: not paused`,
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
        if (target === undefined) return 'Usage: /tag <session> [text]';
        if (!this.deps.states.has(target)) return `Unknown session: ${target}`;
        const tag = args.slice(1).join(' ');
        this.deps.states.setTag(target, tag.length > 0 ? tag : undefined);
        await this.deps.retitle(target);
        return tag.length > 0 ? `${target} tagged '${tag}'.` : `Tag cleared for ${target}.`;
      }
      case 'tail': {
        const target = args[0];
        if (target === undefined) return 'Usage: /tail <session> [lines]';
        const requested = args[1] !== undefined ? Number.parseInt(args[1], 10) : this.deps.tailLimits.defaultLines;
        const lines = Math.min(
          Math.max(Number.isNaN(requested) ? this.deps.tailLimits.defaultLines : requested, 1),
          this.deps.tailLimits.maxLines,
        );
        return this.deps.tail(target, lines);
      }
      case 'spawn':
        return this.spawnCommand(args);
      case 'teardown': {
        const target = args[0];
        if (target === undefined) return 'Usage: /teardown <name> [-D|--delete]';
        return this.deps.lifecycle.teardown(target, args.includes('--delete') || args.includes('-D'));
      }
      default: {
        // /<codename> [message] shortcut
        if (this.deps.sessions().has(command)) {
          this.talkTarget = command;
          const message = args.join(' ');
          if (message.length === 0) return `Talking to ${command}.`;
          return this.deps.messaging.sendToSession('operator', command, message);
        }
        return `Unknown command: /${command}. Try /help.`;
      }
    }
  }

  async freeText(text: string): Promise<string> {
    if (this.talkTarget === undefined) {
      return 'No active conversation. Use /talk <session> or /<session> <message>.';
    }
    return this.deps.messaging.sendToSession('operator', this.talkTarget, text);
  }

  private async sessionCommand(verb: 'start' | 'continue' | 'stop', rawArgs: string[]): Promise<string> {
    const { placement, rest } = parsePlacement(rawArgs);
    const target = rest[0];
    if (target === undefined) return `Usage: /${verb} <session|all>`;
    const run = (session: string): Promise<string> => {
      switch (verb) {
        case 'start':
          return this.deps.lifecycle.start(session, { placement });
        case 'continue':
          return this.deps.lifecycle.continue(session, { placement });
        case 'stop':
          return this.deps.lifecycle.stop(session);
      }
    };
    if (target === 'all') {
      const results: string[] = [];
      for (const session of this.deps.sessions().keys()) {
        results.push(await run(session));
      }
      return results.join('\n');
    }
    return run(target);
  }

  private modeCommand(args: string[], mode: 'autonomous' | 'facilitated'): string {
    return this.forEachTargetSync(args[0], (session) => {
      this.deps.states.setAutonomy(session, mode);
      return `${session} set to ${mode}.`;
    });
  }

  private forEachTargetSync(target: string | undefined, fn: (session: string) => string): string {
    if (target === undefined) return 'Usage: <command> <session|all>';
    if (target === 'all') {
      return [...this.deps.sessions().keys()].map(fn).join('\n');
    }
    if (!this.deps.states.has(target)) return `Unknown session: ${target}`;
    return fn(target);
  }

  private forEachTarget(target: string | undefined, fn: (session: string) => string): string {
    return this.forEachTargetSync(target, fn);
  }

  private async spawnCommand(args: string[]): Promise<string> {
    const { placement, rest } = parsePlacement(args);
    const codename = rest[0];
    if (codename === undefined) {
      return 'Usage: /spawn <name> [-r|--runtime claude-code|codex] [-d|--path p] [-m|--model m] [-p|--prompt "…"] [-w|--worktree repo] [-b|--branch b] [-P|-T|-W placement]';
    }
    let path: string | undefined;
    let runtime: string | undefined;
    let model: string | undefined;
    let prompt: string | undefined;
    let worktreeRepo: string | undefined;
    let branch: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (value === undefined) break;
      if (flag === '--path' || flag === '-d') path = value;
      else if (flag === '--runtime' || flag === '-r') runtime = value;
      else if (flag === '--model' || flag === '-m') model = value;
      else if (flag === '--prompt' || flag === '-p') prompt = value;
      else if (flag === '--worktree' || flag === '-w') worktreeRepo = value;
      else if (flag === '--branch' || flag === '-b') branch = value;
      else continue;
      i += 1;
    }
    return this.deps.lifecycle.spawn(codename, { path, runtime, model, prompt, placement, worktreeRepo, branch });
  }
}
