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

  Idempotent: safe to re-run. Existing settings.json keys are preserved.

  Usage:  .\install.ps1            # install
          .\install.ps1 uninstall  # remove

.PARAMETER Action
  install (default) or uninstall.
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall')]
  [string]$Action = 'install'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir  = Join-Path $env:USERPROFILE '.claude'
$ArtibotDir = Join-Path $ClaudeDir 'artibot'

# Read-only tools auto-approved by default. Write/Edit/Bash excluded for safety.
$SafeAllow = @('Read', 'Glob', 'Grep')

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Write-Log  { param($msg) Write-Host "[artibot] $msg" -ForegroundColor Green }
function Write-Warn2 { param($msg) Write-Host "[artibot] $msg" -ForegroundColor Yellow }
function Write-Err2 { param($msg) Write-Host "[artibot] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
function Test-Prerequisites {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err2 'Node.js not found. Install from https://nodejs.org/ (v18+)'
    exit 1
  }
  $nodeVersion = (node -v) -replace '^v', ''
  $major = [int]($nodeVersion.Split('.')[0])
  if ($major -lt 18) {
    Write-Err2 "Node.js 18+ required. Current: v$nodeVersion"
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
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
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
    Copy-Item -Path $_.FullName -Destination $DstDir -Force
    $count++
  }
  Write-Log "$Label installed: $count files -> $DstDir"
}

function Copy-Tree {
  param([string]$SrcDir, [string]$DstDir)
  if (-not (Test-Path $SrcDir)) { return }
  $target = Join-Path $DstDir (Split-Path -Leaf $SrcDir)
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
    if (-not (Test-Path $dstMeta)) { New-Item -ItemType Directory -Path $dstMeta -Force | Out-Null }
    Copy-Item -Path (Join-Path $srcMeta '*') -Destination $dstMeta -Recurse -Force
  }

  # Config files
  Copy-Item -Path (Join-Path $ScriptDir 'artibot.config.json') -Destination $ArtibotDir -Force
  $pkg = Join-Path $ScriptDir 'package.json'
  if (Test-Path $pkg) { Copy-Item -Path $pkg -Destination $ArtibotDir -Force }

  Write-Log "Hooks & scripts installed -> $ArtibotDir"

  # Rules: into ~/.claude/rules/artibot (auto-activate on file access)
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'rules') -DstDir (Join-Path $ClaudeDir 'rules\artibot') -Label 'Rules'
}

# ---------------------------------------------------------------------------
# Configure settings.json (Agent Teams + read-only permission seed)
# ---------------------------------------------------------------------------
function Set-Settings {
  $settingsFile = Join-Path $ClaudeDir 'settings.json'

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

  Write-Host '[artibot]   Tip: only read-only tools (Read/Glob/Grep) auto-approve by default.' -ForegroundColor Cyan
  Write-Host '            For broader auto-approval run /permissions in a session, or set' -ForegroundColor Cyan
  Write-Host '            "defaultMode" under "permissions" in ~/.claude/settings.json.' -ForegroundColor Cyan
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
      if (Test-Path $t) { Remove-Item $t -Force }
    }
  }
  $srcCmds = Join-Path $ScriptDir 'commands'
  if (Test-Path $srcCmds) {
    Get-ChildItem $srcCmds -Filter '*.md' -File | ForEach-Object {
      $t = Join-Path (Join-Path $ClaudeDir 'commands') $_.Name
      if (Test-Path $t) { Remove-Item $t -Force }
    }
  }
  $rulesDir = Join-Path $ClaudeDir 'rules\artibot'
  if (Test-Path $rulesDir) { Remove-Item $rulesDir -Recurse -Force }
  if (Test-Path $ArtibotDir) { Remove-Item $ArtibotDir -Recurse -Force }
  Write-Log 'Artibot uninstalled. settings.json, CLAUDE.md, and auto-memory left unchanged.'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$version = 'unknown'
try {
  $cfgPath = Join-Path $ScriptDir 'artibot.config.json'
  if (Test-Path $cfgPath) {
    $version = (Get-Content $cfgPath -Raw | ConvertFrom-Json).version
  }
} catch { }

Write-Host ''
Write-Host "  Artibot Installer v$version (Windows / PowerShell)" -ForegroundColor Cyan
Write-Host '  =================================================' -ForegroundColor Cyan
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
