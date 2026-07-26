import type { ConductorEvent, ConductorEventInput, ConductorEventPublisher } from '../../src/events/types.js';

/** Records owning-module emissions without involving the asynchronous fanout bus. */
export class FakeEventPublisher implements ConductorEventPublisher {
  readonly events: ConductorEventInput[] = [];
  private seq = 0;

  emit(input: ConductorEventInput): ConductorEvent {
    this.events.push(input);
    const seq = ++this.seq;
    return {
      ...input,
      schemaVersion: 1,
      id: `fake:${String(seq)}`,
      seq,
      occurredAt: new Date(0).toISOString(),
      conductorInstanceId: 'fake',
      fleetId: 'fake-fleet',
    };
  }
}
