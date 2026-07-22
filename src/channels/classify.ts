/** Canonical operator-channel routing result. */
export type ClassifiedChannelInput =
  { kind: 'command'; command: string; args: string[] } | { kind: 'freeText'; text: string };

/** Classify the slash-command convention shared by operator channels. */
export function classifySlashInput(text: string): ClassifiedChannelInput {
  if (text.startsWith('//')) return { kind: 'freeText', text: text.slice(1) };
  if (!text.startsWith('/')) return { kind: 'freeText', text };

  const parts = text.split(/\s+/).filter((part) => part.length > 0);
  return {
    kind: 'command',
    command: (parts[0] ?? '/').slice(1),
    args: parts.slice(1),
  };
}
