#!/usr/bin/env node
/**
 * validate-install.js — Release gate for install/update integrity.
 *
 * Catches the bug class that repeatedly bit cross-machine setups:
 *   - install.ps1 drifting out of feature-parity with install.sh
 *     (missing source-repo.json, self-install guard, marketplace/cache
 *      mirror, MCP/memory seeding → `/update` fails on Windows installs)
 *   - update.js / update-platform.js syntax breakage
 *   - install scripts or their referenced installers going missing
 *
 * Pure checks (no network, no actual install). Designed to run inside
 * `npm run release` and `npm run ci` so install/update health is verified
 * automatically on every release instead of by hand.
 *
 * Exit codes: 0 = all checks pass, 1 = one or more errors.
 *
 * @module scripts/ci/validate-install
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeBash, toBashPath } from '../utils/bash-compat.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

/**
 * Feature-parity matrix between install.sh and install.ps1. Each capability
 * MUST be present in BOTH installers (matched by a marker substring). Adding a
 * new post-install step to one installer without the other is the exact drift
 * that broke Windows `/update`; this matrix fails the release until parity
 * is restored.
 *
 * @type {{ name: string, sh: string, ps1: string }[]}
 */
export const PARITY_MATRIX = [
  { name: 'prerequisites/claude-check', sh: 'check_prerequisites', ps1: 'Test-Prerequisites' },
  { name: 'self-install guard', sh: 'is_self_install', ps1: 'Test-SelfInstall' },
  { name: 'directory setup', sh: 'setup_directories', ps1: 'Initialize-Directories' },
  { name: 'marketplace mirror', sh: 'install_marketplace_mirror', ps1: 'Update-MarketplaceMirror' },
  { name: 'plugin cache', sh: 'install_plugin_cache', ps1: 'Update-PluginCache' },
  { name: 'mcp install', sh: 'install_mcp', ps1: 'Install-Mcp' },
  { name: 'source-repo.json', sh: 'save_source_path', ps1: 'Save-SourcePath' },
  { name: 'project CLAUDE.md seed', sh: 'seed_project_claude_md', ps1: 'Initialize-ProjectClaudeMd' },
  { name: 'local config seed', sh: 'seed_local_config', ps1: 'Initialize-LocalConfig' },
  { name: 'auto-memory seed', sh: 'seed_auto_memory', ps1: 'Initialize-AutoMemory' },
  { name: 'swarm consent', sh: 'setup_swarm_consent', ps1: 'Set-SwarmConsent' },
  { name: 'auto-learning', sh: 'setup_auto_learning', ps1: 'Set-AutoLearning' },
  { name: 'settings config', sh: 'configure_settings', ps1: 'Set-Settings' },
];

/** Files that must exist for install/update to function. */
export const REQUIRED_FILES = [
  'install.sh',
  'install.ps1',
  'scripts/update.js',
  'scripts/update-platform.js',
];

/**
 * Run all install/update validation checks against a plugin root.
 * Pure: returns structured results, never calls process.exit.
 *
 * @param {string} [root=PLUGIN_ROOT]
 * @returns {{ errors: string[], warnings: string[], passed: string[] }}
 */
