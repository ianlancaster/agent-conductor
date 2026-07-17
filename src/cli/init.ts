import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isValidCodename } from '../config/schema.js';

const SUPERVISOR_TEMPLATE = `# agent-conductor supervisor config.
# Everything is optional — ports, window titles, and tmux session names are
# derived per fleet directory, so multiple fleets never collide.
# Full reference with every knob: examples/supervisor.yaml in the agent-conductor repo.

# terminal:
#   backend: iterm              # or: tmux (headless, Linux/SSH)

# Designate a stall sentinel — an agent (defined in config/agents/) that receives
# every stall from autonomous agents and decides: nudge, dismiss, or escalate.
# Launch it with prompts/sentinel.md as its instructions.
# sentinel:
#   codename: watch

# channels:
#   telegram:
#     enabled: true             # needs CONDUCTOR_TELEGRAM_TOKEN + CONDUCTOR_TELEGRAM_CHAT_ID
`;

function agentTemplate(codename: string, repo: string): string {
  return `codename: ${codename}
repo: ${repo}
# runtime: claude-code          # or: codex
# model: claude-opus-4-6
# systemPromptFile: ./prompts/${codename}.md
# schedules:
#   - cron: "0 9 * * 1-5"
#     prompt: Review open PRs and report via respond_to_user.
`;
}

export interface InitOptions {
  agent?: string;
  repo?: string;
}

/**
 * Scaffold a fleet directory: config/supervisor.yaml, config/agents/, and
 * (optionally) a first agent. Never overwrites existing files. Returns the
 * lines to print — pure enough to test without capturing stdout.
 */
export function initFleet(baseDir: string, opts: InitOptions = {}): string[] {
  const lines: string[] = [];
  const configDir = join(baseDir, 'config');
  const agentsDir = join(configDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const supervisorFile = join(configDir, 'supervisor.yaml');
  if (existsSync(supervisorFile)) {
    lines.push(`kept    ${supervisorFile} (already exists)`);
  } else {
    writeFileSync(supervisorFile, SUPERVISOR_TEMPLATE);
    lines.push(`created ${supervisorFile}`);
  }

  let agentCreated: string | undefined;
  if (opts.agent !== undefined) {
    if (!isValidCodename(opts.agent)) {
      throw new Error(`Invalid codename '${opts.agent}': letters, digits, dashes, underscores only.`);
    }
    if (opts.repo === undefined) {
      throw new Error(`--agent needs --repo <path>: the project directory ${opts.agent} will work in.`);
    }
    const repo = resolve(opts.repo);
    if (!existsSync(repo)) {
      throw new Error(`--repo ${repo} does not exist. Create or clone it first.`);
    }
    const agentFile = join(agentsDir, `${opts.agent}.yaml`);
    if (existsSync(agentFile)) {
      lines.push(`kept    ${agentFile} (already exists)`);
    } else {
      writeFileSync(agentFile, agentTemplate(opts.agent, repo));
      lines.push(`created ${agentFile}`);
      agentCreated = opts.agent;
    }
  }

  lines.push('');
  lines.push(`Fleet '${basename(resolve(baseDir))}' is ready. Next steps:`);
  let step = 1;
  if (agentCreated === undefined) {
    lines.push(`  ${String(step++)}. Add an agent:  conductor init --agent <codename> --repo <project-path>`);
  }
  lines.push(`  ${String(step++)}. conductor validate`);
  lines.push(`  ${String(step++)}. conductor start`);
  if (agentCreated !== undefined) {
    lines.push(`  ${String(step)}. At the conductor> prompt:  /start ${agentCreated}`);
  }
  return lines;
}
