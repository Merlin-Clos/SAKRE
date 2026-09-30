# SAKRE

SAKRE is a configurable AI code review GitHub Action or CLI. A pull request comment starts a risk-based review: specialist agents run in parallel, a coordinator adjudicates their findings, and an independent verifier checks findings that can affect the result.

> SAKRE stands for "Scalable AI Kode Review Engine". The K is a nod to [KlodOnline](https://www.klod-online.com/), the project SAKRE originally grew out of. SAKRE is pronounced like the French word "sacre" ("sakr"), not "sakree".

## How it differs

SAKRE never hands a bare diff to a model. It first measures the change with deterministic tools, scores its risk, and builds a [map of the repository and the change](docs/architecture.md). Agents then review with that map: the right specialists for the risk tier, signals on hotspots, and per-agent models you choose. Verification tries to refute findings before they reach you.

## First step

Comment `@sakre` on a pull request, or run a mock review locally with no credentials:

```sh
./sakre-linux-x64 local --mock --base main
```

[Installation](docs/installation.md) covers the Action setup and the local CLI. See an [example review](docs/example.md).

## Documentation

- [Installation](docs/installation.md): set up the Action or the CLI, reach a first review.
- [Usage](docs/usage.md): commands, guidance, verdicts, early stops.
- [Configuration](docs/configuration.md): models, agents, risk tiers, exclusions.
- [GitHub Action](docs/github-action.md): inputs, private engine, isolation.
- [CLI](docs/cli.md): flags, contexts, credentials.
- [Architecture](docs/architecture.md): lifecycle, repository map, verification, runtime.

## Inspiration

- [Cloudflare: Orchestrating AI Code Review at scale](https://blog.cloudflare.com/ai-code-review/): specialists over one big prompt, a coordinator that judges, risk tiers that fit cost to risk, and prompts that say what not to flag.
- [Alex Op: I Rebuilt Cloudflare's AI Code Review in a 250-Line Workflow](https://alexop.dev/posts/ultracode-review-workflow-cloudflare/#phase-2--verify-where-i-disagreed-with-cloudflare): a dedicated verification phase, one finding at a time, refute-by-default, and the warning that a check which drops nothing verifies nothing.
- [Bun: Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust#adversarial-review): adversarial review in split contexts, where the reviewer never implements and the implementer never reviews.

SAKRE adds its own layer to these ideas: deterministic pre-analysis with a repository map that guides agents before any model runs.

## Tools

SAKRE runs its agents through [OpenCode](https://opencode.ai), measures code with [SCC](https://github.com/boyter/scc) and [CCCC](https://github.com/moznion/cccc), and ships as a [Bun](https://bun.sh)-compiled binary per platform.

## License

MIT. See [LICENSE](LICENSE).
