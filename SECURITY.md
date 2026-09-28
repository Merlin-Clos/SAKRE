# Security Policy

## Supported Versions

Security fixes are provided for the latest published major release.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a public issue with exploit details, credentials, private source code, provider responses, or runner logs.

Include the affected release or commit, runner platform, minimal reproduction, security impact, and any suggested mitigation. Remove secrets and private repository content before attaching logs.

Maintainers will acknowledge a report through GitHub, assess its severity, and coordinate disclosure and a fix when confirmed. No response-time guarantee is made.

## Scope

Reports about Action permission bypasses, command authorization, secret exposure, prompt-boundary failures, embedded engine isolation, native asset integrity, unsafe tool access, and release artifact tampering are in scope.

Provider availability, model quality, provider billing, third-party retention policies, and vulnerabilities in unsupported runner platforms should be reported to the relevant provider unless SAKRE introduces the issue.

## Verification Limits

The Linux artifact test proves a complete review runs with no external network by executing it inside `unshare -rn` with only loopback available. macOS and Windows artifact tests use a loopback fake provider but cannot be network-isolated, so their no-download claim is enforced by construction (no download path is exercised) rather than by namespace isolation.

## Deterministic Pre-Pass Inputs

The ReviewMap pre-pass reads the repository through the VCS layer only: canonical file lists come from `git ls-tree`, symlinks and gitlinks are excluded and never followed, and only the first bytes of changed files are read for generated markers. It does not walk HEAD-controlled directories for discovery.

SCC runs with `--no-config --no-gitignore --no-ignore --no-scc-ignore --no-gitmodule` and a cleared `SCC_CONFIG_PATH`, so a committed `.sccconfig`, `.sccignore`, `.gitignore`, or `.ignore` cannot change the measurement. CCCC runs with `--no-config --no-ignore --no-cache`, so a hostile `cccc.toml`/`.cccc.toml` cannot drop an explicitly named file and no tool cache state is trusted or written in the reviewed workspace. Both tools are pinned by archive and binary SHA-256 and materialized from the embedded artifact; the pre-pass never downloads at run time.
