import type { ConductorEvent, ConductorEventSubscriber } from '../../src/events/types.js';

export class FakeEventSubscriber implements ConductorEventSubscriber {
  readonly events: ConductorEvent[] = [];

  constructor(readonly name = 'fake-events') {}

  onEvent(event: ConductorEvent): void {
    this.events.push(event);
  }
}
