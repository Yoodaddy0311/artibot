#!/usr/bin/env node
/**
 * release-check.js — Verify release readiness before publishing.
 *
 * Checks:
 *   1. Version consistency across package.json, artibot.config.json, plugin.json
 *   2. CHANGELOG.md has an entry for the current version
 *   3. Installed copy at ~/.claude/artibot/ is in sync (warns if drift)
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — version mismatch or missing CHANGELOG entry (blocking)
 *   2 — installed copy drift only (warning; CI can ignore with --no-sync-check)
 *
 * Zero dependencies. Node 18+ built-ins only.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const SKIP_SYNC = args.includes('--no-sync-check');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(scriptDir, '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const errors = [];
const warnings = [];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

// 1. Version consistency
const sources = [
  ['package.json', path.join(PLUGIN_ROOT, 'package.json')],
  ['artibot.config.json', path.join(PLUGIN_ROOT, 'artibot.config.json')],
  ['.claude-plugin/plugin.json', path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')],
];

const versions = sources.map(([label, file]) => {
  if (!existsSync(file)) {
    errors.push(`Missing version file: ${label}`);
    return { label, version: null };
  }
  return { label, version: readJson(file).version || null };
});

const distinct = new Set(versions.map((v) => v.version).filter(Boolean));
if (distinct.size > 1) {
  errors.push('Version mismatch across files:');
  versions.forEach((v) => errors.push(`    ${v.label}: ${v.version ?? '(missing)'}`));
}

const canonicalVersion = versions[0].version;

// 2. CHANGELOG entry
const changelogPath = path.join(PLUGIN_ROOT, 'CHANGELOG.md');
if (existsSync(changelogPath) && canonicalVersion) {
  const changelog = readFileSync(changelogPath, 'utf-8');
  const headingRegex = new RegExp(`^##\\s*\\[?${canonicalVersion.replace(/\./g, '\\.')}\\]?`, 'm');
  if (!headingRegex.test(changelog)) {
    errors.push(`CHANGELOG.md missing entry for version ${canonicalVersion}`);
  }
} else if (!existsSync(changelogPath)) {
  warnings.push('CHANGELOG.md not found');
}

// 3. Installed copy drift
if (!SKIP_SYNC) {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const installedPkg = path.join(home, '.claude', 'artibot', 'package.json');
  if (existsSync(installedPkg)) {
    const installedVersion = readJson(installedPkg).version;
    if (installedVersion !== canonicalVersion) {
      warnings.push(
        `Installed copy drift: ~/.claude/artibot/ is at ${installedVersion}, source is ${canonicalVersion}. ` +
        `Run "npm run sync:local" to re-install.`
      );
    }
  } else {
    warnings.push('Installed copy not found at ~/.claude/artibot/ (first-time install?)');
  }
}

// Report
console.log(`Artibot release check (source version: ${canonicalVersion ?? 'unknown'})`);
console.log('');

if (errors.length === 0 && warnings.length === 0) {
  console.log(`${GREEN}✓ All checks passed${NC}`);
  process.exit(0);
}

if (warnings.length > 0) {
  console.log(`${YELLOW}Warnings:${NC}`);
  warnings.forEach((w) => console.log(`  ${YELLOW}!${NC} ${w}`));
  console.log('');
}

if (errors.length > 0) {
  console.log(`${RED}Errors:${NC}`);
  errors.forEach((e) => console.log(`  ${RED}✗${NC} ${e}`));
  console.log('');
  process.exit(1);
}

// Only warnings: exit 2 (soft fail — CI can ignore)
process.exit(2);
