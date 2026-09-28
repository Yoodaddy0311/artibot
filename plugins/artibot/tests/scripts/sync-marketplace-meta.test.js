/**
 * Tests for scripts/ci/sync-marketplace-meta.mjs — marketplace metadata self-heal.
 *
 * Covers the pure exports, plus the write path and main() against temp copies:
 *   1. resolveTestCount — CLI arg > cached vitest report > null (never fabricated)
 *   2. computeDesired   — pulls version from plugin.json fixture; surfaces errors
 *   3. applyDesired     — edit detection for version / release.current /
 *                         qualityMetrics.tests, including the "no tests source"
 *                         (null) path that must leave the field untouched.
 *   4. writeJsonPreservingEol — a rewrite keeps the original file's line
 *                         endings (CRLF stays CRLF, LF stays LF) and skips the
 *                         write when the bytes would not change.
 *   5. main() end-to-end  — a copy of the script run against a temp repo tree,
 *                         so the real manifests are never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  applyDesired,
  computeDesired,
  resolveTestCount,
  writeJsonPreservingEol,
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

// ---------------------------------------------------------------------------
// EOL preservation (v4.67.0 release had to hand-restore CRLF after the sync
// rewrote both CRLF working-tree manifests as LF)
// ---------------------------------------------------------------------------

const toCrlf = (s) => s.replace(/\n/g, '\r\n');
const hasBareLf = (s) => /(^|[^\r])\n/.test(s);
const PAST = new Date('2020-01-01T00:00:00Z');

function pinPastMtime(file) {
  utimesSync(file, PAST, PAST);
  return statSync(file).mtimeMs;
}

describe('sync-marketplace-meta/writeJsonPreservingEol', () => {
  const stale = { name: 'artibot', version: '4.18.1', release: { current: '4.18.1' } };
  let root;

  beforeEach(async () => {
    root = await makeTmpDir('mkt-eol');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rewrites a CRLF original as CRLF on every line, including the last', async () => {
    const file = path.join(root, 'marketplace.json');
    await writeFile(file, toCrlf(`${JSON.stringify(stale, null, 2)}\n`), 'utf8');
    const { next, edits } = applyDesired(stale, { version: '4.19.4', tests: null });
    expect(edits.length).toBeGreaterThan(0);

    expect(writeJsonPreservingEol(file, next)).toBe(true);
    const out = readFileSync(file, 'utf8');
    expect(JSON.parse(out).version).toBe('4.19.4');
    expect(hasBareLf(out)).toBe(false);
    expect(out.endsWith('}\r\n')).toBe(true);
  });

  it('keeps an LF original LF (no CR introduced)', async () => {
    const file = path.join(root, 'marketplace.json');
    await writeFile(file, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');
    const { next } = applyDesired(stale, { version: '4.19.4', tests: null });

    expect(writeJsonPreservingEol(file, next)).toBe(true);
    const out = readFileSync(file, 'utf8');
    expect(JSON.parse(out).version).toBe('4.19.4');
    expect(out).not.toContain('\r');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('does not write a CRLF original whose content is already in sync', async () => {
    const file = path.join(root, 'marketplace.json');
    const bytes = toCrlf(`${JSON.stringify(stale, null, 2)}\n`);
    await writeFile(file, bytes, 'utf8');
    const before = pinPastMtime(file);

    expect(writeJsonPreservingEol(file, stale)).toBe(false);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
});

describe('sync-marketplace-meta/main (temp repo copy)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const realPluginRoot = path.resolve(here, '..', '..');
  const pluginManifest = { name: 'artibot', version: '4.18.1', release: { current: '4.18.1' } };
  const rootManifest = { name: 'mkt', plugins: [{ name: 'artibot', version: '4.18.1' }] };
  let repo;
  let pluginRoot;
  let script;
  let pluginMkt;
  let rootMkt;

  beforeEach(async () => {
    repo = await makeTmpDir('mkt-main');
    pluginRoot = path.join(repo, 'plugins', 'artibot');
    script = path.join(pluginRoot, 'scripts', 'ci', 'sync-marketplace-meta.mjs');
    pluginMkt = path.join(pluginRoot, 'marketplace.json');
    rootMkt = path.join(repo, '.claude-plugin', 'marketplace.json');
    for (const rel of ['scripts/ci/sync-marketplace-meta.mjs', 'scripts/hooks/_main-entry.js']) {
      await mkdir(path.dirname(path.join(pluginRoot, rel)), { recursive: true });
      await copyFile(path.join(realPluginRoot, rel), path.join(pluginRoot, rel));
    }
    await mkdir(path.dirname(rootMkt), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function seed(version, eolOf) {
    await writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), { version });
    const pluginText = `${JSON.stringify(pluginManifest, null, 2)}\n`;
    const rootText = `${JSON.stringify(rootManifest, null, 2)}\n`;
    await writeFile(pluginMkt, eolOf.plugin === 'crlf' ? toCrlf(pluginText) : pluginText, 'utf8');
    await writeFile(rootMkt, eolOf.root === 'crlf' ? toCrlf(rootText) : rootText, 'utf8');
  }

  const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8' });

  it('syncs a version bump and keeps each file on its own line ending', async () => {
    await seed('4.19.4', { plugin: 'lf', root: 'crlf' });
    run();
    const pluginOut = readFileSync(pluginMkt, 'utf8');
    const rootOut = readFileSync(rootMkt, 'utf8');
    expect(JSON.parse(pluginOut).version).toBe('4.19.4');
    expect(JSON.parse(rootOut).plugins[0].version).toBe('4.19.4');
    expect(pluginOut).not.toContain('\r');
    expect(hasBareLf(rootOut)).toBe(false);
    expect(rootOut.endsWith('}\r\n')).toBe(true);
  });

  it('leaves in-sync CRLF manifests unwritten', async () => {
    await seed('4.18.1', { plugin: 'crlf', root: 'crlf' });
    const before = [pinPastMtime(pluginMkt), pinPastMtime(rootMkt)];
    const bytes = [readFileSync(pluginMkt, 'utf8'), readFileSync(rootMkt, 'utf8')];
    expect(run()).toContain('already in sync');
    expect([statSync(pluginMkt).mtimeMs, statSync(rootMkt).mtimeMs]).toEqual(before);
    expect([readFileSync(pluginMkt, 'utf8'), readFileSync(rootMkt, 'utf8')]).toEqual(bytes);
  });
});
