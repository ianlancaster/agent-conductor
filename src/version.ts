import { readFileSync } from 'node:fs';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** One package version shared by both CLIs and MCP server metadata. */
export const PACKAGE_VERSION = packageMetadata.version;
