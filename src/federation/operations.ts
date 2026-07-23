import { InvalidRequestError } from '../core/errors.js';
import {
  operationSchema,
  optionalString,
  requireString,
  stringProperty,
  validateOperationInput,
  type OperationInputSchema,
} from '../core/operation-schema.js';
import type { OperationActor, OperationAudience } from '../core/operations.js';
import type { FederationService } from './service.js';
import { FederationError } from './types.js';

export interface FederationOperationDefinition {
  name: 'list_peers' | 'send_to_peer' | 'get_peer_message_status';
  description: string;
  audiences: readonly OperationAudience[];
  inputSchema: OperationInputSchema;
  signedIdentity?: boolean;
  handler(args: Record<string, unknown>, actor: OperationActor): Promise<unknown>;
}

const BOTH = ['operator', 'session'] as const;

/** Concrete messages-only federation surface for sessions and operators. */
export class FederationOperations {
  private readonly byName: Map<string, FederationOperationDefinition>;

  constructor(private readonly service: FederationService) {
    const definitions = this.buildDefinitions();
    this.byName = new Map(definitions.map((definition) => [definition.name, definition]));
  }

  definitions(audience?: OperationAudience): FederationOperationDefinition[] {
    const definitions = [...this.byName.values()];
    return audience === undefined
      ? definitions
      : definitions
          .filter((definition) => definition.audiences.includes(audience))
          .map((definition) => this.forAudience(definition, audience));
  }

  async invoke(name: string, args: Record<string, unknown>, actor: OperationActor): Promise<unknown> {
    const baseDefinition = this.byName.get(name);
    if (baseDefinition === undefined) throw new Error(`Unknown federation operation: ${name}`);
    if (!baseDefinition.audiences.includes(actor.audience)) {
      throw new Error(`${name} is not available to ${actor.audience} callers`);
    }
    const definition = this.forAudience(baseDefinition, actor.audience);
    validateOperationInput(definition.name, definition.inputSchema, args);
    try {
      return await definition.handler(args, actor);
    } catch (error) {
      if (error instanceof FederationError) throw new InvalidRequestError(`[${error.code}] ${error.message}`);
      throw error;
    }
  }

  private forAudience(
    definition: FederationOperationDefinition,
    audience: OperationAudience,
  ): FederationOperationDefinition {
    if (definition.name !== 'send_to_peer' || audience !== 'session') return definition;
    const { sourceSession: _sourceSession, ...properties } = definition.inputSchema.properties;
    return {
      ...definition,
      inputSchema: {
        ...definition.inputSchema,
        properties,
        required: definition.inputSchema.required?.filter((name) => name !== 'sourceSession'),
      },
    };
  }

  private buildDefinitions(): FederationOperationDefinition[] {
    return [
      {
        name: 'list_peers',
        description:
          'List explicitly exposed sessions in other local Conductor fleets. Addresses are exact and replyable.',
        audiences: BOTH,
        inputSchema: operationSchema(),
        handler: async () => ({ peers: await this.service.listPeers() }),
      },
      {
        name: 'send_to_peer',
        description:
          'Send a durable message to an exposed session in another fleet. Use an exact address from list_peers; this never starts the target.',
        audiences: BOTH,
        signedIdentity: true,
        inputSchema: operationSchema(
          {
            address: stringProperty("Exact peer address from list_peers, such as 'reviewer@other-fleet'"),
            message: { ...stringProperty('Message text'), maxLength: 65_536 },
            idempotencyKey: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'Optional sender-scoped key for durable deduplication',
            },
            sourceSession: stringProperty('Operator-only: exposed local session represented as the sender'),
          },
          ['address', 'message', 'sourceSession'],
        ),
        handler: (args, actor) => {
          const source = actor.audience === 'session' ? actor.codename : requireString(args, 'sourceSession');
          if (actor.audience === 'session' && args.sourceSession !== undefined) {
            throw new InvalidRequestError("'sourceSession' is set mechanically for session callers");
          }
          return this.service.sendToPeer(
            source,
            requireString(args, 'address'),
            requireString(args, 'message'),
            optionalString(args, 'idempotencyKey'),
          );
        },
      },
      {
        name: 'get_peer_message_status',
        description: "Inspect this Conductor's durable status for one federated message.",
        audiences: BOTH,
        inputSchema: operationSchema({ messageId: stringProperty('Federation message UUID') }, ['messageId']),
        handler: async (args, actor) => {
          const messageId = requireString(args, 'messageId');
          const status = this.service.messageStatus(
            messageId,
            actor.audience === 'session' ? actor.codename : undefined,
          );
          return status ?? { messageId, status: 'not_found' };
        },
      },
    ];
  }
}
