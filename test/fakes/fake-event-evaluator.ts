/** A stand-in for an external evaluator. It deliberately imports no Conductor store types. */
export function evaluateEventJsonl(lines: Iterable<string>): {
  ids: string[];
  types: string[];
  sequenceGaps: number;
} {
  const ids: string[] = [];
  const types: string[] = [];
  let previousInstance: string | undefined;
  let previousSeq: number | undefined;
  let sequenceGaps = 0;

  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (typeof event.id !== 'string' || typeof event.type !== 'string') {
      throw new Error('Evaluator received an invalid event envelope.');
    }
    ids.push(event.id);
    types.push(event.type);
    if (typeof event.conductorInstanceId === 'string' && typeof event.seq === 'number') {
      if (
        event.conductorInstanceId === previousInstance &&
        previousSeq !== undefined &&
        event.seq !== previousSeq + 1
      ) {
        sequenceGaps += 1;
      }
      previousInstance = event.conductorInstanceId;
      previousSeq = event.seq;
    }
  }
  return { ids, types, sequenceGaps };
}
