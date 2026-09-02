import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConductorOperations, OperationActor } from '../src/core/operations.js';
import { FEDERATION_PROTOCOL_VERSION, type FederationRegistry } from '../src/federation/registry.js';
import { FEDERATION_CONTROL_TIMEOUT_MS, FederationRouter } from '../src/federation/router.js';

const actor: OperationActor = { audience: 'session', codename: 'alpha' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function operations(): ConductorOperations {
  return {
    definition: () => ({ audiences: ['session'], federation: 'routable' }),
    invoke: vi.fn().mockResolvedValue('alpha: paused'),
  } as unknown as ConductorOperations;
}

describe('FederationRouter whole-federation control', () => {
  it('uses the exact per-peer deadline and reports response loss as unconfirmed', async () => {
    expect(FEDERATION_CONTROL_TIMEOUT_MS).toBe(15_000);
    const registry = {
      controlSnapshot: async () => ({
        peers: [
          {
            name: 'frontend',
            host: '127.0.0.1',
            port: 4000,
            pid: process.pid,
            protocol: FEDERATION_PROTOCOL_VERSION,
            sessions: ['alpha'],
          },
          {
            name: 'backend',
            host: '127.0.0.1',
            port: 4001,
            pid: process.pid,
            protocol: FEDERATION_PROTOCOL_VERSION,
            sessions: ['beta'],
          },
        ],
        incompatible: [{ name: 'legacy', protocol: 1 }],
      }),
    } as unknown as FederationRegistry;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('connection closed after applying request'));
    vi.stubGlobal('fetch', fetchMock);
    const router = new FederationRouter('frontend', registry, operations());

    const result = await router.invokeFederationWide('pause_session', actor);

    expect(result).toContain('frontend: confirmed.');
    expect(result).toContain('backend: unconfirmed after the peer connection closed without a response.');
    expect(result).toContain('legacy: failed — incompatible federation protocol 1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the fixed deadline as unconfirmed because the peer may have applied the request', async () => {
    const registry = {
      controlSnapshot: async () => ({
        peers: [
          {
            name: 'backend',
            host: '127.0.0.1',
            port: 4001,
            pid: process.pid,
            protocol: FEDERATION_PROTOCOL_VERSION,
            sessions: ['beta'],
          },
        ],
        incompatible: [],
      }),
    } as unknown as FederationRegistry;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));
    const router = new FederationRouter('frontend', registry, operations());

    const result = await router.invokeFederationWide('pause_session', actor);

    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(result).toContain('backend: unconfirmed after 15000ms; the fleet may have applied the operation.');
  });

  it('reports connection refusal as a confirmed fleet failure', async () => {
    const registry = {
      controlSnapshot: async () => ({
        peers: [
          {
            name: 'backend',
            host: '127.0.0.1',
            port: 4001,
            pid: process.pid,
            protocol: FEDERATION_PROTOCOL_VERSION,
            sessions: ['beta'],
          },
        ],
        incompatible: [],
      }),
    } as unknown as FederationRegistry;
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused));
    const router = new FederationRouter('frontend', registry, operations());

    const result = await router.invokeFederationWide('pause_session', actor);

    expect(result).toContain("backend: failed — Federation fleet 'backend' is unavailable.");
  });

  it('rejects recursive federation-wide control from a remote origin', async () => {
    const router = new FederationRouter('backend', {} as FederationRegistry, operations());

    await expect(
      router.invokeFederationWide('pause_session', {
        audience: 'session',
        codename: 'alpha@frontend',
        origin: { fleet: 'frontend', session: 'alpha' },
      }),
    ).rejects.toThrow("The 'federation' target can only originate in the caller's local fleet.");
  });
});
