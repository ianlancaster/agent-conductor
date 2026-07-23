import { CODENAME_PATTERN, FEDERATION_NAME_PATTERN } from '../config/schema.js';
import { FederationError, MAX_FEDERATED_MESSAGE_BYTES, type FederationAddress } from './types.js';

const MAX_ADDRESS_LENGTH = 128;

export function parseFederationAddress(value: string): FederationAddress {
  if (value.length < 3 || value.length > MAX_ADDRESS_LENGTH) {
    throw new FederationError('address_invalid', 'Federation address must be between 3 and 128 characters.');
  }
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) {
    throw new FederationError('address_invalid', "Federation address must have the form 'session@fleet'.");
  }
  const codename = value.slice(0, at);
  const fleet = value.slice(at + 1);
  if (!CODENAME_PATTERN.test(codename) || !FEDERATION_NAME_PATTERN.test(fleet)) {
    throw new FederationError('address_invalid', "Federation address must have the form 'session@fleet'.");
  }
  return { codename, fleet, qualified: `${codename}@${fleet}` };
}

export function qualifyFederationAddress(codename: string, fleet: string): string {
  return parseFederationAddress(`${codename}@${fleet}`).qualified;
}

export function validateFederatedMessage(message: string): void {
  if (message.length === 0) throw new FederationError('message_invalid', 'Federated message must not be empty.');
  if (Buffer.byteLength(message, 'utf8') > MAX_FEDERATED_MESSAGE_BYTES) {
    throw new FederationError('message_invalid', 'Federated message exceeds the 64 KiB UTF-8 limit.');
  }
  for (const character of message) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
      throw new FederationError('message_invalid', 'Federated message contains unsupported control characters.');
    }
  }
}
