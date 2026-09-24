import { execFile } from 'node:child_process';
import { log } from '../logger.js';

/** At most one sound per interval, so a burst of operator messages does not become a siren. */
export const OPERATOR_SOUND_MIN_INTERVAL_MS = 5_000;

const MACOS_SOUNDS_DIR = '/System/Library/Sounds';

export type OperatorSoundKind = 'message' | 'choices';

export interface OperatorSoundSettings {
  enabled: boolean;
  /** A macOS system sound name such as `Glass`, or a path to an audio file. */
  sound: string;
  /** Optional different sound for messages that carry selectable choices. */
  choicesSound: string | null;
}

/** Starts a player without waiting for it; the callback reports only failures. */
export type SoundPlayer = (file: string, args: readonly string[], onError: (error: Error) => void) => void;

export interface OperatorSoundOptions {
  settings: OperatorSoundSettings;
  platform?: NodeJS.Platform;
  /** Player executable; macOS ships `afplay`. */
  binary?: string;
  player?: SoundPlayer;
  now?: () => number;
}

const execFilePlayer: SoundPlayer = (file, args, onError) => {
  execFile(file, [...args], { timeout: 30_000 }, (error) => {
    if (error !== null) onError(error);
  });
};

/** A system sound name resolves to the macOS sound library; anything path-like is used as given. */
export function resolveOperatorSound(sound: string): string {
  return sound.includes('/') ? sound : `${MACOS_SOUNDS_DIR}/${sound}.aiff`;
}

/**
 * Host-local audible alert for operator-bound session messages.
 *
 * Fire-and-forget: playing never delays, fails, or changes message delivery.
 * Only macOS has a player; other hosts log once at debug level and stay silent.
 */
export class OperatorSound {
  private readonly platform: NodeJS.Platform;
  private readonly binary: string;
  private readonly player: SoundPlayer;
  private readonly now: () => number;
  private lastPlayedAt: number | undefined;
  private reportedUnavailable = false;
  private reportedFailure = false;

  constructor(private readonly options: OperatorSoundOptions) {
    this.platform = options.platform ?? process.platform;
    this.binary = options.binary ?? 'afplay';
    this.player = options.player ?? execFilePlayer;
    this.now = options.now ?? Date.now;
  }

  notify(kind: OperatorSoundKind): void {
    const { settings } = this.options;
    if (!settings.enabled) return;
    if (this.platform !== 'darwin') {
      if (!this.reportedUnavailable) {
        this.reportedUnavailable = true;
        log().debug('operator-sound', `no sound player on ${this.platform}; operator messages stay silent`);
      }
      return;
    }
    const now = this.now();
    if (this.lastPlayedAt !== undefined && now - this.lastPlayedAt < OPERATOR_SOUND_MIN_INTERVAL_MS) return;
    this.lastPlayedAt = now;
    const sound = kind === 'choices' ? (settings.choicesSound ?? settings.sound) : settings.sound;
    try {
      this.player(this.binary, [resolveOperatorSound(sound)], (error) => this.reportFailure(error));
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    const detail = error instanceof Error ? error.message : String(error);
    log().warn('operator-sound', `could not play the operator sound (${this.binary}): ${detail}`);
  }
}
