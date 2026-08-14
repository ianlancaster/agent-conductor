import type { SupervisorConfig } from '../../config/schema.js';
import { CodexRuntime } from '../codex/index.js';
import { resolveExecutable } from '../executable.js';

export type SpartanRuntimeSettings = SupervisorConfig['runtimes']['spartan'];

export interface SpartanRuntimeOptions {
  config: SpartanRuntimeSettings;
  codexConfig: SupervisorConfig['runtimes']['codex'];
  baseDir: string;
  protocolPath?: string;
  sessionDataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** SPARTAN launcher using Conductor's Codex-compatible process harness. */
export class SpartanRuntime extends CodexRuntime {
  constructor(opts: SpartanRuntimeOptions) {
    super({
      config: opts.codexConfig,
      baseDir: opts.baseDir,
      protocolPath: opts.protocolPath,
      sessionDataDir: opts.sessionDataDir,
      runtimeName: 'spartan',
      launcherBinary: opts.config.binary,
      prepareLaunchEnvironment: async () => {
        const codexBinary = await resolveExecutable(opts.codexConfig.binary, {
          cwd: opts.baseDir,
          env: opts.env,
        });
        if (codexBinary === undefined) {
          throw new Error(
            `SPARTAN requires the configured Codex CLI '${opts.codexConfig.binary}', but it could not be resolved to an executable.`,
          );
        }
        return {
          SPARTAN_CODEX_BINARY: codexBinary,
          SPARTAN_CODEX_HOME_ISOLATED: '1',
        };
      },
    });
  }
}
