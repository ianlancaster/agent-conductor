import type { OperatorCommandDefinition } from '../core/commands.js';
import type { OperationActor } from '../core/operations.js';
import type { FederationOperations } from './operations.js';
import type { FederationMessageReceipt, PeerDirectoryEntry } from './types.js';
import { renderFederationReceipt } from './service.js';

export function buildFederationOperatorCommands(operations: FederationOperations): OperatorCommandDefinition[] {
  const invoke = (name: string, args: Record<string, unknown>, actor: OperationActor): Promise<unknown> =>
    operations.invoke(name, args, actor);
  return [
    {
      command: 'peers',
      operations: ['list_peers'],
      group: 'Federation',
      usage: '/peers',
      description: 'List explicitly exposed sessions in other local Conductor fleets.',
      invoke: async (_args, actor) => {
        const result = (await invoke('list_peers', {}, actor)) as { peers: PeerDirectoryEntry[] };
        if (result.peers.length === 0) return 'No exposed local peers are currently discoverable.';
        return result.peers
          .map(
            (peer) =>
              `${peer.address} — ${peer.presence} · ${peer.transport}` +
              `${peer.description !== undefined ? ` · ${peer.description}` : ''}` +
              `${peer.ambiguous === true ? ` · AMBIGUOUS instance ${peer.instanceId}` : ''}`,
          )
          .join('\n');
      },
    },
    {
      command: 'tell-peer',
      operations: ['send_to_peer'],
      group: 'Federation',
      usage: '/tell-peer <source-session> <address> <message>',
      description: 'Send a durable message as one exposed local session; never starts the peer.',
      invoke: async (args, actor) => {
        const [sourceSession, address, ...message] = args;
        if (sourceSession === undefined || address === undefined || message.length === 0) {
          throw new Error('Usage: /tell-peer <source-session> <address> <message>');
        }
        return renderFederationReceipt(
          (await invoke(
            'send_to_peer',
            { sourceSession, address, message: message.join(' ') },
            actor,
          )) as FederationMessageReceipt,
        );
      },
    },
    {
      command: 'peer-message-status',
      operations: ['get_peer_message_status'],
      group: 'Federation',
      usage: '/peer-message-status <message-id>',
      description: "Inspect this Conductor's durable status for a federated message.",
      invoke: async (args, actor) => {
        if (args.length !== 1 || args[0] === undefined) {
          throw new Error('Usage: /peer-message-status <message-id>');
        }
        return JSON.stringify(await invoke('get_peer_message_status', { messageId: args[0] }, actor), null, 2);
      },
    },
  ];
}
