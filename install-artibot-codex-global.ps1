[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [string]$GlobalAgentsRoot = '',
  [string]$GlobalCodexRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-UserHome {
  if ($env:USERPROFILE) {
    return $env:USERPROFILE
  }

  if ($HOME) {
    return $HOME
  }

  throw 'Unable to determine the current user home directory.'
}

function Assert-CommandExists {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Get-LinkTargets {
  param([System.IO.DirectoryInfo]$Item)

  if (-not $Item.Target) {
    return @()
  }

  if ($Item.Target -is [System.Array]) {
    return $Item.Target
  }

  return @($Item.Target)
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$userHome = Get-UserHome

if (-not $ProjectRoot) {
  $ProjectRoot = $scriptRoot
}

if (-not $GlobalAgentsRoot) {
  $GlobalAgentsRoot = Join-Path $userHome '.agents\skills'
}

if (-not $GlobalCodexRoot) {
  $GlobalCodexRoot = Join-Path $userHome '.codex\skills'
}

Assert-CommandExists -Name 'node'

$pluginRoot = Join-Path $ProjectRoot 'plugins\artibot'
$localSkillsRoot = Join-Path $ProjectRoot '.agents\skills'
$localAgentsFile = Join-Path $ProjectRoot 'AGENTS.md'
$localManifestFile = Join-Path $ProjectRoot 'agents\openai.yaml'

if (-not (Test-Path $pluginRoot)) {
  throw "Artibot plugin root not found: $pluginRoot"
}

New-Item -ItemType Directory -Force -Path $GlobalAgentsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $GlobalCodexRoot | Out-Null

Write-Host "Exporting Codex files into project root..."
$nodeScript = @"
import fs from 'node:fs/promises';
import path from 'node:path';
import { exportForCodex } from './plugins/artibot/lib/core/skill-exporter.js';

const projectRoot = process.cwd();
const pluginRoot = path.join(projectRoot, 'plugins', 'artibot');
const result = await exportForCodex({ pluginRoot });

for (const file of result.files) {
  const targetPath = path.join(projectRoot, file.path);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, file.content, 'utf8');
}

console.log(JSON.stringify({
  written: result.files.length,
  warnings: result.warnings
}, null, 2));
"@

$exportResult = $null
Push-Location $ProjectRoot
try {
  $exportResult = $nodeScript | node --input-type=module -
  if ($LASTEXITCODE -ne 0) {
    throw 'Codex export failed.'
  }
} finally {
  Pop-Location
}

Write-Host $exportResult

if (-not (Test-Path $localSkillsRoot)) {
  throw "Local skills directory was not created: $localSkillsRoot"
}

$sourceSkills = Get-ChildItem $localSkillsRoot -Directory | Sort-Object Name
$copied = 0
$linked = 0
$refreshedLinks = 0

Write-Host "Syncing $($sourceSkills.Count) skills into global directories..."
foreach ($skill in $sourceSkills) {
  $globalSkillDir = Join-Path $GlobalAgentsRoot $skill.Name
  $globalJunction = Join-Path $GlobalCodexRoot $skill.Name

  if (Test-Path $globalSkillDir) {
    Remove-Item $globalSkillDir -Recurse -Force
  }

  Copy-Item $skill.FullName -Destination $globalSkillDir -Recurse -Force
  $copied++

  if (Test-Path $globalJunction) {
    $junctionItem = Get-Item $globalJunction -Force
    $targets = Get-LinkTargets -Item $junctionItem
    $pointsToExpectedTarget = $junctionItem.LinkType -eq 'Junction' -and ($targets -contains $globalSkillDir)

    if ($pointsToExpectedTarget) {
      $refreshedLinks++
      continue
    }

    Remove-Item $globalJunction -Recurse -Force
  }

  New-Item -ItemType Junction -Path $globalJunction -Target $globalSkillDir | Out-Null
  $linked++
}

$summary = [pscustomobject]@{
  ProjectRoot = $ProjectRoot
  LocalAgentsFile = $localAgentsFile
  LocalManifestFile = $localManifestFile
  SourceSkillCount = $sourceSkills.Count
  GlobalAgentsRoot = $GlobalAgentsRoot
  GlobalCodexRoot = $GlobalCodexRoot
  CopiedSkills = $copied
  CreatedJunctions = $linked
  ReusedJunctions = $refreshedLinks
}

Write-Host ''
Write-Host 'Artibot global Codex install complete.'
$summary | Format-List
Write-Host ''
Write-Host 'Restart Codex to pick up new skills.'
