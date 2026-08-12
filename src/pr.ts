import type { GitHub } from '@actions/github/lib/utils';
import { normalizePath } from './normalize';
import { COMMENT_MARKER } from './render';

type Octokit = InstanceType<typeof GitHub>;

export interface PullRequestRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

/**
 * List every file the pull request touches.
 *
 * Paginated deliberately: `listFiles` caps at 100 per page and GitHub caps the
 * endpoint at 3000 files. A PR beyond that limit is reported so the caller can
 * say the analysis is partial rather than quietly under-reporting impact.
 */
export async function listChangedFiles(
  octokit: Octokit,
  ref: PullRequestRef,
): Promise<{ files: string[]; truncated: boolean }> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pullNumber,
    per_page: 100,
  });

  const paths = new Set<string>();
  for (const file of files) {
    paths.add(normalizePath(file.filename));
    // A rename modifies the new path but also removes the old declaration site.
    if (typeof file.previous_filename === 'string') {
      paths.add(normalizePath(file.previous_filename));
    }
  }

  return { files: [...paths], truncated: files.length >= 3000 };
}

/** A comment written by this action: carries the marker *and* was posted by a bot. */
interface MarkedComment {
  id: number;
  body?: string | undefined;
  user?: { type?: string | undefined } | null | undefined;
}

/**
 * Find this action's own previous comment.
 *
 * Matching is by {@link COMMENT_MARKER} rather than by a specific account, so the
 * upsert works identically under `github-actions[bot]` and a custom app token.
 * The author type is still checked: a pull request author can put the marker in
 * their own comment, and without this guard the action would edit — or under
 * `comment-mode: on-impact`, delete — a human's comment.
 */
function findOwnComment<TComment extends MarkedComment>(
  comments: readonly TComment[],
): TComment | undefined {
  return comments.find(
    (comment) => comment.body?.includes(COMMENT_MARKER) === true && comment.user?.type === 'Bot',
  );
}

/**
 * Create the impact comment, or edit the one this action posted before.
 *
 * Without the upsert, a long-running PR accumulates one comment per push.
 */
export async function upsertComment(
  octokit: Octokit,
  ref: PullRequestRef,
  body: string,
): Promise<{ action: 'created' | 'updated'; url: string }> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pullNumber,
    per_page: 100,
  });

  const previous = findOwnComment(existing);

  if (previous !== undefined) {
    const updated = await octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: previous.id,
      body,
    });
    return { action: 'updated', url: updated.data.html_url };
  }

  const created = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pullNumber,
    body,
  });
  return { action: 'created', url: created.data.html_url };
}

/** Delete this action's comment — used when impact clears and `comment-mode: on-impact`. */
export async function deleteExistingComment(
  octokit: Octokit,
  ref: PullRequestRef,
): Promise<boolean> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pullNumber,
    per_page: 100,
  });

  const previous = findOwnComment(existing);
  if (previous === undefined) return false;

  await octokit.rest.issues.deleteComment({
    owner: ref.owner,
    repo: ref.repo,
    comment_id: previous.id,
  });
  return true;
}
