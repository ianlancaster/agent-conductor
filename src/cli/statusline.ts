import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CODEX_STATUS_LINE_ITEMS = [
  'model-with-reasoning',
  'context-used',
  'used-tokens',
  'project-name',
  'git-branch',
] as const;

export interface StatusLinePaths {
  claudeSettingsPath: string;
  codexConfigPath: string;
  claudeScriptPath: string;
}

export interface ConfigureStatusLineOptions {
  paths?: Partial<StatusLinePaths>;
  homeDir?: string;
  xdgConfigHome?: string;
  codexHome?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function statusLinePaths(options: ConfigureStatusLineOptions): StatusLinePaths {
  const home = options.homeDir ?? homedir();
  const xdgConfigHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  return {
    claudeSettingsPath: options.paths?.claudeSettingsPath ?? join(home, '.claude', 'settings.json'),
    codexConfigPath: options.paths?.codexConfigPath ?? join(codexHome, 'config.toml'),
    claudeScriptPath:
      options.paths?.claudeScriptPath ?? join(xdgConfigHome, 'agent-conductor', 'claude-statusline.mjs'),
  };
}

/** Merge the conductor status-line command into Claude Code's user settings. */
export function renderClaudeSettings(existing: string, command: string): string {
  let parsed: unknown = {};
  if (existing.trim().length > 0) {
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      throw new Error(`Claude Code settings are not valid JSON: ${(error as Error).message}`);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Claude Code settings must contain a JSON object.');
  }
  const settings = parsed as Record<string, unknown>;
  settings.statusLine = { type: 'command', command };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function assignmentEnd(lines: string[], start: number): number {
  const first = lines[start] ?? '';
  const value = first.slice(first.indexOf('=') + 1);
  if (!value.includes('[') || value.includes(']')) return start;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').includes(']')) return index;
  }
  throw new Error('Codex tui.status_line contains an unterminated array.');
}

/**
 * Set Codex's native status line without reformatting the rest of config.toml.
 * A root dotted key is inserted before the first table when no [tui] table
 * exists, which remains valid when Codex has already written [tui.*] tables.
 */
