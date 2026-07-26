import { randomUUID } from 'node:crypto';
import type { ConductorEventPublisher } from '../events/types.js';
import type { RunbookRegistry } from '../runbooks/registry.js';
import type { ResolvedRunbook } from '../runbooks/types.js';
import type { NewRunbookAdoption, RunbookAdoptionRow, RunbookAdoptionSessionRole, Store } from '../store/index.js';
import { InvalidRequestError } from './errors.js';

export interface AdoptRunbookInput {
  runbookId: string;
  version: string;
  topic: string;
  sessions?: readonly string[];
}

export interface SupersedeRunbookInput {
  adoptionId: string;
  runbookId: string;
  version: string;
  topic: string;
}

export interface RunbookAdoptionsDeps {
  store: Store;
  registry: RunbookRegistry;
  sessions(): ReadonlyMap<string, unknown>;
  events: ConductorEventPublisher;
}

export interface RunbookAdoptionActions {
  adopt(input: AdoptRunbookInput): string;
  supersede(input: SupersedeRunbookInput): string;
  end(adoptionId: string): string;
}

/** Records operator-approved provenance without applying or executing runbook content. */
export class RunbookAdoptions implements RunbookAdoptionActions {
  constructor(private readonly deps: RunbookAdoptionsDeps) {}

  adopt(input: AdoptRunbookInput): string {
    const runbook = this.installedRunbook(input.runbookId, input.version, input.topic);
    const sessionRoles = this.parseSessionRoles(input.sessions ?? []);
    const row = this.deps.store.insertRunbookAdoption(this.newRow(runbook, input.topic, sessionRoles));
    this.deps.events.emit({
      type: 'runbook.adopted',
      adoptionId: row.adoptionId,
      runbookId: row.runbookId,
      runbookVersion: row.version,
      source: row.source,
      topic: row.topic,
      approvedBy: 'operator',
      sessions: row.sessionRoles,
    });
    return `Adopted ${row.runbookId}@${row.version} topic '${row.topic}' as ${row.adoptionId}.`;
  }

  supersede(input: SupersedeRunbookInput): string {
    const previous = this.activeAdoption(input.adoptionId);
    const runbook = this.installedRunbook(input.runbookId, input.version, input.topic);
    const replacement = this.deps.store.supersedeRunbookAdoption(
      previous.adoptionId,
      this.newRow(runbook, input.topic, previous.sessionRoles),
    );
    this.deps.events.emit({
      type: 'runbook.superseded',
      adoptionId: previous.adoptionId,
      replacementAdoptionId: replacement.adoptionId,
      runbookId: replacement.runbookId,
      runbookVersion: replacement.version,
      source: replacement.source,
      topic: replacement.topic,
      approvedBy: 'operator',
      sessions: replacement.sessionRoles,
    });
    return `Superseded ${previous.adoptionId} with ${replacement.runbookId}@${replacement.version} topic '${replacement.topic}' as ${replacement.adoptionId}.`;
  }

  end(adoptionId: string): string {
    this.activeAdoption(adoptionId);
    if (!this.deps.store.endRunbookAdoption(adoptionId)) {
      throw new InvalidRequestError(`Runbook adoption '${adoptionId}' could not be ended.`);
    }
    this.deps.events.emit({ type: 'runbook.adoption.ended', adoptionId, approvedBy: 'operator' });
    return `Ended runbook adoption ${adoptionId}.`;
  }

  private installedRunbook(id: string, version: string, topic: string): ResolvedRunbook {
    const runbook = this.deps.registry.snapshot().runbooks.find((candidate) => candidate.id === id);
    if (runbook === undefined) throw new InvalidRequestError(`Runbook '${id}' is not installed and valid.`);
    if (runbook.version !== version) {
      throw new InvalidRequestError(
        `Runbook '${id}' is installed at version ${runbook.version}, not requested version ${version}.`,
      );
    }
    if (!runbook.topics.some((candidate) => candidate.id === topic)) {
      throw new InvalidRequestError(`Runbook '${id}@${version}' has no topic '${topic}'.`);
    }
    return runbook;
  }

  private activeAdoption(adoptionId: string): RunbookAdoptionRow {
    const row = this.deps.store.getRunbookAdoption(adoptionId);
    if (row === undefined) throw new InvalidRequestError(`Unknown runbook adoption: ${adoptionId}`);
    if (row.status !== 'active') {
      throw new InvalidRequestError(`Runbook adoption '${adoptionId}' is ${row.status}, not active.`);
    }
    return row;
  }

  private parseSessionRoles(values: readonly string[]): RunbookAdoptionSessionRole[] {
    const roles: RunbookAdoptionSessionRole[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const separator = value.indexOf('=');
      const session = separator < 0 ? '' : value.slice(0, separator).trim();
      const role = separator < 0 ? '' : value.slice(separator + 1).trim();
      if (session.length === 0 || role.length === 0) {
        throw new InvalidRequestError("Each --session value must use 'codename=role'.");
      }
      if (!this.deps.sessions().has(session)) throw new InvalidRequestError(`Unknown session: ${session}`);
      if (seen.has(session)) throw new InvalidRequestError(`Session '${session}' has more than one runbook role.`);
      seen.add(session);
      roles.push({ codename: session, role });
    }
    return roles;
  }

  private newRow(
    runbook: ResolvedRunbook,
    topic: string,
    sessionRoles: readonly RunbookAdoptionSessionRole[],
  ): NewRunbookAdoption {
    return {
      adoptionId: randomUUID(),
      runbookId: runbook.id,
      version: runbook.version,
      source: runbook.source,
      topic,
      sessionRoles,
    };
  }
}
