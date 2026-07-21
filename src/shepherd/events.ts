import { createHash } from 'node:crypto';
import type { ShepherdConfig } from './config.js';
import type { PullRequestRef, ShepherdEvent, ShepherdEventType } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function eventId(type: ShepherdEventType, pr: PullRequestRef, identity: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonical({ type, repo: pr.repo.toLowerCase(), pr: pr.number, ...identity }))
    .digest('hex');
}

export function factMessage(type: ShepherdEventType, pr: PullRequestRef, facts: Record<string, unknown>): string {
  const lines = [`[PR Shepherd] ${type}: ${pr.repo}#${String(pr.number)}`];
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined || value === null || value === '') continue;
    const rendered =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : (JSON.stringify(value) ?? '[unserializable]');
    lines.push(`${key}: ${rendered}`);
  }
  return lines.join('\n');
}

export function buildEvent(
  config: ShepherdConfig,
  type: ShepherdEventType,
  pr: PullRequestRef,
  identity: Record<string, unknown>,
  facts: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
): ShepherdEvent {
  const base = factMessage(type, pr, facts);
  const guidance = config.guidance[type];
  return {
    id: eventId(type, pr, identity),
    type,
    repo: pr.repo,
    prNumber: pr.number,
    occurredAt,
    source: { ...identity, ...facts },
    message: guidance === undefined ? base : `${base}\n\nGuidance:\n${guidance}`,
  };
}
