# Upstream provenance — vendored anti-slop Oxlint plugin

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (upstream `main` HEAD on 2026-09-27)
- Installed via: `install-anti-slop` skill (`bunx skills add dmmulroy/anti-slop`), `node scripts/install.mjs`
- Installed paths: `tools/oxlint/anti-slop/index.ts` (generic entry), `tools/oxlint/anti-slop/effect/index.ts` (NOT registered, see below)
- Verification: `diff -rq <upstream>/src tools/oxlint/anti-slop` shows zero differences outside `*.test.ts` RuleTester suites (stripped from the bundle by the installer)
- Intentional deviations:
    - Effect plugin (`anti-slop-effect/*`) vendored but NOT enabled: SAKRe is not an Effect-native application (boundary/compat layer only). Revisit only if the architecture changes.
    - All 18 generic `anti-slop/*` rules + native `oxc/no-accumulating-spread` enabled as `error` in `.oxlintrc.json`.
- Update procedure: `bunx skills add dmmulroy/anti-slop --skill install-anti-slop`, stage incoming source separately, three-way merge preserving local rules/config, record new SHA here.
