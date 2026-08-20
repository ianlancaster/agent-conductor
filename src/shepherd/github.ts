import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ShepherdConfig } from './config.js';
import { repositoryInScope } from './scope.js';
import type {
  CheckRun,
  Comment,
  Commit,
  DiscoveryKind,
  DiscoveryResult,
  GitHubMutation,
  GitHubProvider,
  PullRequestDetails,
  PullRequestRef,
  PullRequestSummary,
  RequestedReviewer,
  Review,
  ReviewThread,
  ReviewThreadComment,
  ReviewThreadSide,
  TrackedPullRequestCandidate,
  TrackedPullRequestSelector,
} from './types.js';

const execFileAsync = promisify(execFile);

export interface ProcessExecutor {
  run(file: string, args: readonly string[], timeoutMs: number, acceptedExitCodes?: readonly number[]): Promise<string>;
}

export class AsyncProcessExecutor implements ProcessExecutor {
  async run(
    file: string,
    args: readonly string[],
    timeoutMs: number,
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(file, [...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown };
      if (
        typeof failure.code === 'number' &&
        acceptedExitCodes.includes(failure.code) &&
        typeof failure.stdout === 'string' &&
        failure.stdout.trim().length > 0
      ) {
        return failure.stdout.trim();
      }
      throw error;
    }
  }
}

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  draft?: boolean;
  updated_at: string;
}

interface SearchPage {
  total_count: number;
  incomplete_results: boolean;
  items: SearchItem[];
}

interface RawTrackedSearchPage {
  data: {
    search: {
      issueCount: number;
      nodes: {
        number: number;
        title: string;
        url: string;
        isDraft: boolean;
        updatedAt: string;
        headRefName: string;
        repository: { nameWithOwner: string };
      }[];
      pageInfo: RawPageInfo;
    };
  };
}

interface RawView {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  mergeable: PullRequestDetails['mergeable'];
  mergeStateStatus: string;
  autoMergeRequest: { mergeMethod: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
  reviews: {
    id?: string;
    databaseId?: number;
    author: { login: string };
    state: Review['state'];
    body: string;
    submittedAt: string;
    commit?: { oid: string };
  }[];
  commits: { oid: string; committedDate: string; messageHeadline: string }[];
}

interface RawCheck {
  name: string;
  state: string;
  bucket: CheckRun['bucket'];
  workflow: string;
  link?: string;
}

interface RawComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
}

interface RawPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface RawReviewThreadComment {
  id: string;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  pullRequestReview: { id: string } | null;
}

interface RawReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: ReviewThreadSide | null;
  isOutdated: boolean;
  isResolved: boolean;
  comments: {
    nodes: RawReviewThreadComment[];
    pageInfo: RawPageInfo;
  };
}

interface RawPullRequestMutationState {
  data: {
    repository: {
      pullRequest: {
        id: string;
        headRefOid: string;
        autoMergeRequest: { enabledAt: string } | null;
        mergeQueueEntry: { id: string } | null;
      } | null;
    } | null;
  };
}

interface RawReviewThreadPage {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: RawReviewThread[];
          pageInfo: RawPageInfo;
        };
      } | null;
    } | null;
  };
}

interface RawReviewThreadCommentsPage {
  data: {
    node: {
      comments: {
        nodes: RawReviewThreadComment[];
        pageInfo: RawPageInfo;
      };
    } | null;
  };
}

interface RawReviewRequestPage {
  data: {
    repository: {
      pullRequest: {
        reviewRequests: {
          nodes: { requestedReviewer: { login?: string } | null }[];
          pageInfo: RawPageInfo;
        };
      } | null;
    } | null;
  };
}

const SEARCH_PAGE_SIZE = 50;
const SEARCH_RESULT_CAP = 1_000;
const GRAPHQL_PAGE_SIZE = 100;

const REVIEW_THREADS_QUERY = `
query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${String(GRAPHQL_PAGE_SIZE)}, after: $cursor) {
        nodes {
          id
          path
          line
          originalLine
          diffSide
          isOutdated
          isResolved
          comments(first: ${String(GRAPHQL_PAGE_SIZE)}) {
            nodes {
              id
              author { login }
              body
              createdAt
              updatedAt
              url
              pullRequestReview { id }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const REVIEW_THREAD_COMMENTS_QUERY = `
