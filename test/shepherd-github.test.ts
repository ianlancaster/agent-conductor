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

  it('discovers tracked pull requests by exact label or case-insensitive head prefix', async () => {
    const calls: string[][] = [];
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        if (query.includes('query TrackedHeadSearch')) {
          return JSON.stringify({
            data: {
              search: {
                issueCount: 2,
                nodes: [
                  {
                    number: 7,
                    title: 'Generated and labelled',
                    url: 'https://github.com/acme/api/pull/7',
                    isDraft: true,
                    updatedAt: '2026-08-18T00:00:00Z',
                    headRefName: 'ABBY/generated-change',
                    repository: { nameWithOwner: 'acme/api' },
                  },
                  {
                    number: 8,
                    title: 'Ordinary branch',
                    url: 'https://github.com/acme/api/pull/8',
                    isDraft: false,
                    updatedAt: '2026-08-18T00:00:00Z',
                    headRefName: 'feature/ordinary',
                    repository: { nameWithOwner: 'acme/api' },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        return JSON.stringify({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              number: 7,
              title: 'Generated and labelled',
              html_url: 'https://github.com/acme/api/pull/7',
              repository_url: 'https://api.github.com/repos/acme/api',
              draft: true,
              updated_at: '2026-08-18T00:00:00Z',
            },
          ],
        });
      },
    };
    const config = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      github: { includeOwners: ['acme'] },
    });
    const result = await new GhGitHubProvider(config, executor).discoverTrackedPullRequests([
      { id: 'abby-label', type: 'label', values: ['Abby'] },
      { id: 'abby-branch', type: 'head-prefix', values: ['Abby/'] },
    ]);

    expect(result).toMatchObject({ exhaustive: true });
    expect(result.items).toEqual([
      expect.objectContaining({
        repo: 'acme/api',
        number: 7,
        isDraft: true,
        matches: [
          { selectorId: 'abby-branch', type: 'head-prefix', value: 'Abby/' },
          { selectorId: 'abby-label', type: 'label', value: 'Abby' },
        ],
      }),
    ]);
    expect(calls.some((args) => args.includes('q=is:pr state:open label:"Abby" org:acme'))).toBe(true);
    expect(calls.some((args) => args.includes('queryString=is:pr state:open org:acme'))).toBe(true);
  });

  it('accepts the documented pending and failed exit statuses for gh pr checks only', async () => {
    const accepted: (readonly number[] | undefined)[] = [];
    const executor: ProcessExecutor = {
      run: async (_file, args, _timeout, acceptedExitCodes) => {
        accepted.push(acceptedExitCodes);
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        if (query.includes('query ReviewThreads')) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        }
        if (query.includes('query ReviewRequests')) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 1,
            title: 'PR',
            url: 'https://github.com/acme/api/pull/1',
            isDraft: false,
            updatedAt: '2026-07-20T00:00:00Z',
            state: 'OPEN',
            headRefName: 'feature/api',
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
    expect(details).toMatchObject({
      repo: 'acme/api',
      number: 1,
      state: 'OPEN',
      headRefName: 'feature/api',
      headSha: 'abc',
      checks: [],
      reviewThreads: [],
      requestedReviewers: [],
    });
    expect(accepted).toContainEqual([0, 1, 8]);
    expect(accepted.filter((value) => value !== undefined)).toHaveLength(1);
  });

  it('exhaustively paginates review threads, replies, and requested reviewers', async () => {
    const calls: string[][] = [];
    const pageInfo = (hasNextPage: boolean, endCursor: string | null) => ({ hasNextPage, endCursor });
    const comment = (id: string, author: string, reviewId: string, createdAt: string) => ({
      id,
      author: { login: author },
      body: `${id} body`,
      createdAt,
      updatedAt: createdAt,
      url: `https://github.com/acme/api/pull/1#discussion_r${id}`,
      pullRequestReview: { id: reviewId },
    });
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        const cursor = args.find((arg) => arg.startsWith('cursor='));
        if (query.includes('query ReviewThreadComments')) {
          return JSON.stringify({
            data: {
              node: {
                comments: {
                  nodes: [comment('reply-1', 'author', 'PRR_1', '2026-07-20T10:01:00Z')],
                  pageInfo: pageInfo(false, null),
                },
              },
            },
          });
        }
        if (query.includes('query ReviewThreads')) {
          const second = cursor === 'cursor=thread-page-2';
          const nodes = second
            ? [
                {
                  id: 'thread-2',
                  path: 'src/two.ts',
                  line: null,
                  originalLine: 8,
                  diffSide: 'LEFT',
                  isOutdated: true,
                  isResolved: false,
                  comments: {
                    nodes: [comment('root-2', 'octocat', 'PRR_2', '2026-07-20T10:02:00Z')],
                    pageInfo: pageInfo(false, null),
                  },
                },
              ]
            : [
                {
                  id: 'thread-1',
                  path: 'src/one.ts',
                  line: 12,
                  originalLine: 10,
                  diffSide: 'RIGHT',
                  isOutdated: false,
                  isResolved: false,
                  comments: {
                    nodes: [comment('root-1', 'octocat', 'PRR_1', '2026-07-20T10:00:00Z')],
                    pageInfo: pageInfo(true, 'comment-page-2'),
                  },
                },
              ];
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes,
                    pageInfo: second ? pageInfo(false, null) : pageInfo(true, 'thread-page-2'),
                  },
                },
              },
            },
          });
        }
        if (query.includes('query ReviewRequests')) {
          const second = cursor === 'cursor=request-page-2';
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewRequests: {
                    nodes: second
                      ? [{ requestedReviewer: { login: 'reviewer-two' } }]
                      : [{ requestedReviewer: { login: 'octocat' } }, { requestedReviewer: {} }],
                    pageInfo: second ? pageInfo(false, null) : pageInfo(true, 'request-page-2'),
                  },
                },
              },
            },
          });
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 1,
            title: 'PR',
            url: 'https://github.com/acme/api/pull/1',
            isDraft: false,
            updatedAt: '2026-07-20T00:00:00Z',
            state: 'OPEN',
            headRefName: 'feature/api',
            headRefOid: 'abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            autoMergeRequest: null,
            mergedAt: null,
            closedAt: null,
            reviews: [
              {
                id: 'PRR_1',
                author: { login: 'octocat' },
                state: 'COMMENTED',
                body: '',
                submittedAt: '2026-07-20T10:00:00Z',
                commit: { oid: 'abc' },
              },
            ],
            commits: [],
          });
        }
        return args.includes('checks') ? '[]' : '[[]]';
      },
    };
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });

    const details = await new GhGitHubProvider(config, executor).getPullRequest({ repo: 'acme/api', number: 1 });

    expect(details.reviews[0]).toMatchObject({ id: 'PRR_1', commitSha: 'abc' });
    expect(details.reviewThreads).toHaveLength(2);
    expect(details.reviewThreads[0]).toMatchObject({
      id: 'thread-1',
      rootCommentId: 'root-1',
      reviewId: 'PRR_1',
      originalLine: 10,
      originalSide: 'RIGHT',
      currentLine: 12,
      currentSide: 'RIGHT',
    });
    expect(details.reviewThreads[0]?.comments.map((item) => item.id)).toEqual(['root-1', 'reply-1']);
    expect(details.requestedReviewers).toEqual([{ login: 'octocat' }, { login: 'reviewer-two' }]);
    expect(
      calls.filter((args) => (args.find((arg) => arg.startsWith('query=')) ?? '').includes('ReviewThreads')),
    ).toHaveLength(2);
    expect(
      calls.filter((args) => (args.find((arg) => arg.startsWith('query=')) ?? '').includes('ReviewThreadComments')),
    ).toHaveLength(1);
    expect(
      calls.filter((args) => (args.find((arg) => arg.startsWith('query=')) ?? '').includes('ReviewRequests')),
    ).toHaveLength(2);
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

  it('uses expectedHeadOid for direct merge and merge-queue enqueue mutations', async () => {
    const calls: string[][] = [];
    const headSha = 'a'.repeat(40);
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        if (query.includes('query PullRequestMutationState')) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: { id: 'PR_node', headRefOid: headSha, autoMergeRequest: null, mergeQueueEntry: null },
              },
            },
          });
        }
        return JSON.stringify({ data: {} });
      },
    };
    const provider = new GhGitHubProvider(
      parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } }),
      executor,
    );

    await provider.mutate({
      type: 'merge-exact-head',
      pr: { repo: 'acme/api', number: 7 },
      headSha,
      mergeMethod: 'squash',
    });
    await provider.mutate({ type: 'enqueue-exact-head', pr: { repo: 'acme/api', number: 7 }, headSha });

    const mutations = calls.filter((args) => (args.find((arg) => arg.startsWith('query=')) ?? '').includes('mutation'));
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toEqual(expect.arrayContaining([`expectedHeadOid=${headSha}`, 'mergeMethod=SQUASH']));
    expect(mutations[0]?.find((arg) => arg.startsWith('query='))).toContain('mergePullRequest');
    expect(mutations[1]).toEqual(expect.arrayContaining([`expectedHeadOid=${headSha}`]));
    expect(mutations[1]?.find((arg) => arg.startsWith('query='))).toContain('enqueuePullRequest');
  });

  it('makes enqueue and dequeue retries state-aware and rejects a changed head before mutation', async () => {
    const calls: string[][] = [];
    const headSha = 'a'.repeat(40);
    const states = [
      { headRefOid: headSha, mergeQueueEntry: { id: 'MQ_1' } },
      { headRefOid: headSha, mergeQueueEntry: { id: 'MQ_1' } },
      { headRefOid: headSha, mergeQueueEntry: null },
      { headRefOid: 'b'.repeat(40), mergeQueueEntry: null },
    ];
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        if (query.includes('query PullRequestMutationState')) {
          const state = states.shift();
          if (state === undefined) throw new Error('unexpected state query');
          return JSON.stringify({
            data: { repository: { pullRequest: { id: 'PR_node', autoMergeRequest: null, ...state } } },
          });
        }
        return JSON.stringify({ data: {} });
      },
    };
    const provider = new GhGitHubProvider(
      parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } }),
      executor,
    );

    await provider.mutate({ type: 'enqueue-exact-head', pr: { repo: 'acme/api', number: 7 }, headSha });
    await provider.mutate({ type: 'dequeue', pr: { repo: 'acme/api', number: 7 } });
    await provider.mutate({ type: 'dequeue', pr: { repo: 'acme/api', number: 7 } });
    await expect(
      provider.mutate({ type: 'enqueue-exact-head', pr: { repo: 'acme/api', number: 7 }, headSha }),
    ).rejects.toThrow(/head changed/);

    const mutationQueries = calls
      .map((args) => args.find((arg) => arg.startsWith('query=')) ?? '')
      .filter((query) => query.includes('mutation'));
    expect(mutationQueries).toHaveLength(1);
    expect(mutationQueries[0]).toContain('dequeuePullRequest');
  });

  it('makes persistent auto-merge disable retries state-aware', async () => {
    const calls: string[][] = [];
    const states = [{ enabledAt: '2026-08-17T10:00:00Z' }, null];
    const executor: ProcessExecutor = {
      run: async (_file, args) => {
        calls.push([...args]);
        const query = args.find((arg) => arg.startsWith('query=')) ?? '';
        if (query.includes('query PullRequestMutationState')) {
          const autoMergeRequest = states.shift();
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_node',
                  headRefOid: 'a'.repeat(40),
                  autoMergeRequest,
                  mergeQueueEntry: null,
                },
              },
            },
          });
        }
        return JSON.stringify({ data: {} });
      },
    };
    const provider = new GhGitHubProvider(
      parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } }),
      executor,
    );

    await provider.mutate({ type: 'disable-auto-merge', pr: { repo: 'acme/api', number: 7 } });
    await provider.mutate({ type: 'disable-auto-merge', pr: { repo: 'acme/api', number: 7 } });

    const mutations = calls
      .map((args) => args.find((arg) => arg.startsWith('query=')) ?? '')
      .filter((query) => query.includes('mutation'));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toContain('disablePullRequestAutoMerge');
  });
});
