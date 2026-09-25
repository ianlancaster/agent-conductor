import { readFileSync } from 'node:fs';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** One package version shared by both CLIs and MCP server metadata. */
export const PACKAGE_VERSION = packageMetadata.version;

function readBuildLabel(): string | undefined {
  try {
    // Present only in a built package (dist/build-info.json, next to this module).
    const info = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8')) as {
      commit?: unknown;
      dirty?: unknown;
    };
    if (typeof info.commit !== 'string') return undefined;
    return info.dirty === true ? `${info.commit}-dirty` : info.commit;
  } catch {
    return undefined;
  }
}

/** Source commit of the loaded build, or undefined when running from source or without Git metadata. */
export const PACKAGE_BUILD = readBuildLabel();

/** Human-readable build identity, for example `0.1.0 (63a6853)`. */
export function buildIdentity(version: string = PACKAGE_VERSION, build: string | undefined = PACKAGE_BUILD): string {
  return build === undefined ? version : `${version} (${build})`;
}
