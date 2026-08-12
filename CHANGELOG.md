# Changelog

All notable changes to this action are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Consumers pinned to `@v1` receive every non-breaking release automatically.

## [Unreleased]

## [1.0.0] - 2026-08-12

First release as a standalone repository, split out of the original
`blast-radius-action` monorepo so it can be published to the GitHub Marketplace
(which lists one action per repository, with `action.yml` at the root).

### Added

- Reads the pull request's changed files from the API, with pagination, and
  includes the pre-rename path of a renamed file — that is where a declaration
  used to live.
- Sticky comment: the report is found by an embedded marker and **updated in
  place**, so pushing to a pull request no longer adds another comment.
- `comment-mode` input (`always`, `on-impact`, `never`). In `on-impact`, a stale
  comment is removed once impact clears.
- Outputs: `has-impact`, `affected-repo-count`, `affected-repos`,
  `touched-artifact-count`, `report-markdown`.
- Job summary containing the full report, so the result is visible even when the
  job cannot comment.
- The comment now shows the version each consumer is **pinned to**, which is what
  a reviewer needs to judge whether a change is safe.
- Graph validation with actionable errors for malformed JSON, a missing
  `artifacts` or `repos` map, and a `schemaVersion` newer than this action
  supports — rather than crashing on `undefined` deep in the analysis.
- Staleness warning in the comment footer when the graph is over 48 hours old.
- A note in the comment when the pull request exceeds the API's 3000-file limit,
  so partial analysis is never mistaken for a clean result.
- Explicit notes when this repository is absent from the graph, or when a modified
  artifact has no consumers — previously both looked identical to "no impact".

### Fixed

Carried over from the prototype, where these prevented the action from working
at all:

- The action had no entrypoint. `action.yml` declared `main: dist/index.js`, but
  there was no build, no bundle, and no code reading inputs, fetching the pull
  request's files, or posting a comment — so it could not run.
- Duplicate consumer edges reported the same downstream repository repeatedly when
  an artifact was reachable under more than one alias.
- Changed-file matching was exact-string, so a path reported as `./package.json`
  never matched a declaration recorded as `package.json`.
- A repository consuming its own artifact was reported as its own blast radius.
- Graph validation stopped at the two top-level maps, so an entry missing its
  `exports` or `consumers` list crashed the analysis with an unactionable
  `Cannot read properties of undefined`. Entries are now validated at the
  boundary and a malformed one costs its own edge, not the run.
- A failure to write the job summary sank a run whose analysis had already
  succeeded. It is now a warning, matching how comment failures are handled.

### Security

- All values interpolated into the comment are escaped. A crafted artifact name
  containing a backtick or a pipe can no longer break out of its code span or
  table cell to inject markup into the pull-request comment.
- Failing to comment is a warning, not a failure, so a permissions problem cannot
  be mistaken for a passing impact check.
- The sticky comment is matched on its marker **and** a bot author. A pull
  request author who puts the marker in their own comment can no longer have it
  overwritten, or deleted under `comment-mode: on-impact`.
- CodeQL analysis runs on every pull request and weekly.

[Unreleased]: https://github.com/mchittineni/blast-radius-check/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mchittineni/blast-radius-check/releases/tag/v1.0.0
