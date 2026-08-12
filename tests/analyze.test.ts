import { describe, expect, it } from 'vitest';
import { analyzeImpact, distinctAffectedRepos, graphAgeHours, parseGraph } from '../src/analyze';
import { GENERATED_AT, makeGraph, sampleGraph } from './helpers/graph-fixture';

describe('analyzeImpact', () => {
  it('reports downstream consumers when a declaring file changes', () => {
    const result = analyzeImpact(sampleGraph(), 'acme/core-ui-lib', ['package.json']);
    expect(result.hasImpact).toBe(true);
    expect(distinctAffectedRepos(result)).toEqual(['acme/auth-service', 'acme/user-portal-app']);
    expect(result.touchedArtifacts).toHaveLength(1);
  });

  it('carries the consumer pin through, so reviewers see what is constrained', () => {
    const result = analyzeImpact(sampleGraph(), 'acme/core-ui-lib', ['package.json']);
    expect(result.affectedRepos[0]).toMatchObject({
      repo: 'acme/auth-service',
      consumerFile: 'services/api/package.json',
      versionRequirement: '~2.1.0',
    });
  });

  it('reports no impact when the PR misses every declaring file', () => {
    const result = analyzeImpact(sampleGraph(), 'acme/core-ui-lib', ['src/button.tsx']);
    expect(result.hasImpact).toBe(false);
    expect(result.affectedRepos).toEqual([]);
  });

  it('matches paths regardless of ./ prefixing', () => {
    const result = analyzeImpact(sampleGraph(), 'acme/core-ui-lib', ['./package.json']);
    expect(result.hasImpact).toBe(true);
  });

  it('explains itself instead of silently passing when the repo is absent', () => {
    const result = analyzeImpact(sampleGraph(), 'acme/brand-new-repo', ['package.json']);
    expect(result.hasImpact).toBe(false);
    expect(result.notes.join(' ')).toContain('not present in the dependency graph');
  });

  it('notes a touched artifact that nobody consumes', () => {
    const graph = makeGraph({
      generatedAt: GENERATED_AT,
      repos: [
        {
          repo: 'acme/lonely-lib',
          exports: [{ name: '@acme/lonely', sourceFile: 'package.json' }],
        },
      ],
      artifacts: [
        {
          name: '@acme/lonely',
          publisherRepo: 'acme/lonely-lib',
          publisherFile: 'package.json',
        },
      ],
    });
    const result = analyzeImpact(graph, 'acme/lonely-lib', ['package.json']);
    expect(result.hasImpact).toBe(false);
    expect(result.notes.join(' ')).toContain('no other indexed repository consumes them');
  });
});

