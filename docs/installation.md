# Installation

You can run SAKRE two ways: as a GitHub Action that reviews pull requests, or as a local command that reviews a Git range. Both use the same engine.

## GitHub Action

Copy [`examples/workflow.yml`](../examples/workflow.yml) to `.github/workflows/sakre.yml` in your repository. It already points at `Merlin-Clos/SAKRE@v1`; point it at your fork instead only if you publish your own engine and prompts. Set these repository values:

- `AI_REVIEW_PROVIDER`: `anthropic` or `openai-compatible`
- `AI_PROVIDER_API_KEY` (secret): your provider key
- `AI_REVIEW_MODEL`: for example `claude-sonnet-4-5`
- `AI_PROVIDER_BASE_URL` (optional): only for `openai-compatible`

The workflow needs `contents: read`, `issues: write`, and `pull-requests: read`. Then comment `@sakre` on any pull request.

> [!NOTE]
> The Action downloads its pinned engine automatically, so runners need no Node, Bun, or extra tools.

If the engine lives in a private repository, also set `SAKRE_ENGINE_TOKEN` (secret). See [GitHub Action](github-action.md).

## Local CLI

Download `sakre-<platform>.gz` from a GitHub release, for example `sakre-linux-x64.gz` on Linux. Uncompress it and run your first review in mock mode, which needs no provider key and no GitHub access:

```sh
gunzip sakre-linux-x64.gz
chmod +x sakre-linux-x64
./sakre-linux-x64 local --mock --base main
```

For a live review, give the CLI a provider key. Either export `SAKRE_PROVIDER_API_KEY` or store the key once:

```sh
./sakre-linux-x64 auth login anthropic --key <key>
```

Then run `./sakre-linux-x64 local --base main`. Supported platforms are Linux x64 and ARM64, macOS x64 and ARM64, and Windows x64. Linux x64 is the primary v1 platform.

## Next step

Post `@sakre` on a pull request, or run a local review. [Usage](usage.md) shows the four commands and what each review returns.
