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

  Feature-parity with install.sh (verified against install.sh function names):
    - check_prerequisites  : claude CLI + Node >=20 detection (Test-Prerequisites)
    - is_self_install      : skip copy phase when run from the installed copy
    - install_agents/...    : flat-copy commands/agents (no namespace prefix)
    - install.sh self-copy : copy install.sh -> ~/.claude/artibot/ (update.js fallback)
    - install_marketplace_mirror : refresh ~/.claude/plugins/marketplaces/... hot paths
    - install_plugin_cache : refresh per-version ~/.claude/plugins/cache/... hot paths
    - install_mcp          : seed ~/.claude/.mcp.json (skip if present)
    - save_source_path     : write ~/.claude/artibot/source-repo.json (update.js #1 strategy)
    - seed_project_claude_md / seed_local_config / seed_auto_memory
    - setup_swarm_consent / setup_auto_learning : non-interactive safe (skip/default)

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
# Concurrency lock — parity with install.sh acquire_install_lock (L44-72)
# ---------------------------------------------------------------------------
# install.sh has had this mutex since v4.31.1; install.ps1 shipped without one,
# so the two installers had NO mutual exclusion at all. That gap is reachable:
# on Windows update.js drives the update through Git Bash + install.sh while
# nothing stops a user from launching install.ps1 beside it.
#
# What goes wrong without it is the 2026-07-09 incident — two runs interleaving
# writes into the LIVE plugin cache, leaving lib/core with 14 files and every
# hook spawn failing with ERR_MODULE_NOT_FOUND in every open session.
#
# THE LOCK PATH MUST MATCH install.sh CHARACTER FOR CHARACTER. A different path
# is not a weaker lock, it is no lock: each script would take its own and both
# would proceed. install.sh:47 builds it as "${CLAUDE_DIR}/.artibot-install.lock"
# with CLAUDE_DIR="${HOME:-${USERPROFILE:-...}}/.claude" — the same directory
# $ClaudeDir resolves to here whenever Git Bash's HOME points at the Windows
# profile, which is its default.
$InstallLockDir = Join-Path $ClaudeDir '.artibot-install.lock'
# Stale threshold in seconds. Lockstep with install.sh (`-gt 600`).
$InstallLockStaleSecs = 600
$script:InstallLockHeld = $false

# Count of directory replacements that could not complete. Declared here because
# Set-StrictMode -Version Latest (L60) makes reading an uninitialised variable a
# terminating error.
$script:InstallFailures = 0

# Matches install.sh exactly: try once, reclaim only a lock older than the stale
# threshold, otherwise ERROR OUT. install.sh does not wait or retry
# (install.sh:62-63 errs and exits 1; tests/scripts/install-lock.test.js:145-152
# pins that behaviour), so neither does this — a second installer that silently
# waited would still be a second installer, just later.
function Request-InstallLock {
  if ($DryRun) {
    Write-Log "[dry-run] would acquire install lock ($InstallLockDir)"
    return
  }

  # New-Item WITHOUT -Force is the mutex: it fails when the directory already
  # exists. -Force would succeed on an existing directory and silently defeat
  # the whole mechanism, which is why it must never be added here.
  try {
    New-Item -ItemType Directory -Path $InstallLockDir -ErrorAction Stop | Out-Null
    $script:InstallLockHeld = $true
    return
  } catch { }

  # Unreadable mtime is treated as infinitely old, matching install.sh:52's
  # `|| echo 0` — for a LOCK, fail-open beats deadlocking every future install.
  $ageSecs = $InstallLockStaleSecs + 1
  try {
    $lockItem = Get-Item -LiteralPath $InstallLockDir -Force -ErrorAction Stop
    $ageSecs = [int]((Get-Date) - $lockItem.LastWriteTime).TotalSeconds
  } catch { }

  if ($ageSecs -gt $InstallLockStaleSecs) {
    Write-Warn2 "Reclaiming stale install lock (age ${ageSecs}s)"
    try { Remove-Item -LiteralPath $InstallLockDir -Recurse -Force -ErrorAction Stop } catch { }
    try {
      New-Item -ItemType Directory -Path $InstallLockDir -ErrorAction Stop | Out-Null
      $script:InstallLockHeld = $true
      return
    } catch { }
  }

  Write-Err2 "Another install is already running (lock: $InstallLockDir). Retry after it finishes."
  exit 1
}

# Released from a finally block so an exception or Ctrl-C does not strand the
# lock for the next 10 minutes. This is the counterpart to install.sh's
# `trap ... EXIT`. Caveat worth knowing rather than pretending away: PowerShell
# runs finally on Ctrl-C and on ordinary terminating errors, but a hard kill of
# the host process skips it — that is what the stale-reclaim path above covers.
function Remove-InstallLock {
  if (-not $script:InstallLockHeld) { return }
  try { Remove-Item -LiteralPath $InstallLockDir -Recurse -Force -ErrorAction Stop } catch { }
  $script:InstallLockHeld = $false
}

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
  # claude CLI check — parity with install.sh check_prerequisites (L31-34).
  # install.sh hard-exits when `claude` is absent; match that to keep a single
  # cross-platform contract (an install with no Claude Code CLI cannot run the
  # plugin at all).
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Err2 'Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code'
    exit 1
  }
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
  Write-Log "Prerequisites OK (Claude Code + Node.js v$nodeVersion)"
}

