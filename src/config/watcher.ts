import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single mtime-poll watcher over the session-config directory.
 * Replaces cc-conductor's two overlapping hot-reload mechanisms: one watcher,
 * any number of subscribers (roster reload, scheduler reload).
 */
export class ConfigWatcher {
  private readonly mtimes = new Map<string, number>();
  private readonly listeners: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dir: string) {
    this.snapshot();
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      this.checkNow();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Poll once; notify listeners if anything changed. Exposed for tests and manual ticks. */
  checkNow(): boolean {
    const current = this.scan();
    let changed = current.size !== this.mtimes.size;
    if (!changed) {
      for (const [file, mtime] of current) {
        if (this.mtimes.get(file) !== mtime) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.mtimes.clear();
      for (const [file, mtime] of current) this.mtimes.set(file, mtime);
      for (const listener of this.listeners) listener();
    }
    return changed;
  }

  private snapshot(): void {
    for (const [file, mtime] of this.scan()) this.mtimes.set(file, mtime);
  }

  private scan(): Map<string, number> {
    const result = new Map<string, number>();
    if (existsSync(this.dir)) {
      for (const entry of readdirSync(this.dir)) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
        const file = join(this.dir, entry);
        try {
          result.set(file, statSync(file).mtimeMs);
        } catch {
          // File deleted between readdir and stat — treated as absent.
        }
      }
    }
    return result;
  }
}
