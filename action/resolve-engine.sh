#!/usr/bin/env bash
# SAKRE composite Action delivery.
#
# Resolves the standalone engine executable for the running runner, retrieves
# the pinned release asset when it is not already in the runner temp cache,
# decompresses the gzip asset, verifies the engine SHA-256 against the pin
# committed in engine-pins.json in this Action tree, and executes it with the
# caller's environment. The engine reads the Action inputs from INPUT_*
# variables that action.yml maps from the declared inputs.
#
# Engine download credentials are separate from the target-repository token:
# INPUT_ENGINE_TOKEN (the engine_token input) wins over the
# SAKRE_ENGINE_TOKEN environment fallback. The credential is removed from
# the engine process environment before the engine starts.
#
# SAKRE_ENGINE_BINARY bypasses resolution for self-hosted runners that
# preinstall the engine; the pin is not consulted for that override.
#
# Every phase is timed and appended to $GITHUB_STEP_SUMMARY, and printed as a
# machine-readable line on stderr for the delivery benchmark.

set -u

phase_resolve_ms=0
phase_download_ms=0
phase_verify_ms=0
phase_install_ms=0
phase_bootstrap_ms=0
phase_execute_ms=0
phase_total_ms=0
source_kind='download'
asset=''
tag=''
engine_path=''
engine_status=0
cache_directory=''
AUTH_TOKEN=''
HASH_TOOL=''

now_ms() {
    local value
    if value=$(date +%s%3N 2>/dev/null) && [ -n "$value" ] && [ -z "${value//[0-9]/}" ]; then
        printf '%s\n' "$value"
        return 0
    fi
    if command -v perl >/dev/null 2>&1; then
        perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'
        return 0
    fi
    printf '%s000\n' "$(date +%s)"
}

write_summary() {
    printf 'sakre-engine: source=%s tag=%s asset=%s resolve_ms=%s download_ms=%s verify_ms=%s install_ms=%s bootstrap_ms=%s execute_ms=%s total_ms=%s status=%s\n' \
        "$source_kind" "${tag:-}" "${asset:-}" \
        "$phase_resolve_ms" "$phase_download_ms" "$phase_verify_ms" "$phase_install_ms" \
        "$phase_bootstrap_ms" "$phase_execute_ms" "$phase_total_ms" "$engine_status" >&2
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
    {
        printf '### SAKRE engine delivery\n\n'
        printf '| Phase | Time (ms) |\n'
        printf '| --- | ---: |\n'
        printf '| resolve (target, pin, cache path) | %s |\n' "$phase_resolve_ms"
        printf '| download (0 on cache hit or override) | %s |\n' "$phase_download_ms"
        printf '| verify (SHA-256 against the pin) | %s |\n' "$phase_verify_ms"
        printf '| install (chmod + atomic rename) | %s |\n' "$phase_install_ms"
        printf '| bootstrap before spawn, excluding download | %s |\n' "$phase_bootstrap_ms"
        printf '| execute | %s |\n' "$phase_execute_ms"
        printf '| total | %s |\n\n' "$phase_total_ms"
        printf 'source: `%s`, pin: `%s`, asset: `%s`\n' "$source_kind" "${tag:-none}" "${asset:-none}"
    } >> "$GITHUB_STEP_SUMMARY"
}

fail() {
    engine_status=1
    write_summary
    printf '::error::%s\n' "$1" >&2
    exit 1
}

# Hash through stdin: when the path contains backslashes, as Windows runner
# temp paths do, coreutils escapes the filename and prefixes the whole line with
# a backslash, which `cut -d' ' -f1` would turn into a leading `\` in the
# digest. Hashing stdin reports a stable `-` filename instead.
hash_file() {
    if [ "$HASH_TOOL" = 'sha256sum' ]; then
        sha256sum < "$1" | cut -d' ' -f1
    else
        shasum -a 256 < "$1" | cut -d' ' -f1
    fi
}

# The public browser download URL is tried first: it needs no credentials on a
# public release. A private action repository returns 404 there even with a
# token, so the authenticated fallback resolves the asset id through the
# release API and downloads through the asset API with
# `Accept: application/octet-stream`. The token is read only from
# INPUT_ENGINE_TOKEN or SAKRE_ENGINE_TOKEN and is never written to disk.
anonymous_download() {
    curl --fail --silent --show-error --location --retry 3 --output "$2" "$1"
}

