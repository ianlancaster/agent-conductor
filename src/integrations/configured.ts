import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConfiguredIntegration } from '../config/schema.js';
import type { ConductorIntegration, ConductorIntegrationFactory } from './types.js';

export interface ResolvedConfiguredIntegration {
  readonly index: number;
  readonly configuredModule: string;
  readonly modulePath: string;
  readonly moduleUrl: string;
  readonly options: Record<string, unknown>;
}

/**
 * Resolve and stat configured executable modules without importing them.
 *
 * This function is safe for validate/doctor/preflight: it never executes
 * plugin code. Relative paths are intentionally confined to the fleet root;
 * an absolute path is the fleet owner's explicit escape hatch.
 */
export function resolveConfiguredIntegrations(
  fleetDir: string,
  configured: readonly ConfiguredIntegration[],
): readonly ResolvedConfiguredIntegration[] {
  const fleetRoot = resolve(fleetDir);
  return configured.map((entry, index) => {
    const configuredModule = entry.module;
    const absolute = isAbsolute(configuredModule);
    if (!absolute && /^[a-z][a-z\d+.-]*:/iu.test(configuredModule)) {
      throw integrationPathError(index, configuredModule, undefined, 'URLs and file: specifiers are not supported');
    }
    if (!absolute && !configuredModule.startsWith('./') && !configuredModule.startsWith('../')) {
      throw integrationPathError(
        index,
        configuredModule,
        undefined,
        'bare module specifiers are not supported; use an explicit ./ file path',
      );
    }

    const modulePath = resolve(fleetRoot, configuredModule);
    if (!absolute) {
      const fromFleet = relative(fleetRoot, modulePath);
      if (fromFleet === '..' || fromFleet.startsWith(`..${sep}`) || isAbsolute(fromFleet)) {
        throw integrationPathError(index, configuredModule, modulePath, 'relative path escapes the fleet root');
      }
    }

    let regularFile = false;
    try {
      regularFile = statSync(modulePath).isFile();
    } catch (error) {
      const detail =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'file does not exist'
          : `file could not be inspected: ${boundedError(error)}`;
      throw integrationPathError(index, configuredModule, modulePath, detail);
    }
    if (!regularFile) {
      throw integrationPathError(index, configuredModule, modulePath, 'path is not a regular file');
    }

    return Object.freeze({
      index,
      configuredModule,
      modulePath,
      moduleUrl: pathToFileURL(modulePath).href,
      options: entry.options,
    });
  });
}

/**
 * Execute configured factories exactly once each, in configuration order.
 *
 * All entries are resolved before the first import so a missing later file
 * cannot construct earlier integrations. Import/factory failures are fatal
 * before Supervisor readiness.
 */
export async function loadConfiguredIntegrations(
  fleetDir: string,
  configured: readonly ConfiguredIntegration[],
): Promise<ConductorIntegration[]> {
  const fleetRoot = resolve(fleetDir);
  const resolved = resolveConfiguredIntegrations(fleetRoot, configured);
  const integrations: ConductorIntegration[] = [];
  for (const entry of resolved) {
    let namespace: { default?: unknown };
    try {
      namespace = (await import(entry.moduleUrl)) as { default?: unknown };
    } catch (error) {
      throw integrationLoadError(entry, `module import failed: ${boundedError(error)}`);
    }
    if (typeof namespace.default !== 'function') {
      throw integrationLoadError(entry, 'module must default-export a synchronous integration factory function');
    }

    const factory = namespace.default as ConductorIntegrationFactory;
    const options = Object.freeze({ ...entry.options });
    const input = Object.freeze({ fleetDir: fleetRoot, options });
    let integration: unknown;
    try {
      integration = factory(input);
    } catch (error) {
      throw integrationLoadError(entry, `factory threw: ${boundedError(error)}`);
    }
    if (isThenable(integration)) {
      throw integrationLoadError(
        entry,
        'factory returned a thenable; factories must synchronously construct and return an integration',
      );
    }
    if (integration === null || typeof integration !== 'object' || Array.isArray(integration)) {
      throw integrationLoadError(entry, 'factory must return one ConductorIntegration object');
    }
    integrations.push(integration as ConductorIntegration);
  }
  return integrations;
}

function integrationPathError(
  index: number,
  configuredModule: string,
  modulePath: string | undefined,
  detail: string,
): Error {
  return new Error(
    `integrations[${String(index)}].module '${configuredModule}'${
      modulePath === undefined ? '' : ` resolved to '${modulePath}'`
    }: ${detail}.`,
  );
}

function integrationLoadError(entry: ResolvedConfiguredIntegration, detail: string): Error {
  return new Error(
    `integrations[${String(entry.index)}].module '${entry.configuredModule}' resolved to '${entry.modulePath}': ${detail}.`,
  );
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  try {
    return typeof (value as { then?: unknown }).then === 'function';
  } catch {
    return true;
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 299)}…`;
}
