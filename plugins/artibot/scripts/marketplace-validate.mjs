#!/usr/bin/env node
/**
 * Artibot Marketplace Listing Validator
 *
 * Validates the marketplace submission package:
 *   - marketplace.json (required fields, type checks, version sync)
 *   - README.md sections (Quickstart, Installation, Features)
 *   - LICENSE file
 *   - CHANGELOG.md entry for current version
 *   - _marketplace/ directory + screenshots dir
 *   - package.json keywords coverage
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed
 *   2 — invocation error (bad CLI args, missing repo root)
 *
 * Usage:
 *   node scripts/marketplace-validate.mjs
 *   node scripts/marketplace-validate.mjs --json
 *   node scripts/marketplace-validate.mjs --quiet
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');

const REQUIRED_TOP_FIELDS = [
  'name', 'version', 'description', 'author', 'license',
  'repository', 'categories', 'keywords', 'minimumClaudeCodeVersion',
  'supportedPlatforms', 'entryPoints', 'pricing', 'safetyCompliance',
];

const REQUIRED_README_SECTIONS = ['Quickstart', 'Installation', 'Features'];

const RECOMMENDED_KEYWORDS = ['ai', 'llm', 'agent', 'claude-code', 'mcp'];

const REQUIRED_SUBMISSION_FILES = [
  '_marketplace/README.md',
  '_marketplace/elevator-pitch.md',
  '_marketplace/feature-matrix.md',
  '_marketplace/demo-script.md',
  '_marketplace/SUBMISSION_CHECKLIST.md',
  '_marketplace/screenshots/README.md',
];

// ---------------------------------------------------------------------------
// helpers (pure)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    quiet: argv.includes('--quiet'),
  };
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJsonSafe(p) {
  try {
    const raw = await readFile(p, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function readTextSafe(p) {
  try {
    return { ok: true, text: await readFile(p, 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// individual checks (each returns { id, label, status, detail })
// ---------------------------------------------------------------------------

export function checkRequiredFields(manifest) {
  const missing = REQUIRED_TOP_FIELDS.filter((f) => !(f in manifest));
  return {
    id: 'manifest.required-fields',
    label: 'marketplace.json contains all required top-level fields',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0 ? null : `missing: ${missing.join(', ')}`,
  };
}

export function checkVersionSync(marketplaceVersion, pluginVersion, packageVersion) {
  const versions = [marketplaceVersion, pluginVersion, packageVersion];
  const allDefined = versions.every(Boolean);
  const allEqual = allDefined && versions.every((v) => v === marketplaceVersion);
  return {
    id: 'manifest.version-sync',
    label: 'version matches plugin.json + package.json',
    status: allEqual ? 'pass' : 'fail',
    detail: allEqual
      ? null
      : `marketplace=${marketplaceVersion} plugin=${pluginVersion} package=${packageVersion}`,
  };
}

export function checkReleaseCurrentSync(releaseCurrent, version) {
  const inSync = Boolean(version) && releaseCurrent === version;
  return {
    id: 'manifest.release-current-sync',
    label: 'release.current matches manifest version',
    status: inSync ? 'pass' : 'fail',
    detail: inSync ? null : `release.current=${releaseCurrent} version=${version}`,
  };
}

// qualityMetrics.tests is a release-synced count (see sync-marketplace-meta.mjs).
// We can't recompute the exact test-case count cheaply here, but we CAN catch the
// classic staleness failure mode: a count left frozen across many releases until
// it is wildly below reality. Floor guards against the 4918-while-actually-9600
// drift the 2026-06-05 audit found, without coupling the validator to an exact
// (and constantly moving) number.
const MIN_EXPECTED_TESTS = 5000;

export function checkQualityMetricsTests(qualityMetrics) {
  const tests = qualityMetrics?.tests;
  if (typeof tests !== 'number' || !Number.isInteger(tests)) {
    return {
      id: 'manifest.quality-tests',
      label: 'qualityMetrics.tests is a positive integer',
      status: 'fail',
      detail: `tests=${tests} (expected positive integer)`,
    };
  }
  const ok = tests >= MIN_EXPECTED_TESTS;
  return {
    id: 'manifest.quality-tests',
    label: `qualityMetrics.tests is present and not obviously stale (>= ${MIN_EXPECTED_TESTS})`,
    status: ok ? 'pass' : 'warn',
    detail: ok
      ? null
      : `tests=${tests} below floor ${MIN_EXPECTED_TESTS} — likely stale; run sync-marketplace-meta.mjs`,
  };
}

export function checkReadmeSections(readmeText) {
  if (!readmeText) {
    return {
      id: 'docs.readme-sections',
      label: `README.md contains required sections (${REQUIRED_README_SECTIONS.join(', ')})`,
      status: 'fail',
      detail: 'README.md not readable',
    };
  }
  const lower = readmeText.toLowerCase();
  const missing = REQUIRED_README_SECTIONS.filter((s) => !lower.includes(s.toLowerCase()));
  return {
    id: 'docs.readme-sections',
    label: `README.md contains required sections (${REQUIRED_README_SECTIONS.join(', ')})`,
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0 ? null : `missing: ${missing.join(', ')}`,
  };
}

export function checkChangelogEntry(changelogText, version) {
  if (!changelogText || !version) {
    return {
      id: 'docs.changelog-entry',
      label: `CHANGELOG.md contains entry for v${version}`,
      status: 'fail',
      detail: 'CHANGELOG.md not readable or version unknown',
    };
  }
  // Match "[X.Y.Z]" or "X.Y.Z" anywhere
  const pattern = new RegExp(`(\\[\\s*${version.replace(/\./g, '\\.')}\\s*\\])|(\\b${version.replace(/\./g, '\\.')}\\b)`);
  const found = pattern.test(changelogText);
  return {
    id: 'docs.changelog-entry',
    label: `CHANGELOG.md contains entry for v${version}`,
    status: found ? 'pass' : 'fail',
    detail: found ? null : `no entry matching ${version} found`,
  };
}

export function checkKeywordsCoverage(keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  const missing = RECOMMENDED_KEYWORDS.filter((k) => !list.includes(k));
  return {
    id: 'manifest.recommended-keywords',
    label: `package.json includes recommended keywords (${RECOMMENDED_KEYWORDS.join(', ')})`,
    status: missing.length === 0 ? 'pass' : 'warn',
    detail: missing.length === 0 ? null : `missing recommended: ${missing.join(', ')}`,
  };
}

export function checkPricingShape(pricing) {
  if (!pricing || typeof pricing !== 'object') {
    return {
      id: 'manifest.pricing',
      label: 'pricing block is present and well-formed',
      status: 'fail',
      detail: 'pricing missing or not an object',
    };
  }
  const hasModel = typeof pricing.model === 'string' && pricing.model.length > 0;
  const hasLicense = typeof pricing.license === 'string' && pricing.license.length > 0;
  return {
    id: 'manifest.pricing',
    label: 'pricing block is present and well-formed',
    status: hasModel && hasLicense ? 'pass' : 'fail',
    detail: hasModel && hasLicense ? null : 'pricing.model and pricing.license required',
  };
}

export function checkSafetyCompliance(safety) {
  if (!safety || typeof safety !== 'object') {
    return {
      id: 'manifest.safety',
      label: 'safetyCompliance reflects local-only data policy',
      status: 'fail',
      detail: 'safetyCompliance missing or not an object',
    };
  }
  const local = safety.dataPolicy === 'local-only';
  const noExternal = safety.externalDatabaseAccess === 'forbidden';
  return {
    id: 'manifest.safety',
    label: 'safetyCompliance reflects local-only data policy',
    status: local && noExternal ? 'pass' : 'fail',
    detail: local && noExternal
      ? null
      : `dataPolicy=${safety.dataPolicy} externalDatabaseAccess=${safety.externalDatabaseAccess}`,
  };
}

// ---------------------------------------------------------------------------
// orchestrator (impure — reads filesystem)
// ---------------------------------------------------------------------------

export async function runChecks({ pluginRoot = PLUGIN_ROOT, repoRoot = REPO_ROOT } = {}) {
  const results = [];

  // Manifest read
  const manifestPath = resolve(pluginRoot, 'marketplace.json');
  const manifestRead = await readJsonSafe(manifestPath);
  results.push({
    id: 'manifest.exists',
    label: 'marketplace.json exists and is valid JSON',
    status: manifestRead.ok ? 'pass' : 'fail',
    detail: manifestRead.ok ? null : manifestRead.error,
  });
  const manifest = manifestRead.ok ? manifestRead.data : {};

  if (manifestRead.ok) {
    results.push(checkRequiredFields(manifest));
    results.push(checkPricingShape(manifest.pricing));
    results.push(checkSafetyCompliance(manifest.safetyCompliance));
  }

  // Version sync
  const pluginManifestRead = await readJsonSafe(resolve(pluginRoot, '.claude-plugin', 'plugin.json'));
  const packageJsonRead = await readJsonSafe(resolve(pluginRoot, 'package.json'));
  results.push(checkVersionSync(
    manifest.version,
    pluginManifestRead.ok ? pluginManifestRead.data.version : null,
    packageJsonRead.ok ? packageJsonRead.data.version : null,
  ));

  // Release / metrics freshness (auto-healed by sync-marketplace-meta.mjs).
  if (manifestRead.ok) {
    results.push(checkReleaseCurrentSync(manifest.release?.current, manifest.version));
    results.push(checkQualityMetricsTests(manifest.qualityMetrics));
  }

  // README
  const readmeRead = await readTextSafe(resolve(pluginRoot, 'README.md'));
  results.push({
    id: 'docs.readme-exists',
    label: 'README.md exists',
    status: readmeRead.ok ? 'pass' : 'fail',
    detail: readmeRead.ok ? null : readmeRead.error,
  });
  results.push(checkReadmeSections(readmeRead.ok ? readmeRead.text : ''));

  // LICENSE — check both repo root and plugin root
  const licenseAtRepo = await pathExists(resolve(repoRoot, 'LICENSE'));
  const licenseAtPlugin = await pathExists(resolve(pluginRoot, 'LICENSE'));
  results.push({
    id: 'docs.license-exists',
    label: 'LICENSE file exists (repo root or plugin root)',
    status: licenseAtRepo || licenseAtPlugin ? 'pass' : 'fail',
    detail: licenseAtRepo || licenseAtPlugin ? null : 'LICENSE not found at repo root or plugin root',
  });

  // CHANGELOG
  const changelogRead = await readTextSafe(resolve(pluginRoot, 'CHANGELOG.md'));
  results.push({
    id: 'docs.changelog-exists',
    label: 'CHANGELOG.md exists',
    status: changelogRead.ok ? 'pass' : 'fail',
    detail: changelogRead.ok ? null : changelogRead.error,
  });
  results.push(checkChangelogEntry(
    changelogRead.ok ? changelogRead.text : '',
    manifest.version,
  ));

  // Submission package files
  for (const rel of REQUIRED_SUBMISSION_FILES) {
    const exists = await pathExists(resolve(pluginRoot, rel));
    results.push({
      id: `submission.${rel}`,
      label: `submission file present: ${rel}`,
      status: exists ? 'pass' : 'fail',
      detail: exists ? null : `missing ${rel}`,
    });
  }

  // package.json keywords (recommended; warn only)
  if (packageJsonRead.ok) {
    results.push(checkKeywordsCoverage(packageJsonRead.data.keywords ?? manifest.keywords));
  }

  return results;
}

// ---------------------------------------------------------------------------
// reporters
// ---------------------------------------------------------------------------

export function summarize(results) {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    warned: results.filter((r) => r.status === 'warn').length,
  };
}

function formatHuman(results, summary) {
  const lines = [];
  lines.push('# Marketplace Validation Report');
  lines.push('');
  lines.push(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Warned: ${summary.warned}`);
  lines.push('');
  lines.push('| Status | Check | Detail |');
  lines.push('|---|---|---|');
  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : 'FAIL';
    const detail = r.detail ? r.detail.replace(/\|/g, '\\|') : '';
    lines.push(`| ${icon} | ${r.label} | ${detail} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = await runChecks();
  const summary = summarize(results);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  } else if (!args.quiet) {
    process.stdout.write(`${formatHuman(results, summary)}\n`);
  } else if (summary.failed > 0) {
    process.stdout.write(`marketplace-validate: ${summary.failed} failed, ${summary.warned} warned\n`);
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

// Only run main() when invoked directly (not when imported by tests).
// Absolute-path comparison avoids the Korean-path / percent-encoding mismatch
// (project memory: Windows + non-ASCII chars break file:// URL equality).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main().catch((err) => {
    process.stderr.write(`marketplace-validate error: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
