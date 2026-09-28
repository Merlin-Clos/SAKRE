#!/usr/bin/env pwsh
# SAKRE composite Action delivery (Windows).
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
# Every phase is timed and appended to $env:GITHUB_STEP_SUMMARY, and printed as
# a machine-readable line on stderr for the delivery benchmark.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:phaseResolveMs = 0
$script:phaseDownloadMs = 0
$script:phaseVerifyMs = 0
$script:phaseInstallMs = 0
$script:phaseBootstrapMs = 0
$script:phaseExecuteMs = 0
$script:phaseTotalMs = 0
$script:sourceKind = 'download'
$script:binary = ''
$script:asset = ''
$script:tag = ''
$script:enginePath = ''
$script:engineStatus = 0
$script:cacheDirectory = ''
$script:digest = ''
$script:authToken = ''
$script:stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Get-NowMs {
    return $script:stopwatch.ElapsedMilliseconds
}

function Write-EngineSummary {
    $line = 'sakre-engine: source={0} tag={1} asset={2} resolve_ms={3} download_ms={4} verify_ms={5} install_ms={6} bootstrap_ms={7} execute_ms={8} total_ms={9} status={10}' -f @(
        $script:sourceKind,
        $script:tag,
        $script:asset,
        $script:phaseResolveMs,
        $script:phaseDownloadMs,
        $script:phaseVerifyMs,
        $script:phaseInstallMs,
        $script:phaseBootstrapMs,
        $script:phaseExecuteMs,
        $script:phaseTotalMs,
        $script:engineStatus
    )
    [Console]::Error.WriteLine($line)
    if ([string]::IsNullOrEmpty($env:GITHUB_STEP_SUMMARY)) {
        return
    }
    $summary = @(
        '### SAKRE engine delivery',
        '',
        '| Phase | Time (ms) |',
        '| --- | ---: |',
        "| resolve (target, pin, cache path) | $($script:phaseResolveMs) |",
        "| download (0 on cache hit or override) | $($script:phaseDownloadMs) |",
        "| verify (SHA-256 against the pin) | $($script:phaseVerifyMs) |",
        "| install | $($script:phaseInstallMs) |",
        "| bootstrap before spawn, excluding download | $($script:phaseBootstrapMs) |",
        "| execute | $($script:phaseExecuteMs) |",
        "| total | $($script:phaseTotalMs) |",
        '',
        "source: ``$($script:sourceKind)``, pin: ``$($script:tag)``, asset: ``$($script:asset)``"
    )
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary
}

function Stop-Script([string]$Message) {
    $script:engineStatus = 1
    Write-EngineSummary
    [Console]::Error.WriteLine("::error::$Message")
    exit 1
}

# The public browser download URL is tried first. A private action repository
# returns 404 there even with a token, so the authenticated fallback resolves
# the asset id through the release API and downloads through the asset API.
function Invoke-AuthenticatedDownload([string]$Destination) {
    $api = "https://api.github.com/repos/$($env:GITHUB_ACTION_REPOSITORY)"
    $releaseHeaders = @{ Authorization = "Bearer $($script:authToken)"; Accept = 'application/vnd.github+json' }
    try {
        $release = Invoke-RestMethod -Uri "$api/releases/tags/$($script:tag)" -Headers $releaseHeaders
    } catch {
        return $false
    }
    $match = $release.assets | Where-Object { $_.name -eq $script:asset } | Select-Object -First 1
    if ($null -eq $match) {
        return $false
    }
    $downloadHeaders = @{ Authorization = "Bearer $($script:authToken)"; Accept = 'application/octet-stream' }
    try {
        Invoke-WebRequest -Uri "$api/releases/assets/$($match.id)" -Headers $downloadHeaders -OutFile $Destination
        return $true
    } catch {
        return $false
    }
}

function Expand-GzipFile([string]$Source, [string]$Destination) {
    $inputStream = [System.IO.File]::OpenRead($Source)
    try {
        $outputStream = [System.IO.File]::Create($Destination)
        try {
            $gzip = [System.IO.Compression.GZipStream]::new(
                $inputStream,
                [System.IO.Compression.CompressionMode]::Decompress
            )
            try {
                $gzip.CopyTo($outputStream)
            } finally {
                $gzip.Dispose()
            }
        } finally {
            $outputStream.Dispose()
        }
    } finally {
        $inputStream.Dispose()
    }
}