# ---------------------------------------------------------------------------
# Self-install guard — parity with install.sh is_self_install (L96-104)
# ---------------------------------------------------------------------------
# update.js falls back to the INSTALLED copy of install.sh (it runs
# `bash ~/.claude/artibot/install.sh` when the source repo cannot be found).
# Claude Code on Windows ships Git Bash, so update.js invokes install.sh — not
# install.ps1 — and this guard primarily exists for the case where a user
# manually re-runs install.ps1 from inside ~/.claude/artibot. When ScriptDir is
# ArtibotDir itself, every Copy-Item becomes copy-onto-self; skip the copy phase
# (files already in place — a no-op, not an error). Config/seed steps still run.
function Test-SelfInstall {
  try {
    $src = (Resolve-Path -LiteralPath $ScriptDir -ErrorAction Stop).ProviderPath.TrimEnd('\', '/')
    $dst = (Resolve-Path -LiteralPath $ArtibotDir -ErrorAction Stop).ProviderPath.TrimEnd('\', '/')
  } catch {
    return $false
  }
  return ($src -ieq $dst)
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
# Byte-exact comparison — parity with `cmp -s` in install.sh install_rules().
function Test-FileContentEqual {
  param([string]$PathA, [string]$PathB)
  try {
    $a = [System.IO.File]::ReadAllBytes($PathA)
    $b = [System.IO.File]::ReadAllBytes($PathB)
  } catch {
    return $false
  }
  if ($a.Length -ne $b.Length) { return $false }
  for ($i = 0; $i -lt $a.Length; $i++) {
    if ($a[$i] -ne $b[$i]) { return $false }
  }
  return $true
}

# -Preserve is for rules/ ONLY (see Install-Assets). Agents and commands must
# keep overwriting unconditionally or a plugin update would never reach them.
# Under -Preserve, an installed file that diverges from the repo copy is left
# alone and the repo version is parked as <name>.md.artibot-new. That suffix
# does not end in `.md`, so the rules loader and the verify count ignore it.
function Copy-MdFiles {
  param([string]$SrcDir, [string]$DstDir, [string]$Label, [switch]$Preserve)
  if (-not (Test-Path $SrcDir)) { return }
  $count = 0
  $preserved = 0
  Get-ChildItem -Path $SrcDir -Filter '*.md' -File | ForEach-Object {
    if ($DryRun) { $count++; return }
    $dst = Join-Path $DstDir $_.Name
    if ($Preserve -and (Test-Path $dst) -and -not (Test-FileContentEqual $_.FullName $dst)) {
      Copy-Item -Path $_.FullName -Destination "$dst.artibot-new" -Force
      Write-Warn2 "  Kept your edited $($_.Name) - new version saved as $($_.Name).artibot-new"
      $preserved++
      return
    }
    Copy-Item -Path $_.FullName -Destination $DstDir -Force
    $count++
  }
  $prefix = if ($DryRun) { '[dry-run] would install' } else { 'installed' }
  Write-Log "$Label ${prefix}: $count files -> $DstDir"
  if ($preserved -gt 0) {
    Write-Log "  Locally edited $Label kept as-is: $preserved (review the .artibot-new files to merge)"
  }
}

# Replaces $DstDir/<leaf of SrcDir>. Delegates to Copy-DirAtomic so the direct
# install gets the same no-missing-directory guarantee as the two mirrors —
# statusline reads out of ~/.claude/artibot, and both mirrors copy FROM it.
function Copy-Tree {
  param([string]$SrcDir, [string]$DstDir)
  if (-not (Test-Path $SrcDir)) { return $true }
  $target = Join-Path $DstDir (Split-Path -Leaf $SrcDir)
  Copy-DirAtomic -SrcDir $SrcDir -DstDir $target
}

function Install-Assets {
  # Commands + agents: flat into ~/.claude (NO namespace prefix)
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'agents')   -DstDir (Join-Path $ClaudeDir 'agents')   -Label 'Agents'
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'commands') -DstDir (Join-Path $ClaudeDir 'commands') -Label 'Commands'

  # Runtime trees: into ~/.claude/artibot (clean-before-copy for parity)
  # `$null =` because Copy-Tree now returns a bool and an uncaptured return
  # value would print "True" into the install log. Failures are tallied in
  # $script:InstallFailures, so nothing here needs the value.
  foreach ($dir in @('skills', 'hooks', 'scripts', 'lib', 'output-styles')) {
    $null = Copy-Tree -SrcDir (Join-Path $ScriptDir $dir) -DstDir $ArtibotDir
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

  # Copy install.sh itself into ~/.claude/artibot/ — parity with install.sh L181.
  # update.js (findInstallScript / findSourceRepo fallback #2) looks for
  # ~/.claude/artibot/install.sh after the plugin cache is cleared. On Windows,
  # update.js drives the actual update via Git Bash + install.sh, so this copy is
  # what makes cross-machine `/update` work even when install.ps1 was the entry.
  if ($DryRun) {
    Write-Log "[dry-run] would copy install.sh -> $ArtibotDir"
  } else {
    $srcInstallSh = Join-Path $ScriptDir 'install.sh'
    if (Test-Path $srcInstallSh) {
      Copy-Item -Path $srcInstallSh -Destination $ArtibotDir -Force
    } else {
      Write-Warn2 'install.sh not found beside install.ps1 - update.js fallback may fail to find it'
    }
  }

  Write-Log "Hooks & scripts installed -> $ArtibotDir"

  # Rules: into ~/.claude/rules/artibot (auto-activate on file access)
  # -Preserve: rules are hand-edited personal instructions, never clobber them.
  Copy-MdFiles -SrcDir (Join-Path $ScriptDir 'rules') -DstDir (Join-Path $ClaudeDir 'rules\artibot') -Label 'Rules' -Preserve
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
# Clean replace of a single directory — parity with install.sh
# atomic_replace_dir (see the long rationale there).
# ---------------------------------------------------------------------------
# Removing the destination and then copying into it leaves an interval where
# the directory is absent or half-populated, and hooks a live session spawns
# out of it die with ERR_MODULE_NOT_FOUND. Copy into a sibling staging dir
# first (destination untouched for the whole copy), then swap by rename.
#
# Windows rename semantics, measured rather than assumed:
#   - Moving onto an EXISTING directory puts the source inside it instead of
#     replacing it, so the swap is always two moves, never one onto a live path.
#   - A directory move fails with UnauthorizedAccessException while any process
#     holds an open handle underneath it, while a recursive delete of that same
#     directory succeeds. Rename is therefore less available than delete here
#     and needs the in-place fallback below.
#
# Every failure path leaves the previous directory in place: a stale mirror is
# fixed by re-running the installer, a missing lib/ takes down live sessions.
# Copy the CONTENTS of $Source into $Destination, one item at a time.
#
# `Copy-Item -Recurse` abandons the whole tree on the first TERMINATING error,
# and a locked destination file raises exactly that: measured on PS 5.1, copying
# over a file held with FileShare.None throws IOException which -ErrorAction
# SilentlyContinue does NOT suppress (that switch only governs non-terminating
# errors). Every caller below is a last-resort path that runs *because* the
# destination is locked, so the lock that triggered the fallback would also kill
# it — and install.ps1 runs under $ErrorActionPreference='Stop' with no handler
# anywhere up to the action switch, so the escape took the whole installer down
# before the marketplace/cache mirrors, MCP and settings steps ever ran.
#
# Per-item copying keeps one held file from abandoning the other 292, matching
# what `cp -r` already does for install.sh#atomic_replace_dir. Returns the count
# it could not copy so the caller can say so out loud. Never throws.
function Copy-TreeContents {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path $Source)) { return 0 }

  $failed = 0
  $srcRoot = [System.IO.Path]::GetFullPath($Source)
  # `foreach` (statement), not ForEach-Object: the pipeline form runs its block
  # in a child scope, so `$failed++` there would increment a copy and always
  # report 0.
  foreach ($item in @(Get-ChildItem -Path $srcRoot -Recurse -Force -ErrorAction SilentlyContinue)) {
    $rel = $item.FullName.Substring($srcRoot.Length).TrimStart('\')
    if (-not $rel) { continue }
    $target = Join-Path $Destination $rel
    try {
      if ($item.PSIsContainer) {
        if (-not (Test-Path $target)) {
          New-Item -ItemType Directory -Path $target -Force -ErrorAction Stop | Out-Null
        }
      } else {
        $parent = Split-Path $target -Parent
        if ($parent -and -not (Test-Path $parent)) {
          New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
        }
        Copy-Item -Path $item.FullName -Destination $target -Force -ErrorAction Stop
      }
    } catch {
      $failed++
    }
  }
  return $failed
}

# Returns $true when $DstDir ends up holding the new tree, $false when the
# previous copy was kept or only partly overwritten. Every $false also bumps
# $script:InstallFailures, so a caller that ignores the return value still
# cannot report a clean install (see Show-Summary).
function Copy-DirAtomic {
  param([string]$SrcDir, [string]$DstDir)
  if (-not (Test-Path $SrcDir)) { return $true }
  if ($DryRun) { Write-Log "[dry-run] would mirror $SrcDir -> $DstDir"; return $true }

  $dst = [System.IO.Path]::GetFullPath($DstDir)
  # PID-suffixed: see the rationale on install.sh#atomic_replace_dir. A shared
  # fixed staging name means run B's leftover-prune deletes run A's half-written
  # staging dir, after which A swaps the remains onto a live destination.
  $staging = "$dst.artibot-new.$PID"
  $retired = "$dst.artibot-old.$PID"

  # Our own leftovers are ours to drop. Foreign ones are pruned only past the
  # same staleness threshold the install lock uses, because the alternative is
  # deleting a concurrent run's staging dir mid-copy.
  foreach ($leftover in @($staging, $retired)) {
    if (Test-Path -LiteralPath $leftover) {
      try { Remove-Item -LiteralPath $leftover -Recurse -Force -ErrorAction Stop } catch { }
    }
  }
  $dstParent = Split-Path $dst -Parent
  $dstLeaf = Split-Path $dst -Leaf
  if ($dstParent) {
    foreach ($sibling in @(Get-ChildItem -LiteralPath $dstParent -Force -Directory -ErrorAction SilentlyContinue)) {
      # StartsWith, not -like: a destination leaf containing [ or ] would make
      # -like treat it as a wildcard pattern and match the wrong directories.
      if (-not ($sibling.Name.StartsWith("$dstLeaf.artibot-new.") -or $sibling.Name.StartsWith("$dstLeaf.artibot-old."))) { continue }
      # 600 inline rather than $InstallLockStaleSecs: this function is extracted
      # and run on its own by tests/scripts/install-atomic-replace.test.js, so it
      # must not depend on script-scope state. Lockstep with that variable.
      if (((Get-Date) - $sibling.LastWriteTime).TotalSeconds -le 600) { continue }
      try { Remove-Item -LiteralPath $sibling.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
  }

  try {
    New-Item -ItemType Directory -Path $staging -Force -ErrorAction Stop | Out-Null
  } catch {
    Write-Warn2 "Could not create staging dir for $dst - previous copy left in place ($($_.Exception.Message))"
    $script:InstallFailures++
    return $false
  }
  try {
    # Children only, skipping node_modules/.git at the top for parity with
    # install.sh safe_copy_dir.
    Get-ChildItem -Path $SrcDir -Force | Where-Object {
      $_.Name -ne 'node_modules' -and $_.Name -ne '.git'
    } | ForEach-Object {
      Copy-Item -Path $_.FullName -Destination $staging -Recurse -Force -ErrorAction Stop
    }
  } catch {
    try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { }
    Write-Warn2 "Staging copy failed for $dst - previous copy left in place ($($_.Exception.Message))"
    $script:InstallFailures++
    return $false
  }

  # A copy that silently produced nothing must never replace a good tree.
  $srcHasContent = @(Get-ChildItem -LiteralPath $SrcDir -Force -ErrorAction SilentlyContinue).Count -gt 0
  $stagingEmpty = @(Get-ChildItem -LiteralPath $staging -Force -ErrorAction SilentlyContinue).Count -eq 0
  if ($srcHasContent -and $stagingEmpty) {
    try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { }
    Write-Warn2 "Staging copy for $dst came out empty - previous copy left in place"
    $script:InstallFailures++
    return $false
  }

  # ...and neither must a copy that produced only PART of one. The check above
  # reads one level, so a staging dir that lost whole subtrees passes it while
  # being unloadable. Count files on both sides, applying the same top-level
  # node_modules/.git exclusion the staging copy above uses.
  $srcFileCount = 0
  foreach ($child in @(Get-ChildItem -LiteralPath $SrcDir -Force -ErrorAction SilentlyContinue)) {
    if ($child.Name -eq 'node_modules' -or $child.Name -eq '.git') { continue }
    if ($child.PSIsContainer) {
      $srcFileCount += @(Get-ChildItem -LiteralPath $child.FullName -Recurse -Force -File -ErrorAction SilentlyContinue).Count
    } else {
      $srcFileCount++
    }
  }
  $stagingFileCount = @(Get-ChildItem -LiteralPath $staging -Recurse -Force -File -ErrorAction SilentlyContinue).Count
  if ($srcFileCount -gt 0 -and $stagingFileCount -lt $srcFileCount) {
    try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { }
    Write-Warn2 "Staging copy for $dst is incomplete ($stagingFileCount/$srcFileCount files) - previous copy left in place"
    $script:InstallFailures++
    return $false
  }

  # Nothing to displace: one move, no window at all.
  if (-not (Test-Path $dst)) {
    try { [System.IO.Directory]::Move($staging, $dst); return $true } catch { }
    try { New-Item -ItemType Directory -Path $dst -Force -ErrorAction Stop | Out-Null } catch { }
    $failed = Copy-TreeContents -Source $staging -Destination $dst
    if ($failed -gt 0) {
      Write-Warn2 "$dst - $failed item(s) could not be written after the move was refused"
    }
    try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { }
    if ($failed -gt 0) {
      $script:InstallFailures++
      return $false
    }
    return $true
  }

  $movedAside = $false
  try { [System.IO.Directory]::Move($dst, $retired); $movedAside = $true } catch { }

  if ($movedAside) {
    try {
      [System.IO.Directory]::Move($staging, $dst)
      # Best-effort: an `.artibot-old` that will not unlink is harmless and the
      # next run prunes it. Failing the install over it would be worse.
      try { Remove-Item -LiteralPath $retired -Recurse -Force -ErrorAction Stop } catch { }
      return $true
    } catch { }
    # The destination is already moved aside - the one path that can leave a
    # mirror with no directory at all. Put it back before anything else.
    try {
      [System.IO.Directory]::Move($retired, $dst)
      Write-Warn2 "Swap failed for $dst; restored the previous copy"
    } catch {
      Write-Warn2 "Swap failed for $dst and rename-back was refused; copying the previous copy back"
      try { New-Item -ItemType Directory -Path $dst -Force -ErrorAction Stop | Out-Null } catch { }
      $failed = Copy-TreeContents -Source $retired -Destination $dst
      if ($failed -gt 0) {
        Write-Warn2 "$dst - $failed item(s) of the previous copy could not be restored"
      }
      try { Remove-Item -LiteralPath $retired -Recurse -Force -ErrorAction Stop } catch { }
    }
    try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { }
    # Either branch above means the NEW tree never landed - the destination is
    # back on the previous version. That is the safe outcome, not a successful
    # install, and the summary has to say so.
    $script:InstallFailures++
    return $false
  }

  # Destination locked by an open handle. Overwrite in place: no path is ever
  # removed before its replacement exists. The very lock that sent us here will
  # refuse some of these writes, so this must report and continue rather than
  # abort — see Copy-TreeContents.
  $failed = Copy-TreeContents -Source $staging -Destination $dst
  if ($failed -gt 0) {
    Write-Warn2 "$dst - $failed item(s) are held by another process and stay at the previous version"
    Write-Warn2 "Re-run the installer once that process exits; the previous files are intact."
  }
  Get-ChildItem -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($dst.Length).TrimStart('\')
    if ($rel -and -not (Test-Path -LiteralPath (Join-Path $staging $rel))) {
      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
  }
  try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { }
  # A mixed-version tree is not a completed replacement.
  if ($failed -gt 0) {
    $script:InstallFailures++
    return $false
  }
  return $true
}

# Name kept for the marketplace + plugin-cache mirror call sites.
function Copy-DirClean {
  param([string]$SrcDir, [string]$DstDir)
  Copy-DirAtomic -SrcDir $SrcDir -DstDir $DstDir
}

# ---------------------------------------------------------------------------
# Marketplace mirror — parity with install.sh install_marketplace_mirror (L202)
# ---------------------------------------------------------------------------
# Sessions load hooks/skills from the per-version plugin CACHE — the
# marketplace copy is only the install source Claude Code pulls from.
# GIT-MANAGED GUARD (v4.36.4): when the marketplace copy is git-managed,
# writing into it leaves the worktree dirty/diverged, Claude Code's refresh
# pull then fails silently, and `claude plugin update` reports a stale
# version as "latest" forever (2026-07-13 v4.32.0-stuck incident). The
# mirror only runs for non-git (directory-sourced) marketplace layouts.
function Update-MarketplaceMirror {
  $mktClone = Join-Path $ClaudeDir 'plugins\marketplaces\artibot'
  $mktRoot = Join-Path $mktClone 'plugins\artibot'
  if (-not (Test-Path $mktRoot)) {
    Write-Log 'Marketplace install not present (skip mirror)'
    return
  }
  if (Test-Path (Join-Path $mktClone '.git')) {
    Write-Log "Marketplace is git-managed by Claude Code (skip mirror - use 'claude plugin marketplace update artibot')"
    return
  }

  # Hot runtime paths come from the direct install we just wrote.
  foreach ($dir in @('scripts', 'hooks', 'lib', 'skills', 'output-styles', '.claude-plugin')) {
    $src = Join-Path $ArtibotDir $dir
    if (Test-Path $src) { $null = Copy-DirClean -SrcDir $src -DstDir (Join-Path $mktRoot $dir) }
  }

  # Commands + agents live only in the source repo (the direct install omits
  # them — Claude Code reads them straight from the marketplace path). Pull from
  # the source repo, not ArtibotDir.
  foreach ($dir in @('commands', 'agents')) {
    $src = Join-Path $ScriptDir $dir
    if (Test-Path $src) { $null = Copy-DirClean -SrcDir $src -DstDir (Join-Path $mktRoot $dir) }
  }

  if (-not $DryRun) {
    Copy-Item -Path (Join-Path $ScriptDir 'artibot.config.json') -Destination $mktRoot -Force
    $pkg = Join-Path $ScriptDir 'package.json'
    if (Test-Path $pkg) { Copy-Item -Path $pkg -Destination $mktRoot -Force }
  }
  Write-Log "Marketplace mirror updated -> $mktRoot"
}

# ---------------------------------------------------------------------------
# Plugin cache mirror — parity with install.sh install_plugin_cache (L254)
# ---------------------------------------------------------------------------
# Claude Code loads hooks.json from the per-version cache dir at session start.
# Mirroring the hot paths into every cache version dir keeps post-restart
# sessions consistent. We deliberately do NOT touch .claude-plugin/plugin.json
# inside the cache (its version field is the cache routing key) and do NOT delete
# the cache dir (clearCache() in update.js owns invalidation).
function Update-PluginCache {
  $cacheRoot = Join-Path $ClaudeDir 'plugins\cache\artibot\artibot'
  if (-not (Test-Path $cacheRoot)) {
    Write-Log 'Plugin cache not present (skip cache sync)'
    return
  }

  $synced = 0
  Get-ChildItem -Path $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $vRoot = $_.FullName
    foreach ($dir in @('scripts', 'hooks', 'lib', 'output-styles')) {
      $src = Join-Path $ArtibotDir $dir
      if (Test-Path $src) { $null = Copy-DirClean -SrcDir $src -DstDir (Join-Path $vRoot $dir) }
    }
    if (-not $DryRun) {
      $cfg = Join-Path $ScriptDir 'artibot.config.json'
      if (Test-Path $cfg) { Copy-Item -Path $cfg -Destination $vRoot -Force }
      $pkg = Join-Path $ScriptDir 'package.json'
      if (Test-Path $pkg) { Copy-Item -Path $pkg -Destination $vRoot -Force }
    }
    $synced++
  }

  if ($synced -gt 0) {
    Write-Log "Plugin cache synced: $synced version dir(s) -> $cacheRoot"
  } else {
    Write-Log 'Plugin cache directory present but contained no version dirs (skip)'
  }
}

# ---------------------------------------------------------------------------
# MCP config — parity with install.sh install_mcp (L484)
# ---------------------------------------------------------------------------
function Install-Mcp {
  $mcpFile = Join-Path $ClaudeDir '.mcp.json'
  $srcMcp  = Join-Path $ScriptDir '.mcp.json'

  if (Test-Path $mcpFile) {
    Write-Warn2 'MCP config exists at ~/.claude/.mcp.json - merge manually recommended'
    Write-Warn2 "Artibot MCP config: $srcMcp"
    return
  }
  if (Test-Path $srcMcp) {
    if ($DryRun) { Write-Log "[dry-run] would copy .mcp.json -> $mcpFile"; return }
    Copy-Item -Path $srcMcp -Destination $mcpFile -Force
    Write-Log 'MCP servers configured (Context7, Playwright)'
  }
}

# ---------------------------------------------------------------------------
# source-repo.json — parity with install.sh save_source_path (L891)
# ---------------------------------------------------------------------------
# This is update.js findSourceRepo()'s #1 (most reliable) strategy. Written to
# ~/.claude/artibot/source-repo.json with { repoRoot, pluginDir, savedAt } —
# the exact shape update.js reads (repoRoot + .git existence check, pluginDir).
function Save-SourcePath {
  $gitRoot = $null
  try {
    Push-Location $ScriptDir
    $gitRoot = (git rev-parse --show-toplevel 2>$null)
  } catch {
    $gitRoot = $null
  } finally {
    Pop-Location
  }

  if ([string]::IsNullOrWhiteSpace($gitRoot)) {
    Write-Warn2 'Not a git repo - source path not saved (manual git pull needed for updates)'
    return
  }
  # git returns forward slashes; normalize to a native path so update.js's
  # existsSync(path.join(repoRoot, '.git')) resolves on Windows.
  $gitRoot = $gitRoot.Trim() -replace '/', '\'

  $sourceJson = Join-Path $ArtibotDir 'source-repo.json'
  if ($DryRun) { Write-Log "[dry-run] would save source-repo.json -> $sourceJson"; return }

  $payload = [ordered]@{
    repoRoot  = $gitRoot
    pluginDir = $ScriptDir
    savedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  ($payload | ConvertTo-Json) + "`n" | Set-Content -Path $sourceJson -Encoding utf8 -NoNewline
  Write-Log "Source repo path saved for auto-updates: $gitRoot"
}

# ---------------------------------------------------------------------------
# Seed project CLAUDE.md — parity with install.sh seed_project_claude_md (L311)
# ---------------------------------------------------------------------------
$script:ArtibotSection = @'

## Artibot Integration

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file -> Make change -> Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
'@

function Initialize-ProjectClaudeMd {
  $claudeMd = Join-Path (Get-Location).Path 'CLAUDE.md'

  if (Test-Path $claudeMd) {
    if (Select-String -Path $claudeMd -Pattern '## Artibot Integration' -Quiet -ErrorAction SilentlyContinue) {
      Write-Log 'Project CLAUDE.md already has Artibot section - skipping'
      return
    }
    if ($DryRun) { Write-Log '[dry-run] would append Artibot section to CLAUDE.md'; return }
    Add-Content -Path $claudeMd -Value $script:ArtibotSection -Encoding utf8
    Write-Log 'Artibot section appended to existing CLAUDE.md'
  } else {
    if ($DryRun) { Write-Log '[dry-run] would create CLAUDE.md with Artibot methodology'; return }
    Set-Content -Path $claudeMd -Value ("# Project Instructions`n" + $script:ArtibotSection) -Encoding utf8
    Write-Log 'Project CLAUDE.md created with Artibot methodology'
  }
}

# ---------------------------------------------------------------------------
# Seed CLAUDE.local.md — parity with install.sh seed_local_config (L386)
# ---------------------------------------------------------------------------
function Initialize-LocalConfig {
  $cwd       = (Get-Location).Path
  $localMd   = Join-Path $cwd 'CLAUDE.local.md'
  $gitignore = Join-Path $cwd '.gitignore'
  $template  = Join-Path $ScriptDir 'templates\CLAUDE.local.md.template'

  if (Test-Path $localMd) {
    Write-Log 'CLAUDE.local.md already exists - skipping'
    return
  }
  if (-not (Test-Path $template)) {
    Write-Warn2 "CLAUDE.local.md.template not found at $ScriptDir\templates\ - skipping seed"
    return
  }
  if ($DryRun) { Write-Log '[dry-run] would seed CLAUDE.local.md from template + gitignore it'; return }

  Copy-Item -Path $template -Destination $localMd -Force
  Write-Log 'CLAUDE.local.md created from template (personalize it!)'

  if (Test-Path $gitignore) {
    if (-not (Select-String -Path $gitignore -Pattern 'CLAUDE.local.md' -Quiet -ErrorAction SilentlyContinue)) {
      Add-Content -Path $gitignore -Value 'CLAUDE.local.md' -Encoding utf8
      Write-Log 'Added CLAUDE.local.md to .gitignore'
    }
  } else {
    Write-Warn2 'No .gitignore found - CLAUDE.local.md may be accidentally committed'
  }
}

# ---------------------------------------------------------------------------
# Seed auto-memory — parity with install.sh seed_auto_memory (L417)
# ---------------------------------------------------------------------------
# Claude Code hashes the project path into ~/.claude/projects/<hash>/memory/.
# The hash replaces space / \ : with '-' and strips a leading '-'.
function Initialize-AutoMemory {
  $memoryDir = Join-Path $ClaudeDir 'projects'
  $cwd = (Get-Location).Path

  # Build the path hash the same way Claude Code does (space, /, \, : -> -).
  $projectHash = ($cwd -replace '[ /:\\]', '-') -replace '^-', ''

  # Fallback: if the computed hash dir is absent, match by trailing basename.
  $candidate = Join-Path $memoryDir $projectHash
  if ((-not (Test-Path $candidate)) -and (Test-Path $memoryDir)) {
    $leaf = Split-Path -Leaf $cwd
    $match = Get-ChildItem -Path $memoryDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "*$leaf" } | Select-Object -First 1
    if ($match) { $projectHash = $match.Name }
  }
  $projectMemory = Join-Path (Join-Path $memoryDir $projectHash) 'memory'

  if ((Test-Path (Join-Path $projectMemory 'MEMORY.md'))) {
    Write-Log 'Auto-memory already exists - skipping seed'
    return
  }
  if ($DryRun) { Write-Log "[dry-run] would seed MEMORY.md -> $projectMemory"; return }

  $agentCount = (Get-ChildItem (Join-Path $ClaudeDir 'agents')   -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $cmdCount   = (Get-ChildItem (Join-Path $ClaudeDir 'commands') -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $skillsDir  = Join-Path $ArtibotDir 'skills'
  $skillCount = if (Test-Path $skillsDir) { (Get-ChildItem $skillsDir -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }

  New-Item -ItemType Directory -Path $projectMemory -Force | Out-Null
  $seed = @"
# Project Memory (Seeded by Artibot)

## Artibot Quick Reference
- **Agents**: $agentCount specialized agents - use ``Task()`` to delegate
- **Commands**: ``/sc`` routes to optimal command/agent/skill automatically
- **DEV Protocol**: Decompose -> Execute -> Verify (mandatory for all code changes)
- **Quality**: 80%+ test coverage, immutable patterns, functions < 50 lines

## Workflow Tips
- Complex features: start with ``/sc plan [feature]`` or use planner agent
- After implementation: code-reviewer agent runs automatically via rules
- Parallel work: launch multiple agents with ``Task()`` for independent tasks
- Vibe coding: rules auto-activate on file access (no /sc needed after install)

## Key Paths
- Agents: ``~/.claude/agents/`` ($agentCount .md files)
- Commands: ``~/.claude/commands/`` ($cmdCount .md files)
- Skills: ``~/.claude/artibot/skills/`` ($skillCount skill directories)
- Rules: ``~/.claude/rules/artibot/`` (auto-activate on file access)
- Config: ``~/.claude/artibot/artibot.config.json``
"@
  Set-Content -Path (Join-Path $projectMemory 'MEMORY.md') -Value $seed -Encoding utf8
  Write-Log "Auto-memory seeded with Artibot quickstart -> $projectMemory\MEMORY.md"
}

# ---------------------------------------------------------------------------
# Swarm consent — parity with install.sh setup_swarm_consent (L650)
# ---------------------------------------------------------------------------
# install.sh prompts interactively; PowerShell installs here are treated as
# non-interactive by default (this script is the unattended Windows path). To
# match install.sh's `[ ! -t 0 ]` non-interactive branch, swarm is left disabled
# unless a consent file already exists. Users opt in later via '/sc swarm opt-in'.
function Set-SwarmConsent {
  $consentFile = Join-Path $ArtibotDir 'swarm-consent.json'
  if (Test-Path $consentFile) {
    Write-Log 'Swarm consent already configured - skipping'
    return
  }
  Write-Warn2 "Swarm disabled by default (non-interactive install). Use '/sc swarm opt-in' later."
}

# ---------------------------------------------------------------------------
# Auto-learning — parity with install.sh setup_auto_learning (L826)
# ---------------------------------------------------------------------------
# install.sh tries claude-schedule -> crontab -> schtasks. On Windows the
# relevant path is schtasks. We honor the same gating: skip if a marker exists,
# skip if autoLearning is disabled in config, else register a daily 03:00 task
# via schtasks (idempotent) and write the marker regardless to avoid re-prompts.
function Set-AutoLearning {
  $marker = Join-Path $ArtibotDir 'auto-learning-registered.json'
  if (Test-Path $marker) {
    Write-Log 'Auto-learning schedule already registered - skipping'
    return
  }

  # Read autoLearning.enabled + schedule from the installed config via Node
  # (mirrors install.sh _is_auto_learning_enabled / _get_auto_learning_schedule).
  $cfgFile = Join-Path $ArtibotDir 'artibot.config.json'
  $enabled = $false
  $schedule = '0 3 * * *'
  if ((Test-Path $cfgFile) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
      $env:ARTIBOT_CFG = $cfgFile
      $enabled = (node --input-type=commonjs -e "const c=JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8'));process.stdout.write(c.autoLearning&&c.autoLearning.enabled===true?'1':'0')") -eq '1'
      $sched = node --input-type=commonjs -e "const c=JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8'));process.stdout.write((c.autoLearning&&c.autoLearning.schedule)||'0 3 * * *')"
      if ($sched) { $schedule = $sched }
    } catch { }
  }

  if (-not $enabled) {
    Write-Log 'Auto-learning pipeline disabled in config - skipping'
    return
  }

  if ($DryRun) { Write-Log "[dry-run] would register auto-learning ($schedule) via schtasks"; return }

  $method = 'hint-only'
  $runner = Join-Path $ArtibotDir 'scripts\run-auto-learning.js'
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $schtasks = Get-Command schtasks.exe -ErrorAction SilentlyContinue

  if ($schtasks -and $nodeCmd -and (Test-Path $runner)) {
    $taskName = 'ArtibotAutoLearning'
    $already = $false
    & schtasks.exe /Query /TN $taskName *> $null
    if ($LASTEXITCODE -eq 0) { $already = $true }

    if ($already) {
      $method = 'schtasks'
      Write-Log 'Auto-learning already registered in Task Scheduler'
    } else {
      $tr = '"{0}" "{1}"' -f $nodeCmd.Source, $runner
      & schtasks.exe /Create /TN $taskName /TR $tr /SC DAILY /ST 03:00 /F *> $null
      if ($LASTEXITCODE -eq 0) {
        $method = 'schtasks'
        Write-Log 'Auto-learning registered via Windows Task Scheduler'
      }
    }
  }

  if ($method -eq 'hint-only') {
    Write-Warn2 'Could not auto-register schedule. Manual options:'
    Write-Tip '  1) In Claude session: use CronCreate tool'
    Write-Tip '  2) node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule'
  }

  # Write marker regardless (prevents re-prompting) — mirrors install.sh.
  $markerPayload = [ordered]@{
    registeredAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    schedule     = $schedule
    method       = $method
  }
  ($markerPayload | ConvertTo-Json) + "`n" | Set-Content -Path $marker -Encoding utf8 -NoNewline
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
function Show-Summary {
  $agentCount = (Get-ChildItem (Join-Path $ClaudeDir 'agents')   -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $cmdCount   = (Get-ChildItem (Join-Path $ClaudeDir 'commands') -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $skillsDir  = Join-Path $ArtibotDir 'skills'
  $skillCount = if (Test-Path $skillsDir) { (Get-ChildItem $skillsDir -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
  $rulesDir   = Join-Path $ClaudeDir 'rules\artibot'
  $ruleCount  = if (Test-Path $rulesDir) { (Get-ChildItem $rulesDir -Filter '*.md' -File -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
  $hooksDir   = Join-Path $ArtibotDir 'scripts\hooks'
  $hookCount  = if (Test-Path $hooksDir) { (Get-ChildItem $hooksDir -Filter '*.js' -File -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }

  Write-Host ''
  Write-Log '--- Installation Summary ---'
  Write-Host "  Agents:   $agentCount files in ~/.claude/agents/"
  Write-Host "  Commands: $cmdCount files in ~/.claude/commands/ (no prefix -> /save, /sc, /daily)"
  Write-Host "  Skills:   $skillCount dirs in ~/.claude/artibot/skills/"
  Write-Host "  Rules:    $ruleCount files in ~/.claude/rules/artibot/ (auto-activate)"
  Write-Host "  Hooks:    $hookCount scripts in ~/.claude/artibot/scripts/"
  Write-Host ''

  $cwd = (Get-Location).Path
  if (Test-Path (Join-Path $cwd 'CLAUDE.md'))       { Write-Host '  Project:  CLAUDE.md seeded with Artibot methodology' }
  if (Test-Path (Join-Path $cwd 'CLAUDE.local.md')) { Write-Host '  Local:    CLAUDE.local.md ready for personalization' }
  Write-Host ''

  # The counts above are read off whatever is on disk, so a directory that could
  # not be replaced still counts - as its PREVIOUS version. Only the failure
  # tally separates the two, which is why the completion line is gated on it.
  if ($script:InstallFailures -gt 0) {
    Write-Err2 "PARTIAL INSTALL - $($script:InstallFailures) directory replacement(s) failed."
    Write-Err2 'The previous copies were left in place, so the counts above may describe'
    Write-Err2 'the OLD version. Re-run the installer once the files named in the'
    Write-Err2 'warnings above are no longer held by another process.'
    return
  }

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
    try {
      Test-Prerequisites
      Initialize-Directories
      # Self-install guard (parity with install.sh main L996): when run from the
      # installed copy, skip the copy/mirror phase (no-op) but still run config +
      # seed steps below.
      if (Test-SelfInstall) {
        Write-Warn2 "Running from the installed location ($ArtibotDir) - files already in place."
        Write-Warn2 'Skipping copy phase (no-op); continuing with config & seed steps.'
        # INV-6 marker (parity with install.sh): record that THIS install skipped
        # the file-copy phase so update.js can detect a self-install no-op when a
        # real update was due and refuse to falsely report success. Best-effort.
        $noopMarker = Join-Path $ArtibotDir '.last-install-noop'
        if ($DryRun) {
          Write-Log "[dry-run] would write no-op marker -> $noopMarker"
        } else {
          try { New-Item -ItemType File -Path $noopMarker -Force | Out-Null } catch { }
        }
      } else {
        # Acquired here, not at the top: the self-install branch writes nothing
        # into the live trees, and install.sh takes the lock in exactly the same
        # place (install.sh:1229, inside the non-self-install branch).
        Request-InstallLock
        Install-Assets
        Update-MarketplaceMirror
        Update-PluginCache
        # INV-6 marker cleanup (parity with install.sh): a real copy happened, so
        # clear any stale no-op marker from a previous self-install run; otherwise
        # the next post-install check false-fails on an outdated marker.
        $noopMarker = Join-Path $ArtibotDir '.last-install-noop'
        if ($DryRun) {
          Write-Log "[dry-run] would remove stale no-op marker -> $noopMarker"
        } elseif (Test-Path $noopMarker) {
          try { Remove-Item -Path $noopMarker -Force } catch { }
        }
      }
      Install-Mcp
      Set-Settings
      Initialize-ProjectClaudeMd
      Initialize-LocalConfig
      Initialize-AutoMemory
      Set-SwarmConsent
      Set-AutoLearning
      Save-SourcePath
      Show-Summary
    } finally {
      # Runs on the success path, on a terminating error, and on Ctrl-C, so a
      # failed install does not leave the next one blocked for ten minutes.
      Remove-InstallLock
    }
  }
  'uninstall' {
    Uninstall-Artibot
  }
}

# A directory that could not be replaced means the tree on disk is not the tree
# that was shipped. Saying so in a warning while exiting 0 is how a stale
# install gets mistaken for a current one - `npm run sync:local` and update.js
# both read this exit code.
if ($script:InstallFailures -gt 0) { exit 1 }