authenticated_download() {
    local destination="$1"
    local api="https://api.github.com/repos/$GITHUB_ACTION_REPOSITORY"
    local release_json
    # `--config -` keeps the token out of the process argument list for both
    # the metadata call and the asset download.
    release_json=$(printf 'header = "Authorization: Bearer %s"\n' "$AUTH_TOKEN" \
        | curl --config - --fail --silent --show-error --location --retry 3 \
            --header 'Accept: application/vnd.github+json' \
            "$api/releases/tags/$tag") || return 1
    local asset_id
    asset_id=$(printf '%s\n' "$release_json" | awk -v asset="$asset" '
        /"id":/ { id=$0; sub(/^.*"id": */, "", id); sub(/,.*$/, "", id) }
        /"name":/ {
            name=$0; sub(/^.*"name": *"/, "", name); sub(/".*$/, "", name)
            if (name == asset) { print id; exit }
        }')
    if [ -z "$asset_id" ]; then
        return 1
    fi
    printf 'header = "Authorization: Bearer %s"\n' "$AUTH_TOKEN" \
        | curl --config - --fail --silent --show-error --location --retry 3 \
            --header 'Accept: application/octet-stream' \
            --output "$destination" \
            "$api/releases/assets/$asset_id"
}

fetch() {
    if anonymous_download "$1" "$2" 2>/dev/null; then
        return 0
    fi
    if [ -z "$AUTH_TOKEN" ]; then
        # Retry without suppressing the error so the log names the failure.
        anonymous_download "$1" "$2"
        return $?
    fi
    authenticated_download "$2"
}

download_engine() {
    source_kind='download'
    if [ -z "${GITHUB_ACTION_REPOSITORY:-}" ]; then
        fail 'GITHUB_ACTION_REPOSITORY is not set; set SAKRE_ENGINE_BINARY to run a preinstalled engine.'
    fi
    if ! command -v curl >/dev/null 2>&1; then
        fail 'curl is required to download the pinned engine binary; set SAKRE_ENGINE_BINARY to run a preinstalled engine.'
    fi
    mkdir -p "$cache_directory"
    local started
    local temporary="$cache_directory/.$asset.$$.tmp"
    local decompressed="$cache_directory/.$binary.$$.tmp"
    rm -f "$temporary" "$decompressed"
    local url="https://github.com/$GITHUB_ACTION_REPOSITORY/releases/download/$tag/$asset"
    started=$(now_ms)
    if ! fetch "$url" "$temporary"; then
        rm -f "$temporary" "$decompressed"
        fail "Failed to download $url. If the action repository is private, set the \"engine_token\" Action input or the SAKRE_ENGINE_TOKEN environment variable with Contents: Read on $GITHUB_ACTION_REPOSITORY, or set SAKRE_ENGINE_BINARY to run a preinstalled engine."
    fi
    phase_download_ms=$(( $(now_ms) - started ))
    started=$(now_ms)
    if ! gzip -dc "$temporary" > "$decompressed" 2>/dev/null; then
        rm -f "$temporary" "$decompressed"
        fail "The downloaded $asset is not a valid gzip archive; refusing to execute it."
    fi
    local actual_digest
    actual_digest=$(hash_file "$decompressed")
    phase_verify_ms=$(( $(now_ms) - started ))
    if [ "$actual_digest" != "$digest" ]; then
        rm -f "$temporary" "$decompressed"
        fail "The downloaded $asset does not match the pinned SHA-256 for $tag (expected $digest, got ${actual_digest:-none})."
    fi
    started=$(now_ms)
    chmod +x "$decompressed"
    mv -f "$decompressed" "$engine_path"
    rm -f "$temporary"
    phase_install_ms=$(( $(now_ms) - started ))
}

start_ms=$(now_ms)

# An explicit preinstalled binary wins over release resolution and does not
# consult the pin, exactly like the self-hosted override this replaces.
override="${SAKRE_ENGINE_BINARY:-}"
if [ -n "$override" ]; then
    source_kind='override'
    engine_path="$override"
    if [ ! -f "$engine_path" ]; then
        fail "SAKRE_ENGINE_BINARY does not point to a file: $engine_path"
    fi
    phase_resolve_ms=$(( $(now_ms) - start_ms ))
else
    case "${RUNNER_OS:-}/${RUNNER_ARCH:-}" in
        Linux/X64) binary='sakre-linux-x64' ;;
        Linux/ARM64) binary='sakre-linux-arm64' ;;
        macOS/X64) binary='sakre-darwin-x64' ;;
        macOS/ARM64) binary='sakre-darwin-arm64' ;;
        Windows/X64) binary='sakre-windows-x64.exe' ;;
        *)
            fail "SAKRE does not publish an engine for ${RUNNER_OS:-unknown}/${RUNNER_ARCH:-unknown}; supported targets are Linux/X64, Linux/ARM64, macOS/X64, macOS/ARM64 and Windows/X64."
            ;;
    esac
    asset="$binary.gz"

    if command -v sha256sum >/dev/null 2>&1; then
        HASH_TOOL='sha256sum'
    elif command -v shasum >/dev/null 2>&1; then
        HASH_TOOL='shasum'
    else
        fail 'Neither sha256sum nor shasum is available to verify the pinned engine binary.'
    fi
    if ! command -v gzip >/dev/null 2>&1; then
        fail 'gzip is required to decompress the pinned engine asset; set SAKRE_ENGINE_BINARY to run a preinstalled engine.'
    fi

    pin_file="${GITHUB_ACTION_PATH:-}/engine-pins.json"
    if [ -z "${GITHUB_ACTION_PATH:-}" ] || [ ! -f "$pin_file" ]; then
        fail "engine-pins.json was not found in the Action tree (GITHUB_ACTION_PATH=${GITHUB_ACTION_PATH:-unset})."
    fi
    asset_pattern=$(printf '%s' "$asset" | sed 's/[.]/\\./g')
    pinned_tag=$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pin_file" | head -n 1)
    digest=$(sed -n "s/.*\"$asset_pattern\"[[:space:]]*:[[:space:]]*\"\([0-9a-fA-F]\{64\}\)\".*/\1/p" "$pin_file" | head -n 1)

    requested_tag=''
    if [ -n "${GITHUB_ACTION_REF:-}" ] && printf '%s' "$GITHUB_ACTION_REF" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
        requested_tag="$GITHUB_ACTION_REF"
    fi
    if [ -z "$pinned_tag" ]; then
        if [ -n "$requested_tag" ]; then
            fail "engine-pins.json in this Action tree does not pin $requested_tag; use the @v1 major tag or a release commit that contains its own pin."
        fi
        fail 'engine-pins.json in this Action tree does not pin an engine release yet. Publish a release, or set SAKRE_ENGINE_BINARY to run a preinstalled engine.'
    fi
    if [ -n "$requested_tag" ] && [ "$requested_tag" != "$pinned_tag" ]; then
        fail "engine-pins.json pins $pinned_tag, but this Action ref is $requested_tag; use the matching release tag or @v1."
    fi
    tag="$pinned_tag"
    if [ -z "$digest" ]; then
        fail "engine-pins.json has no SHA-256 pin for $asset in $tag."
    fi
    digest=$(printf '%s' "$digest" | tr 'A-F' 'a-f')
    # The engine_token input wins; the documented environment fallback covers
    # workflows that set SAKRE_ENGINE_TOKEN explicitly. The
    # target-repository token is never used for the engine download.
    AUTH_TOKEN="${INPUT_ENGINE_TOKEN:-${SAKRE_ENGINE_TOKEN:-}}"

    phase_resolve_ms=$(( $(now_ms) - start_ms ))

    started=$(now_ms)
    cache_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
    cache_directory="$cache_root/sakre-engine/$tag"
    engine_path="$cache_directory/$binary"
    if [ -f "$engine_path" ]; then
        actual_digest=$(hash_file "$engine_path")
        phase_verify_ms=$(( $(now_ms) - started ))
        if [ "$actual_digest" = "$digest" ]; then
            source_kind='cache'
            started=$(now_ms)
            chmod +x "$engine_path"
            phase_install_ms=$(( $(now_ms) - started ))
        else
            rm -f "$engine_path"
            download_engine
        fi
    else
        download_engine
    fi
fi

phase_bootstrap_ms=$(( $(now_ms) - start_ms - phase_download_ms ))
# The engine has no use for the engine-download credential.
unset INPUT_ENGINE_TOKEN SAKRE_ENGINE_TOKEN
started=$(now_ms)
"$engine_path" "$@"
engine_status=$?
phase_execute_ms=$(( $(now_ms) - started ))
phase_total_ms=$(( $(now_ms) - start_ms ))
write_summary
exit "$engine_status"
