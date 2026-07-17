import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isValidCodename } from '../config/schema.js';

const SUPERVISOR_TEMPLATE = `# agent-conductor supervisor config.
# Everything is optional — ports, window titles, and tmux session names are
# derived per fleet directory, so multiple fleets never collide.
# Full reference with every knob: examples/supervisor.yaml in the agent-conductor repo.

# terminal:
#   backend: iterm              # or: tmux (headless, Linux/SSH)

# Designate a stall sentinel — a session (defined in config/sessions/) that receives
# every stall from autonomous sessions and decides: nudge, dismiss, or escalate.
# Launch it with prompts/sentinel.md as its instructions.
# sentinel:
#   codename: watch

# channels:
#   telegram:
#     enabled: true             # needs CONDUCTOR_TELEGRAM_TOKEN + CONDUCTOR_TELEGRAM_CHAT_ID
`;

function sessionTemplate(codename: string, repo: string): string {
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
  session?: string;
  repo?: string;
}

/**
 * Scaffold a fleet directory: config/supervisor.yaml, config/sessions/, and
 * (optionally) a first session. Never overwrites existing files. Returns the
 * lines to print — pure enough to test without capturing stdout.
 */
export function initFleet(baseDir: string, opts: InitOptions = {}): string[] {
  const lines: string[] = [];
  const configDir = join(baseDir, 'config');
  const sessionsDir = join(configDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const supervisorFile = join(configDir, 'supervisor.yaml');
  if (existsSync(supervisorFile)) {
    lines.push(`kept    ${supervisorFile} (already exists)`);
  } else {
    writeFileSync(supervisorFile, SUPERVISOR_TEMPLATE);
    lines.push(`created ${supervisorFile}`);
  }

  let sessionCreated: string | undefined;
  if (opts.session !== undefined) {
    if (!isValidCodename(opts.session)) {
      throw new Error(`Invalid codename '${opts.session}': letters, digits, dashes, underscores only.`);
    }
    if (opts.repo === undefined) {
      throw new Error(`--session needs --repo <path>: the project directory ${opts.session} will work in.`);
    }
    const repo = resolve(opts.repo);
    if (!existsSync(repo)) {
      throw new Error(`--repo ${repo} does not exist. Create or clone it first.`);
    }
    const sessionFile = join(sessionsDir, `${opts.session}.yaml`);
    if (existsSync(sessionFile)) {
      lines.push(`kept    ${sessionFile} (already exists)`);
    } else {
      writeFileSync(sessionFile, sessionTemplate(opts.session, repo));
      lines.push(`created ${sessionFile}`);
      sessionCreated = opts.session;
    }
  }

  lines.push('');
  lines.push(`Fleet '${basename(resolve(baseDir))}' is ready. Next steps:`);
  let step = 1;
  if (sessionCreated === undefined) {
    lines.push(`  ${String(step++)}. Add a session:  conductor init --session <codename> --repo <project-path>`);
  }
  lines.push(`  ${String(step++)}. conductor validate`);
  lines.push(`  ${String(step++)}. conductor start`);
  if (sessionCreated !== undefined) {
    lines.push(`  ${String(step)}. At the conductor> prompt:  /start ${sessionCreated}`);
  }
  return lines;
}
