/**
 * Graph fixtures for the checker's tests.
 *
 * This repository deliberately does not depend on the indexer: `graph.json` is
 * the contract between them, so the fixtures are written as the literal JSON
 * shape the checker must accept. If the indexer's output ever drifts from this,
 * these tests should fail — that is the point.
 *
 * Keep in sync with `blast-radius-indexer` (its own copy of GRAPH_SCHEMA_VERSION).
 */
import { GRAPH_SCHEMA_VERSION, type ArtifactType, type GraphIndex } from '../../src/types';

export const GENERATED_AT = '2026-01-01T00:00:00.000Z';

export interface ExportSpec {
  type?: ArtifactType;
  name: string;
  version?: string;
  sourceFile: string;
}

export interface ConsumerSpec {
  repo: string;
  sourceFile: string;
  versionRequirement?: string;
}

export interface RepoSpec {
  repo: string;
  exports?: ExportSpec[];
}

export interface ArtifactSpec {
  type?: ArtifactType;
  name: string;
  publisherRepo: string;
  publisherFile: string;
  consumers?: ConsumerSpec[];
}

export interface GraphFixtureSpec {
  org?: string;
  generatedAt?: string;
  repos: RepoSpec[];
  artifacts?: ArtifactSpec[];
}

/** Assemble a `GraphIndex` exactly as the indexer would serialize it. */
export function makeGraph(spec: GraphFixtureSpec): GraphIndex {
  const graph: GraphIndex = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: spec.generatedAt ?? GENERATED_AT,
    org: spec.org ?? 'acme',
    artifacts: {},
    repos: {},
  };

  for (const repo of spec.repos) {
    graph.repos[repo.repo] = {
      repo: repo.repo,
      exports: (repo.exports ?? []).map((entry) => ({
        type: entry.type ?? 'npm',
        name: entry.name,
        version: entry.version,
        sourceFile: entry.sourceFile,
      })),
      imports: [],
    };
  }

  for (const artifact of spec.artifacts ?? []) {
    const type = artifact.type ?? 'npm';
    graph.artifacts[`${type}:${artifact.name}`] = {
      type,
      name: artifact.name,
      publisherRepo: artifact.publisherRepo,
      publisherFile: artifact.publisherFile,
      consumers: (artifact.consumers ?? []).map((consumer) => ({
        repo: consumer.repo,
        sourceFile: consumer.sourceFile,
        versionRequirement: consumer.versionRequirement,
      })),
    };
  }

  return graph;
}

/**
 * The canonical scenario: `acme/core-ui-lib` publishes `@acme/core-ui`, consumed
 * by two other repositories with different pins and consumer file paths.
 */
export function sampleGraph(artifactName = '@acme/core-ui'): GraphIndex {
  return makeGraph({
    repos: [
      {
        repo: 'acme/core-ui-lib',
        exports: [{ name: artifactName, version: '2.1.0', sourceFile: 'package.json' }],
      },
      { repo: 'acme/user-portal-app' },
      { repo: 'acme/auth-service' },
    ],
    artifacts: [
      {
        name: artifactName,
        publisherRepo: 'acme/core-ui-lib',
        publisherFile: 'package.json',
        consumers: [
          {
            repo: 'acme/auth-service',
            sourceFile: 'services/api/package.json',
            versionRequirement: '~2.1.0',
          },
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
