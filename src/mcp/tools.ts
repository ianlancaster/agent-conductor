import type { ConductorOperations } from '../core/operations.js';
import type { FederationOperations } from '../federation/operations.js';
import type { McpToolDefinition } from './server.js';

const IDENTITY_NOTE =
  'Your identity and message signature are added automatically by the conductor — do not prefix messages with your codename.';

/** MCP is a thin adapter over the canonical conductor operation registry. */
export function buildMcpTools(operations: ConductorOperations, federation?: FederationOperations): McpToolDefinition[] {
  const federationDefinitions = federation?.definitions('session') ?? [];
  const federationNames = new Set<string>(federationDefinitions.map((definition) => definition.name));
  const definitions = [...operations.definitions('session'), ...federationDefinitions];
  return definitions.map((operation) => ({
    name: operation.name,
    description: operation.signedIdentity ? `${operation.description} ${IDENTITY_NOTE}` : operation.description,
    inputSchema: operation.inputSchema as unknown as Record<string, unknown>,
    handler: (args, caller) =>
      federation !== undefined && federationNames.has(operation.name)
        ? federation.invoke(operation.name, args, { audience: 'session', codename: caller })
        : operations.invoke(operation.name, args, { audience: 'session', codename: caller }),
  }));
}