query ReviewThreadComments($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${String(GRAPHQL_PAGE_SIZE)}, after: $cursor) {
        nodes {
          id
          author { login }
          body
          createdAt
          updatedAt
          url
          pullRequestReview { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const REVIEW_REQUESTS_QUERY = `
query ReviewRequests($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewRequests(first: ${String(GRAPHQL_PAGE_SIZE)}, after: $cursor) {
        nodes {
          requestedReviewer {
            ... on User { login }
            ... on Bot { login }
            ... on Mannequin { login }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const MERGE_EXACT_HEAD_MUTATION = `
mutation MergeExactHead($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) {
  mergePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: $mergeMethod }) {
    pullRequest { id merged }
  }
}`;

const ENQUEUE_EXACT_HEAD_MUTATION = `
mutation EnqueueExactHead($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
    mergeQueueEntry { id }
  }
}`;

const DEQUEUE_MUTATION = `
mutation DequeuePullRequest($pullRequestId: ID!) {
  dequeuePullRequest(input: { id: $pullRequestId }) { clientMutationId }
}`;

const DISABLE_AUTO_MERGE_MUTATION = `
mutation DisableAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { pullRequest { id } }
}`;

const PULL_REQUEST_MUTATION_STATE_QUERY = `
query PullRequestMutationState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id headRefOid autoMergeRequest { enabledAt } mergeQueueEntry { id } }
  }
}`;

const TRACKED_HEAD_SEARCH_QUERY = `
query TrackedHeadSearch($queryString: String!, $cursor: String) {
  search(type: ISSUE, query: $queryString, first: ${String(GRAPHQL_PAGE_SIZE)}, after: $cursor) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        updatedAt
        headRefName
        repository { nameWithOwner }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export class GhGitHubProvider implements GitHubProvider {
  constructor(
    private readonly config: ShepherdConfig,
    private readonly executor: ProcessExecutor = new AsyncProcessExecutor(),
    private readonly timeoutMs = 30_000,
  ) {}

  async discover(kind: DiscoveryKind, githubUser: string): Promise<DiscoveryResult<PullRequestSummary>> {
    const qualifier = this.qualifier(kind, githubUser);
    const scopeQueries = this.scopeQueries();
    const byKey = new Map<string, PullRequestSummary>();
    let exhaustive = true;
    const warnings: string[] = [];

    for (const scope of scopeQueries) {
      const result = await this.search(`${qualifier} ${scope}`.trim());
      exhaustive &&= result.exhaustive;
      if (result.warning !== undefined) warnings.push(result.warning);
      for (const item of result.items) {
        if (!repositoryInScope(item.repo, this.config.github)) continue;
        byKey.set(`${item.repo.toLowerCase()}#${String(item.number)}`, item);
      }
    }

    return {
      items: [...byKey.values()],
      exhaustive,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  }

  async discoverTrackedPullRequests(
    selectors: TrackedPullRequestSelector[],
  ): Promise<DiscoveryResult<TrackedPullRequestCandidate>> {
    const candidates = new Map<string, TrackedPullRequestCandidate>();
    const warnings: string[] = [];
    let exhaustive = true;
    const addMatch = (item: PullRequestSummary, match: TrackedPullRequestCandidate['matches'][number]): void => {
      if (!repositoryInScope(item.repo, this.config.github)) return;
      const key = `${item.repo.toLowerCase()}#${String(item.number)}`;
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, { ...item, matches: [match] });
      } else if (
        !existing.matches.some(
          (candidate) =>
            candidate.selectorId === match.selectorId &&
            candidate.type === match.type &&
            candidate.value === match.value,
        )
      ) {
        existing.matches.push(match);
      }
    };

    for (const selector of selectors.filter((candidate) => candidate.type === 'label')) {
      for (const value of selector.values) {
        for (const scope of this.scopeQueries()) {
          const result = await this.search(`is:pr state:open label:${this.searchValue(value)} ${scope}`.trim());
          exhaustive &&= result.exhaustive;
          if (result.warning !== undefined) warnings.push(result.warning);
          for (const item of result.items) addMatch(item, { selectorId: selector.id, type: selector.type, value });
        }
      }
    }

    const prefixSelectors = selectors.filter((candidate) => candidate.type === 'head-prefix');
    if (prefixSelectors.length > 0) {
      for (const scope of this.scopeQueries()) {
        const result = await this.searchPullRequestHeads(`is:pr state:open ${scope}`.trim());
        exhaustive &&= result.exhaustive;
        if (result.warning !== undefined) warnings.push(result.warning);
        for (const item of result.items) {
          for (const selector of prefixSelectors) {
            for (const value of selector.values) {
              if (item.headRefName.toLowerCase().startsWith(value.toLowerCase())) {
                addMatch(item, { selectorId: selector.id, type: selector.type, value });
              }
            }
          }
        }
      }
    }

    return {
      items: [...candidates.values()]
        .map((candidate) => ({
          ...candidate,
          matches: [...candidate.matches].sort((left, right) => {
            const leftKey = `${left.selectorId}\u0000${left.type}\u0000${left.value}`;
            const rightKey = `${right.selectorId}\u0000${right.type}\u0000${right.value}`;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        }))
        .sort((left, right) => {
          const leftKey = `${left.repo.toLowerCase()}\u0000${String(left.number).padStart(12, '0')}`;
          const rightKey = `${right.repo.toLowerCase()}\u0000${String(right.number).padStart(12, '0')}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        }),
      exhaustive,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  }

  async getPullRequest(pr: PullRequestRef): Promise<PullRequestDetails> {
    const fields = [
      'number',
      'title',
      'url',
      'isDraft',
      'updatedAt',
      'state',
      'headRefName',
      'headRefOid',
      'mergeable',
      'mergeStateStatus',
      'autoMergeRequest',
      'mergedAt',
      'closedAt',
      'reviews',
      'commits',
    ].join(',');
    const [viewRaw, checksRaw, commentsRaw, reviewThreads, requestedReviewers] = await Promise.all([
      this.gh(['pr', 'view', String(pr.number), '-R', pr.repo, '--json', fields]),
      this.gh(
        ['pr', 'checks', String(pr.number), '-R', pr.repo, '--json', 'name,state,bucket,workflow,link'],
        [0, 1, 8],
      ),
      this.gh(['api', `repos/${pr.repo}/issues/${String(pr.number)}/comments`, '--paginate', '--slurp']),
      this.reviewThreads(pr),
      this.requestedReviewers(pr),
    ]);
    const view = this.json<RawView>(viewRaw, `${pr.repo}#${String(pr.number)} view`);
    const rawChecks = this.json<RawCheck[]>(checksRaw || '[]', `${pr.repo}#${String(pr.number)} checks`);
    const commentPages = this.json<RawComment[][]>(commentsRaw || '[]', `${pr.repo}#${String(pr.number)} comments`);
    const rawComments = commentPages.flat();
    const checks = rawChecks
      .filter((check) => !this.config.checks.ignored.includes(check.name))
      .map((check) => ({ ...check, id: check.link ?? `${check.workflow}:${check.name}` }));
    const reviews = view.reviews
      .filter((review) => !this.ignoredActor(review.author.login))
      .map((review) => ({
        id:
          review.id ??
          (review.databaseId === undefined
            ? `${review.author.login}:${review.submittedAt}:${review.state}`
            : String(review.databaseId)),
        author: review.author.login,
        state: review.state,
        body: review.body,
        submittedAt: review.submittedAt,
        ...(review.commit === undefined ? {} : { commitSha: review.commit.oid }),
      }));
    const comments: Comment[] = rawComments.map((comment) => ({
      id: String(comment.id),
      author: comment.user.login,
      body: comment.body,
      createdAt: comment.created_at,
    }));
    const commits: Commit[] = view.commits.map((commit) => ({
      sha: commit.oid,
      committedAt: commit.committedDate,
      message: commit.messageHeadline,
    }));
    return {
      repo: pr.repo,
      number: view.number,
      title: view.title,
      url: view.url,
      isDraft: view.isDraft,
      updatedAt: view.updatedAt,
      state: view.state === 'MERGED' ? 'MERGED' : view.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
      headRefName: view.headRefName,
      headSha: view.headRefOid,
      mergeable: view.mergeable,
      mergeStateStatus: view.mergeStateStatus,
      autoMergeRequest: view.autoMergeRequest,
      mergedAt: view.mergedAt,
      closedAt: view.closedAt,
      checks,
      reviews,
      reviewThreads,
      requestedReviewers,
      comments,
      commits,
    };
  }

  async getMergeAutomationState(pr: PullRequestRef): Promise<{
    headSha: string;
    autoMergeEnabled: boolean;
    queued: boolean;
  }> {
    const state = await this.pullRequestMutationState(pr);
    return {
      headSha: state.headRefOid,
      autoMergeEnabled: state.autoMergeRequest !== null,
      queued: state.mergeQueueEntry !== null,
    };
  }

  async mutate(mutation: GitHubMutation): Promise<void> {
    if (mutation.type === 'enable-auto-merge') {
      await this.gh([
        'pr',
        'merge',
        String(mutation.pr.number),
        '-R',
        mutation.pr.repo,
        '--auto',
        `--${mutation.mergeMethod}`,
      ]);
      return;
    }
    if (mutation.type === 'merge-exact-head' || mutation.type === 'enqueue-exact-head') {
      const state = await this.pullRequestMutationState(mutation.pr);
      if (state.headRefOid.toLowerCase() !== mutation.headSha.toLowerCase()) {
        throw new Error(
          `GitHub head changed before the conditional mutation for ${mutation.pr.repo}#${String(mutation.pr.number)}.`,
        );
      }
      if (mutation.type === 'merge-exact-head') {
        await this.graphql(MERGE_EXACT_HEAD_MUTATION, {
          pullRequestId: state.id,
          expectedHeadOid: mutation.headSha,
          mergeMethod: mutation.mergeMethod.toUpperCase(),
        });
      } else {
        if (state.mergeQueueEntry !== null) return;
        await this.graphql(ENQUEUE_EXACT_HEAD_MUTATION, {
          pullRequestId: state.id,
          expectedHeadOid: mutation.headSha,
        });
      }
      return;
    }
    if (mutation.type === 'dequeue') {
      const state = await this.pullRequestMutationState(mutation.pr);
      if (state.mergeQueueEntry === null) return;
      await this.graphql(DEQUEUE_MUTATION, { pullRequestId: state.id });
      return;
    }
    if (mutation.type === 'disable-auto-merge') {
      const state = await this.pullRequestMutationState(mutation.pr);
      if (state.autoMergeRequest === null) return;
      await this.graphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId: state.id });
      return;
    }
    if (mutation.type === 'update-branch') {
      await this.gh(['pr', 'update-branch', String(mutation.pr.number), '-R', mutation.pr.repo]);
      return;
    }
    const commentsRaw = await this.gh([
      'api',
      `repos/${mutation.pr.repo}/issues/${String(mutation.pr.number)}/comments`,
      '--paginate',
      '--slurp',
    ]);
    const comments = this.json<RawComment[][]>(
      commentsRaw || '[]',
      `${mutation.pr.repo}#${String(mutation.pr.number)} comments`,
    ).flat();
    if (comments.some((comment) => comment.body === mutation.body)) return;
    await this.gh(['pr', 'comment', String(mutation.pr.number), '-R', mutation.pr.repo, '--body', mutation.body]);
  }

  private async search(query: string): Promise<DiscoveryResult<PullRequestSummary>> {
    const items: PullRequestSummary[] = [];
    let page = 1;
    let total = 0;
    let incomplete = false;
    do {
      const raw = await this.gh([
        'api',
        '-X',
        'GET',
        'search/issues',
        '-f',
        `q=${query}`,
        '-f',
        `per_page=${String(SEARCH_PAGE_SIZE)}`,
        '-f',
        `page=${String(page)}`,
      ]);
      const response = this.json<SearchPage>(raw, `search page ${String(page)}`);
      total = response.total_count;
      incomplete ||= response.incomplete_results;
      for (const item of response.items) {
        const repo = item.repository_url.split('/repos/')[1];
        if (repo === undefined) continue;
        items.push({
          repo,
          number: item.number,
          title: item.title,
          url: item.html_url,
          isDraft: item.draft ?? false,
          updatedAt: item.updated_at,
        });
      }
      page += 1;
      if (response.items.length < SEARCH_PAGE_SIZE) break;
    } while (items.length < Math.min(total, SEARCH_RESULT_CAP));

    const exhaustive = !incomplete && total <= SEARCH_RESULT_CAP && items.length >= total;
    return {
      items,
      exhaustive,
      ...(!exhaustive
        ? {
            warning: `GitHub search was non-exhaustive (${String(items.length)}/${String(total)} results for ${query})`,
          }
        : {}),
    };
  }

  private async searchPullRequestHeads(
    query: string,
  ): Promise<DiscoveryResult<PullRequestSummary & { headRefName: string }>> {
    const items: (PullRequestSummary & { headRefName: string })[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const raw = await this.graphql(TRACKED_HEAD_SEARCH_QUERY, { queryString: query, cursor });
      const response = this.json<RawTrackedSearchPage>(raw, `tracked head search for ${query}`);
      const connection = response.data.search;
      total = connection.issueCount;
      for (const item of connection.nodes) {
        items.push({
          repo: item.repository.nameWithOwner,
          number: item.number,
          title: item.title,
          url: item.url,
          isDraft: item.isDraft,
          updatedAt: item.updatedAt,
          headRefName: item.headRefName,
        });
      }
      cursor =
        connection.pageInfo.hasNextPage && items.length < SEARCH_RESULT_CAP
          ? this.nextCursor(connection.pageInfo, `tracked head search for ${query}`)
          : undefined;
    } while (cursor !== undefined);
    const exhaustive = total <= SEARCH_RESULT_CAP && items.length >= total;
    return {
      items,
      exhaustive,
      ...(!exhaustive
        ? {
            warning: `GitHub search was non-exhaustive (${String(items.length)}/${String(total)} results for ${query})`,
          }
        : {}),
    };
  }

  private searchValue(value: string): string {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }

  private qualifier(kind: DiscoveryKind, user: string): string {
    if (kind === 'authored' || kind === 'reviewer-nudge') return `is:pr state:open author:${user}`;
    if (kind === 'review-inbox') return `is:pr state:open review-requested:${user}`;
    return `is:pr state:open reviewed-by:${user}`;
  }

  private async reviewThreads(pr: PullRequestRef): Promise<ReviewThread[]> {
    const { owner, name } = this.repoParts(pr.repo);
    const threads: ReviewThread[] = [];
    let cursor: string | undefined;
    do {
      const raw = await this.graphql(REVIEW_THREADS_QUERY, { owner, name, number: pr.number, cursor });
      const response = this.json<RawReviewThreadPage>(raw, `${pr.repo}#${String(pr.number)} review threads`);
      const connection = response.data.repository?.pullRequest?.reviewThreads;
      if (connection === undefined)
        throw new Error(`GitHub returned no pull request for ${pr.repo}#${String(pr.number)}.`);
      for (const thread of connection.nodes) {
        const comments = [...thread.comments.nodes];
        let commentPage = thread.comments.pageInfo;
        while (commentPage.hasNextPage) {
          const commentCursor = this.nextCursor(commentPage, `review thread ${thread.id} comments`);
          const commentsRaw = await this.graphql(REVIEW_THREAD_COMMENTS_QUERY, {
            id: thread.id,
            cursor: commentCursor,
          });
          const commentsResponse = this.json<RawReviewThreadCommentsPage>(
            commentsRaw,
            `${pr.repo}#${String(pr.number)} review thread ${thread.id} comments`,
          );
          if (commentsResponse.data.node === null) throw new Error(`GitHub review thread ${thread.id} disappeared.`);
          comments.push(...commentsResponse.data.node.comments.nodes);
          commentPage = commentsResponse.data.node.comments.pageInfo;
        }
        const normalized = comments
          .map((comment) => this.reviewThreadComment(comment))
          .sort((left, right) => {
            const byTime = left.createdAt.localeCompare(right.createdAt);
            return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
          });
        const root = comments
          .map((comment) => ({ raw: comment, normalized: this.reviewThreadComment(comment) }))
          .sort((left, right) => {
            const byTime = left.normalized.createdAt.localeCompare(right.normalized.createdAt);
            return byTime === 0 ? left.normalized.id.localeCompare(right.normalized.id) : byTime;
          })[0];
        const rootReview = root?.raw.pullRequestReview;
        if (root === undefined || rootReview === null || rootReview === undefined) {
          throw new Error(`GitHub review thread ${thread.id} has no root review comment.`);
        }
        threads.push({
          id: thread.id,
          rootCommentId: root.normalized.id,
          reviewId: rootReview.id,
          rootAuthor: root.normalized.author,
          path: thread.path,
          originalLine: thread.originalLine,
          originalSide: thread.originalLine === null ? null : thread.diffSide,
          currentLine: thread.line,
          currentSide: thread.line === null ? null : thread.diffSide,
          url: root.normalized.url,
          isOutdated: thread.isOutdated,
          isResolved: thread.isResolved,
          comments: normalized,
        });
      }
      cursor = connection.pageInfo.hasNextPage
        ? this.nextCursor(connection.pageInfo, `${pr.repo}#${String(pr.number)} review threads`)
        : undefined;
    } while (cursor !== undefined);
    return threads;
  }

  private async pullRequestMutationState(pr: PullRequestRef): Promise<{
    id: string;
    headRefOid: string;
    autoMergeRequest: { enabledAt: string } | null;
    mergeQueueEntry: { id: string } | null;
  }> {
    const { owner, name } = this.repoParts(pr.repo);
    const raw = await this.graphql(PULL_REQUEST_MUTATION_STATE_QUERY, { owner, name, number: pr.number });
    const response = this.json<RawPullRequestMutationState>(raw, `${pr.repo}#${String(pr.number)} mutation state`);
    const state = response.data.repository?.pullRequest;
    if (state === undefined || state === null) {
      throw new Error(`GitHub returned no pull request for ${pr.repo}#${String(pr.number)}.`);
    }
    return state;
  }

  private async requestedReviewers(pr: PullRequestRef): Promise<RequestedReviewer[]> {
    const { owner, name } = this.repoParts(pr.repo);
    const reviewers = new Map<string, RequestedReviewer>();
    let cursor: string | undefined;
    do {
      const raw = await this.graphql(REVIEW_REQUESTS_QUERY, { owner, name, number: pr.number, cursor });
      const response = this.json<RawReviewRequestPage>(raw, `${pr.repo}#${String(pr.number)} review requests`);
      const connection = response.data.repository?.pullRequest?.reviewRequests;
      if (connection === undefined)
        throw new Error(`GitHub returned no pull request for ${pr.repo}#${String(pr.number)}.`);
      for (const node of connection.nodes) {
        const login = node.requestedReviewer?.login;
        if (login !== undefined) reviewers.set(login.toLowerCase(), { login });
      }
      cursor = connection.pageInfo.hasNextPage
        ? this.nextCursor(connection.pageInfo, `${pr.repo}#${String(pr.number)} review requests`)
        : undefined;
    } while (cursor !== undefined);
    return [...reviewers.values()];
  }

  private reviewThreadComment(comment: RawReviewThreadComment): ReviewThreadComment {
    return {
      id: comment.id,
      author: comment.author?.login ?? 'ghost',
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      url: comment.url,
    };
  }

  private repoParts(repo: string): { owner: string; name: string } {
    const [owner, name, extra] = repo.split('/');
    if (owner === undefined || name === undefined || extra !== undefined || owner === '' || name === '') {
      throw new Error(`Invalid GitHub repository name: ${repo}`);
    }
    return { owner, name };
  }

  private nextCursor(page: RawPageInfo, label: string): string {
    if (page.endCursor === null) throw new Error(`GitHub pagination for ${label} has no end cursor.`);
    return page.endCursor;
  }

  private graphql(query: string, variables: Record<string, string | number | undefined>): Promise<string> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined) continue;
      args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${String(value)}`);
    }
    return this.gh(args);
  }

  private scopeQueries(): string[] {
    const includes = [
      ...this.config.github.includeOwners.map((owner) => `org:${owner}`),
      ...this.config.github.includeRepos.map((repo) => `repo:${repo}`),
    ];
    const exclusions = [
      ...this.config.github.excludeOwners.map((owner) => `-org:${owner}`),
      ...this.config.github.excludeRepos.map((repo) => `-repo:${repo}`),
    ].join(' ');
    return (includes.length === 0 ? [''] : includes).map((include) => `${include} ${exclusions}`.trim());
  }

  private ignoredActor(actor: string): boolean {
    return this.config.reviews.ignoredActors.some((ignored) => ignored.toLowerCase() === actor.toLowerCase());
  }

  private gh(args: readonly string[], acceptedExitCodes?: readonly number[]): Promise<string> {
    return this.executor.run('gh', args, this.timeoutMs, acceptedExitCodes);
  }

  private json<T>(raw: string, label: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`Malformed JSON from gh for ${label}.`);
    }
  }
}
