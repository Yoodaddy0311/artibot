#Requires -Version 5.1
<#
.SYNOPSIS
  Artibot installer for Windows (PowerShell 5.1+) — feature-parity with install.sh.

.DESCRIPTION
  Flat-copies the Artibot plugin into ~/.claude so slash commands resolve
  WITHOUT the marketplace `artibot:` namespace prefix (i.e. `/save`, not
  `/artibot:save`). Mirrors plugins/artibot/install.sh:

    commands/  agents/                  -> ~/.claude/{commands,agents}/
    skills/ hooks/ scripts/ lib/ ...    -> ~/.claude/artibot/
    rules/                              -> ~/.claude/rules/artibot/

  Also enables Agent Teams and seeds a conservative read-only permission
  allowlist (Read/Glob/Grep) into ~/.claude/settings.json so new users don't
  face repeated permission prompts. Write/Edit/Bash are deliberately excluded.

  This installer never clones the repo nor relies on the marketplace plugin
  loader — that path produces namespaced (`/artibot:save`) commands, which is
  exactly the UX regression this flat-copy installer exists to avoid. Keep it in
  lockstep with install.sh.

  Idempotent: safe to re-run. Existing settings.json keys are preserved.

  Usage:  .\install.ps1                    # install
          .\install.ps1 uninstall          # remove
          .\install.ps1 -DryRun            # preview without writing
          .\install.ps1 -NoColor           # plain (CI) output

.PARAMETER Action
  install (default) or uninstall.

.PARAMETER DryRun
  Print the actions that would be taken without mutating the filesystem.

.PARAMETER NoColor
  Disable colored console output (CI / non-ANSI terminals).
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall')]
  [string]$Action = 'install',
  [switch]$DryRun,
  [switch]$NoColor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Color shim: when -NoColor passed, drop -ForegroundColor. Checked once here so
# each logging call stays a one-liner.
$script:UseColor = -not $NoColor

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir  = Join-Path $env:USERPROFILE '.claude'
$ArtibotDir = Join-Path $ClaudeDir 'artibot'

# Minimum supported Node major (lockstep with install.sh MIN_NODE_MAJOR=20).
$MIN_NODE_MAJOR = 20

# Read-only tools auto-approved by default. Write/Edit/Bash excluded for safety.
$SafeAllow = @('Read', 'Glob', 'Grep')

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Write-Log   { param($msg) if ($script:UseColor) { Write-Host "[artibot] $msg" -ForegroundColor Green } else { Write-Host "[artibot] $msg" } }
function Write-Warn2 { param($msg) if ($script:UseColor) { Write-Host "[artibot] $msg" -ForegroundColor Yellow } else { Write-Host "[artibot] $msg" } }
function Write-Err2  { param($msg) if ($script:UseColor) { Write-Host "[artibot] $msg" -ForegroundColor Red } else { Write-Host "[artibot] $msg" } }
function Write-Tip   { param($msg) if ($script:UseColor) { Write-Host "[artibot] $msg" -ForegroundColor Cyan } else { Write-Host "[artibot] $msg" } }

# ---------------------------------------------------------------------------
# Version resolution (dynamic — never hardcode)
# ---------------------------------------------------------------------------
# Prefer .claude-plugin/plugin.json (the manifest CI guards), fall back to
# artibot.config.json, then package.json. No literal version string anywhere.
function Get-ArtibotVersion {
  foreach ($rel in @('.claude-plugin\plugin.json', 'artibot.config.json', 'package.json')) {
    $p = Join-Path $ScriptDir $rel
    if (Test-Path $p) {
      try {
        $v = (Get-Content $p -Raw | ConvertFrom-Json).version
        if ($v) { return $v }
      } catch { }
    }
  }
  return 'unknown'
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
function Test-Prerequisites {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err2 "Node.js not found. Install from https://nodejs.org/ (v$MIN_NODE_MAJOR+)"
    exit 1
  }
  $nodeVersion = (node -v) -replace '^v', ''
  $major = [int]($nodeVersion.Split('.')[0])
  if ($major -lt $MIN_NODE_MAJOR) {
    Write-Err2 "Node.js $MIN_NODE_MAJOR+ required. Current: v$nodeVersion"
    exit 1
  }
  Write-Log "Prerequisites OK (Node.js v$nodeVersion)"
}

