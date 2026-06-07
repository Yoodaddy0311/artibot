#Requires -Version 5.1
<#
.SYNOPSIS
  Artibot - One-click installer for Windows (PowerShell 5.1+)

.DESCRIPTION
  Installs the Artibot Claude Code plugin.
  Usage: irm https://raw.githubusercontent.com/Yoodaddy0311/artibot/main/plugins/artibot/scripts/install.ps1 | iex
  or:    .\scripts\install.ps1 [-PluginDir <path>]

  Idempotent: safe to re-run. Will update in-place if already installed.

.PARAMETER PluginDir
  Override the default plugin install directory.
  Default: $env:USERPROFILE\.claude\plugins\artibot
#>
[CmdletBinding()]
param(
  [string]$PluginDir = "",
  [switch]$DryRun,
  [switch]$NoColor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Color cmdlet shim: when -NoColor passed, swap colored Write-Host for plain.
# This is checked once at top-level so each Write-* call stays a one-liner.
$script:UseColor = -not $NoColor

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
# Resolve plugin source dir (works for both local invocation and irm | iex pipe)
$_sourceDir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { $null }
$_pluginJson = if ($_sourceDir) { Join-Path $_sourceDir ".claude-plugin\plugin.json" } else { $null }
$_pkgJson    = if ($_sourceDir) { Join-Path $_sourceDir "package.json" } else { $null }
if ($_pluginJson -and (Test-Path $_pluginJson)) {
  $ARTIBOT_VERSION = (Get-Content $_pluginJson -Raw | ConvertFrom-Json).version
} elseif ($_pkgJson -and (Test-Path $_pkgJson)) {
  $ARTIBOT_VERSION = (Get-Content $_pkgJson -Raw | ConvertFrom-Json).version
} else {
  # Last-resort fallback for `irm | iex` pipe installs where $PSScriptRoot is empty.
  # Fetch plugin.json from GitHub raw so the banner shows a real version instead
  # of a misleading "unknown".
  try {
    $rawUrl = "https://raw.githubusercontent.com/Yoodaddy0311/artibot/master/plugins/artibot/.claude-plugin/plugin.json"
    $remote = Invoke-RestMethod -Uri $rawUrl -TimeoutSec 5 -ErrorAction Stop
    $ARTIBOT_VERSION = if ($remote.version) { $remote.version } else { "unknown" }
  } catch {
    $ARTIBOT_VERSION = "unknown"
  }
}
$MIN_NODE_MAJOR   = 20
$DEFAULT_PLUGIN_DIR = Join-Path $env:USERPROFILE ".claude\plugins\artibot"
$REPO_URL = "https://github.com/Yoodaddy0311/artibot"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info    {
  param($msg)
  if ($script:UseColor) { Write-Host "[artibot] $msg" -ForegroundColor Cyan } else { Write-Host "[artibot] $msg" }
}
function Write-Ok      {
  param($msg)
  if ($script:UseColor) { Write-Host "[artibot] $msg" -ForegroundColor Green } else { Write-Host "[artibot] $msg" }
}
function Write-Warn    { param($msg) Write-Warning "[artibot] $msg" }
function Write-Fail    { param($msg) Write-Error "[artibot] ERROR: $msg"; exit 1 }

# ---------------------------------------------------------------------------
# 1. Check Node.js >= MIN_NODE_MAJOR
# ---------------------------------------------------------------------------
function Test-NodeVersion {
  Write-Info "Checking Node.js..."

  $nodePath = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodePath) {
    Write-Fail "Node.js not found. Install Node.js $MIN_NODE_MAJOR+ from https://nodejs.org and re-run."
  }

  $versionOutput = node --version   # e.g. v18.20.0
  if ($versionOutput -match '^v(\d+)\.') {
    $major = [int]$Matches[1]
    if ($major -lt $MIN_NODE_MAJOR) {
      Write-Fail "Node.js $versionOutput is too old. Requires >=$MIN_NODE_MAJOR. Please upgrade."
    }
    Write-Ok "Node.js $versionOutput OK"
  } else {
    Write-Warn "Could not parse Node.js version '$versionOutput'. Continuing..."
  }
}