export function runInstallChecks(root = PLUGIN_ROOT) {
  const errors = [];
  const warnings = [];
  const passed = [];

  // 1. Required files present.
  for (const rel of REQUIRED_FILES) {
    if (existsSync(path.join(root, rel))) passed.push(`exists: ${rel}`);
    else errors.push(`Missing required file: ${rel}`);
  }

  const shPath = path.join(root, 'install.sh');
  const ps1Path = path.join(root, 'install.ps1');
  const sh = existsSync(shPath) ? readFileSync(shPath, 'utf-8') : '';
  const ps1 = existsSync(ps1Path) ? readFileSync(ps1Path, 'utf-8') : '';

  // 2. install.sh ↔ install.ps1 feature parity.
  if (sh && ps1) {
    for (const cap of PARITY_MATRIX) {
      const inSh = sh.includes(cap.sh);
      const inPs1 = ps1.includes(cap.ps1);
      if (inSh && inPs1) {
        passed.push(`parity: ${cap.name}`);
      } else if (!inSh && !inPs1) {
        warnings.push(`parity capability "${cap.name}" absent from BOTH installers (matrix stale?)`);
      } else if (!inPs1) {
        errors.push(`install.ps1 missing "${cap.name}" (install.sh has \`${cap.sh}\`) — feature-parity drift`);
      } else {
        errors.push(`install.sh missing "${cap.name}" (install.ps1 has \`${cap.ps1}\`) — feature-parity drift`);
      }
    }
  }

  // 3. update.js self-install fallback must reference both installers.
  const updatePath = path.join(root, 'scripts', 'update.js');
  const updatePlatformPath = path.join(root, 'scripts', 'update-platform.js');
  const updateSrc = [updatePath, updatePlatformPath]
    .filter(existsSync)
    .map((p) => readFileSync(p, 'utf-8'))
    .join('\n');
  if (updateSrc) {
    if (updateSrc.includes('install.sh')) passed.push('update references install.sh');
    else errors.push('update.js/update-platform.js no longer references install.sh fallback');
    if (updateSrc.includes('install.ps1')) passed.push('update references install.ps1');
    else errors.push('update.js/update-platform.js no longer references install.ps1 (Windows path)');
  }

  // 4. Syntax checks (best-effort; skipped with a warning when the toolchain
  //    is unusable — bash absent, or a bash that cannot open native paths such
  //    as WSL bash when this process was launched from PowerShell).
  const node = process.execPath;
  for (const rel of ['scripts/update.js', 'scripts/update-platform.js']) {
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    try {
      execFileSync(node, ['--check', full], { stdio: 'pipe' });
      passed.push(`node --check: ${rel}`);
    } catch (err) {
      errors.push(`Syntax error in ${rel}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  if (sh) {
    // probeBash() checks that bash can OPEN a converted native path, not just
    // that a bash exists. `bash --version` succeeds under WSL bash, which then
    // reports "syntax error" on every Windows path it cannot open — turning an
    // environment mismatch into a fake install.sh defect. See bash-compat.js.
    const { ok: bashOk, reason: bashReason } = probeBash();
    if (bashOk) {
      try {
        execFileSync('bash', ['-n', toBashPath(shPath)], { stdio: 'pipe' });
        passed.push('bash -n: install.sh');
      } catch (err) {
        errors.push(`Syntax error in install.sh: ${String(err.stderr || err.message).split('\n')[0]}`);
      }
    } else {
      warnings.push(`skipped install.sh syntax check — ${bashReason}`);
    }
  }

  // 5. PowerShell syntax (best-effort; only when a PS host is present —
  //    typically local Windows, not Linux CI).
  if (ps1) {
    const pwsh = whichPwsh();
    if (pwsh) {
      try {
        execFileSync(
          pwsh,
          ['-NoProfile', '-NonInteractive', '-Command',
            `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){Write-Error ($e[0].Message);exit 1}`],
          { stdio: 'pipe' },
        );
        passed.push('PowerShell parse: install.ps1');
      } catch (err) {
        errors.push(`PowerShell parse error in install.ps1: ${String(err.stderr || err.message).split('\n')[0]}`);
      }
    } else {
      warnings.push('PowerShell host unavailable — skipped install.ps1 parse check');
    }
  }

  return { errors, warnings, passed };
}

function whichPwsh() {
  for (const cmd of ['pwsh', 'powershell']) {
    try {
      execFileSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function main() {
  const { errors, warnings, passed } = runInstallChecks();
  console.log('Artibot install/update validation');
  console.log(`  ${passed.length} checks passed`);
  for (const w of warnings) console.log(`${YELLOW}  ! ${w}${NC}`);
  if (errors.length) {
    console.log(`${RED}Errors:${NC}`);
    for (const e of errors) console.log(`${RED}  ✗ ${e}${NC}`);
    console.log(`${RED}✗ install/update validation failed (${errors.length})${NC}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ install/update validation passed${NC}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate-install.js')) {
  main();
}
