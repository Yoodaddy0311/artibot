#!/usr/bin/env node
/**
 * sync-marketplace-meta.mjs — Auto-fix marketplace.json metadata to match reality.
 *
 * marketplace.json carries three derived facts that drift silently because no
 * gate watched them: `version`, `qualityMetrics.tests`, and `release.current`.
 * (Field audit 2026-06-05 found version 4.18.1, tests 4918, current 4.13.0 — all
 * stale against the live 4.19.4 / 9600 reality.) marketplace-validate.mjs already
 * fails on version drift, but the test count and release.current had no source of
 * truth wired in, so a release could bump plugin.json and leave these behind.
 *
 * This is the marketplace counterpart to sync-readme-claims.js: it reuses the
 * authoritative sources (plugin.json for version, a vitest count for tests) and
 * rewrites the three fields in place instead of failing on drift. Run it in the
 * release sync step (before the marketplace-validate gate) so the metadata never
 * reaches a human stale.
 *
 * Sources of truth:
 *   version            — plugins/artibot/.claude-plugin/plugin.json `version`
 *   release.current    — same plugin.json `version`
 *   qualityMetrics.tests
 *                      — measured test-case count. Preferred order:
 *                        1. --tests=N CLI arg (release pipeline passes the count
 *                           it already computed, avoids a second vitest run)
 *                        2. a cached vitest JSON report at
 *                           runtime/vitest-report.json (numTotalTests)
 *                        3. left unchanged (never fabricated) when neither exists
 *
 * Modes:
 *   (default)  — Rewrite drifting fields in marketplace.json. Idempotent: a
 *                no-op when already in sync.
 *   --check    — Report would-be changes and exit 1 if any (CI dry-run); makes
 *                no writes. Exit 0 when already in sync.
 *
 * Options:
 *   --tests=N  — Supply the authoritative test-case count directly (integer).
 *
 * Exit codes:
 *   0 — in sync (or successfully rewritten in write mode)
 *   1 — (--check only) drift detected that a write run would fix
 *   2 — invocation error (unreadable plugin.json / marketplace.json)
 *
 * Zero dependencies. Node 20+ built-ins only.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(scriptDir, '..', '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function parseArgs(argv) {
  const out = { check: false, tests: null };
  for (const a of argv) {
    if (a === '--check') out.check = true;
    else if (a.startsWith('--tests=')) {
      const n = Number.parseInt(a.slice('--tests='.length), 10);
      if (Number.isInteger(n) && n > 0) out.tests = n;
    }
  }
  return out;
}

function readJsonSafe(file) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf-8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Resolve the authoritative test-case count.
 * @param {{ tests: number|null }} opts
 * @param {string} pluginRoot
 * @returns {number|null} count, or null when no trustworthy source exists
 */
export function resolveTestCount(opts, pluginRoot = PLUGIN_ROOT) {
  if (Number.isInteger(opts.tests) && opts.tests > 0) return opts.tests;
  const report = path.join(pluginRoot, 'runtime', 'vitest-report.json');
  const read = readJsonSafe(report);
  if (read.ok && Number.isInteger(read.data?.numTotalTests) && read.data.numTotalTests > 0) {
    return read.data.numTotalTests;
  }
  return null;
}

/**
 * Compute the desired field values from sources of truth.
 * @returns {{ ok: boolean, error?: string, desired?: {version:string, tests:number|null} }}
 */