# ---------------------------------------------------------------------------
# 2. Detect / prompt for plugin directory
# ---------------------------------------------------------------------------
function Resolve-PluginDir {
  # Priority: CLI param > env var > interactive prompt > default
  if ($PluginDir) {
    return $PluginDir
  }
  if ($env:ARTIBOT_PLUGIN_DIR) {
    return $env:ARTIBOT_PLUGIN_DIR
  }

  # Interactive prompt (only when running from a real console)
  if ($Host.UI.RawUI.KeyAvailable -or [Environment]::UserInteractive) {
    $prompt = Read-Host "[artibot] Plugin install directory [$DEFAULT_PLUGIN_DIR]"
    if ($prompt.Trim()) { return $prompt.Trim() }
  }

  return $DEFAULT_PLUGIN_DIR
}

# ---------------------------------------------------------------------------
# 3. Clone or copy plugin files
# ---------------------------------------------------------------------------
function Install-Files {
  param([string]$Target)

  # Determine if this script is running from an already-cloned repo
  $scriptDir  = Split-Path -Parent $MyInvocation.PSCommandPath 2>$null
  $sourceRoot = if ($scriptDir) { Split-Path -Parent $scriptDir } else { $null }
  $pluginJson = if ($sourceRoot) { Join-Path $sourceRoot ".claude-plugin\plugin.json" } else { $null }

  if ($pluginJson -and (Test-Path $pluginJson)) {
    Write-Info "Installing from local source: $sourceRoot"
    if ($DryRun) {
      Write-Info "[dry-run] would copy $sourceRoot -> $Target (excl node_modules, .git)"
      return
    }
    if (-not (Test-Path $Target)) {
      New-Item -ItemType Directory -Path $Target -Force | Out-Null
    }
    # Exclude node_modules and .git: copying them on fresh-machine install can
    # hang or fail with EPERM (Windows symlink semantics). They are rebuilt by
    # `npm install` post-install anyway.
    Copy-Item -Path "$sourceRoot\*" -Destination $Target -Recurse -Force -Exclude @('node_modules', '.git')
  } else {
    # Running via pipe — use git clone
    $gitPath = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitPath) {
      Write-Fail "git not found. Install Git for Windows and re-run, or download manually from $REPO_URL"
    }

    if (Test-Path (Join-Path $Target ".git")) {
      Write-Info "Updating existing installation..."
      if ($DryRun) {
        Write-Info "[dry-run] would git -C $Target pull --ff-only"
      } else {
        & git -C $Target pull --ff-only
      }
    } else {
      Write-Info "Cloning repository..."
      if ($DryRun) {
        Write-Info "[dry-run] would git clone --depth 1 $REPO_URL $Target"
      } else {
        $parentDir = Split-Path -Parent $Target
        if (-not (Test-Path $parentDir)) {
          New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        & git clone --depth 1 $REPO_URL $Target
      }
    }
  }

  Write-Ok "Files installed to $Target"
}

# ---------------------------------------------------------------------------
# 4. npm ci (devDependencies only, no scripts)
# ---------------------------------------------------------------------------
function Install-Deps {
  param([string]$Target)

  $pkgJson = Join-Path $Target "package.json"
  if (-not (Test-Path $pkgJson)) {
    Write-Warn "package.json not found, skipping npm install."
    return
  }

  Write-Info "Installing dependencies..."
  if ($DryRun) {
    Write-Info "[dry-run] would run npm ci/install in $Target"
    return
  }
  $lockFile = Join-Path $Target "package-lock.json"
  Push-Location $Target
  try {
    if (Test-Path $lockFile) {
      & npm ci --include=dev --ignore-scripts 2>&1 | Select-Object -Last 5
    } else {
      & npm install --ignore-scripts 2>&1 | Select-Object -Last 5
    }
    Write-Ok "Dependencies installed"
  } finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------------------
# 5. Run validation
# ---------------------------------------------------------------------------
function Invoke-Validation {
  param([string]$Target)

  $validateScript = Join-Path $Target "scripts\validate.js"
  if (-not (Test-Path $validateScript)) {
    Write-Warn "validate.js not found, skipping validation."
    return
  }

  Write-Info "Running validation..."
  if ($DryRun) {
    Write-Info "[dry-run] would run node $validateScript"
    return
  }
  & node $validateScript
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "Validation failed. Check errors above."
  }
  Write-Ok "Validation passed"
}

