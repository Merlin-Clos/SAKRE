# Configuration

SAKRE reads [`.github/sakre.yml`](../.github/sakre.yml) from the protected base commit, never from the pull request head, so a pull request cannot weaken its own review.

> [!IMPORTANT]
> Every section below is optional. Omit what you do not need. A complete annotated sample lives in [`examples/sakre.yml`](../examples/sakre.yml).

Defaults for anything you omit live in [`defaults/review.yml`](../defaults/review.yml). Field types and bounds are enforced by [`sakre.schema.json`](../sakre.schema.json), which your editor can use for autocomplete.

The smallest useful file sets a provider and a model:

```yaml
provider: anthropic
model: claude-sonnet-4-5
```

## Models

`model` is the global fallback. `models.routing` assigns a model per agent and per risk tier. Each cell falls back to the agent default, then to `model`. A route that resolves to nothing fails the review before any provider call.

```yaml
model: claude-sonnet-4-5
models:
    routing:
        security:
            hard: claude-opus-4-6
        coordinator:
            default: claude-opus-4-6
```

Append `#variant` to select a named OpenCode variant overlay, for example `claude-sonnet-4-5#xhigh`. `#default` selects no overlay. OpenCode owns the model catalogue and rejects an unknown id at load time. If you declare `models.catalog`, its keys must be the base ids your routing and `model` reference. A catalog entry can attach an Artificial Analysis URL, rendered as a link on the model in the result:

```yaml
models:
    catalog:
        kimi-k2.6:
            artificialAnalysisUrl: https://artificialanalysis.ai/models/kimi-k2-6
```

## Prompt overrides

Point any agent (including `shared` and `coordinator`) at a relative Markdown file to replace its prompt. The stock prompts live in [`defaults/prompts/`](../defaults/prompts/).

```yaml
prompts:
    overrides:
        security: ./prompts/my-security.md
```

> [!TIP]
> Start from a copy of the stock file for that agent. You keep the output contract and change only the expertise.

### One shared set or per-repository prompts

Two choices are independent: which repository provides the Action (`uses:` in the workflow: upstream or your fork), and which files provide the prompts (stock embedded prompts, or your override files).

Overrides always resolve to files in the reviewed repository at the base commit. SAKRE has no built-in shared prompt library: to run the same prompts on every repository of your organization, distribute the same files to each one with a mechanism you own (copy, submodule, or automation). Identical files mean comparable findings, so you can tell whether a prompt change really improved results. An override replaces only the business objective; guardrails stay in code. A missing or blank override file falls back to the stock prompt.

## Agents

Each risk tier runs a plan, a list of agent ids. Defaults: `lite` runs correctness, tests, coordinator, verifier; `standard` adds conventions and maintainability; `hard` adds security and performance. You can replace a plan, disable agents, or add your own roles bound to file globs:

```yaml
agents:
    disabled: [maintainability]
    roles:
        - name: database-contracts
          objective: Check that migrations keep backward compatibility.
          globs: ['db/**', '**/migrations/**']
    plan:
        lite: [correctness, tests, coordinator, verifier]
        standard: [correctness, conventions, tests, coordinator, verifier]
        hard: [correctness, security, database-contracts, coordinator, verifier]
```

Role names use lowercase letters, digits, and dashes. Role globs must be safe: universal patterns such as `**` are rejected at load time. Built-in ids are `correctness`, `security`, `performance`, `conventions`, `maintainability`, `tests`, `coordinator`, and `verifier`.

## Risk tiers

SAKRE scores every diff as `score = files * changedFiles + lines * changedLines`, maps the score to `lite`, `standard`, or `hard`, then raises the tier when sensitive paths or large ratios match. Escalations only raise. Current defaults:

| Setting                       | Default |
| ----------------------------- | ------- |
| `thresholds.liteMaxScore`     | 12      |
| `thresholds.standardMaxScore` | 35      |
| `weights.changedFiles`        | 0.18    |
| `weights.changedLines`        | 0.008   |
| `ratios.fileRatio`            | 0.2     |
| `ratios.lineRatio`            | 0.1     |
| `largeChangeLines`            | 250     |

These are starting defaults, not calibrated optima. Override any field:

```yaml
risk:
    thresholds: { liteMaxScore: 5, standardMaxScore: 10 }
    weights: { changedFiles: 1, changedLines: 0.1 }
```

`risk.escalations` replaces the whole escalation list. Each entry names an id, safe (non-universal) patterns, a `minTier` of `standard` or `hard`, and an optional specialist to add:

```yaml
risk:
    escalations:
        - id: db-migrations
          patterns: ['db/**']
          minTier: hard
          addSpecialist: security
```

> [!WARNING]
> If you define `escalations`, restate every rule you want to keep. The default list (critical paths, workflows, dependency manifests, migrations, security, performance, conventions) no longer applies.

The default list escalates critical paths, workflows, and dependency manifests to `standard`, migrations to `hard`, and adds the security, performance, or conventions specialist on matching paths. Invalid tuning (inverted thresholds, zero ratios, duplicate ids, universal globs) fails at load time.

## File classification

SAKRE classifies every path before measuring: lockfiles, vendor, generated code, docs, tests, configs, dependency manifests, and security, performance, or convention sensitive paths. Classification drives noise filtering, escalation patterns, and the signals agents receive. Override any list with safe globs:

```yaml
classification:
    generatedMarkers: ['@generated']
```

## Excluded files

`review.exclude` keeps matching files out of automatic agent context: no hunks, no budget use, no reads. Excluded files stay classified and counted, and the map shows only a global `N files (M lines)` summary for them. They never block completeness.

```yaml
review:
    exclude: ['docs/**', 'fixtures/**']
```

Matching is path-only and rename-safe: either endpoint of a rename matches.

## Review behavior

```yaml
review:
    failurePolicy: continue-partial
    deadlineMinutes: 15
    diffBudgetChars: 80000
```

`failurePolicy` is `fail-fast` (abort on the first required failure) or `continue-partial` (keep successes, stay `incomplete`). `deadlineMinutes` accepts 1 to 60. `diffBudgetChars` accepts 20,000 to 1,000,000; a diff above the budget aborts unless `--force-over-budget` allows partial coverage.

## External context tools

Both tools are off by default and need an explicit opt-in:

```yaml
tools:
    context7: { enabled: true, url: 'https://your-context7' }
    web: { enabled: true }
```

Context7 needs a URL and reads its key from `SAKRE_CONTEXT7_API_KEY`. Agents must report whether they used Context7.
