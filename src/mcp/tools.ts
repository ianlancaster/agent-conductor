import type { ConductorOperations } from '../core/operations.js';
import type { McpToolDefinition } from './server.js';

const IDENTITY_NOTE =
  'Your identity and message signature are added automatically by the conductor — do not prefix messages with your codename.';

/** MCP is a thin adapter over the canonical conductor operation registry. */
export function buildMcpTools(operations: ConductorOperations): McpToolDefinition[] {
  return operations.definitions('session').map((operation) => ({
    name: operation.name,
    description: `${operation.description} Returns: ${operation.resultDescription}${
      operation.signedIdentity ? ` ${IDENTITY_NOTE}` : ''
    }`,
    inputSchema: operation.inputSchema as unknown as Record<string, unknown>,
    handler: (args, caller) => operations.invoke(operation.name, args, { audience: 'session', codename: caller }),
  }));
}
