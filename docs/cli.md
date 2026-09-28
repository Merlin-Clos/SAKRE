# CLI

The same binary serves the Action and your terminal. With no arguments it behaves as the Action entrypoint. Two subcommands exist: `local` and `auth`.

> [!NOTE]
> Most `local` flags mirror [configuration](configuration.md) fields: `--provider` overrides `provider`, `--model` overrides `model`. Put stable values in the config file and keep flags for per-run overrides. An explicit flag always wins over the file.

## `local`

Review a local Git range with the same engine as the Action:

```sh
sakre local --base main
```

| Flag                           | Meaning                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <path>`                | Repository to review. Defaults to the current directory.                                                                                                                                                |
| `--base <ref>`, `--head <ref>` | Range to review. Defaults resolve from Git.                                                                                                                                                             |
| `--context auto\|git\|github`  | Where pull-request context comes from. Default `auto`: use the pull request when found, else synthesize from Git. `git` never contacts GitHub. `github` requires a remote, a token, and a pull request. |
| `--auth auto\|env\|opencode`   | Where the provider key comes from. Default `auto`.                                                                                                                                                      |
| `--provider <id>`              | `anthropic` or `openai-compatible`.                                                                                                                                                                     |
| `--credential <id>`            | Stored credential id. Requires `--auth auto`.                                                                                                                                                           |
| `--model <id>`                 | Global fallback model.                                                                                                                                                                                  |
| `--config <path>`              | Config file. A missing or unreadable file fails closed.                                                                                                                                                 |
| `--instructions <path>`        | Guidance file. Same contract as [review guidance](usage.md#review-guidance): untrusted, max 8,000 characters, and over-cap fails here instead of warning.                                               |
| `--output terminal\|github-pr` | Print the report or publish it to a pull request. Default `terminal`.                                                                                                                                   |
| `--output-file <path>`         | Also write the Markdown report to a file.                                                                                                                                                               |
| `--pr <number>`                | Pull request number when auto-detection fails. Must be a positive integer.                                                                                                                              |
| `--mock`                       | Run without calling an AI provider.                                                                                                                                                                     |
| `--force-over-budget`          | Allow partial coverage above the diff budget.                                                                                                                                                           |

GitHub contact uses `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. `--context git --output terminal` needs no remote, token, or pull request.

## `auth`

```sh
sakre auth login anthropic --key <key>  # store a provider key
sakre auth login anthropic              # interactive OAuth when supported
sakre auth list [provider]              # list stored credentials, never secrets
sakre auth remove <credential>          # remove by id shown in list
```

`--key` and `--method` cannot combine. Key lookup order is environment, then the SAKRE store, then the OpenCode store. Mock mode needs no credential.
