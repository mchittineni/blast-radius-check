import { describe, expect, it } from 'vitest';
import { deleteExistingComment, listChangedFiles, upsertComment } from '../src/pr';
import { COMMENT_MARKER } from '../src/render';
import { createFakeOctokit } from './helpers/fake-octokit';

const ref = { owner: 'acme', repo: 'core-ui-lib', pullNumber: 42 };

describe('listChangedFiles', () => {
  it('normalizes paths and includes the pre-rename path', async () => {
    const { octokit } = createFakeOctokit({
      'pulls.listFiles': () => [
        { filename: './package.json' },
        { filename: 'src/new-name.ts', previous_filename: 'src/old-name.ts' },
      ],
    });

    const { files, truncated } = await listChangedFiles(octokit, ref);
    // The old path matters: it is where the declaration used to live.
    expect(files.sort()).toEqual(['package.json', 'src/new-name.ts', 'src/old-name.ts']);
    expect(truncated).toBe(false);
  });

  it('deduplicates repeated paths', async () => {
    const { octokit } = createFakeOctokit({
      'pulls.listFiles': () => [{ filename: 'package.json' }, { filename: './package.json' }],
    });
    expect(await listChangedFiles(octokit, ref)).toMatchObject({ files: ['package.json'] });
  });

  it('flags truncation at the API ceiling instead of under-reporting silently', async () => {
    const { octokit } = createFakeOctokit({
      'pulls.listFiles': () =>
        Array.from({ length: 3000 }, (_, index) => ({ filename: `file-${String(index)}.ts` })),
    });
    expect((await listChangedFiles(octokit, ref)).truncated).toBe(true);
  });
});

describe('upsertComment', () => {
  it('creates a comment when none exists', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [],
      'issues.createComment': () => ({ data: { html_url: 'https://example.test/created' } }),
      'issues.updateComment': () => ({ data: { html_url: 'https://example.test/updated' } }),
    });

    expect(await upsertComment(octokit, ref, 'body')).toEqual({
      action: 'created',
      url: 'https://example.test/created',
    });
    expect(calls.map((call) => call.endpoint)).toContain('issues.createComment');
    expect(calls.map((call) => call.endpoint)).not.toContain('issues.updateComment');
  });

  it('edits its own comment in place, so pushes do not pile up new comments', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [
        { id: 1, body: 'an unrelated review comment', user: { type: 'User' } },
        { id: 2, body: `${COMMENT_MARKER}\nprevious report`, user: { type: 'Bot' } },
      ],
      'issues.createComment': () => ({ data: { html_url: 'https://example.test/created' } }),
      'issues.updateComment': () => ({ data: { html_url: 'https://example.test/updated' } }),
    });

    expect(await upsertComment(octokit, ref, 'new body')).toEqual({
      action: 'updated',
      url: 'https://example.test/updated',
    });

    const update = calls.find((call) => call.endpoint === 'issues.updateComment');
    expect(update?.params).toMatchObject({ comment_id: 2, body: 'new body' });
  });

  it('ignores comments without a body', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [{ id: 1 }],
      'issues.createComment': () => ({ data: { html_url: 'https://example.test/created' } }),
    });
    await upsertComment(octokit, ref, 'body');
    expect(calls.map((call) => call.endpoint)).toContain('issues.createComment');
  });

  it('never edits a human comment, even one carrying the marker', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [
        { id: 3, body: `${COMMENT_MARKER}\nposted by the PR author`, user: { type: 'User' } },
      ],
      'issues.createComment': () => ({ data: { html_url: 'https://example.test/created' } }),
      'issues.updateComment': () => ({ data: { html_url: 'https://example.test/updated' } }),
    });

    expect(await upsertComment(octokit, ref, 'body')).toEqual({
      action: 'created',
      url: 'https://example.test/created',
    });
    expect(calls.map((call) => call.endpoint)).not.toContain('issues.updateComment');
  });
});

describe('deleteExistingComment', () => {
  it('removes a stale report once impact clears', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [
        { id: 7, body: `${COMMENT_MARKER}\nstale`, user: { type: 'Bot' } },
      ],
      'issues.deleteComment': () => ({}),
    });

    expect(await deleteExistingComment(octokit, ref)).toBe(true);
    expect(calls.find((call) => call.endpoint === 'issues.deleteComment')?.params).toMatchObject({
      comment_id: 7,
    });
  });

  it('reports nothing to delete when the action never commented', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [{ id: 1, body: 'unrelated', user: { type: 'User' } }],
      'issues.deleteComment': () => ({}),
    });

    expect(await deleteExistingComment(octokit, ref)).toBe(false);
    expect(calls.map((call) => call.endpoint)).not.toContain('issues.deleteComment');
  });

  it('never deletes a human comment carrying the marker', async () => {
    const { octokit, calls } = createFakeOctokit({
      'issues.listComments': () => [
        { id: 9, body: `${COMMENT_MARKER}\nquoted by a reviewer`, user: { type: 'User' } },
      ],
      'issues.deleteComment': () => ({}),
    });

    expect(await deleteExistingComment(octokit, ref)).toBe(false);
    expect(calls.map((call) => call.endpoint)).not.toContain('issues.deleteComment');
  });
});
