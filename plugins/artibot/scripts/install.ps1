#Requires -Version 5.1
<#
.SYNOPSIS
  DEPRECATED shim — forwards to plugins/artibot/install.ps1.

.DESCRIPTION
  The canonical Windows installer now lives at the plugin root:
  plugins/artibot/install.ps1. It flat-copies commands/agents into
  ~/.claude so slash commands resolve WITHOUT the `artibot:` namespace
  prefix (i.e. `/save`, not `/artibot:save`), matching install.sh.

  This file used to be a separate marketplace-style installer that cloned
  into ~/.claude/plugins/artibot and told users to `/plugins load`, which
  produced the namespaced `/artibot:save` commands. It is kept only as a
  redirector for any bookmarked path.

.PARAMETER Action
  Passed through to the canonical installer: install (default) or uninstall.
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall')]
  [string]$Action = 'install'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot  = Split-Path -Parent $ScriptDir
$Canonical   = Join-Path $PluginRoot 'install.ps1'

Write-Host '[artibot] scripts/install.ps1 is deprecated — using plugins/artibot/install.ps1' -ForegroundColor Yellow

if (-not (Test-Path $Canonical)) {
  Write-Host "[artibot] Canonical installer not found at $Canonical" -ForegroundColor Red
  exit 1
}

& $Canonical -Action $Action
exit $LASTEXITCODE