function Invoke-EngineDownload {
    $script:sourceKind = 'download'
    if ([string]::IsNullOrEmpty($env:GITHUB_ACTION_REPOSITORY)) {
        Stop-Script 'GITHUB_ACTION_REPOSITORY is not set; set SAKRE_ENGINE_BINARY to run a preinstalled engine.'
    }
    New-Item -ItemType Directory -Path $script:cacheDirectory -Force | Out-Null
    $temporary = Join-Path $script:cacheDirectory ".$($script:asset).$PID.tmp"
    $decompressed = Join-Path $script:cacheDirectory ".$($script:binary).$PID.tmp"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $decompressed -Force -ErrorAction SilentlyContinue
    $url = "https://github.com/$($env:GITHUB_ACTION_REPOSITORY)/releases/download/$($script:tag)/$($script:asset)"
    $started = Get-NowMs
    $downloaded = $false
    try {
        Invoke-WebRequest -Uri $url -OutFile $temporary
        $downloaded = $true
    } catch {
        if (-not [string]::IsNullOrEmpty($script:authToken)) {
            $downloaded = Invoke-AuthenticatedDownload -Destination $temporary
        }
    }
    if (-not $downloaded) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Stop-Script "Failed to download $url. If the action repository is private, set the engine_token Action input or SAKRE_ENGINE_TOKEN with Contents: Read on $($env:GITHUB_ACTION_REPOSITORY), or set SAKRE_ENGINE_BINARY to run a preinstalled engine."
    }
    $script:phaseDownloadMs = (Get-NowMs) - $started
    $started = Get-NowMs
    try {
        Expand-GzipFile -Source $temporary -Destination $decompressed
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $decompressed -Force -ErrorAction SilentlyContinue
        Stop-Script "The downloaded $($script:asset) is not a valid gzip archive; refusing to execute it."
    }
    $actual = (Get-FileHash -LiteralPath $decompressed -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:phaseVerifyMs = (Get-NowMs) - $started
    if ($actual -ne $script:digest) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $decompressed -Force -ErrorAction SilentlyContinue
        Stop-Script "The downloaded $($script:asset) does not match the pinned SHA-256 for $($script:tag) (expected $($script:digest), got $actual)."
    }
    $started = Get-NowMs
    Move-Item -LiteralPath $decompressed -Destination $script:enginePath -Force
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    $script:phaseInstallMs = (Get-NowMs) - $started
}

