import { describe, expect, it } from 'vitest';
import { parseShepherdConfig } from '../src/shepherd/config.js';
import { AsyncProcessExecutor, GhGitHubProvider, type ProcessExecutor } from '../src/shepherd/github.js';

class ScriptedExecutor implements ProcessExecutor {
  readonly calls: string[][] = [];

  async run(_file: string, args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const pageArg = args.find((arg) => arg.startsWith('page='));
    const page = Number(pageArg?.slice('page='.length));
    const count = page === 1 ? 50 : 1;
    const start = page === 1 ? 1 : 51;
    return JSON.stringify({
      total_count: 51,
      incomplete_results: false,
      items: Array.from({ length: count }, (_, index) => ({
        number: start + index,
        title: `PR ${String(start + index)}`,
        html_url: `https://github.com/acme/api/pull/${String(start + index)}`,
        repository_url: 'https://api.github.com/repos/acme/api',
        draft: false,
        updated_at: '2026-07-20T00:00:00Z',
      })),
    });
  }
}

describe('async gh provider', () => {
  it('retains JSON output from explicitly accepted nonzero command statuses', async () => {
    const executor = new AsyncProcessExecutor();
    const script = "process.stdout.write(JSON.stringify([{bucket:'pending'}])); process.exit(8)";
    await expect(executor.run(process.execPath, ['-e', script], 2_000, [0, 8])).resolves.toBe('[{"bucket":"pending"}]');
    await expect(executor.run(process.execPath, ['-e', script], 2_000)).rejects.toMatchObject({ code: 8 });
  });

  it('enforces process timeouts and rejects malformed GitHub JSON', async () => {
    const executor = new AsyncProcessExecutor();
    await expect(executor.run(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], 100)).rejects.toBeDefined();

    const malformed: ProcessExecutor = { run: async () => '{not-json' };
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    await expect(new GhGitHubProvider(config, malformed).discover('authored', 'octocat')).rejects.toThrow(
      'Malformed JSON from gh',
    );
  });

  it('paginates beyond 50 results and adds scope to the query', async () => {
    const config = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      github: { includeOwners: ['acme'] },
    });
    const executor = new ScriptedExecutor();
    const result = await new GhGitHubProvider(config, executor).discover('authored', 'octocat');
    expect(result).toMatchObject({ exhaustive: true });
    expect(result.items).toHaveLength(51);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]).toContain('q=is:pr state:open author:octocat org:acme');
    expect(executor.calls[1]).toContain('page=2');
  });

  it('marks incomplete search results non-exhaustive', async () => {
    const executor: ProcessExecutor = {
      run: async () => JSON.stringify({ total_count: 1, incomplete_results: true, items: [] }),
    };
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    const result = await new GhGitHubProvider(config, executor).discover('review-inbox', 'octocat');
    expect(result.exhaustive).toBe(false);
    expect(result.warning).toContain('non-exhaustive');
  });

  it('applies scope to all four discovery paths', async () => {
    const queries: string[] = [];
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        queries.push(args.find((arg) => arg.startsWith('q=')) ?? '');
        return JSON.stringify({ total_count: 0, incomplete_results: false, items: [] });
      },
    };
    const config = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      github: { includeOwners: ['acme'], excludeRepos: ['acme/private'] },
    });
    const provider = new GhGitHubProvider(config, executor);

    for (const kind of ['authored', 'review-inbox', 'review-follow-up', 'reviewer-nudge'] as const) {
      await provider.discover(kind, 'octocat');
    }

    expect(queries).toEqual([
      'q=is:pr state:open author:octocat org:acme -repo:acme/private',
      'q=is:pr state:open review-requested:octocat org:acme -repo:acme/private',
      'q=is:pr state:open reviewed-by:octocat org:acme -repo:acme/private',
      'q=is:pr state:open author:octocat org:acme -repo:acme/private',
    ]);
  });

  it('accepts the documented pending and failed exit statuses for gh pr checks only', async () => {
    const accepted: (readonly number[] | undefined)[] = [];
    const executor: ProcessExecutor = {
      run: async (_file, args, _timeout, acceptedExitCodes) => {
        accepted.push(acceptedExitCodes);
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 1,
            title: 'PR',
            url: 'https://github.com/acme/api/pull/1',
            isDraft: false,
            updatedAt: '2026-07-20T00:00:00Z',
            state: 'OPEN',
            headRefOid: 'abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            autoMergeRequest: null,
            mergedAt: null,
            closedAt: null,
            reviews: [],
            commits: [],
          });
        }
        return args.includes('checks') ? '[]' : '[[]]';
      },
    };
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    const details = await new GhGitHubProvider(config, executor).getPullRequest({ repo: 'acme/api', number: 1 });
    expect(details).toMatchObject({ repo: 'acme/api', number: 1, state: 'OPEN', headSha: 'abc', checks: [] });
    expect(accepted).toContainEqual([0, 1, 8]);
    expect(accepted.filter((value) => value !== undefined)).toHaveLength(1);
  });

  it('does not repost a durable reviewer comment after an ambiguous first response', async () => {
    const calls: string[][] = [];
    const body = 'Ready for review.\n\n<!-- pr-shepherd-action:stable -->';
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        return JSON.stringify([[{ id: 1, user: { login: 'octocat' }, body, created_at: '2026-07-20T00:00:00Z' }]]);
      },
    };
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });

    await new GhGitHubProvider(config, executor).mutate({
      type: 'post-reviewer-comment',
      pr: { repo: 'acme/api', number: 1 },
      reviewer: 'reviewer',
      body,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(['api', 'repos/acme/api/issues/1/comments']);
  });

  it('uses explicit argument arrays for auto-merge and branch-update mutations', async () => {
    const calls: string[][] = [];
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        return '';
      },
    };
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    const provider = new GhGitHubProvider(config, executor);

    await provider.mutate({
      type: 'enable-auto-merge',
      pr: { repo: 'acme/api', number: 7 },
      mergeMethod: 'squash',
    });
    await provider.mutate({ type: 'update-branch', pr: { repo: 'acme/api', number: 7 } });

    expect(calls).toEqual([
      ['pr', 'merge', '7', '-R', 'acme/api', '--auto', '--squash'],
      ['pr', 'update-branch', '7', '-R', 'acme/api'],
    ]);
  });
});
