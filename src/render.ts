import { escapeInlineCode } from './markdown';
import type { GraphIndex, ImpactAnalysisResult } from './types';
import { distinctAffectedRepos, graphAgeHours, STALENESS_WARNING_HOURS } from './analyze';

/**
 * Marker used to find and update this action's own comment.
 *
 * An HTML comment is invisible in rendered markdown but searchable through the
 * API, which is what lets a `synchronize` event edit the existing comment
 * instead of adding a new one on every push.
 */
export const COMMENT_MARKER = '<!-- blast-radius-action: impact-report -->';

export interface RenderOptions {
  result: ImpactAnalysisResult;
  currentRepo: string;
  graph: GraphIndex;
  now?: Date;
}

/**
 * Render the pull-request comment.
 *
 * Every interpolated value originates in repository content, so it goes through
 * {@link escapeInlineCode} — an artifact name containing a pipe or a backtick
 * would otherwise break the table or inject markup into the comment.
 */
export function renderComment(options: RenderOptions): string {
  const { result } = options;
  const lines: string[] = [COMMENT_MARKER, '', '### 💥 Blast Radius Impact Analysis', ''];

  if (!result.hasImpact) {
    lines.push('✅ **No downstream repositories are affected by this pull request.**', '');
    for (const note of result.notes) lines.push(`> ℹ️ ${note}`, '');
    lines.push(renderFooter(options));
    return lines.join('\n');
  }

  const repos = distinctAffectedRepos(result);
  const repoLabel = repos.length === 1 ? 'repository' : 'repositories';

  lines.push(
    `⚠️ **This pull request modifies shared artifact declarations affecting ` +
      `${String(repos.length)} downstream ${repoLabel}.**`,
    '',
    '#### 📦 Modified shared artifacts',
    '',
  );

  for (const artifact of result.touchedArtifacts) {
    const version =
      artifact.version === undefined ? '' : ` at \`${escapeInlineCode(artifact.version)}\``;
    lines.push(
      `- \`${escapeInlineCode(artifact.name)}\` (\`${artifact.type}\`)${version} — declared in ` +
        `\`${escapeInlineCode(artifact.sourceFile)}\``,
    );
  }

  lines.push(
    '',
    '#### 🎯 Affected downstream repositories',
    '',
    '| Downstream repository | Shared artifact | Type | Consumer file | Pinned to |',
    '| :--- | :--- | :--- | :--- | :--- |',
  );

  for (const affected of result.affectedRepos) {
    const pinned =
      affected.versionRequirement === undefined
        ? '—'
        : `\`${escapeInlineCode(affected.versionRequirement)}\``;
    lines.push(
      `| **${escapeInlineCode(affected.repo)}** | \`${escapeInlineCode(affected.artifactName)}\` ` +
        `| \`${affected.type}\` | \`${escapeInlineCode(affected.consumerFile)}\` | ${pinned} |`,
    );
  }

  for (const note of result.notes) lines.push('', `> ℹ️ ${note}`);

  lines.push(
    '',
    '<details><summary>💡 <b>Before merging</b></summary>',
    '',
    '1. **Backwards compatibility** — confirm exported interfaces and signatures still satisfy the pinned ranges above.',
    '2. **Companion PRs** — for a breaking change, open the downstream PRs first so consumers are never left broken.',
    '3. **Integration checks** — trigger the downstream test pipelines rather than assuming the pin absorbs the change.',
    '4. **Version intent** — if this is a breaking change, make sure the version bump says so.',
    '</details>',
    '',
    renderFooter(options),
  );

  return lines.join('\n');
}

function renderFooter(options: RenderOptions): string {
  const { graph, currentRepo } = options;
  const parts = [
    `<sub>Analyzed \`${escapeInlineCode(currentRepo)}\` against a graph of ` +
      `${String(Object.keys(graph.repos).length)} repositories, generated ` +
      `\`${escapeInlineCode(graph.generatedAt)}\`.</sub>`,
  ];

  const ageHours = graphAgeHours(graph, options.now ?? new Date());
  if (ageHours !== null && ageHours > STALENESS_WARNING_HOURS) {
    parts.push(
      `<sub>⏳ The graph is ${String(Math.round(ageHours))}h old; recently added dependencies may be missing.</sub>`,
    );
  }

  return parts.join('\n');
}

/** Compact rendering of the same result for the Actions job summary. */
export function renderJobSummary(options: RenderOptions): string {
  return renderComment(options).replace(`${COMMENT_MARKER}\n\n`, '');
}
