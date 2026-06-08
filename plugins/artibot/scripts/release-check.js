#!/usr/bin/env node
/**
 * release-check.js — Verify release readiness before publishing.
 *
 * Checks:
 *   1. Version consistency across the lockstep set (per AGENTS.md §8):
 *        package.json, artibot.config.json, .claude-plugin/plugin.json,
 *        .well-known/mcp-server.json, AGENTS.md ("Current plugin version: **X**"),
 *        plus the README version badges (root README.md — GitHub-visible —
 *        and plugins/artibot/README.md) which used to drift silently.
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

// 1. Version consistency — lockstep set (AGENTS.md §8)
// Includes the repo-root package.json + both marketplace.json files because
// drift on those silently routes Claude Code's marketplace cache to the wrong
// plugin version (incident: 4.13.1 vs 4.19.6 mismatch surfaced 2026-06-08).
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const sources = [
  ['package.json', path.join(PLUGIN_ROOT, 'package.json')],
  ['artibot.config.json', path.join(PLUGIN_ROOT, 'artibot.config.json')],
  ['.claude-plugin/plugin.json', path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')],
  ['.well-known/mcp-server.json', path.join(PLUGIN_ROOT, '.well-known', 'mcp-server.json')],
  ['<repo>/package.json', path.join(REPO_ROOT, 'package.json')],
];

const versions = sources.map(([label, file]) => {
  if (!existsSync(file)) {
    errors.push(`Missing version file: ${label}`);
    return { label, version: null };
  }
  return { label, version: readJson(file).version || null };
});

// AGENTS.md is markdown — extract the lockstep version line.
const agentsPath = path.join(PLUGIN_ROOT, 'AGENTS.md');
if (existsSync(agentsPath)) {
  const agentsBody = readFileSync(agentsPath, 'utf-8');
  const match = agentsBody.match(/Current plugin version:\s*\*\*([^*]+)\*\*/);
  versions.push({ label: 'AGENTS.md', version: match ? match[1].trim() : null });
  if (!match) {
    errors.push('AGENTS.md missing "Current plugin version: **X.Y.Z**" line');
  }
} else {
  errors.push('Missing version file: AGENTS.md');
  versions.push({ label: 'AGENTS.md', version: null });
}

// README version badges participate in the lockstep too. These are markdown
// (not JSON) and the GitHub-visible root README in particular drifted silently
// across releases because nothing enforced it. Now it does.
const READMES = [
  ['README.md (root)', path.resolve(PLUGIN_ROOT, '..', '..', 'README.md')],
  ['plugins/artibot/README.md', path.join(PLUGIN_ROOT, 'README.md')],
];
for (const [label, file] of READMES) {
  if (!existsSync(file)) {
    errors.push(`Missing version file: ${label}`);
    versions.push({ label, version: null });
    continue;
  }
  const badge = readFileSync(file, 'utf-8').match(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/);
  versions.push({ label, version: badge ? badge[1] : null });
  if (!badge) {
    errors.push(`${label} missing version badge "badge/version-X.Y.Z-"`);
  }
}

// Marketplace JSON files participate in the lockstep but use nested key paths
// (plugin entry version + release.current). Drift here routes Claude Code's
// per-version plugin cache to stale code (2026-06-08 incident).
const rootMarketplacePath = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
if (existsSync(rootMarketplacePath)) {
  const mkt = readJson(rootMarketplacePath);
  const artibotEntry = Array.isArray(mkt.plugins) ? mkt.plugins.find((p) => p?.name === 'artibot') : null;
  versions.push({ label: '<repo>/.claude-plugin/marketplace.json#/plugins[artibot].version', version: artibotEntry?.version ?? null });
  if (!artibotEntry) {
    errors.push('<repo>/.claude-plugin/marketplace.json missing artibot plugin entry');
  }
} else {
  errors.push('Missing version file: <repo>/.claude-plugin/marketplace.json');
}

const publicMarketplacePath = path.join(PLUGIN_ROOT, 'marketplace.json');
if (existsSync(publicMarketplacePath)) {
  const pub = readJson(publicMarketplacePath);
  versions.push({ label: 'marketplace.json#/version', version: pub.version ?? null });
  versions.push({ label: 'marketplace.json#/release.current', version: pub.release?.current ?? null });
} else {
  errors.push('Missing version file: plugins/artibot/marketplace.json');
}

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