export function computeDesired(opts, pluginRoot = PLUGIN_ROOT) {
  const pluginRead = readJsonSafe(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  if (!pluginRead.ok) {
    return { ok: false, error: `plugin.json unreadable: ${pluginRead.error}` };
  }
  const version = pluginRead.data.version;
  if (typeof version !== 'string' || version.length === 0) {
    return { ok: false, error: 'plugin.json has no version' };
  }
  return { ok: true, desired: { version, tests: resolveTestCount(opts, pluginRoot) } };
}

/**
 * Apply desired values to a parsed manifest, returning the edit list (pure).
 * `tests === null` means "no trustworthy source" → leave the field as-is.
 * @returns {{ next: object, edits: Array<{field:string, from:any, to:any}> }}
 */
export function applyDesired(manifest, desired) {
  const next = structuredClone(manifest);
  const edits = [];

  if (next.version !== desired.version) {
    edits.push({ field: 'version', from: next.version, to: desired.version });
    next.version = desired.version;
  }

  if (!next.release || typeof next.release !== 'object') next.release = {};
  if (next.release.current !== desired.version) {
    edits.push({ field: 'release.current', from: next.release.current, to: desired.version });
    next.release.current = desired.version;
  }

  if (desired.tests !== null) {
    if (!next.qualityMetrics || typeof next.qualityMetrics !== 'object') next.qualityMetrics = {};
    if (next.qualityMetrics.tests !== desired.tests) {
      edits.push({ field: 'qualityMetrics.tests', from: next.qualityMetrics.tests, to: desired.tests });
      next.qualityMetrics.tests = desired.tests;
    }
  }

  return { next, edits };
}

/**
 * Apply desired version to the root .claude-plugin/marketplace.json (the
 * Claude Code marketplace routing file). Returns edit list (pure).
 */
export function applyDesiredToRoot(rootManifest, desired) {
  const next = structuredClone(rootManifest);
  const edits = [];

  if (Array.isArray(next.plugins)) {
    for (let i = 0; i < next.plugins.length; i++) {
      const entry = next.plugins[i];
      if (entry?.name === 'artibot' && entry.version !== desired.version) {
        edits.push({ field: `plugins[${i}].version`, from: entry.version, to: desired.version });
        next.plugins[i] = { ...entry, version: desired.version };
      }
    }
  }

  return { next, edits };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(PLUGIN_ROOT, 'marketplace.json');
  // Root .claude-plugin/marketplace.json is the Claude Code marketplace routing
  // entry. It drifted to 4.13.1 while plugin.json was 4.19.6 (incident
  // 2026-06-08) because nothing wrote to it. Include it here so the same
  // version sync covers both files in one pass.
  const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
  const rootManifestPath = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

  const manifestRead = readJsonSafe(manifestPath);
  if (!manifestRead.ok) {
    console.error(`${RED}marketplace.json unreadable: ${manifestRead.error}${NC}`);
    process.exit(2);
  }

  const rootManifestRead = readJsonSafe(rootManifestPath);
  if (!rootManifestRead.ok) {
    console.error(`${RED}root .claude-plugin/marketplace.json unreadable: ${rootManifestRead.error}${NC}`);
    process.exit(2);
  }

  const computed = computeDesired(opts);
  if (!computed.ok) {
    console.error(`${RED}${computed.error}${NC}`);
    process.exit(2);
  }

  const { desired } = computed;
  console.log(`Artibot marketplace meta sync (mode: ${opts.check ? 'check' : 'write'})`);
  console.log(`  version            ${desired.version}`);
  console.log(`  release.current    ${desired.version}`);
  console.log(
    `  qualityMetrics.tests ${desired.tests === null ? '(no source — unchanged)' : desired.tests}`
  );
  console.log('');

  const { next, edits } = applyDesired(manifestRead.data, desired);
  const { next: rootNext, edits: rootEdits } = applyDesiredToRoot(rootManifestRead.data, desired);

  if (edits.length === 0 && rootEdits.length === 0) {
    console.log(`${GREEN}marketplace.json metadata already in sync — no changes.${NC}`);
    process.exit(0);
  }

  for (const e of edits) {
    const verb = opts.check ? 'would rewrite' : 'rewrote';
    console.log(`  ${YELLOW}${verb}${NC} marketplace.json ${e.field}: ${e.from} -> ${e.to}`);
  }
  for (const e of rootEdits) {
    const verb = opts.check ? 'would rewrite' : 'rewrote';
    console.log(`  ${YELLOW}${verb}${NC} <repo>/.claude-plugin/marketplace.json ${e.field}: ${e.from} -> ${e.to}`);
  }
  console.log('');

  if (opts.check) {
    console.log(`${RED}Drift detected. Run \`node scripts/ci/sync-marketplace-meta.mjs\` to fix.${NC}`);
    process.exit(1);
  }

  // Preserve trailing newline (the files end with one).
  if (edits.length > 0) {
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  if (rootEdits.length > 0) {
    writeFileSync(rootManifestPath, `${JSON.stringify(rootNext, null, 2)}\n`);
  }
  console.log(`${GREEN}marketplace.json metadata synced to sources of truth.${NC}`);
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by tests).
// Absolute-path comparison avoids the Korean-path / percent-encoding mismatch
// (project memory: Windows + non-ASCII chars break file:// URL equality).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main();
}
