import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_STATUS_LINE_ITEMS,
  configureStatusLines,
  renderClaudeSettings,
  renderCodexConfig,
} from '../src/cli/statusline.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-statusline-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('renderClaudeSettings', () => {
  it('preserves unrelated settings and installs a command status line', () => {
    const result = JSON.parse(renderClaudeSettings('{"permissions":{"allow":["Read"]}}', "node '/tmp/line.mjs'")) as {
      permissions: unknown;
      statusLine: { type: string; command: string };
    };
    expect(result.permissions).toEqual({ allow: ['Read'] });
    expect(result.statusLine).toEqual({ type: 'command', command: "node '/tmp/line.mjs'" });
  });

  it('refuses to overwrite malformed user settings', () => {
    expect(() => renderClaudeSettings('{ nope', 'command')).toThrow(/not valid JSON/);
  });
});

describe('renderCodexConfig', () => {
  const expected = `tui.status_line = [${CODEX_STATUS_LINE_ITEMS.map((item) => JSON.stringify(item)).join(', ')}]`;

  it('adds a root dotted key to an empty config', () => {
    expect(renderCodexConfig('')).toBe(`${expected}\n`);
  });

  it('inserts before existing tui child tables so the TOML remains valid', () => {
    const result = renderCodexConfig('model = "gpt-test"\n\n[tui.model_availability_nux]\nseen = 1\n');
    expect(result).toBe(`model = "gpt-test"\n\n${expected}\n\n[tui.model_availability_nux]\nseen = 1\n`);
  });

  it('updates an existing tui table and removes a multiline old value', () => {
    const result = renderCodexConfig(
      '[tui]\nstatus_line = [\n  "current-dir",\n  "git-branch",\n]\nanimations = false\n',
    );
    expect(result).toContain(
      `[tui]\nstatus_line = [${CODEX_STATUS_LINE_ITEMS.map((item) => JSON.stringify(item)).join(', ')}]\nanimations`,
    );
    expect(result).not.toContain('"current-dir",\n');
  });

  it('is idempotent', () => {
    const once = renderCodexConfig('model = "gpt-test"\n');
    expect(renderCodexConfig(once)).toBe(once);
  });
});

describe('configureStatusLines', () => {
  it('configures both runtimes without depending on fleet initialization', () => {
    const claudeSettingsPath = join(baseDir, 'claude', 'settings.json');
    const codexConfigPath = join(baseDir, 'codex', 'config.toml');
    const claudeScriptPath = join(baseDir, 'conductor', 'statusline.mjs');
    mkdirSync(join(baseDir, 'claude'), { recursive: true });
    mkdirSync(join(baseDir, 'codex'), { recursive: true });
    writeFileSync(claudeSettingsPath, '{"spinnerTipsEnabled":false}\n');
    writeFileSync(codexConfigPath, 'model = "gpt-test"\n');

    const options = { paths: { claudeSettingsPath, codexConfigPath, claudeScriptPath } };
    const lines = configureStatusLines(options);
    const firstClaude = readFileSync(claudeSettingsPath, 'utf8');
    const firstCodex = readFileSync(codexConfigPath, 'utf8');

    expect(lines.join('\n')).toContain('Start a new session');
    expect(firstClaude).toContain('"spinnerTipsEnabled": false');
    expect(firstClaude).toContain(claudeScriptPath);
    expect(firstCodex).toContain('model-with-reasoning');
    expect(readFileSync(claudeScriptPath, 'utf8')).toContain('context_window');

    configureStatusLines(options);
    expect(readFileSync(claudeSettingsPath, 'utf8')).toBe(firstClaude);
    expect(readFileSync(codexConfigPath, 'utf8')).toBe(firstCodex);
  });

  it('installs a working Claude Code status-line program', () => {
    const paths = {
      claudeSettingsPath: join(baseDir, 'claude', 'settings.json'),
      codexConfigPath: join(baseDir, 'codex', 'config.toml'),
      claudeScriptPath: join(baseDir, 'conductor', 'statusline.mjs'),
    };
    configureStatusLines({ paths });
    const output = execFileSync(process.execPath, [paths.claudeScriptPath], {
      encoding: 'utf8',
      input: JSON.stringify({
        model: { display_name: 'Opus' },
        context_window: { used_percentage: 42.4 },
        cost: { total_cost_usd: 1.236 },
        worktree: { original_cwd: baseDir, name: 'feature-one' },
      }),
    });
    expect(output).toBe(
      'Opus | 42% | $1.24 | 📁 conductor-statusline-' + baseDir.split('-').at(-1) + ' | 🌳 feature-one | 🌿 no branch',
    );
  });

  it('detects a linked worktree that was created outside Claude Code', () => {
    const paths = {
      claudeSettingsPath: join(baseDir, 'claude', 'settings.json'),
      codexConfigPath: join(baseDir, 'codex', 'config.toml'),
      claudeScriptPath: join(baseDir, 'conductor', 'statusline.mjs'),
    };
    const source = join(baseDir, 'source');
    const linked = join(baseDir, 'review-one');
    mkdirSync(source);
    const gitEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
      delete gitEnv[key];
    }
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
        stdio: 'ignore',
        env: gitEnv,
      });
    };
    git(source, 'init', '-b', 'main');
    writeFileSync(join(source, 'README.md'), 'source\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'initial');
    git(source, 'worktree', 'add', '-b', 'review-one', linked);

    configureStatusLines({ paths });
    const output = execFileSync(process.execPath, [paths.claudeScriptPath], {
      encoding: 'utf8',
      input: JSON.stringify({ model: { display_name: 'Opus' }, cwd: linked }),
    });
    const sourceOutput = execFileSync(process.execPath, [paths.claudeScriptPath], {
      encoding: 'utf8',
      input: JSON.stringify({ model: { display_name: 'Opus' }, cwd: source }),
    });

    expect(output).toContain('📁 review-one | 🌳 review-one | 🌿 review-one');
    expect(sourceOutput).toContain('📁 source | 🌳 no worktree | 🌿 main');
  });
});
