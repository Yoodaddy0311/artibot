/**
 * Tests for scripts/ci/sync-marketplace-meta.mjs — marketplace metadata self-heal.
 *
 * Covers the pure exports (the impure main() is exercised end-to-end via the
 * release workflow, not unit tests):
 *   1. resolveTestCount — CLI arg > cached vitest report > null (never fabricated)
 *   2. computeDesired   — pulls version from plugin.json fixture; surfaces errors
 *   3. applyDesired     — edit detection for version / release.current /
 *                         qualityMetrics.tests, including the "no tests source"
 *                         (null) path that must leave the field untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyDesired,
  computeDesired,
  resolveTestCount,
} from '../../scripts/ci/sync-marketplace-meta.mjs';

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

// ---------------------------------------------------------------------------
// resolveTestCount
// ---------------------------------------------------------------------------

describe('sync-marketplace-meta/resolveTestCount', () => {
  it('prefers the explicit --tests CLI value', () => {
    expect(resolveTestCount({ tests: 9600 }, '/nonexistent')).toBe(9600);
  });

  it('falls back to a cached vitest report numTotalTests', async () => {
    const root = await makeTmpDir('mkt-tc');
    await writeJson(path.join(root, 'runtime', 'vitest-report.json'), {
      numTotalTests: 9600,
    });
    expect(resolveTestCount({ tests: null }, root)).toBe(9600);
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when no source exists (never fabricates)', async () => {
    const root = await makeTmpDir('mkt-tc-empty');
    expect(resolveTestCount({ tests: null }, root)).toBe(null);
    await rm(root, { recursive: true, force: true });
  });

  it('ignores a non-positive report count', async () => {
    const root = await makeTmpDir('mkt-tc-zero');
    await writeJson(path.join(root, 'runtime', 'vitest-report.json'), {
      numTotalTests: 0,
    });
    expect(resolveTestCount({ tests: null }, root)).toBe(null);
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// computeDesired
// ---------------------------------------------------------------------------

describe('sync-marketplace-meta/computeDesired', () => {
  let root;

  beforeEach(async () => {
    root = await makeTmpDir('mkt-cd');
    await writeJson(path.join(root, '.claude-plugin', 'plugin.json'), {
      name: 'artibot',
      version: '4.19.4',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('derives version from plugin.json and tests from the CLI arg', () => {
    const r = computeDesired({ tests: 9600 }, root);
    expect(r.ok).toBe(true);
    expect(r.desired).toEqual({ version: '4.19.4', tests: 9600 });
  });

  it('returns tests=null when no count source is available', () => {
    const r = computeDesired({ tests: null }, root);
    expect(r.ok).toBe(true);
    expect(r.desired.tests).toBe(null);
  });

  it('errors when plugin.json is unreadable', () => {
    const r = computeDesired({ tests: 9600 }, '/nonexistent-root');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('plugin.json');
  });
});

// ---------------------------------------------------------------------------
// applyDesired
// ---------------------------------------------------------------------------

describe('sync-marketplace-meta/applyDesired', () => {
  const baseManifest = () => ({
    name: 'artibot',
    version: '4.18.1',
    qualityMetrics: { tests: 4918, coverage: { lines: 90 } },
    release: { current: '4.13.0', channel: 'stable' },
  });

  it('rewrites all three stale fields and lists each edit', () => {
    const { next, edits } = applyDesired(baseManifest(), { version: '4.19.4', tests: 9600 });
    expect(next.version).toBe('4.19.4');
    expect(next.release.current).toBe('4.19.4');
    expect(next.qualityMetrics.tests).toBe(9600);
    const fields = edits.map((e) => e.field).sort();
    expect(fields).toEqual(['qualityMetrics.tests', 'release.current', 'version']);
  });

  it('is a no-op (zero edits) when already in sync', () => {
    const manifest = {
      name: 'artibot',
      version: '4.19.4',
      qualityMetrics: { tests: 9600 },
      release: { current: '4.19.4' },
    };
    const { edits } = applyDesired(manifest, { version: '4.19.4', tests: 9600 });
    expect(edits).toHaveLength(0);
  });

  it('leaves qualityMetrics.tests untouched when desired.tests is null', () => {
    const { next, edits } = applyDesired(baseManifest(), { version: '4.18.1', tests: null });
    expect(next.qualityMetrics.tests).toBe(4918); // unchanged
    expect(edits.map((e) => e.field)).not.toContain('qualityMetrics.tests');
  });

  it('preserves sibling fields it does not own', () => {
    const { next } = applyDesired(baseManifest(), { version: '4.19.4', tests: 9600 });
    expect(next.release.channel).toBe('stable');
    expect(next.qualityMetrics.coverage).toEqual({ lines: 90 });
  });

  it('creates missing release / qualityMetrics objects rather than throwing', () => {
    const { next } = applyDesired({ name: 'artibot', version: '4.18.1' }, {
      version: '4.19.4',
      tests: 9600,
    });
    expect(next.release.current).toBe('4.19.4');
    expect(next.qualityMetrics.tests).toBe(9600);
  });

  it('does not mutate the input manifest', () => {
    const input = baseManifest();
    applyDesired(input, { version: '4.19.4', tests: 9600 });
    expect(input.version).toBe('4.18.1');
    expect(input.release.current).toBe('4.13.0');
  });
});