# An explicit preinstalled binary wins over release resolution and does not
# consult the pin, exactly like the self-hosted override this replaces.
$override = $env:SAKRE_ENGINE_BINARY
if (-not [string]::IsNullOrEmpty($override)) {
    $script:sourceKind = 'override'
    $script:enginePath = $override
    if (-not (Test-Path -LiteralPath $script:enginePath -PathType Leaf)) {
        Stop-Script "SAKRE_ENGINE_BINARY does not point to a file: $($script:enginePath)"
    }
    $script:phaseResolveMs = Get-NowMs
} else {
    switch ("$($env:RUNNER_OS)/$($env:RUNNER_ARCH)") {
        'Linux/X64' { $script:binary = 'sakre-linux-x64' }
        'Linux/ARM64' { $script:binary = 'sakre-linux-arm64' }
        'macOS/X64' { $script:binary = 'sakre-darwin-x64' }
        'macOS/ARM64' { $script:binary = 'sakre-darwin-arm64' }
        'Windows/X64' { $script:binary = 'sakre-windows-x64.exe' }
        default {
            Stop-Script "SAKRE does not publish an engine for $($env:RUNNER_OS)/$($env:RUNNER_ARCH); supported targets are Linux/X64, Linux/ARM64, macOS/X64, macOS/ARM64 and Windows/X64."
        }
    }
    $script:asset = "$($script:binary).gz"

    if ([string]::IsNullOrEmpty($env:GITHUB_ACTION_PATH)) {
        Stop-Script 'GITHUB_ACTION_PATH is not set; this script runs inside the composite Action.'
    }
    $pinFile = Join-Path $env:GITHUB_ACTION_PATH 'engine-pins.json'
    if (-not (Test-Path -LiteralPath $pinFile -PathType Leaf)) {
        Stop-Script "engine-pins.json was not found in the Action tree: $pinFile"
    }
    $pin = Get-Content -LiteralPath $pinFile -Raw | ConvertFrom-Json
    $pinnedTag = $pin.tag
    $assetName = $script:asset
    $digest = $pin.assets.$assetName
    if ($digest -isnot [string]) {
        $digest = ''
    }

    $requestedTag = ''
    if ($env:GITHUB_ACTION_REF -match '^v[0-9]+\.[0-9]+\.[0-9]+$') {
        $requestedTag = $env:GITHUB_ACTION_REF
    }
    if ([string]::IsNullOrEmpty($pinnedTag)) {
        if (-not [string]::IsNullOrEmpty($requestedTag)) {
            Stop-Script "engine-pins.json in this Action tree does not pin $requestedTag; use the @v1 major tag or a release commit that contains its own pin."
        }
        Stop-Script 'engine-pins.json in this Action tree does not pin an engine release yet. Publish a release, or set SAKRE_ENGINE_BINARY to run a preinstalled engine.'
    }
    if (-not [string]::IsNullOrEmpty($requestedTag) -and $requestedTag -ne $pinnedTag) {
        Stop-Script "engine-pins.json pins $pinnedTag, but this Action ref is $requestedTag; use the matching release tag or @v1."
    }
    $script:tag = $pinnedTag
    if ($digest -notmatch '^[0-9a-fA-F]{64}$') {
        Stop-Script "engine-pins.json has no SHA-256 pin for $($script:asset) in $($script:tag)."
    }
    $script:digest = $digest.ToLowerInvariant()

    # The engine_token input wins; the documented environment fallback covers
    # workflows that set SAKRE_ENGINE_TOKEN explicitly. The
    # target-repository token is never used for the engine download.
    $script:authToken = $env:INPUT_ENGINE_TOKEN
    if ([string]::IsNullOrEmpty($script:authToken)) {
        $script:authToken = $env:SAKRE_ENGINE_TOKEN
    }

    $script:phaseResolveMs = Get-NowMs

    $cacheRoot = $env:RUNNER_TEMP
    if ([string]::IsNullOrEmpty($cacheRoot)) {
        $cacheRoot = [System.IO.Path]::GetTempPath()
    }
    $script:cacheDirectory = Join-Path $cacheRoot "sakre-engine/$($script:tag)"
    $script:enginePath = Join-Path $script:cacheDirectory $script:binary
    if (Test-Path -LiteralPath $script:enginePath -PathType Leaf) {
        $started = Get-NowMs
        $actual = (Get-FileHash -LiteralPath $script:enginePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $script:phaseVerifyMs = (Get-NowMs) - $started
        if ($actual -eq $script:digest) {
            $script:sourceKind = 'cache'
        } else {
            Remove-Item -LiteralPath $script:enginePath -Force
            Invoke-EngineDownload
        }
    } else {
        Invoke-EngineDownload
    }
}

$script:phaseBootstrapMs = (Get-NowMs) - $script:phaseDownloadMs
# The engine has no use for the engine-download credential.
Remove-Item -Path Env:INPUT_ENGINE_TOKEN -ErrorAction SilentlyContinue
Remove-Item -Path Env:SAKRE_ENGINE_TOKEN -ErrorAction SilentlyContinue
$started = Get-NowMs
try {
    & $script:enginePath @args
    $script:engineStatus = $LASTEXITCODE
} catch {
    $script:engineStatus = 1
    Write-EngineSummary
    [Console]::Error.WriteLine("::error::$($_.Exception.Message)")
    exit 1
}
$script:phaseExecuteMs = (Get-NowMs) - $started
$script:phaseTotalMs = Get-NowMs
Write-EngineSummary
exit $script:engineStatus
