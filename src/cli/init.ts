import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleetPaths } from '../config/paths.js';
import { isValidCodename } from '../config/schema.js';

const SUPERVISOR_TEMPLATE = `# agent-conductor supervisor config.
# Everything is optional — ports, window titles, and tmux session names are
# derived per fleet directory, so multiple fleets never collide.
# Full reference with every knob: examples/supervisor.yaml in the agent-conductor repo.

# defaults:
#   runtime: codex              # default: claude-code; session files can override
#   bypassPermissions: false    # default: true; session files can override

# terminal:
#   backend: iterm              # or: tmux. Default auto-detects: tmux when the
#                               # conductor is started inside tmux, else iterm on
#                               # macOS. Daemons should set this explicitly.

# Designate the initial stall sentinel — a session (defined in .conductor/config/sessions/)
# that receives every stall from auto sessions and decides what to do.
# The set_sentinel MCP tool can change or clear it later, with persistence.
# Launch it with .conductor/prompts/sentinel.md as its instructions.
# sentinel:
#   codename: watch

# channels:
#   telegram:
#     enabled: true             # opt in; credentials come from .conductor/.env or inherited env
`;

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONDUCTOR_GITIGNORE = `.env
data/
`;

function sessionTemplate(codename: string, repo: string): string {
  return `codename: ${codename}
repo: ${repo}
# runtime: codex                # optional override of defaults.runtime
# bypassPermissions: false      # optional override of defaults.bypassPermissions
# model: claude-opus-4-8
# effort: xhigh                  # optional per-session default; runtime/model dependent
# systemPromptFile: ./.conductor/prompts/${codename}.md
# schedules:
#   - cron: "0 9 * * 1-5"
#     prompt: Review open PRs and report via send_to_operator.
`;
}

export interface InitOptions {
  session?: string;
  repo?: string;
}

/**
 * Scaffold a fleet directory under .conductor/: config/supervisor.yaml,
 * config/sessions/, env.template, and (optionally) a first session. Legacy
 * root-level fleets are preserved in place. Never overwrites existing files.
 * Returns the lines to print — pure enough to test without capturing stdout.
 */
export function initFleet(baseDir: string, opts: InitOptions = {}): string[] {
  const lines: string[] = [];
  const paths = resolveFleetPaths(baseDir);
  const sessionsDir = paths.sessionsDir;
  mkdirSync(sessionsDir, { recursive: true });

  const supervisorFile = paths.supervisorFile;
  if (existsSync(supervisorFile)) {
    lines.push(`kept    ${supervisorFile} (already exists)`);
  } else {
    writeFileSync(supervisorFile, SUPERVISOR_TEMPLATE);
    lines.push(`created ${supervisorFile}`);
  }

  const environmentTemplate = paths.environmentTemplate;
  if (existsSync(environmentTemplate)) {
    lines.push(`kept    ${environmentTemplate} (already exists)`);
  } else {
    writeFileSync(environmentTemplate, readFileSync(join(PACKAGE_ROOT, 'env.template'), 'utf8'));
    lines.push(`created ${environmentTemplate}`);
  }

  if (paths.layout === 'conductor-directory') {
    const gitignore = join(paths.rootDir, '.gitignore');
    if (existsSync(gitignore)) {
      lines.push(`kept    ${gitignore} (already exists)`);
    } else {
      writeFileSync(gitignore, CONDUCTOR_GITIGNORE);
      lines.push(`created ${gitignore}`);
    }
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