# ---------------------------------------------------------------------------
# Directory setup
# ---------------------------------------------------------------------------
function Initialize-Directories {
  foreach ($d in @(
    (Join-Path $ClaudeDir 'agents'),
    (Join-Path $ClaudeDir 'commands'),
    (Join-Path $ClaudeDir 'rules\artibot'),
    $ArtibotDir
  )) {
    if (-not (Test-Path $d)) {
      if ($DryRun) { Write-Log "[dry-run] would create $d" }
      else { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
  }
  Write-Log 'Directories ready'
}

# ---------------------------------------------------------------------------
# Copy helpers
# ---------------------------------------------------------------------------
function Copy-MdFiles {
  param([string]$SrcDir, [string]$DstDir, [string]$Label)
  if (-not (Test-Path $SrcDir)) { return }
  $count = 0
  Get-ChildItem -Path $SrcDir -Filter '*.md' -File | ForEach-Object {
    if ($DryRun) { $count++; return }
    Copy-Item -Path $_.FullName -Destination $DstDir -Force
    $count++
  }
  $prefix = if ($DryRun) { '[dry-run] would install' } else { 'installed' }
  Write-Log "$Label ${prefix}: $count files -> $DstDir"
}

function Copy-Tree {
  param([string]$SrcDir, [string]$DstDir)
  if (-not (Test-Path $SrcDir)) { return }
  $target = Join-Path $DstDir (Split-Path -Leaf $SrcDir)
  if ($DryRun) { Write-Log "[dry-run] would copy $SrcDir -> $target"; return }
  if (Test-Path $target) { Remove-Item -Path $target -Recurse -Force }
  Copy-Item -Path $SrcDir -Destination $DstDir -Recurse -Force
}

function Install-Assets {
  # Commands + agents: flat into ~/.claude (NO namespace prefix)
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'agents')   -DstDir (Join-Path $ClaudeDir 'agents')   -Label 'Agents'
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'commands') -DstDir (Join-Path $ClaudeDir 'commands') -Label 'Commands'

  # Runtime trees: into ~/.claude/artibot (clean-before-copy for parity)
  foreach ($dir in @('skills', 'hooks', 'scripts', 'lib', 'output-styles')) {
    Copy-Tree -SrcDir (Join-Path $ScriptDir $dir) -DstDir $ArtibotDir
  }

  # .claude-plugin metadata (swarm-profile.json, plugin.json, ...)
  $srcMeta = Join-Path $ScriptDir '.claude-plugin'
  if (Test-Path $srcMeta) {
    $dstMeta = Join-Path $ArtibotDir '.claude-plugin'
    if ($DryRun) {
      Write-Log "[dry-run] would copy $srcMeta -> $dstMeta"
    } else {
      if (-not (Test-Path $dstMeta)) { New-Item -ItemType Directory -Path $dstMeta -Force | Out-Null }
      Copy-Item -Path (Join-Path $srcMeta '*') -Destination $dstMeta -Recurse -Force
    }
  }

  # Config files
  if ($DryRun) {
    Write-Log "[dry-run] would copy artibot.config.json + package.json -> $ArtibotDir"
  } else {
    Copy-Item -Path (Join-Path $ScriptDir 'artibot.config.json') -Destination $ArtibotDir -Force
    $pkg = Join-Path $ScriptDir 'package.json'
    if (Test-Path $pkg) { Copy-Item -Path $pkg -Destination $ArtibotDir -Force }
  }

  Write-Log "Hooks & scripts installed -> $ArtibotDir"

  # Rules: into ~/.claude/rules/artibot (auto-activate on file access)
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'rules') -DstDir (Join-Path $ClaudeDir 'rules\artibot') -Label 'Rules'
}

