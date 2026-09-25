import { existsSync, readdirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/**
 * mtime alone misses a replacement that preserves it (`cp -p`, `rsync -a`, an atomic
 * rename of a `touch -r` copy). The inode, status-change time, and size catch those.
 */
function fingerprint(stats: Stats): string {
  return `${String(stats.mtimeMs)}:${String(stats.ctimeMs)}:${String(stats.ino)}:${String(stats.size)}`;
}

/**
 * Single stat-poll watcher over the session-config directory.
 * Replaces cc-conductor's two overlapping hot-reload mechanisms: one watcher,
 * any number of subscribers (roster reload, scheduler reload).
 */
export class ConfigWatcher {
  /** Per-file change fingerprint (see {@link fingerprint}). */
  private readonly fingerprints = new Map<string, string>();
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
    let changed = current.size !== this.fingerprints.size;
    if (!changed) {
      for (const [file, value] of current) {
        if (this.fingerprints.get(file) !== value) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.fingerprints.clear();
      for (const [file, value] of current) this.fingerprints.set(file, value);
      for (const listener of this.listeners) listener();
    }
    return changed;
  }

  private snapshot(): void {
    for (const [file, value] of this.scan()) this.fingerprints.set(file, value);
  }

  private scan(): Map<string, string> {
    const result = new Map<string, string>();
    if (existsSync(this.dir)) {
      for (const entry of readdirSync(this.dir)) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
        const file = join(this.dir, entry);
        try {
          result.set(file, fingerprint(statSync(file)));
        } catch {
          // File deleted between readdir and stat — treated as absent.
        }
      }
    }
    return result;
  }
}
