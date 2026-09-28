# GitHub Action

## Setup

Copy [`examples/workflow.yml`](../examples/workflow.yml) to `.github/workflows/sakre.yml`. The workflow reacts to `issue_comment` events on pull requests with `contents: read`, `issues: write`, and `pull-requests: read`. Set `uses: Merlin-Clos/SAKRE@v1` (or your fork, with your values); the full input list is short and [`action.yml`](../action.yml) is canonical:

| Input                         | Default                     | Meaning                                                                          |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `github_token`                | (required)                  | Reads the pull request, posts the comment.                                       |
| `provider`                    |                             | `anthropic` or `openai-compatible`.                                              |
| `provider_api_key`            |                             | Provider key. A review without one fails closed.                                 |
| `provider_base_url`           |                             | Required for custom endpoints. Must be a URL.                                    |
| `default_model`               |                             | Global fallback model.                                                           |
| `agent_name`                  | `sakre`                     | Public identity; commands derive as `@<agent_name>`. Must be mention-compatible. |
| `allowed_author_associations` | `OWNER,MEMBER,COLLABORATOR` | Who may trigger reviews.                                                         |
| `config_path`                 | `.github/sakre.yml`         | Relative path, resolved at the base commit.                                      |
| `mock_mode`                   | `false`                     | Exercise the path without calling a provider.                                    |
| `force_over_budget`           | `false`                     | Allow partial coverage above the diff budget.                                    |
| `engine_token`                |                             | Only for a private engine repository. Falls back to `SAKRE_ENGINE_TOKEN`.        |

## Upstream or fork

`uses:` points at the repository that provides the Action, and that repository also provides the engine: the binary downloads from its releases, and the pin comes from its `engine-pins.json`.

- Point at upstream (`Merlin-Clos/SAKRE`) to run stock behavior. Per-repository customization still lives in the reviewed repository: `.github/sakre.yml` and prompt override files.
- Fork to change the engine itself: stock prompts, pins, or Action code. You then publish your own releases from the fork.
- Either way, prompt overrides resolve in the reviewed repository, as described in [Configuration](configuration.md).

## How a run works

A comment matching `@sakre` starts the review on the pull request head. SAKRE reads configuration from the protected base commit, runs the pipeline from [Architecture](architecture.md), and posts one comment with findings and verdict. It never approves, requests changes, or merges.

## Private engine

The Action downloads its pinned engine from the public release by default. If the engine repository is private, give the Action a token with Contents read on that repository via `engine_token` or the `SAKRE_ENGINE_TOKEN` environment variable. This token never touches the reviewed repository.

## Isolation

Agents run with deny-by-default permissions: read-only workspace access plus result submission. Network fetch runs only when you enable `tools.web` or `tools.context7` in configuration. Untrusted comment text is prompt content, never an instruction: it cannot change the provider, model, plan, budget, or verdict. See [Architecture](architecture.md) for the full model.
