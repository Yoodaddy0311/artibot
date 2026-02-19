#Requires -Version 5.1
<#
.SYNOPSIS
  Artibot - One-click installer for Windows (PowerShell 5.1+)

.DESCRIPTION
  Installs the Artibot Claude Code plugin.
  Usage: irm https://raw.githubusercontent.com/Artience/artibot/main/plugins/artibot/scripts/install.ps1 | iex
  or:    .\scripts\install.ps1 [-PluginDir <path>]

  Idempotent: safe to re-run. Will update in-place if already installed.

.PARAMETER PluginDir
  Override the default plugin install directory.
  Default: $env:USERPROFILE\.claude\plugins\artibot
#>
[CmdletBinding()]
param(
  [string]$PluginDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$ARTIBOT_VERSION = "1.3.0"
$MIN_NODE_MAJOR   = 18
$DEFAULT_PLUGIN_DIR = Join-Path $env:USERPROFILE ".claude\plugins\artibot"
$REPO_URL = "https://github.com/Artience/artibot"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info    { param($msg) Write-Host "[artibot] $msg" -ForegroundColor Cyan }
function Write-Ok      { param($msg) Write-Host "[artibot] $msg" -ForegroundColor Green }
function Write-Warn    { param($msg) Write-Warning "[artibot] $msg" }
function Write-Fail    { param($msg) Write-Error "[artibot] ERROR: $msg"; exit 1 }

# ---------------------------------------------------------------------------
# 1. Check Node.js >= 18
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
    if (-not (Test-Path $Target)) {
      New-Item -ItemType Directory -Path $Target -Force | Out-Null
    }
    Copy-Item -Path "$sourceRoot\*" -Destination $Target -Recurse -Force
  } else {
    # Running via pipe — use git clone
    $gitPath = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitPath) {
      Write-Fail "git not found. Install Git for Windows and re-run, or download manually from $REPO_URL"
    }

    if (Test-Path (Join-Path $Target ".git")) {
      Write-Info "Updating existing installation..."
      & git -C $Target pull --ff-only
    } else {
      Write-Info "Cloning repository..."
      $parentDir = Split-Path -Parent $Target
      if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
      }
      & git clone --depth 1 $REPO_URL $Target
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
  & node $validateScript
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "Validation failed. Check errors above."
  }
  Write-Ok "Validation passed"
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
Write-Host "  Artibot v$ARTIBOT_VERSION Installer" -ForegroundColor Cyan
Write-Host "  ==================================" -ForegroundColor Cyan
Write-Host ""

Test-NodeVersion

$resolvedPluginDir = Resolve-PluginDir
Write-Info "Plugin directory: $resolvedPluginDir"

Install-Files -Target $resolvedPluginDir
Install-Deps  -Target $resolvedPluginDir
Invoke-Validation -Target $resolvedPluginDir
Write-SuccessMessage -Target $resolvedPluginDir
