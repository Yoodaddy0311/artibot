/**
 * Tests for scripts/marketplace-validate.mjs — marketplace listing validator.
 *
 * Covers:
 *   1. parseArgs (--json / --quiet)
 *   2. checkRequiredFields (missing-field detection)
 *   3. checkVersionSync (mismatch detection)
 *   4. checkReadmeSections (section detection, case-insensitive)
 *   5. checkChangelogEntry (presence + version match)
 *   6. checkKeywordsCoverage (warns when recommended keywords missing)
 *   7. checkPricingShape / checkSafetyCompliance (well-formed vs malformed)
 *   8. runChecks end-to-end on a temp fixture (full pass + missing fields fail)
 *   9. summarize (counts pass/fail/warn correctly)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkChangelogEntry,
  checkKeywordsCoverage,
  checkPricingShape,
  checkQualityMetricsTests,
  checkReadmeSections,
  checkReleaseCurrentSync,
  checkRequiredFields,
  checkSafetyCompliance,
  checkVersionSync,
  parseArgs,
  runChecks,
  summarize,
} from '../../scripts/marketplace-validate.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix) {
  const dir = path.join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}

async function buildValidFixture() {
  const repoRoot = await makeTmpDir('mkt-repo');
  const pluginRoot = path.join(repoRoot, 'plugins', 'artibot');
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(pluginRoot, '_marketplace', 'screenshots'), { recursive: true });

  await writeJson(path.join(pluginRoot, 'marketplace.json'), {
    name: 'artibot',
    version: '3.9.0',
    description: 'desc',
    author: { name: 'Artience' },
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.com/x.git' },
    categories: ['orchestration'],
    keywords: ['ai', 'llm', 'agent', 'claude-code', 'mcp'],
    minimumClaudeCodeVersion: '1.0.0',
    supportedPlatforms: ['claude-code'],
    entryPoints: { agents: { count: 28 } },
    pricing: { model: 'free', license: 'MIT' },
    safetyCompliance: {
      dataPolicy: 'local-only',
      externalDatabaseAccess: 'forbidden',
    },
    qualityMetrics: { tests: 9600 },
    release: { current: '3.9.0', channel: 'stable' },
  });

  await writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), {
    name: 'artibot',
    version: '3.9.0',
  });

  await writeJson(path.join(pluginRoot, 'package.json'), {
    name: 'artibot',
    version: '3.9.0',
    keywords: ['ai', 'llm', 'agent', 'claude-code', 'mcp'],
  });

  await writeFile(
    path.join(pluginRoot, 'README.md'),
    '# Artibot\n\n## Quickstart\n\n## Installation\n\n## Features\n',
    'utf8',
  );
  await writeFile(
    path.join(pluginRoot, 'CHANGELOG.md'),
    '# Changelog\n\n## [3.9.0] - 2026-04-24\n\n### Added\n- stuff\n',
    'utf8',
  );
  await writeFile(path.join(repoRoot, 'LICENSE'), 'MIT License\n', 'utf8');

  // submission package
  for (const rel of [
    '_marketplace/README.md',
    '_marketplace/elevator-pitch.md',
    '_marketplace/feature-matrix.md',
    '_marketplace/demo-script.md',
    '_marketplace/SUBMISSION_CHECKLIST.md',
    '_marketplace/screenshots/README.md',
  ]) {
    await writeFile(path.join(pluginRoot, rel), '# placeholder\n', 'utf8');
  }

  return { repoRoot, pluginRoot };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('marketplace-validate/parseArgs', () => {
  it('default: json=false, quiet=false', () => {
    expect(parseArgs([])).toEqual({ json: false, quiet: false });
  });

  it('--json sets json=true', () => {
    expect(parseArgs(['--json']).json).toBe(true);
  });

  it('--quiet sets quiet=true', () => {
    expect(parseArgs(['--quiet']).quiet).toBe(true);
  });

  it('combines flags', () => {
    expect(parseArgs(['--json', '--quiet'])).toEqual({ json: true, quiet: true });
  });
});

// ---------------------------------------------------------------------------
// checkRequiredFields
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkRequiredFields', () => {
  it('passes when all required fields present', () => {
    const manifest = {
      name: 'x', version: '1.0.0', description: 'd',
      author: {}, license: 'MIT', repository: {},
      categories: [], keywords: [], minimumClaudeCodeVersion: '1.0.0',
      supportedPlatforms: [], entryPoints: {}, pricing: {}, safetyCompliance: {},
    };
    expect(checkRequiredFields(manifest).status).toBe('pass');
  });

  it('fails and reports missing fields', () => {
    const result = checkRequiredFields({ name: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('version');
    expect(result.detail).toContain('description');
  });
});

// ---------------------------------------------------------------------------
// checkVersionSync
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkVersionSync', () => {
  it('passes when all three versions match', () => {
    expect(checkVersionSync('3.9.0', '3.9.0', '3.9.0').status).toBe('pass');
  });

  it('fails on mismatch', () => {
    const r = checkVersionSync('3.9.0', '3.8.0', '3.9.0');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('plugin=3.8.0');
  });

  it('fails when any is null', () => {
    expect(checkVersionSync('3.9.0', null, '3.9.0').status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkReadmeSections
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkReadmeSections', () => {
  it('passes when all required sections present (case-insensitive)', () => {
    const text = '# Title\n## quickstart\n## INSTALLATION\n## Features\n';
    expect(checkReadmeSections(text).status).toBe('pass');
  });

  it('fails when a section is missing', () => {
    const text = '# Title\n## Quickstart\n## Features\n';
    const r = checkReadmeSections(text);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('Installation');
  });

  it('fails on empty text', () => {
    expect(checkReadmeSections('').status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkChangelogEntry
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkChangelogEntry', () => {
  it('passes when [version] header exists', () => {
    expect(checkChangelogEntry('## [3.9.0] - 2026', '3.9.0').status).toBe('pass');
  });

  it('passes when bare version mentioned', () => {
    expect(checkChangelogEntry('Released 3.9.0 today', '3.9.0').status).toBe('pass');
  });

  it('fails when version not present', () => {
    expect(checkChangelogEntry('## [3.8.0]', '3.9.0').status).toBe('fail');
  });

  it('fails on empty changelog', () => {
    expect(checkChangelogEntry('', '3.9.0').status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkKeywordsCoverage
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkKeywordsCoverage', () => {
  it('passes when all recommended keywords present', () => {
    const r = checkKeywordsCoverage(['ai', 'llm', 'agent', 'claude-code', 'mcp']);
    expect(r.status).toBe('pass');
  });

  it('warns (not fails) when some recommended keywords missing', () => {
    const r = checkKeywordsCoverage(['ai', 'agent']);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('llm');
    expect(r.detail).toContain('mcp');
  });

  it('warns on empty list', () => {
    expect(checkKeywordsCoverage([]).status).toBe('warn');
  });

  it('treats non-array as empty', () => {
    expect(checkKeywordsCoverage(undefined).status).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// checkPricingShape / checkSafetyCompliance
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkPricingShape', () => {
  it('passes with model + license', () => {
    expect(checkPricingShape({ model: 'free', license: 'MIT' }).status).toBe('pass');
  });

  it('fails when missing model', () => {
    expect(checkPricingShape({ license: 'MIT' }).status).toBe('fail');
  });

  it('fails when null', () => {
    expect(checkPricingShape(null).status).toBe('fail');
  });
});

describe('marketplace-validate/checkSafetyCompliance', () => {
  it('passes when dataPolicy=local-only and externalDatabaseAccess=forbidden', () => {
    const r = checkSafetyCompliance({
      dataPolicy: 'local-only',
      externalDatabaseAccess: 'forbidden',
    });
    expect(r.status).toBe('pass');
  });

  it('fails when dataPolicy is permissive', () => {
    const r = checkSafetyCompliance({
      dataPolicy: 'cloud',
      externalDatabaseAccess: 'forbidden',
    });
    expect(r.status).toBe('fail');
  });

  it('fails when undefined', () => {
    expect(checkSafetyCompliance(undefined).status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkReleaseCurrentSync
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkReleaseCurrentSync', () => {
  it('passes when release.current matches version', () => {
    expect(checkReleaseCurrentSync('4.19.4', '4.19.4').status).toBe('pass');
  });

  it('fails when release.current lags the version', () => {
    const r = checkReleaseCurrentSync('4.13.0', '4.19.4');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('release.current=4.13.0');
    expect(r.detail).toContain('version=4.19.4');
  });

  it('fails when version is missing', () => {
    expect(checkReleaseCurrentSync('4.19.4', undefined).status).toBe('fail');
  });

  it('fails when release.current is undefined', () => {
    expect(checkReleaseCurrentSync(undefined, '4.19.4').status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkQualityMetricsTests
// ---------------------------------------------------------------------------

describe('marketplace-validate/checkQualityMetricsTests', () => {
  it('passes when tests count is at or above the staleness floor', () => {
    expect(checkQualityMetricsTests({ tests: 9600 }).status).toBe('pass');
  });

  it('passes exactly at the floor', () => {
    expect(checkQualityMetricsTests({ tests: 5000 }).status).toBe('pass');
  });

  it('warns (not fails) when count is below the floor — likely stale', () => {
    const r = checkQualityMetricsTests({ tests: 4918 });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('4918');
    expect(r.detail).toContain('sync-marketplace-meta');
  });

  it('fails when tests is not an integer', () => {
    expect(checkQualityMetricsTests({ tests: 'lots' }).status).toBe('fail');
  });

  it('fails when qualityMetrics is missing', () => {
    expect(checkQualityMetricsTests(undefined).status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe('marketplace-validate/summarize', () => {
  it('counts pass / fail / warn', () => {
    const results = [
      { status: 'pass' }, { status: 'pass' },
      { status: 'fail' }, { status: 'warn' },
    ];
    expect(summarize(results)).toEqual({ total: 4, passed: 2, failed: 1, warned: 1 });
  });
});

// ---------------------------------------------------------------------------
// runChecks (end-to-end on temp fixture)
// ---------------------------------------------------------------------------

describe('marketplace-validate/runChecks (e2e)', () => {
  let fixture;

  beforeEach(async () => {
    fixture = await buildValidFixture();
  });

  afterEach(async () => {
    if (fixture?.repoRoot) {
      await rm(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('returns all-pass on a valid fixture', async () => {
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const summary = summarize(results);
    expect(summary.failed).toBe(0);
  });

  it('reports failure when marketplace.json is missing required fields', async () => {
    const manifestPath = path.join(fixture.pluginRoot, 'marketplace.json');
    await writeJson(manifestPath, {
      name: 'artibot',
      version: '3.9.0',
      // intentionally missing description, author, license, etc.
    });
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const summary = summarize(results);
    expect(summary.failed).toBeGreaterThan(0);
    const requiredFieldsCheck = results.find((r) => r.id === 'manifest.required-fields');
    expect(requiredFieldsCheck.status).toBe('fail');
  });

  it('reports failure on version mismatch', async () => {
    await writeJson(path.join(fixture.pluginRoot, '.claude-plugin', 'plugin.json'), {
      name: 'artibot',
      version: '3.8.0',
    });
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const versionCheck = results.find((r) => r.id === 'manifest.version-sync');
    expect(versionCheck.status).toBe('fail');
  });

  it('reports failure when CHANGELOG entry for current version missing', async () => {
    await writeFile(
      path.join(fixture.pluginRoot, 'CHANGELOG.md'),
      '# Changelog\n\n## [3.7.0] - 2026-04-01\n',
      'utf8',
    );
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const cl = results.find((r) => r.id === 'docs.changelog-entry');
    expect(cl.status).toBe('fail');
  });

  it('reports failure when submission package files are missing', async () => {
    await rm(path.join(fixture.pluginRoot, '_marketplace', 'feature-matrix.md'), { force: true });
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const missing = results.find((r) => r.id === 'submission._marketplace/feature-matrix.md');
    expect(missing.status).toBe('fail');
  });

  it('reports failure when LICENSE missing in both repo and plugin root', async () => {
    await rm(path.join(fixture.repoRoot, 'LICENSE'), { force: true });
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const lic = results.find((r) => r.id === 'docs.license-exists');
    expect(lic.status).toBe('fail');
  });

  it('reports failure when release.current lags the manifest version', async () => {
    const manifestPath = path.join(fixture.pluginRoot, 'marketplace.json');
    const manifest = JSON.parse(
      await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'),
    );
    manifest.release.current = '3.7.0'; // stale vs version 3.9.0
    await writeJson(manifestPath, manifest);
    const results = await runChecks({
      pluginRoot: fixture.pluginRoot,
      repoRoot: fixture.repoRoot,
    });
    const rel = results.find((r) => r.id === 'manifest.release-current-sync');
    expect(rel.status).toBe('fail');
  });
});
