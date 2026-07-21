import type { ShepherdConfig } from './config.js';

export function repositoryInScope(repo: string, config: ShepherdConfig['github']): boolean {
  const normalized = repo.toLowerCase();
  const owner = normalized.split('/')[0] ?? '';
  const includeOwners = new Set(config.includeOwners.map((value) => value.toLowerCase()));
  const includeRepos = new Set(config.includeRepos.map((value) => value.toLowerCase()));
  const excludeOwners = new Set(config.excludeOwners.map((value) => value.toLowerCase()));
  const excludeRepos = new Set(config.excludeRepos.map((value) => value.toLowerCase()));
  const included =
    includeOwners.size === 0 && includeRepos.size === 0
      ? true
      : includeOwners.has(owner) || includeRepos.has(normalized);
  return included && !excludeOwners.has(owner) && !excludeRepos.has(normalized);
}

export function patternMatches(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}
