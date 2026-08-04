import type { PaneRef, Placement } from '../../src/core/types.js';
import type {
  CreatePaneOptions,
  DeliveryCapture,
  TerminalBackend,
  TerminalCapabilities,
} from '../../src/terminals/types.js';

export interface FakePane {
  session: string;
  placement: Placement;
  headless: boolean;
  cwd: string | undefined;
  lines: string[];
  alive: boolean;
  sessionActive: boolean;
  name: string;
  launched: string[];
  received: string[];
}

/** In-memory TerminalBackend — the test harness for everything above the seam. */
export class FakeTerminalBackend implements TerminalBackend {
  readonly name = 'fake';
  readonly capabilities: TerminalCapabilities = { headless: true };

  readonly panes = new Map<string, FakePane>();
  survivors = new Map<string, PaneRef>();
  /**
   * Pane ids the terminal cannot currently be asked about — isAlive throws
   * rather than answering. A real terminal does this on a timeout, a busy
   * automation queue, or an element that vanished mid-scan; it is a different
   * fact from a pane that is gone, and callers must not conflate them.
   */
  readonly unobservable = new Set<string>();
  private counter = 0;

  async init(): Promise<void> {
    // no-op
  }

  async createPane(session: string, placement: Placement, cwd?: string, opts?: CreatePaneOptions): Promise<PaneRef> {
    this.counter += 1;
    const id = `pane-${this.counter}`;
    this.panes.set(id, {
      session,
      placement,
      headless: opts?.headless === true,
      cwd,
      lines: [],
      alive: true,
      sessionActive: false,
      name: session,
      launched: [],
      received: [],
    });
    return { backend: this.name, id };
  }

  async launch(pane: PaneRef, command: string): Promise<void> {
    const p = this.mustGet(pane);
    p.sessionActive = true;
    p.launched.push(command);
    p.lines.push(`$ ${command}`);
  }

  async run(pane: PaneRef, text: string): Promise<void> {
    const p = this.mustGet(pane);
    p.received.push(text);
    p.lines.push(...text.split('\n'));
  }

  async captureForDelivery(pane: PaneRef, lines: number): Promise<DeliveryCapture> {
    const content = this.mustGet(pane).lines.join('\n');
    return { content: content.split('\n').slice(-lines).join('\n'), token: content };
  }

  async submitIfUnchanged(pane: PaneRef, text: string, token: string): Promise<boolean> {
    if (this.mustGet(pane).lines.join('\n') !== token) return false;
    await this.run(pane, text);
    return true;
  }

  async capture(pane: PaneRef, lines: number): Promise<string> {
    return this.mustGet(pane).lines.slice(-lines).join('\n');
  }

  async isAlive(pane: PaneRef): Promise<boolean> {
    if (this.unobservable.has(pane.id)) throw new Error(`fake terminal cannot observe ${pane.id}`);
    return this.panes.get(pane.id)?.alive ?? false;
  }

  async isSessionActive(pane: PaneRef): Promise<boolean> {
    const p = this.panes.get(pane.id);
    return p?.alive === true && p.sessionActive;
  }

  async kill(pane: PaneRef): Promise<void> {
    const p = this.panes.get(pane.id);
    if (p) {
      p.alive = false;
      p.sessionActive = false;
    }
  }

  async rename(pane: PaneRef, name: string): Promise<void> {
    this.mustGet(pane).name = name;
  }

  async rediscover(): Promise<Map<string, PaneRef>> {
    return new Map(this.survivors);
  }

  // ── test helpers ──────────────────────────────────────────────────────────

  setPaneContent(paneId: string, content: string): void {
    const p = this.panes.get(paneId);
    if (!p) throw new Error(`No fake pane ${paneId}`);
    p.lines = content.split('\n');
  }

  endSession(paneId: string): void {
    const p = this.panes.get(paneId);
    if (!p) throw new Error(`No fake pane ${paneId}`);
    p.sessionActive = false;
  }

  paneFor(session: string): FakePane | undefined {
    return [...this.panes.values()].find((p) => p.session === session && p.alive);
  }

  private mustGet(pane: PaneRef): FakePane {
    const p = this.panes.get(pane.id);
    if (!p) throw new Error(`No fake pane ${pane.id}`);
    if (!p.alive) throw new Error(`Fake pane ${pane.id} is dead`);
    return p;
  }
}
