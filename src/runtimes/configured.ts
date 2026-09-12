import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuredRuntimeAdapterSchema, type ConfiguredRuntimeAdapter } from '../config/schema.js';
import type { SessionRuntime } from './types.js';

export const RUNTIME_ADAPTER_API_VERSION = 1 as const;

/** Trusted factory input. No fleet secrets, environment values, store or control-plane handles. */
export interface RuntimeAdapterFactoryContext {
  readonly apiVersion: typeof RUNTIME_ADAPTER_API_VERSION;
  readonly conductorVersion: string;
  readonly name: string;
  readonly fleetDir: string;
  readonly protocolPath?: string;
  readonly sessionDataDir: string;
  readonly options: Readonly<Record<string, unknown>>;
}
export type RuntimeAdapterFactory = (context: RuntimeAdapterFactoryContext) => SessionRuntime;
export type RuntimeAdapterHostContext = Pick<
  RuntimeAdapterFactoryContext,
  'conductorVersion' | 'protocolPath' | 'sessionDataDir'
>;

export interface ResolvedRuntimeAdapter {
  readonly name: string;
  readonly modulePath: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** Resolve all files without importing them. Relative paths cannot escape through symlinks. */
export function resolveConfiguredRuntimeAdapters(
  fleetDir: string,
  configured: readonly ConfiguredRuntimeAdapter[],
): readonly ResolvedRuntimeAdapter[] {
  const names = new Set<string>();
  return configured.map((input, index) => {
    const parsed = configuredRuntimeAdapterSchema.safeParse(input);
    if (!parsed.success) throw new Error(`runtimeAdapters[${String(index)}]: invalid adapter configuration.`);
    const entry = parsed.data;
    const fail = (reason: string): never => {
      throw new Error(`Runtime adapter '${entry.name}': ${reason}.`);
    };
    if (names.has(entry.name)) fail('duplicate configured name');
    names.add(entry.name);
    const absolute = isAbsolute(entry.module);
    if (!absolute && !entry.module.startsWith('./') && !entry.module.startsWith('../')) {
      fail('use an explicit local file path; URLs and bare package names are unsupported');
    }
    let modulePath: string;
    try {
      modulePath = realpathSync(resolve(fleetDir, entry.module));
      if (!statSync(modulePath).isFile()) fail('module must be a regular file');
    } catch {
      fail('module is missing, unreadable or not a regular file');
    }
    if (!absolute) {
      const fromFleet = relative(realpathSync(fleetDir), modulePath!);
      if (fromFleet === '..' || fromFleet.startsWith(`..${sep}`) || isAbsolute(fromFleet)) {
        fail('relative module path escapes the fleet root');
      }
    }
    return Object.freeze({ name: entry.name, modulePath: modulePath!, options: Object.freeze({ ...entry.options }) });
  });
}

/** Foreground-only construction. Complete before creating Supervisor or launching any session. */
export async function loadConfiguredRuntimeAdapters(
  fleetDir: string,
  configured: readonly ConfiguredRuntimeAdapter[],
  host: RuntimeAdapterHostContext,
): Promise<SessionRuntime[]> {
  const resolved = resolveConfiguredRuntimeAdapters(fleetDir, configured);
  const runtimes: SessionRuntime[] = [];
  for (const entry of resolved) {
    const fail = (reason: string): never => {
      throw new Error(`Runtime adapter '${entry.name}': ${reason}.`);
    };
    let namespace: { runtimeAdapterApiVersion?: unknown; default?: unknown };
    try {
      namespace = (await import(pathToFileURL(entry.modulePath).href)) as {
        runtimeAdapterApiVersion?: unknown;
        default?: unknown;
      };
    } catch {
      fail('module import failed; check its locally installed dependencies');
    }
    if (namespace!.runtimeAdapterApiVersion !== RUNTIME_ADAPTER_API_VERSION)
      fail('unsupported runtimeAdapterApiVersion (expected 1)');
    if (typeof namespace!.default !== 'function') fail('default export must be a synchronous factory');
    let runtime: unknown;
    try {
      runtime = (namespace!.default as RuntimeAdapterFactory)(
        Object.freeze({
          ...host,
          apiVersion: RUNTIME_ADAPTER_API_VERSION,
          name: entry.name,
          fleetDir: resolve(fleetDir),
          options: entry.options,
        }),
      );
      // Consume a rejected Promise from an invalid async factory, without accepting async factories.
      if (
        runtime !== null &&
        (typeof runtime === 'object' || typeof runtime === 'function') &&
        typeof (runtime as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(runtime).catch(() => undefined);
        fail('factory must be synchronous');
      }
    } catch {
      fail('factory failed or returned a thenable; factories must construct synchronously without side effects');
    }
    try {
      if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) fail('invalid SessionRuntime');
      const value = runtime as Record<string, unknown>;
      if (value.name !== entry.name) fail('returned runtime name differs from configured name');
      for (const name of ['prepare', 'buildLaunchCommand', 'parseInputState', 'stripChrome', 'parseEvent']) {
        if (typeof value[name] !== 'function') fail(`missing required method ${name}`);
      }
      for (const name of ['parseActivityState', 'resolveInputState', 'readLastAssistantMessage']) {
        if (value[name] !== undefined && typeof value[name] !== 'function') fail(`invalid optional method ${name}`);
      }
      const caps = value.capabilities as Record<string, unknown> | undefined;
      if (!caps || typeof caps !== 'object' || Array.isArray(caps)) fail('invalid capabilities');
      for (const name of ['lifecycleEvents', 'contextProbe', 'styledCapture']) {
        if (typeof caps![name] !== 'boolean') fail(`invalid capability ${name}`);
      }
      for (const name of ['targetedResume', 'authoritativeTurnCompletion']) {
        if (caps![name] !== undefined && typeof caps![name] !== 'boolean') fail(`invalid capability ${name}`);
      }
      if (caps!.continuityState !== undefined && caps!.continuityState !== true)
        fail('invalid continuityState capability');
    } catch {
      fail('returned object does not satisfy SessionRuntime name, methods and capabilities');
    }
    runtimes.push(runtime as SessionRuntime);
  }
  return runtimes;
}