# ---------------------------------------------------------------------------
# 6a. Mirror to Claude Code marketplace install (parity with install.sh:196-225)
# ---------------------------------------------------------------------------
# Claude Code's plugin system maintains its own install copy at
#   ~/.claude/plugins/marketplaces/artibot/plugins/artibot/
# Every project session reads hooks from THAT path (via CLAUDE_PLUGIN_ROOT),
# not from $Target. Skipping this mirror leaves the marketplace at whatever
# version Claude Code last fetched, causing silent hook regressions in other
# projects after a manual update here.
function Install-MarketplaceMirror {
  param([string]$SourceRoot, [string]$Target)

  $claudeDir = Join-Path $env:USERPROFILE ".claude"
  $mktRoot   = Join-Path $claudeDir "plugins\marketplaces\artibot\plugins\artibot"

  if (-not (Test-Path $mktRoot)) {
    Write-Info "Marketplace install not present (skip mirror)"
    return
  }
  if ($DryRun) {
    Write-Info "[dry-run] would mirror $Target -> $mktRoot"
    return
  }

  # Mirror the hot paths from the direct install we just wrote.
  # Same clean-before-copy contract as install.sh:install_marketplace_mirror.
  foreach ($dir in @('scripts', 'hooks', 'lib', 'skills', 'output-styles', '.claude-plugin')) {
    $srcDir = Join-Path $Target $dir
    $dstDir = Join-Path $mktRoot $dir
    if (Test-Path $srcDir) {
      if (Test-Path $dstDir) { Remove-Item -Path $dstDir -Recurse -Force -ErrorAction SilentlyContinue }
      Copy-Item -Path $srcDir -Destination $dstDir -Recurse -Force -Exclude @('node_modules', '.git')
    }
  }

  # Commands and agents live only in the source repo. Pull from $SourceRoot.
  if ($SourceRoot) {
    foreach ($dir in @('commands', 'agents')) {
      $srcDir = Join-Path $SourceRoot $dir
      $dstDir = Join-Path $mktRoot $dir
      if (Test-Path $srcDir) {
        if (Test-Path $dstDir) { Remove-Item -Path $dstDir -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item -Path $srcDir -Destination $dstDir -Recurse -Force -Exclude @('node_modules', '.git')
      }
    }

    $cfgSrc = Join-Path $SourceRoot "artibot.config.json"
    if (Test-Path $cfgSrc) { Copy-Item -Path $cfgSrc -Destination $mktRoot -Force }
    $pkgSrc = Join-Path $SourceRoot "package.json"
    if (Test-Path $pkgSrc) { Copy-Item -Path $pkgSrc -Destination $mktRoot -Force }
  }

  Write-Ok "Marketplace mirror updated -> $mktRoot"
}

# ---------------------------------------------------------------------------
# 6b. Mirror to Claude Code plugin cache (parity with install.sh:248-284)
# ---------------------------------------------------------------------------
# Claude Code maintains a per-version plugin cache at
#   ~/.claude/plugins/cache/artibot/artibot/<version>/
# At session start it loads hooks.json from THE CACHE DIR. The v4.6.4 -> v4.8.2
# hook regression went unnoticed for so long precisely because users' caches
# held v4.6.4 args[] schema while the marketplace mirror had moved on. We do
# NOT touch .claude-plugin/plugin.json inside the cache (its version field is
# the cache routing key — overwriting it would orphan the cache entry).
function Install-PluginCache {
  param([string]$SourceRoot, [string]$Target)

  $claudeDir = Join-Path $env:USERPROFILE ".claude"
  $cacheRoot = Join-Path $claudeDir "plugins\cache\artibot\artibot"

  if (-not (Test-Path $cacheRoot)) {
    Write-Info "Plugin cache not present (skip cache sync)"
    return
  }
  if ($DryRun) {
    Write-Info "[dry-run] would sync $Target -> $cacheRoot per-version dirs"
    return
  }

  $synced = 0
  $versionDirs = Get-ChildItem -Path $cacheRoot -Directory -ErrorAction SilentlyContinue
  foreach ($vDir in $versionDirs) {
    $vRoot = $vDir.FullName

    # Mirror runtime hot paths only (NOT .claude-plugin — preserve plugin.json
    # version routing key).
    foreach ($dir in @('scripts', 'hooks', 'lib', 'output-styles')) {
      $srcDir = Join-Path $Target $dir
      $dstDir = Join-Path $vRoot $dir
      if (Test-Path $srcDir) {
        if (Test-Path $dstDir) { Remove-Item -Path $dstDir -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item -Path $srcDir -Destination $dstDir -Recurse -Force -Exclude @('node_modules', '.git')
      }
    }

    if ($SourceRoot) {
      $cfgSrc = Join-Path $SourceRoot "artibot.config.json"
      if (Test-Path $cfgSrc) { Copy-Item -Path $cfgSrc -Destination $vRoot -Force }
      $pkgSrc = Join-Path $SourceRoot "package.json"
      if (Test-Path $pkgSrc) { Copy-Item -Path $pkgSrc -Destination $vRoot -Force }
    }

    $synced++
  }

  if ($synced -gt 0) {
    Write-Ok "Plugin cache synced: $synced version dir(s) -> $cacheRoot"
  } else {
    Write-Info "Plugin cache directory present but contained no version dirs (skip)"
  }
}

# ---------------------------------------------------------------------------
# 6. Display success message
# ---------------------------------------------------------------------------
function Write-SuccessMessage {
  param([string]$Target)

  Write-Host ""
  Write-Ok "Artibot v$ARTIBOT_VERSION installed successfully!"
  Write-Host ""
  Write-Host "  Plugin directory: $Target" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  Getting started:"
  Write-Host "    1. Open Claude Code"
  Write-Host "    2. Load the plugin: /plugins load $Target"
  Write-Host "    3. Try your first command: /sc help"
  Write-Host ""
  Write-Host "  Documentation: $REPO_URL#readme"
  Write-Host ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Write-Host ""
$_bannerColor = if ($script:UseColor) { 'Cyan' } else { $null }
$_bannerSuffix = if ($DryRun) { "  [DRY-RUN]" } else { "" }
if ($_bannerColor) {
  Write-Host "  Artibot v$ARTIBOT_VERSION Installer$_bannerSuffix" -ForegroundColor $_bannerColor
  Write-Host "  ==================================" -ForegroundColor $_bannerColor
} else {
  Write-Host "  Artibot v$ARTIBOT_VERSION Installer$_bannerSuffix"
  Write-Host "  =================================="
}
Write-Host ""

Test-NodeVersion

$resolvedPluginDir = Resolve-PluginDir
Write-Info "Plugin directory: $resolvedPluginDir"

Install-Files -Target $resolvedPluginDir
Install-Deps  -Target $resolvedPluginDir
Invoke-Validation -Target $resolvedPluginDir
# Mirror to Claude Code marketplace + per-version cache (closes the
# Windows-side gap that caused the v4.6.4 -> v4.8.2 hook regression to persist
# silently for users running the per-plugin installer).
Install-MarketplaceMirror -SourceRoot $_sourceDir -Target $resolvedPluginDir
Install-PluginCache       -SourceRoot $_sourceDir -Target $resolvedPluginDir
Write-SuccessMessage -Target $resolvedPluginDir
