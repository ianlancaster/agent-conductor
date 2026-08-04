import type { ConductorOperations } from '../core/operations.js';
import type { OperationInputSchema } from '../core/operations.js';
import type { FederationRouter } from '../federation/router.js';
import type { McpToolDefinition } from './server.js';

const IDENTITY_NOTE =
  'Your identity and message signature are added automatically by the conductor — do not prefix messages with your codename.';

/** MCP is a thin adapter over the canonical conductor operation registry. */
function federatedSchema(schema: OperationInputSchema): OperationInputSchema {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      fleet: {
        type: 'string',
        minLength: 1,
        description: 'Destination federation fleet (default: local fleet)',
      },
    },
  };
}

export function buildMcpTools(operations: ConductorOperations, federation?: FederationRouter): McpToolDefinition[] {
  return operations.definitions('session').map((operation) => ({
    name: operation.name,
    description: `${operation.description} Returns: ${operation.resultDescription}${
      operation.signedIdentity ? ` ${IDENTITY_NOTE}` : ''
    }`,
    inputSchema:
      federation !== undefined && operation.federation === 'routable'
        ? (federatedSchema(operation.inputSchema) as unknown as Record<string, unknown>)
        : (operation.inputSchema as unknown as Record<string, unknown>),
    handler: (args, caller) =>
      federation !== undefined && operation.federation === 'routable'
        ? federation.invokeFromSession(operation.name, args, caller)
        : operations.invoke(operation.name, args, { audience: 'session', codename: caller }),
  }));
}
