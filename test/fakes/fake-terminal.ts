import type { PaneRef, Placement } from '../../src/core/types.js';
import type { TerminalBackend, TerminalCapabilities } from '../../src/terminals/types.js';

export interface FakePane {
  agent: string;
  placement: Placement;
  cwd: string | undefined;
  lines: string[];
  alive: boolean;
  name: string;
  launched: string[];
  received: string[];
}

/** In-memory TerminalBackend — the test harness for everything above the seam. */
export class FakeTerminalBackend implements TerminalBackend {
  readonly name = 'fake';
  readonly capabilities: TerminalCapabilities = { focusTracking: true, headless: true };

  readonly panes = new Map<string, FakePane>();
  focusedAgent: string | null = null;
  survivors = new Map<string, PaneRef>();
  private counter = 0;

  async init(): Promise<void> {
    // no-op
  }

  async createPane(agent: string, placement: Placement, cwd?: string): Promise<PaneRef> {
    this.counter += 1;
    const id = `pane-${this.counter}`;
    this.panes.set(id, {
      agent,
      placement,
      cwd,
      lines: [],
      alive: true,
      name: agent,
      launched: [],
      received: [],
    });
    return { backend: this.name, id };
  }

  async launch(pane: PaneRef, command: string): Promise<void> {
    const p = this.mustGet(pane);
    p.launched.push(command);
    p.lines.push(`$ ${command}`);
  }

  async run(pane: PaneRef, text: string): Promise<void> {
    const p = this.mustGet(pane);
    p.received.push(text);
    p.lines.push(...text.split('\n'));
  }

  async capture(pane: PaneRef, lines: number): Promise<string> {
    return this.mustGet(pane).lines.slice(-lines).join('\n');
  }

  async isAlive(pane: PaneRef): Promise<boolean> {
    return this.panes.get(pane.id)?.alive ?? false;
  }

  async kill(pane: PaneRef): Promise<void> {
    const p = this.panes.get(pane.id);
    if (p) p.alive = false;
  }

  async rename(pane: PaneRef, name: string): Promise<void> {
    this.mustGet(pane).name = name;
  }

  async rediscover(): Promise<Map<string, PaneRef>> {
    return new Map(this.survivors);
  }

  async getFocusedAgent(): Promise<string | null> {
    return this.focusedAgent;
  }

  async focusWindow(): Promise<void> {
    // no-op
  }

  // ── test helpers ──────────────────────────────────────────────────────────

  setPaneContent(paneId: string, content: string): void {
    const p = this.panes.get(paneId);
    if (!p) throw new Error(`No fake pane ${paneId}`);
    p.lines = content.split('\n');
  }

  paneFor(agent: string): FakePane | undefined {
    return [...this.panes.values()].find((p) => p.agent === agent && p.alive);
  }

  private mustGet(pane: PaneRef): FakePane {
    const p = this.panes.get(pane.id);
    if (!p) throw new Error(`No fake pane ${pane.id}`);
    if (!p.alive) throw new Error(`Fake pane ${pane.id} is dead`);
    return p;
  }
}
