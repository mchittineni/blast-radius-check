import { normalizePath } from './normalize';
import {
  GRAPH_SCHEMA_VERSION,
  artifactKey,
  type AffectedRepo,
  type ArtifactConsumer,
  type ArtifactConsumerRef,
  type ArtifactDeclaration,
  type ArtifactNode,
  type ArtifactType,
  type GraphIndex,
  type ImpactAnalysisResult,
  type RepositoryIndex,
} from './types';

/**
 * Parse and validate a `graph.json` payload.
 *
 * The graph is an untrusted input: it is fetched from another repository and may
 * be stale, truncated, or written by a different version of the indexer.
 * Validating up front turns a confusing `undefined` crash deep in the analysis
 * into one actionable message.
 */
export function parseGraph(raw: string): GraphIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`graph.json is not valid JSON: ${error instanceof Error ? error.message : ''}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('graph.json must contain a JSON object.');
  }

  // Typed as unknown-valued, not `Partial<GraphIndex>`: the payload is untrusted,
  // so `artifacts: null` and `schemaVersion: "1"` are both genuinely possible and
  // must be checked at runtime rather than assumed away by an assertion.
  const candidate = parsed as Record<string, unknown>;

  const artifacts = candidate['artifacts'];
  if (typeof artifacts !== 'object' || artifacts === null || Array.isArray(artifacts)) {
    throw new Error('graph.json is missing the `artifacts` map. Re-run the indexer action.');
  }
  const repos = candidate['repos'];
  if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) {
    throw new Error('graph.json is missing the `repos` map. Re-run the indexer action.');
  }

  const rawSchemaVersion = candidate['schemaVersion'];
  const schemaVersion = typeof rawSchemaVersion === 'number' ? rawSchemaVersion : 0;
  if (schemaVersion > GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `graph.json declares schema version ${String(schemaVersion)}, but this action supports ` +
        `up to ${String(GRAPH_SCHEMA_VERSION)}. Upgrade the checker action.`,
    );
  }

  const generatedAt = candidate['generatedAt'];
  const org = candidate['org'];
  const warnings = candidate['warnings'];

  return {
    schemaVersion,
    generatedAt: typeof generatedAt === 'string' ? generatedAt : 'unknown',
    org: typeof org === 'string' ? org : 'unknown',
    warnings: Array.isArray(warnings) ? warnings.map((entry) => String(entry)) : undefined,
    artifacts: normalizeArtifacts(artifacts as Record<string, unknown>),
    repos: normalizeRepos(repos as Record<string, unknown>),
  };
}

/**
 * Coerce the graph's entries into the shape the analysis is typed against.
 *
 * A shallow check on the two top-level maps is not enough to make the declared
 * types true: an older indexer, a truncated write, or a hand-edited graph can
 * leave an entry without its `exports` or `consumers` list. Without this, the
 * analysis dies on `Cannot read properties of undefined` — the opaque crash this
 * function exists to prevent. Missing lists become empty ones, so a partial graph
 * under-reports impact and the reader gets a note, rather than a stack trace.
 */
function normalizeRepos(repos: Record<string, unknown>): GraphIndex['repos'] {
  const normalized: GraphIndex['repos'] = {};

  for (const [name, entry] of Object.entries(repos)) {
    const candidate = asRecord(entry);
    if (candidate === undefined) continue;

    const index: RepositoryIndex = {
      repo: str(candidate['repo']) ?? name,
      exports: mapEntries(candidate['exports'], toDeclaration),
      imports: mapEntries(candidate['imports'], toConsumer),
    };

    const defaultBranch = str(candidate['defaultBranch']);
    if (defaultBranch !== undefined) index.defaultBranch = defaultBranch;

    normalized[name] = index;
  }

  return normalized;
}

function normalizeArtifacts(artifacts: Record<string, unknown>): GraphIndex['artifacts'] {
  const normalized: GraphIndex['artifacts'] = {};

  for (const [key, entry] of Object.entries(artifacts)) {
    const candidate = asRecord(entry);
    if (candidate === undefined) continue;

    const type = str(candidate['type']);
    const name = str(candidate['name']);
    if (type === undefined || name === undefined) continue;

    normalized[key] = {
      type: type as ArtifactNode['type'],
      name,
      publisherRepo: str(candidate['publisherRepo']) ?? '',
      publisherFile: str(candidate['publisherFile']) ?? '',
      consumers: mapEntries(candidate['consumers'], toConsumerRef),
    };
  }

  return normalized;
}

/** An artifact declaration, or `undefined` when it lacks a field the analysis reads. */
function toDeclaration(entry: Record<string, unknown>): ArtifactDeclaration | undefined {
  const type = str(entry['type']);
  const name = str(entry['name']);
  const sourceFile = str(entry['sourceFile']);
  if (type === undefined || name === undefined || sourceFile === undefined) return undefined;

  const declaration: ArtifactDeclaration = { type: type as ArtifactType, name, sourceFile };
  const version = str(entry['version']);
  if (version !== undefined) declaration.version = version;
  const aliases = entry['aliases'];
  if (Array.isArray(aliases)) declaration.aliases = aliases.filter(isString);
  return declaration;
}

function toConsumer(entry: Record<string, unknown>): ArtifactConsumer | undefined {
  const ref = toConsumerRef(entry);
  const type = str(entry['type']);
  const artifactName = str(entry['artifactName']);
  if (ref === undefined || type === undefined || artifactName === undefined) return undefined;

  return { ...ref, type: type as ArtifactType, artifactName };
}

function toConsumerRef(entry: Record<string, unknown>): ArtifactConsumerRef | undefined {
  const repo = str(entry['repo']);
  const sourceFile = str(entry['sourceFile']);
  if (repo === undefined || sourceFile === undefined) return undefined;

  const ref: ArtifactConsumerRef = { repo, sourceFile };
  const versionRequirement = str(entry['versionRequirement']);
  if (versionRequirement !== undefined) ref.versionRequirement = versionRequirement;
  return ref;
}

/**
 * Convert the object entries of a list, dropping whatever does not convert.
 *
 * Dropping rather than throwing is the deliberate choice: one malformed entry in
 * a graph of thousands should cost that edge, not the whole run.
 */
function mapEntries<TResult>(
  value: unknown,
  convert: (entry: Record<string, unknown>) => TResult | undefined,
): TResult[] {
  if (!Array.isArray(value)) return [];

  const converted: TResult[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const result = convert(record);
    if (result !== undefined) converted.push(result);
  }
  return converted;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** How old a graph may be before the comment calls it out. */
export const STALENESS_WARNING_HOURS = 48;

export function graphAgeHours(graph: GraphIndex, now: Date = new Date()): number | null {
  const generated = Date.parse(graph.generatedAt);
  if (Number.isNaN(generated)) return null;
  return (now.getTime() - generated) / 3_600_000;
}

/**
 * Determine which downstream repositories a pull request puts at risk.
 *
 * The rule: if the PR modifies a file that *declares* an artifact this repo
 * publishes, every other repo consuming that artifact is in the blast radius.
 * Consumers are deduplicated on `repo + artifact + file`, because one artifact
 * reachable under several alias names would otherwise be reported repeatedly.
 */
export function analyzeImpact(
  graph: GraphIndex,
  repoName: string,
  changedFiles: readonly string[],
): ImpactAnalysisResult {
  const result: ImpactAnalysisResult = {
    hasImpact: false,
    touchedArtifacts: [],
    affectedRepos: [],
    notes: [],
  };

  const repoIndex = graph.repos[repoName];
  if (repoIndex === undefined) {
    result.notes.push(
      `\`${repoName}\` is not present in the dependency graph, so no impact could be computed. ` +
        'It may be newly created, filtered out, or added after the last index run.',
    );
    return result;
  }

  const changed = new Set(changedFiles.map(normalizePath));
  const seenEdges = new Set<string>();

  for (const declaration of repoIndex.exports) {
    if (!changed.has(normalizePath(declaration.sourceFile))) continue;
    result.touchedArtifacts.push(declaration);

    const node = graph.artifacts[artifactKey(declaration.type, declaration.name)];
    if (node === undefined || node.consumers.length === 0) continue;

    for (const consumer of node.consumers) {
      if (consumer.repo === repoName) continue;

      const edgeKey = `${consumer.repo}|${declaration.type}:${declaration.name}|${consumer.sourceFile}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const affected: AffectedRepo = {
        repo: consumer.repo,
        artifactName: declaration.name,
        type: declaration.type,
        consumerFile: consumer.sourceFile,
        versionRequirement: consumer.versionRequirement,
      };
      result.affectedRepos.push(affected);
    }
  }

  result.affectedRepos.sort(
    (left, right) =>
      left.repo.localeCompare(right.repo) || left.artifactName.localeCompare(right.artifactName),
  );

  if (result.touchedArtifacts.length > 0 && result.affectedRepos.length === 0) {
    result.notes.push(
      'This PR modifies shared artifact declarations, but no other indexed repository consumes them.',
    );
  }

  result.hasImpact = result.affectedRepos.length > 0;
  return result;
}

/** Distinct downstream repositories, for a headline count that is not edge-inflated. */
export function distinctAffectedRepos(result: ImpactAnalysisResult): string[] {
  return [...new Set(result.affectedRepos.map((entry) => entry.repo))].sort();
}
