# Usage

## Start a review

Comment one of these exact commands on a pull request. Only the first line counts.

| Command                      | Effect                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `@sakre`                     | Review the current head commit, unless it already has a complete review.      |
| `@sakre --force`             | Review the current head commit again.                                         |
| `@sakre --force-over-budget` | Review again and allow a diff above the budget. Coverage becomes partial.     |
| `@sakre --diagnostic`        | Check trigger authorization and configuration without calling an AI provider. |

Text after the command line is review guidance. It tells agents where to look. It cannot change the provider, model, plan, budget, permissions, refs, output, or verdict, and it cannot suppress a finding. Guidance above 8,000 characters is ignored with a warning and the review continues. The same contract applies to `--instructions` in the local CLI.

## Review guidance

Guidance exists on both surfaces. In CI it is the text after the command line:

```md
@sakre
Focus on the migration path; the old API stays for one release.
```

Locally it is a file you pass explicitly:

```sh
./sakre-linux-x64 local --base main --instructions ./notes.md
```

Write guidance as investigation context: technologies, areas of concern, review goals. Agents still review their assigned scope independently, and the coordinator and verifier never see raw guidance, only its provenance.

> [!IMPORTANT]
> Guidance focuses attention. It never changes run options and never suppresses, downgrades, or invents findings. Treat it as untrusted input, because anyone who can comment can write it.

## Read the result

SAKRE posts a comment on the pull request. Each review ends in one of four states:

- `clean`: no confirmed findings.
- `comments`: confirmed findings below Blocker severity.
- `changes_required`: at least one confirmed Blocker.
- `incomplete`: something failed or coverage was cut, so the result is partial. The comment names the cause.

The Action only publishes a comment.

> [!IMPORTANT]
> It never approves, requests changes through the API, or merges. Informational only.

## Example review

See the [example review](example.md): a shortened synthetic review showing the headline, findings, signals, and models blocks.

## When a review stops early

SAKRE fails closed: a problem produces an explicit `incomplete` result instead of a silent pass.

| Cause                                                                       | What you see                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Diff above the budget (default 80,000 characters)                           | Abort comment with exact numbers; rerun with `--force-over-budget` for partial coverage.                                                   |
| Agent plan cannot resolve (bad tier route, missing coordinator or verifier) | `incomplete` before any provider call.                                                                                                     |
| A specialist or the verifier fails                                          | `continue-partial` keeps successes but stays `incomplete`; `fail-fast` aborts on the first failure. See [Configuration](configuration.md). |
| Deadline reached (default 15 minutes)                                       | `incomplete` with the cause named.                                                                                                         |

## Local reviews

The local CLI reviews a Git range with the same engine:

```sh
# No provider, no GitHub: exercises the full local path
./sakre-linux-x64 local --mock --base main

# GitHub pull-request context; GITHUB_TOKEN is only for GitHub reads
GITHUB_TOKEN=... ./sakre-linux-x64 local --context github --pr 123

# Publish the result to that pull request
GITHUB_TOKEN=... ./sakre-linux-x64 local --output github-pr --pr 123
```

`--context git` synthesizes context from commits only and never contacts GitHub. `--context auto` uses the pull request when it finds one and falls back to Git otherwise. Full flag reference: [CLI](cli.md).