export function renderCodexConfig(existing: string): string {
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  const items = CODEX_STATUS_LINE_ITEMS.map((item) => JSON.stringify(item)).join(', ');
  const rootAssignment = `tui.status_line = [${items}]`;
  const tableAssignment = `status_line = [${items}]`;

  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLimit = firstTable === -1 ? lines.length : firstTable;
  const dottedIndex = lines.slice(0, rootLimit).findIndex((line) => /^\s*tui\.status_line\s*=/.test(line));
  if (dottedIndex !== -1) {
    lines.splice(dottedIndex, assignmentEnd(lines, dottedIndex) - dottedIndex + 1, rootAssignment);
    return `${lines.join(newline)}${newline}`;
  }

  const tuiIndex = lines.findIndex((line) => /^\s*\[tui\]\s*(?:#.*)?$/.test(line));
  if (tuiIndex !== -1) {
    let nextTable = lines.findIndex((line, index) => index > tuiIndex && /^\s*\[/.test(line));
    if (nextTable === -1) nextTable = lines.length;
    const relativeStatusIndex = lines
      .slice(tuiIndex + 1, nextTable)
      .findIndex((line) => /^\s*status_line\s*=/.test(line));
    if (relativeStatusIndex === -1) {
      lines.splice(tuiIndex + 1, 0, tableAssignment);
    } else {
      const statusIndex = tuiIndex + 1 + relativeStatusIndex;
      lines.splice(statusIndex, assignmentEnd(lines, statusIndex) - statusIndex + 1, tableAssignment);
    }
    return `${lines.join(newline)}${newline}`;
  }

  const insertAt = firstTable === -1 ? lines.length : firstTable;
  const prefix = insertAt > 0 && (lines[insertAt - 1] ?? '').trim().length > 0 ? [''] : [];
  const suffix = insertAt < lines.length && (lines[insertAt] ?? '').trim().length > 0 ? [''] : [];
  lines.splice(insertAt, 0, ...prefix, rootAssignment, ...suffix);
  return `${lines.join(newline)}${newline}`;
}

/** A dependency-free Claude Code status-line program installed in the user's config directory. */
export function renderClaudeStatusLineScript(): string {
  return `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

let input = {};
try {
  const text = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
  input = JSON.parse(text || '{}');
} catch {
  input = {};
}

const runGit = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const countLines = (value) => value.length === 0 ? 0 : value.split('\\n').filter(Boolean).length;

const model = input?.model?.display_name || 'Unknown Model';
const used = Number(input?.context_window?.used_percentage);
// The runtime's own resolved window, not a number derived from the model name.
// A display name cannot distinguish variants of one model that differ only in
// context size, so a percentage alone leaves the denominator unknowable from the
// pane. Printing the window makes it a read value rather than an inference, and
// it is the denominator any compaction-threshold check needs.
const windowSize = Number(input?.context_window?.context_window_size);
const formatTokens = (value) =>
  value >= 1_000_000 ? \`\${(value / 1_000_000).toFixed(1)}M\` : \`\${Math.round(value / 1000)}k\`;
const percent = Number.isFinite(used) ? \`\${Math.round(used)}%\` : '0%';
const usage = Number.isFinite(windowSize) && windowSize > 0 ? \`\${percent} of \${formatTokens(windowSize)}\` : percent;
const cost = Number(input?.cost?.total_cost_usd);
const costText = Number.isFinite(cost) ? \`$\${cost.toFixed(2)}\` : '$0.00';
const cwd = input?.worktree?.original_cwd || input?.cwd || process.cwd();
const root = runGit(cwd, ['rev-parse', '--show-toplevel']) || cwd;
const directory = basename(root);
const gitDir = runGit(cwd, ['rev-parse', '--absolute-git-dir']);
const commonGitDir = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
const linkedWorktree = gitDir.length > 0 && commonGitDir.length > 0 && gitDir !== commonGitDir;
const worktree = input?.worktree?.name || (linkedWorktree ? basename(root) : 'no worktree');

let git = 'no branch';
if (gitDir) {
  const branch = runGit(cwd, ['branch', '--show-current']) || runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const staged = countLines(runGit(cwd, ['diff', '--cached', '--numstat']));
  const modified = countLines(runGit(cwd, ['diff', '--numstat']));
  const green = '\\u001b[32m';
  const yellow = '\\u001b[33m';
  const reset = '\\u001b[0m';
  git = branch || 'detached';
  if (staged > 0) git += \` \${green}+\${staged}\${reset}\`;
  if (modified > 0) git += \` \${yellow}🔺\${modified}\${reset}\`;
}

process.stdout.write(\`\${model} | \${usage} | \${costText} | 📁 \${directory} | 🌳 \${worktree} | 🌿 \${git}\`);
`;
}

/** Configure both supported runtimes. This is intentionally opt-in and is never called by init. */
export function configureStatusLines(options: ConfigureStatusLineOptions = {}): string[] {
  const paths = statusLinePaths(options);
  const command = `node ${shellQuote(paths.claudeScriptPath)}`;

  // Render both configs before writing either, so malformed user config cannot
  // leave a half-configured installation.
  const claudeSettings = renderClaudeSettings(readIfExists(paths.claudeSettingsPath), command);
  const codexConfig = renderCodexConfig(readIfExists(paths.codexConfigPath));

  for (const path of [paths.claudeScriptPath, paths.claudeSettingsPath, paths.codexConfigPath]) {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(paths.claudeScriptPath, renderClaudeStatusLineScript(), { mode: 0o644 });
  writeFileSync(paths.claudeSettingsPath, claudeSettings);
  writeFileSync(paths.codexConfigPath, codexConfig);

  return [
    `Claude Code status line configured in ${paths.claudeSettingsPath}`,
    `Codex status line configured in ${paths.codexConfigPath}`,
    'Start a new session, or restart a managed session, to see the new status line.',
  ];
}