# ---------------------------------------------------------------------------
# Configure settings.json (Agent Teams + read-only permission seed)
# ---------------------------------------------------------------------------
function Set-Settings {
  $settingsFile = Join-Path $ClaudeDir 'settings.json'

  if ($DryRun) {
    Write-Log "[dry-run] would enable Agent Teams + seed read-only permissions (Read/Glob/Grep) in $settingsFile"
    return
  }

  if (Test-Path $settingsFile) {
    # Merge into existing settings via Node (preserves user keys, idempotent).
    $node = @'
const fs = require('fs');
const path = process.env.ARTIBOT_SETTINGS;
const seed = JSON.parse(process.env.ARTIBOT_ALLOW_SEED);
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
if (!cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
const perms = cfg.permissions && typeof cfg.permissions === 'object' ? cfg.permissions : {};
const existing = Array.isArray(perms.allow) ? perms.allow : [];
const merged = [...existing];
for (const e of seed) { if (!merged.includes(e)) merged.push(e); }
perms.allow = merged;
cfg.permissions = perms;
if (!cfg.statusLine) {
  cfg.statusLine = { type: 'command', command: 'bash ~/.claude/artibot/scripts/hooks/statusline.sh', padding: 2 };
}
const tmp = path + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
fs.renameSync(tmp, path);
'@
    $env:ARTIBOT_SETTINGS  = $settingsFile
    $env:ARTIBOT_ALLOW_SEED = ($SafeAllow | ConvertTo-Json -Compress)
    node --input-type=commonjs -e $node
    Write-Log 'settings.json merged: Agent Teams enabled + read-only permissions seeded'
  } else {
    $json = @'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep"
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh",
    "padding": 2
  }
}
'@
    Set-Content -Path $settingsFile -Value $json -Encoding utf8
    Write-Log 'settings.json created: Agent Teams enabled + read-only permissions seeded'
  }

  Write-Tip '  Tip: only read-only tools (Read/Glob/Grep) auto-approve by default.'
  Write-Tip '       For broader auto-approval run /permissions in a session, or set'
  Write-Tip '       "defaultMode" under "permissions" in ~/.claude/settings.json.'
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
function Show-Summary {
  $agentCount = (Get-ChildItem (Join-Path $ClaudeDir 'agents')   -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $cmdCount   = (Get-ChildItem (Join-Path $ClaudeDir 'commands') -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $skillsDir  = Join-Path $ArtibotDir 'skills'
  $skillCount = if (Test-Path $skillsDir) { (Get-ChildItem $skillsDir -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }

  Write-Host ''
  Write-Log '--- Installation Summary ---'
  Write-Host "  Agents:   $agentCount files in ~/.claude/agents/"
  Write-Host "  Commands: $cmdCount files in ~/.claude/commands/ (no prefix -> /save, /sc, /daily)"
  Write-Host "  Skills:   $skillCount dirs in ~/.claude/artibot/skills/"
  Write-Host ''
  Write-Log 'Installation complete! Start Claude Code and type: /sc hello'
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
function Uninstall-Artibot {
  Write-Warn2 'Removing Artibot...'
  $srcAgents = Join-Path $ScriptDir 'agents'
  if (Test-Path $srcAgents) {
    Get-ChildItem $srcAgents -Filter '*.md' -File | ForEach-Object {
      $t = Join-Path (Join-Path $ClaudeDir 'agents') $_.Name
      if (Test-Path $t) {
        if ($DryRun) { Write-Log "[dry-run] would remove $t" } else { Remove-Item $t -Force }
      }
    }
  }
  $srcCmds = Join-Path $ScriptDir 'commands'
  if (Test-Path $srcCmds) {
    Get-ChildItem $srcCmds -Filter '*.md' -File | ForEach-Object {
      $t = Join-Path (Join-Path $ClaudeDir 'commands') $_.Name
      if (Test-Path $t) {
        if ($DryRun) { Write-Log "[dry-run] would remove $t" } else { Remove-Item $t -Force }
      }
    }
  }
  $rulesDir = Join-Path $ClaudeDir 'rules\artibot'
  if (Test-Path $rulesDir) {
    if ($DryRun) { Write-Log "[dry-run] would remove $rulesDir" } else { Remove-Item $rulesDir -Recurse -Force }
  }
  if (Test-Path $ArtibotDir) {
    if ($DryRun) { Write-Log "[dry-run] would remove $ArtibotDir" } else { Remove-Item $ArtibotDir -Recurse -Force }
  }
  Write-Log 'Artibot uninstalled. settings.json, CLAUDE.md, and auto-memory left unchanged.'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$version = Get-ArtibotVersion
$bannerSuffix = if ($DryRun) { '  [DRY-RUN]' } else { '' }

Write-Host ''
if ($script:UseColor) {
  Write-Host "  Artibot Installer v$version (Windows / PowerShell)$bannerSuffix" -ForegroundColor Cyan
  Write-Host '  =================================================' -ForegroundColor Cyan
} else {
  Write-Host "  Artibot Installer v$version (Windows / PowerShell)$bannerSuffix"
  Write-Host '  ================================================='
}
Write-Host ''

switch ($Action) {
  'install' {
    Test-Prerequisites
    Initialize-Directories
    Install-Assets
    Set-Settings
    Show-Summary
  }
  'uninstall' {
    Uninstall-Artibot
  }
}
