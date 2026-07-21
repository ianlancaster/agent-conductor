import { describe, expect, it } from 'vitest';
import { parseShepherdConfig } from '../src/shepherd/config.js';
import { buildEvent, eventId } from '../src/shepherd/events.js';

describe('Shepherd events', () => {
  it('builds stable IDs from canonical source identity rather than key order', () => {
    const pr = { repo: 'Acme/API', number: 7 };
    expect(eventId('ci-failed', pr, { headSha: 'abc', checks: ['one', 'two'] })).toBe(
      eventId('ci-failed', { repo: 'acme/api', number: 7 }, { checks: ['one', 'two'], headSha: 'abc' }),
    );
  });

  it('keeps base messages factual and appends only configured event guidance', () => {
    const config = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      guidance: { 'ci-failed': 'Run the repository validation commands.' },
    });
    const failure = buildEvent(
      config,
      'ci-failed',
      { repo: 'acme/api', number: 7 },
      { headSha: 'abc' },
      { failedChecks: ['test'], url: 'https://github.com/acme/api/pull/7' },
    );
    const comment = buildEvent(
      config,
      'comment',
      { repo: 'acme/api', number: 7 },
      { commentId: '1' },
      { author: 'reviewer', body: 'Please consider this edge case.' },
    );

    expect(failure.message).toContain('Guidance:\nRun the repository validation commands.');
    expect(comment.message).not.toContain('Guidance:');
    expect(comment.message).not.toMatch(/dispatch|worker|organization-specific/i);
  });
});
