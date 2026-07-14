import { join } from 'node:path';
import type { IdentityEndpoints } from '../runtimes/types.js';

export interface IdentitySettings {
  host: string;
  port: number;
  dataDir: string;
}

/**
 * Per-agent identity endpoints. The codename embedded in the URLs IS the
 * identity — the MCP server extracts it from the path, so agents cannot
 * impersonate each other.
 */
export function identityFor(codename: string, settings: IdentitySettings): IdentityEndpoints {
  const base = `http://${settings.host}:${settings.port}`;
  const encoded = encodeURIComponent(codename);
  return {
    mcpUrl: `${base}/mcp/${encoded}`,
    eventsUrl: `${base}/events/${encoded}`,
    configDir: join(settings.dataDir, 'agents', codename),
  };
}
