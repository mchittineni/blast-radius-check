# 💥 Cross-Repo Blast Radius Check

[![CI](https://github.com/mchittineni/blast-radius-check/actions/workflows/ci.yml/badge.svg)](https://github.com/mchittineni/blast-radius-check/actions/workflows/ci.yml)
[![Check dist](https://github.com/mchittineni/blast-radius-check/actions/workflows/check-dist.yml/badge.svg)](https://github.com/mchittineni/blast-radius-check/actions/workflows/check-dist.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=000000)](https://buymeacoffee.com/mchittineni)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-24292F?style=for-the-badge&logo=githubsponsors&logoColor=EA4AAA)](https://github.com/sponsors/mchittineni)

A GitHub Action that tells a pull request **which other repositories it is about to
break**. When a PR modifies a file that declares a shared artifact an npm
package, a container image, a Terraform module this posts a comment naming every
downstream repository that consumes it, and the version each one is pinned to.

It reads a `graph.json` describing which repository publishes each shared artifact
and which repositories consume it. Any process that produces that shape will do
the companion [**blast-radius-indexer**](https://github.com/mchittineni/blast-radius-indexer) action builds one by scanning an
organization. [`src/types.ts`](src/types.ts) is the authoritative schema.

---

## Quick start

```yaml
name: Blast radius

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write # required to post the comment

jobs:
  blast-radius:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v7

      # Fetch the graph from wherever your blast-radius-indexer commits it.
      - name: Checkout Repository for Graph
        uses: actions/checkout@v7
        with:
          repository: owner/dependency-graph
          path: .graph
          github-token: ${{ secrets.GITHUB_TOKEN }} # omit if the repo is public

      - name: Setup Blast Radius
        uses: mchittineni/blast-radius-check@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          graph-path: .graph/graph.json
```

`permissions: pull-requests: write` is what lets the comment be posted. Without it
the analysis still runs the result lands in the job summary and the outputs, and
the action logs a warning instead of failing.

---

## What the comment looks like

> ### 💥 Blast Radius Impact Analysis
>
> ⚠️ **This pull request modifies shared artifact declarations affecting 2 downstream repositories.**
>
> #### 📦 Modified shared artifacts
>
> - `@acme/core-ui` (`npm`) at `2.1.0` — declared in `package.json`
>
> #### 🎯 Affected downstream repositories
>
> | Downstream repository | Shared artifact | Type  | Consumer file               | Pinned to |
> | :-------------------- | :-------------- | :---- | :-------------------------- | :-------- |
> | **acme/auth-service** | `@acme/core-ui` | `npm` | `services/api/package.json` | `~2.1.0`  |
> | **acme/user-portal**  | `@acme/core-ui` | `npm` | `package.json`              | `^2.0.0`  |

The comment is **updated in place** on every push rather than added again, so a
long-lived pull request keeps exactly one impact comment.

---

## Inputs

| Input            | Required | Default               | Description                                    |
| :--------------- | :------- | :-------------------- | :--------------------------------------------- |
| `github-token`   | **yes**  | `${{ github.token }}` | Needs `pull-requests: write` to comment.       |
| `graph-path`     | no       | `graph.json`          | Path to the graph produced by the indexer.     |
| `fail-on-impact` | no       | `false`               | Fail the step when downstream impact is found. |
| `comment-mode`   | no       | `always`              | `always`, `on-impact`, or `never` (see below). |

### `comment-mode`

| Value       | Behavior                                                                                                                                                   |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `always`    | Post or update the comment on every run, including the clean "no impact" result.                                                                           |
| `on-impact` | Comment only when downstream repositories are affected. If a previous run reported impact and the latest push clears it, the stale comment is **removed**. |
| `never`     | No comment at all use the outputs and the job summary. Useful when another job aggregates the result.                                                      |

## Outputs

| Output                   | Description                                                 |
| :----------------------- | :---------------------------------------------------------- |
| `has-impact`             | `true` when at least one downstream repository is affected. |
| `affected-repo-count`    | Number of distinct downstream repositories.                 |
| `affected-repos`         | Comma-separated list of those repositories.                 |
| `touched-artifact-count` | Shared artifact declarations the PR modified.               |
| `report-markdown`        | The rendered markdown report.                               |

### Gating a merge on it

```yaml
- uses: mchittineni/blast-radius-check@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    graph-path: .graph/graph.json
    fail-on-impact: 'true' # make this a required status check
```

### Triggering downstream verification

```yaml
- uses: mchittineni/blast-radius-check@v1
  id: blast
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}

- if: steps.blast.outputs.has-impact == 'true'
  env:
    AFFECTED: ${{ steps.blast.outputs.affected-repos }}
  run: |
    for repo in ${AFFECTED//,/ }; do
      gh workflow run integration.yml --repo "$repo"
    done
```

---

## How impact is determined

1. List every file the pull request touches (including the **old path** of a
   rename, since that is where a declaration used to live).
2. Look up this repository in the graph and take its declared exports.
3. For each export whose declaring file the PR modified, collect every consumer of
   that artifact in another repository.
4. Deduplicate on repository + artifact + consumer file, and sort.

The action is deliberately quiet in the cases where it cannot know something, and
says so in the comment rather than passing silently:

- **This repository is not in the graph**: newly created, filtered out, or added
  after the last index run.
- **A modified artifact has no consumers**: nothing downstream to break.
- **The graph is more than 48 hours old**: recently added dependencies may be
  missing, noted in the comment footer.
- **The pull request exceeds 3000 files**: the GitHub API caps the file list, so
  the comment states that impact may be under-reported.

### Safety of the rendered comment

Artifact names, file paths, and version ranges come from arbitrary repository
content. Every value is escaped before rendering: backticks are neutralized so a
crafted name cannot close its code span, and pipes are escaped so it cannot break
out of a table cell.

### Graph compatibility

`graph.json` carries a `schemaVersion`. If the indexer that wrote it is newer than
this action understands, the action fails with a clear message rather than
misreading the file. Keep both actions on matching major versions.

---

## Honest caveats

1. **Only as fresh as the graph.** Impact is computed against the last index run,
   not live state. The comment footer surfaces the graph's age.
2. **Declaration-level, not source-level.** It fires when the file that _declares_
   an artifact changes — a `package.json`, a `Dockerfile`, a root `.tf`. It does
   not know whether an edit to `src/button.tsx` is a breaking change to the
   package's API.
3. **A pin is not protection.** The report shows what each consumer is pinned to
   so you can judge whether your change satisfies it; it does not evaluate semver
   compatibility for you.
4. **Comment failures do not fail the job.** A missing `pull-requests: write` is
   reported as a warning, with the result still available in the outputs and job
   summary. Set `fail-on-impact` if you want a hard gate on impact itself.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Note the one rule that surprises everyone:
`dist/` is a committed build artifact, and `npm run build` must be run with every
source change.

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
