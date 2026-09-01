import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store/index.js';
import { sessionConfigSchema } from '../src/config/schema.js';
import type { SessionConfig } from '../src/config/schema.js';
import type { IdentityEndpoints } from '../src/runtimes/types.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';

const mocks = vi.hoisted(() => ({
  runOsa: vi.fn<(script: string, args?: readonly string[]) => Promise<string>>(),
}));

vi.mock('../src/terminals/iterm/applescript.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runOsa: mocks.runOsa,
}));

import { ITermBackend } from '../src/terminals/iterm/index.js';

function backend(): ITermBackend {
  return new ITermBackend({
    store: {} as Store,
    config: {
      windowName: 'test',
      fleetId: 'test',
      badge: false,
      focusNewPanes: false,
      bracketedPasteThreshold: 512,
      launchTimeoutSec: 1,
      pollIntervalSec: 0.01,
    },
  });
}

const PANE = { backend: 'iterm', id: '11111111-1111-4111-8111-111111111111' } as const;

function makeSession(): SessionConfig {
  return sessionConfigSchema.parse({ codename: 'sample', repo: '/repos/sample', runtime: 'codex' });
}

const IDENTITY: IdentityEndpoints = {
  mcpUrl: 'http://127.0.0.1:3456/mcp/sample',
  eventsUrl: 'http://127.0.0.1:3456/events/sample',
  configDir: '/cfg/sample',
};

/** The one runOsa call that performed the pane write. */
function deliveryScript(): string {
  const writes = mocks.runOsa.mock.calls.map(([script]) => script).filter((s) => s.includes('write contents of file'));
  expect(writes).toHaveLength(1);
  return writes[0] ?? '';
}

/**
 * Regression for the Codex composer-newline defect: iTerm's `write text`
 * appends a second carriage return unless `newline false` is given. The shell
 * consumes only the first CR to execute the launch command, the runtime
 * inherits the second, and Codex turns it into a blank newline sitting in its
 * composer on every fresh start and native resume.
 */
function expectSingleSubmitCarriageReturn(script: string): void {
  expect(script).toContain('write text (ASCII character 13) newline false');
  expect(script.match(/ASCII character 13/g)).toHaveLength(1);
  expect(script).not.toMatch(/write text \(ASCII character 13\)(?! newline false)/);
}

describe('iTerm delivery submit keystroke', () => {
  beforeEach(() => {
    mocks.runOsa.mockReset();
    // First the launch prompt poll reads pane contents (a shell at a prompt),
    // then the delivery write runs inside the session.
    mocks.runOsa.mockImplementation(async (script) => (script.includes('contents as string') ? '~/repos ❯' : 'OK'));
  });

  it('fresh codex start delivers the launch command with exactly one carriage return', async () => {
    const runtime = new CodexRuntime({ config: { binary: 'codex', toolTimeoutSec: 600 }, baseDir: '/base' });
    const command = runtime.buildLaunchCommand(makeSession(), IDENTITY, { continueSession: false });
    await backend().launch(PANE, command);
    expectSingleSubmitCarriageReturn(deliveryScript());
  });

  it('native codex continue/resume delivers the launch command with exactly one carriage return', async () => {
    const runtime = new CodexRuntime({ config: { binary: 'codex', toolTimeoutSec: 600 }, baseDir: '/base' });
    const command = runtime.buildLaunchCommand(makeSession(), IDENTITY, { continueSession: true });
    expect(command).toContain('resume --last');
    await backend().launch(PANE, command);
    expectSingleSubmitCarriageReturn(deliveryScript());
  });

  it('mid-session message delivery submits with exactly one carriage return', async () => {
    await backend().run(PANE, 'status update, please');
    expectSingleSubmitCarriageReturn(deliveryScript());
  });
});
