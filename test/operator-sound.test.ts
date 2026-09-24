import { afterEach, describe, expect, it, vi } from 'vitest';

import { supervisorConfigSchema } from '../src/config/schema.js';
import { OperatorRequests } from '../src/core/operator-requests.js';
import {
  OPERATOR_SOUND_MIN_INTERVAL_MS,
  OperatorSound,
  resolveOperatorSound,
  type OperatorSoundKind,
  type OperatorSoundSettings,
  type SoundPlayer,
} from '../src/core/operator-sound.js';
import { log } from '../src/logger.js';
import { Store } from '../src/store/index.js';

const ENABLED: OperatorSoundSettings = { enabled: true, sound: 'Glass', choicesSound: null };

interface Harness {
  sound: OperatorSound;
  plays: { file: string; args: readonly string[] }[];
  fail: (error: Error) => void;
  advance: (ms: number) => void;
}

function harness(settings: OperatorSoundSettings = ENABLED, platform: NodeJS.Platform = 'darwin'): Harness {
  const plays: { file: string; args: readonly string[] }[] = [];
  let onError: ((error: Error) => void) | undefined;
  let clock = 1_000_000;
  const player: SoundPlayer = (file, args, reportError) => {
    plays.push({ file, args });
    onError = reportError;
  };
  const sound = new OperatorSound({ settings, platform, player, now: () => clock });
  return {
    sound,
    plays,
    fail: (error) => onError?.(error),
    advance: (ms) => {
      clock += ms;
    },
  };
}

function requests(sound: { notify(kind: OperatorSoundKind): void }, delivered = true) {
  const store = new Store(':memory:');
  const operatorRequests = new OperatorRequests({
    store,
    channelSend: async () => delivered,
    messaging: { sendToSession: async () => 'Delivered.' },
    sound,
  });
  return { store, operatorRequests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OperatorSound', () => {
  it('is off by default and never plays', () => {
    const config = supervisorConfigSchema.parse({});
    expect(config.channels.operatorSound).toEqual({ enabled: false, sound: 'Glass', choicesSound: null });
    const { sound, plays } = harness(config.channels.operatorSound);
    sound.notify('message');
    sound.notify('choices');
    expect(plays).toEqual([]);
  });

  it('plays the configured sound through afplay and uses the choices sound when set', () => {
    const { sound, plays, advance } = harness({ enabled: true, sound: 'Glass', choicesSound: '/tmp/ask.aiff' });
    sound.notify('message');
    advance(OPERATOR_SOUND_MIN_INTERVAL_MS);
    sound.notify('choices');
    expect(plays).toEqual([
      { file: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'] },
      { file: 'afplay', args: ['/tmp/ask.aiff'] },
    ]);
    expect(resolveOperatorSound('Ping')).toBe('/System/Library/Sounds/Ping.aiff');
  });

  it('debounces a burst to one sound per interval', () => {
    const { sound, plays, advance } = harness();
    sound.notify('message');
    advance(1_000);
    sound.notify('message');
    advance(1_000);
    sound.notify('choices');
    expect(plays).toHaveLength(1);
    advance(OPERATOR_SOUND_MIN_INTERVAL_MS - 2_000);
    sound.notify('message');
    expect(plays).toHaveLength(2);
  });

  it('stays silent off macOS and logs that once at debug level', () => {
    const debug = vi.spyOn(log(), 'debug').mockImplementation(() => undefined);
    const { sound, plays } = harness(ENABLED, 'linux');
    sound.notify('message');
    sound.notify('message');
    expect(plays).toEqual([]);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('logs a player failure once, however often it recurs', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const { sound, fail, advance } = harness();
    sound.notify('message');
    fail(new Error('sound file missing'));
    advance(OPERATOR_SOUND_MIN_INTERVAL_MS);
    sound.notify('message');
    fail(new Error('sound file missing'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('sound file missing');
  });
});

describe('send_to_operator sound', () => {
  it('alerts exactly once per send_to_operator call, with the message kind', async () => {
    const notify = vi.fn();
    const { store, operatorRequests } = requests({ notify });
    expect(await operatorRequests.send('alpha', 'heads up')).toBe('Sent to the operator.');
    expect(await operatorRequests.send('alpha', 'which?', ['a', 'b'])).toBe('Request #1 sent to the operator.');
    expect(notify.mock.calls).toEqual([['message'], ['choices']]);
    store.close();
  });

  it('still alerts when no operator interface accepted the message', async () => {
    const notify = vi.fn();
    const { store, operatorRequests } = requests({ notify }, false);
    expect(await operatorRequests.send('alpha', 'heads up')).toContain('NOT delivered');
    expect(notify.mock.calls).toEqual([['message']]);
    store.close();
  });

  it('delivers the message even when the alert throws', async () => {
    const { store, operatorRequests } = requests({
      notify: () => {
        throw new Error('speaker exploded');
      },
    });
    expect(await operatorRequests.send('alpha', 'heads up')).toBe('Sent to the operator.');
    store.close();
  });

  it('still delivers and logs once when the player binary is missing', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const sound = new OperatorSound({
      settings: ENABLED,
      platform: 'darwin',
      binary: 'conductor-test-missing-sound-player',
    });
    const { store, operatorRequests } = requests(sound);
    expect(await operatorRequests.send('alpha', 'heads up')).toBe('Sent to the operator.');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]?.[1]).toContain('conductor-test-missing-sound-player');
    store.close();
  });
});

describe('operatorSound configuration', () => {
  it('accepts an enabled alert with custom sounds', () => {
    const config = supervisorConfigSchema.parse({
      channels: { operatorSound: { enabled: true, sound: 'Ping', choicesSound: '/Users/me/ask.aiff' } },
    });
    expect(config.channels.operatorSound).toEqual({
      enabled: true,
      sound: 'Ping',
      choicesSound: '/Users/me/ask.aiff',
    });
  });

  it('rejects unknown keys, blank sounds, and non-boolean enablement', () => {
    for (const operatorSound of [{ volume: 3 }, { sound: '  ' }, { choicesSound: '' }, { enabled: 'yes' }]) {
      expect(supervisorConfigSchema.safeParse({ channels: { operatorSound } }).success).toBe(false);
    }
  });
});
