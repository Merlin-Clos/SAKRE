# Example Review

This is a shortened synthetic example. Real reviews include only the sections and findings produced for that change.

## 🛑 SAKRE: Changes requested (risk standard)

Reviewed commit: `9f2c4b1a3d5e6f708192a3b4c5d6e7f8091a2b3c4`

Risk tier: `standard`
Execution: GitHub Action
Engine: SAKRE 1.0.0
Base: `9f2c4b1`
Head: `e7f8091`
User guidance: none

**2 confirmed · 1 unverified · 2 rejected · 4/5 files fully covered (80.0%)**

**🔴 1 Blocker · 🟠 1 Important · 🟡 1 Minor**

<details>
<summary>Review completeness, coverage, and agent failures</summary>

### Review states

- **Confirmed**: independently checked by the verifier against the reviewed diff.
- **Unverified**: reported by a specialist but not independently confirmed. Minor findings are never sent to verification, and verifier failures leave findings visible as unverified.
- **Rejected**: independently checked and refuted. Rejected findings stay available as adjudication evidence but are excluded from active severity counts.
- **Files fully covered**: the complete canonical Git diff for those files fit inside the configured review budget. Agents may inspect repository files directly when needed, but full diff coverage is only guaranteed for files counted here.

</details>

### Analysis signals

| Metric               |         Change |           Δ |   Δ % |
| -------------------- | -------------: | ----------: | ----: |
| Repository files     |       41 -> 43 |      **+2** | +4.9% |
| Code LOC             | 3,980 -> 4,215 |    **+235** | +5.9% |
| DRYness              | 71.2% -> 70.8% | **-0.4 pp** |   n/a |
| McCabe complexity    |     312 -> 328 |     **+16** | +5.1% |
| Cognitive complexity |     402 -> 431 |     **+29** | +7.2% |

<details>
<summary>Models used (3)</summary>

| Agent       | Model             |
| ----------- | ----------------- |
| correctness | claude-sonnet-4-5 |
| security    | claude-sonnet-4-5 |
| coordinator | claude-opus-4-6   |

</details>

## Findings: 5

## Confirmed: 2

<details open>
<summary>🔴 Blocker (1)</summary>

##### F-001: Unsanitized workspace key reaches the database query

Location: `src/db.ts:61`
Reported by: security

Impact: A workspace key containing SQL metacharacters runs inside the query, so a crafted key can read or modify other workspaces.

Evidence: `findWorkspace` interpolates `key` directly into the statement at line 61. The caller at line 44 passes the raw request parameter with no validation in between.

Suggested fix: Bind the key as a query parameter instead of interpolating it.

</details>

<details open>
<summary>🟠 Important (1)</summary>

##### F-002: Stale cache served after entry update

Location: `src/cache.ts:42`
Reported by: correctness

Impact: Readers get the previous value for up to a minute after a write, so two consecutive reads can disagree.

Evidence: `updateEntry` writes the store but never touches the read-through cache filled at line 28. The existing test only reads once per key, so it cannot catch the staleness window.

Suggested fix: Invalidate the key in `updateEntry` before returning, or write through to the cache.

</details>

## Unverified: 1

<details open>
<summary>🟡 Minor (1)</summary>

##### F-003: Duplicated config helper in two modules

Location: `src/config.ts:17`
Reported by: maintainability

Impact: Two copies of the same default-merging logic to keep in sync; a fix in one will not reach the other.

Evidence: `mergeDefaults` here matches `applyDefaults` in `src/options.ts` line 9 token for token except the parameter name.

Suggested fix: Keep one copy and import it in the other module.

</details>

<details>
<summary>Rejected findings: 2 · 🟠 Important 1 · 🟡 Minor 1</summary>

<details>
<summary>🟠 Important (1)</summary>

##### R-001: Missing authorization check on workspace reset

Severity: Important
Location: `src/admin.ts:33`
Reported by: security

Claimed impact: Any signed-in user could reset any workspace.

Evidence considered: The handler at line 33 performs no role check inline.

Suggested fix if re-opened: None.

Why it was rejected: The `requireAdmin` middleware at `src/middleware.ts:12` runs before the handler on this route and rejects non-admin callers, so the check exists one layer up.

</details>

<details>
<summary>🟡 Minor (1)</summary>

##### R-002: Suspected race between enqueue and drain

Severity: Minor
Location: `src/queue.ts:88`
Reported by: performance

Claimed impact: Concurrent calls could interleave and drop an item.

Evidence considered: Both paths hold the queue lock from line 81 before touching the buffer.

Suggested fix if re-opened: None.

Why it was rejected: The lock at line 81 already serializes both paths, so the interleaving cannot happen.

</details>

</details>

<details>
<summary>Review intelligence · deterministic SCC + CCCC</summary>

[SCC](https://github.com/boyter/scc) measures repository size, languages, ULOC, DRYness, and a file-level complexity estimate.

[CCCC](https://github.com/moznion/cccc) measures function-level McCabe and cognitive complexity.

These deterministic signals help rank attention. They do not decide findings or review scope.

TypeScript: 4,215 code lines across 43 files.

</details>

### Risk escalation reasons

Volume tier `lite` -> final tier `standard`.

- workflows -> standard (matched .github/workflows/ci.yml)

<details>
<summary>Review diagnostics</summary>

Tier: standard (volume tier lite, score 1.444).
Changed files: 5, changed lines: 68.
Noise files excluded from source metrics: 1.
File ratio: 0.05, line ratio: 0.12.
Score thresholds: lite <= 12, standard <= 35.
Score weights: files=0.18, lines=0.008.
Ratio thresholds: files=0.2, lines=0.1.
Performance specialist threshold: 250 changed lines.
Coverage: 4/5 reviewable files fully covered.

</details>