describe('parseGraph', () => {
  it('round-trips a graph produced by the indexer', () => {
    const graph = sampleGraph();
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it('rejects invalid JSON with an actionable message', () => {
    expect(() => parseGraph('{ nope')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON payload that is not an object', () => {
    expect(() => parseGraph('42')).toThrow(/must contain a JSON object/);
    expect(() => parseGraph('null')).toThrow(/must contain a JSON object/);
  });

  it('rejects a payload missing the artifacts map', () => {
    expect(() => parseGraph(JSON.stringify({ repos: {} }))).toThrow(/missing the `artifacts` map/);
  });

  it('rejects a payload missing the repos map', () => {
    expect(() => parseGraph(JSON.stringify({ artifacts: {} }))).toThrow(/missing the `repos` map/);
  });

  it('refuses a graph written by a newer indexer rather than misreading it', () => {
    const future = JSON.stringify({ schemaVersion: 99, artifacts: {}, repos: {} });
    expect(() => parseGraph(future)).toThrow(/Upgrade the checker action/);
  });

  it('accepts a legacy graph with no schema version', () => {
    expect(parseGraph(JSON.stringify({ artifacts: {}, repos: {} })).schemaVersion).toBe(0);
  });

  // A partial graph must cost the malformed edge, not the run. Before these,
  // each case reached the analysis and died on `Cannot read properties of
  // undefined` — a stack trace no reviewer can act on.
  it('survives a repo entry with no exports list', () => {
    const graph = parseGraph(
      JSON.stringify({ artifacts: {}, repos: { 'acme/web': { repo: 'acme/web' } } }),
    );

    expect(graph.repos['acme/web']?.exports).toEqual([]);
    expect(() => analyzeImpact(graph, 'acme/web', ['package.json'])).not.toThrow();
  });

  it('survives an artifact node with no consumers list', () => {
    const graph = parseGraph(
      JSON.stringify({
        artifacts: { 'npm:@acme/ui': { type: 'npm', name: '@acme/ui' } },
        repos: {
          'acme/web': {
            repo: 'acme/web',
            exports: [{ type: 'npm', name: '@acme/ui', sourceFile: 'package.json' }],
          },
        },
      }),
    );

    expect(analyzeImpact(graph, 'acme/web', ['package.json']).hasImpact).toBe(false);
  });

  it('drops entries missing a field the analysis reads, keeping the rest', () => {
    const graph = parseGraph(
      JSON.stringify({
        artifacts: {
          'npm:@acme/ui': {
            type: 'npm',
            name: '@acme/ui',
            consumers: [
              { repo: 'acme/portal', sourceFile: 'package.json' },
              { repo: 'acme/broken' }, // no sourceFile
              'not an object',
            ],
          },
          'npm:nameless': { type: 'npm' },
        },
        repos: {
          'acme/web': {
            repo: 'acme/web',
            exports: [
              { type: 'npm', name: '@acme/ui', sourceFile: 'package.json' },
              { type: 'npm', name: '@acme/half' }, // no sourceFile
            ],
          },
        },
      }),
    );

    expect(graph.repos['acme/web']?.exports).toHaveLength(1);
    expect(graph.artifacts['npm:nameless']).toBeUndefined();

    const result = analyzeImpact(graph, 'acme/web', ['package.json']);
    expect(result.affectedRepos.map((entry) => entry.repo)).toEqual(['acme/portal']);
  });

  it('preserves the optional fields the report reads, and drops non-string aliases', () => {
    const graph = parseGraph(
      JSON.stringify({
        artifacts: {},
        repos: {
          'acme/web': {
            defaultBranch: 'main',
            exports: [
              {
                type: 'npm',
                name: '@acme/ui',
                sourceFile: 'package.json',
                version: '2.1.0',
                aliases: ['ghcr.io/acme/ui', 7, null],
              },
            ],
            imports: [
              {
                repo: 'acme/web',
                sourceFile: 'package.json',
                type: 'npm',
                artifactName: '@acme/other',
                versionRequirement: '^1.0.0',
              },
              { repo: 'acme/web', sourceFile: 'package.json' }, // no artifactName
            ],
          },
        },
      }),
    );

    const index = graph.repos['acme/web'];
    expect(index?.repo).toBe('acme/web'); // falls back to the map key
    expect(index?.defaultBranch).toBe('main');
    expect(index?.exports[0]?.version).toBe('2.1.0');
    expect(index?.exports[0]?.aliases).toEqual(['ghcr.io/acme/ui']);
    expect(index?.imports).toHaveLength(1);
    expect(index?.imports[0]?.versionRequirement).toBe('^1.0.0');
  });

  it('drops a repo entry that is not an object', () => {
    const graph = parseGraph(
      JSON.stringify({ artifacts: {}, repos: { 'acme/web': 'not an object' } }),
    );
    expect(graph.repos['acme/web']).toBeUndefined();
  });
});

describe('graphAgeHours', () => {
  it('measures the age of the graph', () => {
    const graph = sampleGraph();
    expect(graphAgeHours(graph, new Date('2026-01-02T00:00:00.000Z'))).toBe(24);
  });

  it('returns null for an unparseable timestamp', () => {
    expect(graphAgeHours({ ...sampleGraph(), generatedAt: 'unknown' })).toBeNull();
  });
});
