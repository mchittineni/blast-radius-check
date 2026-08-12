import { describe, expect, it } from 'vitest';
import { analyzeImpact } from '../src/analyze';
import { COMMENT_MARKER, renderComment, renderJobSummary } from '../src/render';
import { escapeInlineCode } from '../src/markdown';
import type { GraphIndex } from '../src/types';
import { GENERATED_AT, makeGraph } from './helpers/graph-fixture';

const NOW = new Date('2026-01-01T01:00:00.000Z');

/** One publisher, exactly one downstream consumer — keeps the headline count at 1. */
function graphWith(artifactName: string): GraphIndex {
  return makeGraph({
    generatedAt: GENERATED_AT,
    repos: [
      {
        repo: 'acme/core-ui-lib',
        exports: [{ name: artifactName, version: '2.1.0', sourceFile: 'package.json' }],
      },
      { repo: 'acme/user-portal-app' },
    ],
    artifacts: [
      {
        name: artifactName,
        publisherRepo: 'acme/core-ui-lib',
        publisherFile: 'package.json',
        consumers: [
          {
            repo: 'acme/user-portal-app',
            sourceFile: 'package.json',
            versionRequirement: '^2.0.0',
          },
        ],
      },
    ],
  });
}

function render(artifactName: string, changed: string[] = ['package.json']): string {
  const graph = graphWith(artifactName);
  const result = analyzeImpact(graph, 'acme/core-ui-lib', changed);
  return renderComment({ result, currentRepo: 'acme/core-ui-lib', graph, now: NOW });
}

describe('renderComment', () => {
  it('embeds the marker that makes the comment updatable in place', () => {
    expect(render('@acme/core-ui')).toContain(COMMENT_MARKER);
  });

  it('reports the affected repository, artifact and pin', () => {
    const body = render('@acme/core-ui');
    expect(body).toContain('1 downstream repository');
    expect(body).toContain('**acme/user-portal-app**');
    expect(body).toContain('`^2.0.0`');
  });

  it('renders a clean pass when nothing downstream is affected', () => {
    const body = render('@acme/core-ui', ['src/button.tsx']);
    expect(body).toContain('No downstream repositories are affected');
    expect(body).not.toContain('Affected downstream repositories');
  });

  it('pluralizes the headline count', () => {
    expect(render('@acme/core-ui')).toContain('1 downstream repository.');
  });

  it('keeps a crafted artifact name inside its code span and table cell', () => {
    // Payload carries a pipe (would split a cell) and a backtick (would close
    // the code span, letting the rest render as raw markdown/HTML).
    const body = render('@acme/evil|`<script>alert(1)</script>');

    // No backtick from the payload survives, so the span cannot be closed and
    // the angle brackets stay inert code-span text.
    expect(body).not.toContain('evil\\|`');
    expect(body).toContain('\\|');

    // The table row must still have exactly five columns.
    const row = body.split('\n').find((line) => line.startsWith('| **acme/user-portal-app**'));
    expect(row).toBeDefined();
    const cells = row!.replace(/\\\|/g, '').split('|');
    expect(cells).toHaveLength(7); // 5 cells + empty leading/trailing edges
  });

  it('warns when the graph is old enough to be misleading', () => {
    const graph = graphWith('@acme/core-ui');
    const result = analyzeImpact(graph, 'acme/core-ui-lib', ['package.json']);
    const stale = renderComment({
      result,
      currentRepo: 'acme/core-ui-lib',
      graph,
      now: new Date('2026-01-05T00:00:00.000Z'),
    });
    expect(stale).toContain('h old');
  });

  it('stays quiet about staleness for a fresh graph', () => {
    expect(render('@acme/core-ui')).not.toContain('h old');
  });

  it('surfaces analysis notes to the reader', () => {
    const graph = graphWith('@acme/core-ui');
    const result = analyzeImpact(graph, 'acme/missing-repo', ['package.json']);
    const body = renderComment({ result, currentRepo: 'acme/missing-repo', graph, now: NOW });
    expect(body).toContain('not present in the dependency graph');
  });
});

describe('renderJobSummary', () => {
  it('drops the marker, which only has meaning on a comment', () => {
    const graph = graphWith('@acme/core-ui');
    const options = {
      result: analyzeImpact(graph, 'acme/core-ui-lib', ['package.json']),
      currentRepo: 'acme/core-ui-lib',
      graph,
      now: NOW,
    };

    const summary = renderJobSummary(options);
    expect(summary).not.toContain(COMMENT_MARKER);
    expect(summary).toContain('Blast Radius Impact Analysis');
    expect(summary.startsWith('###')).toBe(true);
  });
});

describe('markdown escaping', () => {
  it('replaces backticks that would close an inline code span', () => {
    expect(escapeInlineCode('a`b')).not.toContain('`');
  });

  it('escapes pipes that would split a table cell', () => {
    expect(escapeInlineCode('a|b')).toBe('a\\|b');
  });

  it('collapses newlines that would break a row', () => {
    expect(escapeInlineCode('a\nb')).toBe('a b');
  });

  it('labels an empty value rather than rendering an empty span', () => {
    expect(escapeInlineCode('   ')).toBe('(empty)');
  });
});
