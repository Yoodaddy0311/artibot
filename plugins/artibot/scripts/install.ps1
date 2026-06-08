#Requires -Version 5.1
<#
.SYNOPSIS
  DEPRECATED shim — forwards to plugins/artibot/install.ps1.

.DESCRIPTION
  The canonical Windows installer now lives at the plugin root:
  plugins/artibot/install.ps1. It FLAT-COPIES commands/agents into ~/.claude so
  slash commands resolve WITHOUT the `artibot:` namespace prefix (i.e. `/save`,
  not `/artibot:save`), enables Agent Teams, and seeds a conservative read-only
  permission allowlist into ~/.claude/settings.json. It does NOT git-clone or
  use `/plugins load`.

  This file is kept only as a thin redirector for any bookmarked path. It
  forwards ALL arguments verbatim (install | uninstall, -DryRun, -NoColor) to
  the canonical installer, so callers see no behavioral difference.

  Usage:  .\scripts\install.ps1 [install|uninstall] [-DryRun] [-NoColor]
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$Canonical  = Join-Path $PluginRoot 'install.ps1'

Write-Host '[artibot] scripts/install.ps1 is deprecated - using plugins/artibot/install.ps1' -ForegroundColor Yellow

if (-not (Test-Path $Canonical)) {
  Write-Host "[artibot] Canonical installer not found at $Canonical" -ForegroundColor Red
  exit 1
}

# Forward every argument transparently (-PluginDir / -DryRun / -NoColor / ...).
& $Canonical @args
exit $LASTEXITCODE
