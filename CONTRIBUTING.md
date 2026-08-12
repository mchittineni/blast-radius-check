# Contributing

Thanks for helping improve this action. This document covers the local setup, the
non-obvious rules of the repository, and what a reviewable change looks like.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Requirements

- **Node.js >= 22.** `.nvmrc` pins the development version; `nvm use` picks it up.
- npm >= 10.

## Setup

```bash
npm ci
npm run all     # format check, lint, typecheck, tests, bundle
```

`npm run all` is exactly what CI runs. If it passes locally, CI should agree.

## Everyday commands

| Command                 | What it does                                  |
| :---------------------- | :-------------------------------------------- |
| `npm test`              | Run the test suite once                       |
| `npm run test:watch`    | Re-run tests on change                        |
| `npm run test:coverage` | Tests plus coverage, enforcing the thresholds |
| `npm run typecheck`     | `tsc --noEmit` under the strict config        |
| `npm run lint`          | ESLint, type-aware rules included             |
| `npm run format`        | Rewrite files with Prettier                   |
| `npm run build`         | Bundle `src/main.ts` into `dist/index.js`     |
| `npm run build:watch`   | Rebuild the bundle on change                  |

## The one rule that surprises everyone: commit `dist/`

GitHub Actions **does not run `npm install`** for a JavaScript action. It executes
the committed `dist/index.js` directly, so the bundle is a build artifact that
must be checked in.

**Run `npm run build` and commit `dist/` with every source change.** The
`check-dist` workflow rebuilds from scratch and fails the pull request if the
committed bundle does not match the sources — that check exists so a stale bundle
can never ship.

## Architecture, and why it is shaped this way

```
action.yml        Action metadata. Must stay at the repository root (Marketplace).
src/main.ts       Entrypoint. A thin @actions/core adapter: inputs in, outputs out.
src/analyze.ts    Graph validation and impact computation. Pure functions.
src/render.ts     Markdown rendering, including all escaping of untrusted values.
src/pr.ts         GitHub API calls: changed files, and the sticky-comment upsert.
src/types.ts      The `graph.json` contract, including GRAPH_SCHEMA_VERSION.
src/inputs.ts     Tolerant parsing of the action's inputs.
src/markdown.ts   Escaping of untrusted values bound for the comment.
src/normalize.ts  Path canonicalization, so both sides compare the same form.
tests/            Vitest suites, mirroring the src module names.
scripts/build.mjs esbuild bundler configuration.
dist/             Generated, committed. Never edit by hand.
```

Two conventions hold this together:

1. **`main.ts` stays thin.** It reads inputs, calls one function, sets outputs,
   and has a single failure surface. Everything testable lives elsewhere, which
   is why the suite needs no Actions runner.
2. **Analysis and I/O stay apart.** `analyze.ts` and `render.ts` are pure: give
   them a graph and a file list and they produce a result and a string. Every API
   call lives in `pr.ts`. That is why the suite covers the interesting behavior
   with no network and no Actions runner — keep new code on the correct side.

### `src/types.ts` is a cross-repository contract

This action and `blast-radius-indexer` are separate repositories because
Marketplace publishes one action per repository. Each owns its own sources
outright — there is no shared directory to keep in lockstep — but `src/types.ts`
and its `GRAPH_SCHEMA_VERSION` still describe the `graph.json` contract between
them.

**If you change `src/types.ts`, make the matching change in the indexer and bump
`GRAPH_SCHEMA_VERSION` for anything breaking.** This action refuses a graph whose
schema version is newer than it understands, which turns a silent misread into a
clear error.

`tests/helpers/graph-fixture.ts` deliberately builds graphs as literal JSON rather
than importing the indexer's builder. That is the point: it asserts the shape this
action must accept, so drift in the contract shows up as a failing test here.

## Testing expectations

- Every behavioral change needs a test. Coverage thresholds are enforced
  (95% lines/statements, 90% functions, 85% branches).
- Test names state the behavior and, where it is not obvious, the reason:
  `'does not mistake a build stage for an external image'` beats `'parses FROM'`.
- Prefer a fixture directory or the fake Octokit in `tests/helpers/` over mocking
  internal modules.
- Parsers are the highest-risk area. New syntax support needs the odd cases too:
  comments, interpolation, multi-stage builds, alternative URL spellings.

## Changing the report

The comment is untrusted output. `render.ts` routes every interpolated value
through `escapeInlineCode` from `src/markdown.ts`, because artifact names and
paths are read out of arbitrary repository content. A name containing a backtick
would otherwise close its code span and let the rest render as raw markup.

**If you add a field to the comment, escape it, and add a test proving a crafted
value cannot break out of its cell.** `tests/render.test.ts` has the pattern.

When adding a case where the action cannot be sure of something, push a message
onto `result.notes` instead of staying silent. A quiet pass and a genuine
"no impact" must never look the same to a reviewer.

## Testing expectations for API code

`tests/helpers/fake-octokit.ts` is a hand-rolled client: you declare handlers for
the exact endpoints the code should call, and assert on the recorded calls. Prefer
it over mocking modules — it makes an unintended extra API call visible as a test
failure. Use `HttpError` to exercise the status-code paths (404, 403, 409).

## Pull requests

- Branch from `main`; keep changes focused.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
  `fix:`, `docs:`, `chore:`) — the changelog and version bumps read from them.
- Fill in the pull request template, including the `dist/` rebuild checkbox.
- Note any change to `action.yml` inputs or outputs; those are a public contract.

## Releasing

Maintainers only:

1. Update `CHANGELOG.md`.
2. Tag the release: `git tag -a v1.2.3 -m "v1.2.3" && git push origin v1.2.3`.
3. Publish a GitHub Release from the tag, checking **"Publish this Action to the
   GitHub Marketplace"**. GitHub validates `action.yml` at that point.
4. The `release` workflow moves the floating `v1` major tag so `@v1` consumers
   pick the change up. Verify it ran.
