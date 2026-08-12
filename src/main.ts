import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { booleanInput, enumInput, stringInput } from './inputs';
import { analyzeImpact, distinctAffectedRepos, parseGraph } from './analyze';
import { deleteExistingComment, listChangedFiles, upsertComment, type PullRequestRef } from './pr';
import { renderComment, renderJobSummary } from './render';

type CommentMode = 'always' | 'on-impact' | 'never';

const COMMENT_MODES: readonly CommentMode[] = ['always', 'on-impact', 'never'];

/**
 * Action entrypoint for the PR impact checker.
 *
 * Ordering is deliberate: analysis and the job summary happen before any attempt
 * to comment, so a repo without `pull-requests: write` still gets the result in
 * the summary and the outputs instead of only a permissions error.
 */
export async function run(): Promise<void> {
  try {
    const graphPath = stringInput('graph-path', 'graph.json');
    const failOnImpact = booleanInput('fail-on-impact', false);
    const commentMode = enumInput<CommentMode>('comment-mode', COMMENT_MODES, 'always');

    const pullRequest = github.context.payload.pull_request;
    if (pullRequest === undefined) {
      core.info('Not a pull_request event; nothing to analyze.');
      core.setOutput('has-impact', false);
      core.setOutput('affected-repo-count', 0);
      return;
    }

    let raw: string;
    try {
      raw = await fs.readFile(graphPath, 'utf8');
    } catch {
      throw new Error(
        `Could not read the dependency graph at \`${graphPath}\`. ` +
          'Check out the repository holding `graph.json` before this step, or set `graph-path`.',
      );
    }
    const graph = parseGraph(raw);

    const ref: PullRequestRef = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pullNumber: pullRequest.number,
    };
    const currentRepo = `${ref.owner}/${ref.repo}`;

    const octokit = github.getOctokit(core.getInput('github-token', { required: true }));
    const { files, truncated } = await listChangedFiles(octokit, ref);
    core.info(`Pull request touches ${String(files.length)} file(s).`);

    const result = analyzeImpact(graph, currentRepo, files);
    if (truncated) {
      result.notes.push(
        'This pull request exceeds the 3000-file API limit, so the file list is partial and impact may be under-reported.',
      );
    }

    const affectedRepos = distinctAffectedRepos(result);
    const body = renderComment({ result, currentRepo, graph });

    core.setOutput('has-impact', result.hasImpact);
    core.setOutput('affected-repo-count', affectedRepos.length);
    core.setOutput('affected-repos', affectedRepos.join(','));
    core.setOutput('touched-artifact-count', result.touchedArtifacts.length);
    core.setOutput('report-markdown', body);

    await writeJobSummary(renderJobSummary({ result, currentRepo, graph }));

    await syncComment(octokit, ref, body, commentMode, result.hasImpact);

    if (result.hasImpact) {
      const message =
        `Blast radius: ${String(affectedRepos.length)} downstream repository(ies) affected — ` +
        affectedRepos.join(', ');
      if (failOnImpact) {
        core.setFailed(message);
      } else {
        core.warning(message);
      }
      return;
    }

    core.info('No downstream repositories affected.');
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Write the report to the Actions job summary.
 *
 * Failures are downgraded to warnings for the same reason comment failures are:
 * the analysis has already succeeded and is in the outputs. `summary.write()`
 * throws when `GITHUB_STEP_SUMMARY` is unset — which never happens on a GitHub
 * runner, but does under `act`, in a container, or when the bundle is invoked
 * directly. Failing there would sink a run whose result was already computed.
 */
async function writeJobSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown).write();
  } catch (error) {
    core.warning(
      'Could not write the job summary: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Post, update, or remove the comment according to `comment-mode`.
 *
 * Comment failures are downgraded to warnings: the analysis already succeeded
 * and is recorded in the outputs and the summary, so a missing
 * `pull-requests: write` permission should not fail the build.
 */
async function syncComment(
  octokit: ReturnType<typeof github.getOctokit>,
  ref: PullRequestRef,
  body: string,
  mode: CommentMode,
  hasImpact: boolean,
): Promise<void> {
  if (mode === 'never') return;

  try {
    if (mode === 'on-impact' && !hasImpact) {
      const removed = await deleteExistingComment(octokit, ref);
      if (removed) core.info('Impact cleared; removed the previous blast-radius comment.');
      return;
    }

    const { action, url } = await upsertComment(octokit, ref, body);
    core.info(`${action === 'created' ? 'Posted' : 'Updated'} blast-radius comment: ${url}`);
  } catch (error) {
    core.warning(
      'Could not write the pull-request comment (does the job grant `pull-requests: write`?): ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

// Run when executed directly (the bundled `dist/index.js`), not when imported by
// a test. `require.main` does not exist in ESM, so compare resolved paths instead.
/* c8 ignore next 3 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
