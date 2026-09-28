# AGENTS.md

## Commands

- `bun run format`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test`.
- Focused: `bun test <path>` (e.g. `bun test tests/config/examples.test.ts`); coverage: `bun test --coverage`.
- Full suite takes ~80s on an Intel N95 2 vCPU, anything modern runs it way faster.
- Build: `bun scripts/build-release.ts --target linux-x64` (`dist-release/` is gitignored).

## Product identity

- `src/identity.ts` owns name, slug, markers, env prefix, trigger, and paths. Derive from it; never add product literals elsewhere (enforced by `tests/identity.test.ts`).
- `examples/workflow*.yml` point at the real upstream ref (`Merlin-Clos/SAKRE@v1`), tracked by Renovate. No placeholders.

## Config contracts (test-enforced, keep them green)

- `src/config/schema.ts` is the source; `sakre.schema.json` must mirror it exactly.
- `defaults/review.yml` agent plan must match `DEFAULT_AGENT_PLAN`.
- `risk.escalations` present replaces the whole escalation list; config loads at the base SHA, never head.
- `tests/config/examples.test.ts` asserts the README origin sentence verbatim and scans public files for leaked secrets/owners (KlodOnline allowlisted only in that sentence).

## Lint policy

Oxlint runs in full non-nursery mode: `.oxlintrc.json` enables every built-in category except `nursery`, plus type-aware analysis and the vendored `anti-slop` plugin (`tools/oxlint/anti-slop/`, see `UPSTREAM.md`). CI runs `bun run lint`, which is `oxlint --deny-warnings --report-unused-disable-directives`.

Never disable a lint rule just to make CI pass. Fix the code first.

If a violation is intentionally correct, suppress only the smallest possible scope (`eslint-disable-next-line` with a short reason). A rule may be disabled globally, or for a file pattern, only when it is structurally inapplicable to this project; the reason must be documented in `.oxlintrc.json` next to the entry. Blanket disables are forbidden.

Never change intentional sequential, fail-closed, protocol-sensitive, or resource-bounded behavior only to satisfy a generic lint preference. Prefer a justified local suppression over a false refactor, and a simple real fix over a suppression.

`--fix` is allowed only for whitespace-only rules (`require-readable-spacing`), always followed by `bun run format` and a re-lint that must be stable. `--fix-suggestions` and `--fix-dangerously` are forbidden.
