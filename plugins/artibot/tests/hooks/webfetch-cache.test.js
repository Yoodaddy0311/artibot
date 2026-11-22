import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getHomeDir } from '../../lib/core/platform.js';
import { EGRESS_PATTERNS, findEgress, globalNetNames, importSpecifiers } from '../helpers/no-egress.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(TEST_DIR, '..', '..', 'scripts', 'hooks');

// ---------------------------------------------------------------------------
// Pure-function imports (no main() execution side-effects — guarded via
// the `isMain` check inside each script).
// ---------------------------------------------------------------------------
const { cacheKey, cacheDir, loadCachedMeta, buildOutput: buildPreOutput } = await import(
  '../../scripts/hooks/webfetch-cache-pre.js'
);
const {
  extractContent,
  extractValidators,
  buildRecord,
  persistCacheEntry,
} = await import('../../scripts/hooks/webfetch-cache-post.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'artibot-webfetch-cache-'));
}

/** `<base>/plugins/cache/artibot/artibot/<version>` — an installed plugin's root. */
function makeInstalledRoot(base) {
  const root = path.join(base, 'plugins', 'cache', 'artibot', 'artibot', '4.71.16');
  mkdirSync(root, { recursive: true });
  return root;
}

/** The marketplace cache dir `<pluginRoot>/../..` used to name as a repo root. */
function marketplaceRuntime(installedRoot) {
  return path.resolve(installedRoot, '..', '..', 'runtime');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('webfetch-cache hooks', () => {
  describe('cacheKey()', () => {
    it('produces a stable 40-hex SHA-1 for a given URL', () => {
      const k1 = cacheKey('https://docs.example.com/page');
      const k2 = cacheKey('https://docs.example.com/page');
      expect(k1).toBe(k2);
      expect(k1).toMatch(/^[0-9a-f]{40}$/);
    });

    it('produces different keys for different URLs', () => {
      const k1 = cacheKey('https://a.example.com/');
      const k2 = cacheKey('https://b.example.com/');
      expect(k1).not.toBe(k2);
    });

    it('treats query strings as part of the key', () => {
      const k1 = cacheKey('https://x.example.com/page');
      const k2 = cacheKey('https://x.example.com/page?v=2');
      expect(k1).not.toBe(k2);
    });
  });

  // Measured 2026-11-22: `<pluginRoot>/../..` is the marketplace cache dir for an
  // installed plugin (a sibling `runtime/` appeared there). The cache is URL-keyed, so it
  // is per user, not per project or per build: it lives in the artibot state dir.
  describe('cacheDir()', () => {
    let tmp;
    let restoreStateDir;
    let savedPluginRoot;
    beforeEach(() => {
      tmp = makeTempDir();
      restoreStateDir = pointStateDirAt(path.join(tmp, 'state'));
      savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    });
    afterEach(() => {
      if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
      restoreStateDir();
      rmSync(tmp, { recursive: true, force: true });
    });

    it('resolves under <state dir>/runtime/cache/webfetch', () => {
      expect(cacheDir()).toBe(path.join(tmp, 'state', 'runtime', 'cache', 'webfetch'));
    });

    it('does not follow an installed plugin root into the marketplace cache dir', () => {
      process.env.CLAUDE_PLUGIN_ROOT = makeInstalledRoot(tmp);
      expect(cacheDir()).toBe(path.join(tmp, 'state', 'runtime', 'cache', 'webfetch'));
    });
  });

  describe('loadCachedMeta()', () => {
    let tmp;
    beforeEach(() => { tmp = makeTempDir(); });
    afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

    it('returns null when the cache file does not exist', async () => {
      const meta = await loadCachedMeta(tmp, 'deadbeef');
      expect(meta).toBeNull();
    });

    it('returns null when the file is corrupt JSON', async () => {
      writeFileSync(path.join(tmp, 'abc123.json'), '{not json', 'utf-8');
      const meta = await loadCachedMeta(tmp, 'abc123');
      expect(meta).toBeNull();
    });

    it('reads etag/lastModified/fetchedAt from a valid entry', async () => {
      const record = {
        url: 'https://example.com',
        etag: 'W/"abc"',
        lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
        content: 'hi',
        fetchedAt: '2026-04-28T00:00:00.000Z',
      };
      writeFileSync(path.join(tmp, 'k.json'), JSON.stringify(record), 'utf-8');
      const meta = await loadCachedMeta(tmp, 'k');
      expect(meta).not.toBeNull();
      expect(meta.etag).toBe('W/"abc"');
      expect(meta.lastModified).toContain('2025');
      expect(meta.fetchedAt).toBe('2026-04-28T00:00:00.000Z');
      expect(meta.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('buildPreOutput()', () => {
    it('marks cached=false when meta is null', () => {
      const out = buildPreOutput({
        url: 'https://x.example.com/',
        key: 'k0'.repeat(20),
        meta: null,
      });
      expect(out.continue).toBe(true);
      expect(out.hookSpecificOutput.cached).toBe(false);
      expect(out.hookSpecificOutput.cacheKey).toBeDefined();
    });

    it('marks cached=true and surfaces validators when meta is present', () => {
      const out = buildPreOutput({
        url: 'https://x.example.com/',
        key: 'a'.repeat(40),
        meta: {
          etag: '"v1"',
          lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
          fetchedAt: '2026-04-28T00:00:00.000Z',
          sizeBytes: 100,
        },
      });
      expect(out.hookSpecificOutput.cached).toBe(true);
      expect(out.hookSpecificOutput.etag).toBe('"v1"');
      expect(out.hookSpecificOutput.additionalContext).toContain('disk hit');
    });
  });

  describe('extractContent()', () => {
    it('returns the string body when tool_response is a string', () => {
      expect(extractContent('plain body')).toBe('plain body');
    });

    it('reads .result first', () => {
      expect(extractContent({ result: 'r', output: 'o' })).toBe('r');
    });

    it('falls back to .output, .text, .content, .body in order', () => {
      expect(extractContent({ output: 'o', text: 't' })).toBe('o');
      expect(extractContent({ text: 't', body: 'b' })).toBe('t');
      expect(extractContent({ content: 'c' })).toBe('c');
      expect(extractContent({ body: 'b' })).toBe('b');
    });

    it('returns empty string when no candidates match', () => {
      expect(extractContent({})).toBe('');
      expect(extractContent(null)).toBe('');
      expect(extractContent(42)).toBe('');
    });
  });

  describe('extractValidators()', () => {
    it('returns nulls when no headers', () => {
      expect(extractValidators({})).toEqual({ etag: null, lastModified: null });
    });

    it('reads etag and last-modified case-insensitively', () => {
      const v = extractValidators({
        headers: { ETag: '"abc"', 'Last-Modified': 'today' },
      });
      expect(v.etag).toBe('"abc"');
      expect(v.lastModified).toBe('today');
    });
  });

  describe('buildRecord() and persistCacheEntry()', () => {
    let tmpRoot;
    let restoreStateDir;
    let savedPluginRoot;
    beforeEach(() => {
      tmpRoot = makeTempDir();
      restoreStateDir = pointStateDirAt(path.join(tmpRoot, 'state'));
      savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    });
    afterEach(() => {
      if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
      restoreStateDir();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('truncates content above MAX_BYTES and sets the truncated flag', () => {
      const big = 'x'.repeat(300 * 1024);
      const rec = buildRecord({ url: 'https://x', content: big, etag: null, lastModified: null });
      expect(rec.truncated).toBe(true);
      expect(rec.content.length).toBeLessThanOrEqual(256 * 1024);
    });

    // The cap is 262,144 UTF-8 BYTES. It used to be `content.length`, i.e. UTF-16 code units,
    // so Hangul (3 bytes per character) stored up to 768 KiB (review LOW, 2026-11-22). Each
    // fixture is LARGER than the cap in bytes, and the Hangul one is SMALLER than it in
    // characters, so the old character cap does not truncate it at all.
    const CAP = 262_144;
    const record = (content) => buildRecord({ url: 'https://x', content, etag: null, lastModified: null });

    it('caps Hangul content at 262,144 UTF-8 bytes and never cuts a character in half', () => {
      const content = '가'.repeat(100_000); // 300,000 B, 100,000 characters
      expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(CAP);

      const rec = record(content);

      expect(rec.truncated).toBe(true);
      // 262,144 = 3 * 87,381 + 1: the 87,382nd character straddles the cap, so it is dropped whole.
      expect(Buffer.byteLength(rec.content, 'utf8')).toBe(262_143);
      expect(rec.content).toBe('가'.repeat(87_381));
      expect(rec.content).not.toContain('�');
    });

    it('never splits a 4-byte character (surrogate pair) at the cap', () => {
      const content = `a${'😀'.repeat(70_000)}`; // 1 + 280,000 B
      const rec = record(content);

      expect(rec.truncated).toBe(true);
      expect(Buffer.byteLength(rec.content, 'utf8')).toBe(1 + 4 * 65_535);
      expect(rec.content).not.toContain('�');
      expect(rec.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
      expect(content.startsWith(rec.content)).toBe(true);
    });

    it('keeps content of exactly 262,144 bytes whole and cuts one byte more', () => {
      expect(record('x'.repeat(CAP))).toMatchObject({ truncated: false, content: 'x'.repeat(CAP) });
      expect(record('x'.repeat(CAP + 1))).toMatchObject({ truncated: true, content: 'x'.repeat(CAP) });
    });

    it('reports persisted size in UTF-8 bytes, not characters', async () => {
      const result = await persistCacheEntry('https://example.com/hangul', '가나다', { etag: null, lastModified: null });
      expect(result).toMatchObject({ persisted: true, bytes: 9 });
    });

    it('persists into the state dir, not the marketplace cache dir, for an installed plugin', async () => {
      const installed = makeInstalledRoot(tmpRoot);
      process.env.CLAUDE_PLUGIN_ROOT = installed;
      const url = 'https://example.com/persist-test';

      const result = await persistCacheEntry(url, 'hello world', { etag: null, lastModified: null });

      expect(result.persisted).toBe(true);
      expect(result.key).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(path.join(tmpRoot, 'state', 'runtime', 'cache', 'webfetch', `${result.key}.json`))).toBe(true);
      expect(existsSync(marketplaceRuntime(installed))).toBe(false);
      expect(existsSync(path.join(installed, 'runtime'))).toBe(false);
      // Round-trip via the pre-hook reader
      const meta = await loadCachedMeta(cacheDir(), result.key);
      expect(meta).not.toBeNull();
    });
  });

  // The real scripts as child processes under an installed plugin root: post writes,
  // pre reports the hit. The payload carries no hook_event_name / cwd / session_id, so
  // `_main-entry.js#tapDirectFiring` records nothing anywhere.
  describe('hook processes under an installed plugin root', () => {
    let tmpRoot;
    beforeEach(() => { tmpRoot = makeTempDir(); });
    afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

    function runHook(script, payload, env) {
      const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, script)], {
        input: JSON.stringify(payload), encoding: 'utf8', cwd: tmpRoot, env, timeout: 30_000,
      });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout);
    }

    it('post persists to <state dir>/runtime/cache/webfetch and pre sees the hit', () => {
      const installed = makeInstalledRoot(tmpRoot);
      const stateDir = path.join(tmpRoot, 'state');
      const env = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: installed,
        ARTIBOT_STATE_DIR: stateDir,
        ARTIBOT_STATE_DIR_HOME: getHomeDir(),
      };
      const url = 'https://example.com/spawned';

      const post = runHook('webfetch-cache-post.js', { tool_input: { url }, tool_response: { result: 'body' } }, env);
      const pre = runHook('webfetch-cache-pre.js', { tool_input: { url } }, env);

      expect(post.hookSpecificOutput.persisted).toBe(true);
      expect(existsSync(path.join(stateDir, 'runtime', 'cache', 'webfetch', `${cacheKey(url)}.json`))).toBe(true);
      expect(pre.hookSpecificOutput.cached).toBe(true);
      expect(existsSync(marketplaceRuntime(installed))).toBe(false);
    });
  });

  // Scanner: tests/helpers/no-egress.js (its header lists the three layers and what they cannot
  // see). The old pattern here let `import https from 'https'` through (review 2026-11-22, e1),
  // and a deny-list alone let node:dns, ws, ky, request and `const f = fetch` through (lane D).
  describe('no-egress invariant', () => {
    // Layer 1, fail-closed: each hook may name only the modules it uses today (measured
    // 2026-11-22). Any new import — node:dns, ws, an HTTP client — is outside the set and goes red.
    const ALLOWED_IMPORTS = {
      'webfetch-cache-pre.js': ['node:crypto', 'node:fs/promises', 'node:path', '../utils/index.js',
        '../../lib/core/hook-utils.js', '../../lib/core/runtime-state.js', './_main-entry.js'],
      'webfetch-cache-post.js': ['node:path', '../utils/index.js', '../../lib/core/file.js',
        '../../lib/core/hook-utils.js', './webfetch-cache-pre.js', './_main-entry.js'],
    };

    it.each(Object.keys(ALLOWED_IMPORTS))('%s imports only allow-listed modules and uses no network global', (hook) => {
      const src = readFileSync(path.join(HOOKS_DIR, hook), 'utf-8');
      const imports = importSpecifiers(src);
      expect(imports.length).toBeGreaterThan(0); // the extractor saw this file's imports at all
      expect(imports.filter((s) => !ALLOWED_IMPORTS[hook].includes(s))).toEqual([]);
      expect(globalNetNames(src)).toEqual([]);
    });

    it.each(['webfetch-cache-pre.js', 'webfetch-cache-post.js'])('%s matches none of the deny-list patterns', (hook) => {
      const src = readFileSync(path.join(HOOKS_DIR, hook), 'utf-8');
      expect(findEgress(src)).toEqual([]);
    });

    // Scanner self-check: every pattern fires on a positive sample and none fires on the
    // look-alikes these hooks really contain — so a green scan above is not a vacuous one.
    it.each([
      ["import https from 'https';", 'http / https / http2 module'],
      ["const h = await import('node:https');", 'http / https / http2 module'],
      ['const h = require("http");', 'http / https / http2 module'],
      ["import http2 from 'node:http2';", 'http / https / http2 module'],
      ["import net from 'node:net';", 'raw socket module (net / tls / dgram)'],
      ["import tls from 'tls';", 'raw socket module (net / tls / dgram)'],
      ['const d = await import(`dgram`);', 'raw socket module (net / tls / dgram)'],
      ["import { spawn } from 'node:child_process';", 'child_process module'],
      ['await fetch(url);', 'fetch() call'],
      ["import axios from 'axios';", 'HTTP client package'],
      ['new WebSocket(u);', 'XMLHttpRequest / WebSocket'],
    ])('the scanner flags %s', (sample, name) => {
      expect(findEgress(sample)).toContain(name);
    });

    it('the scanner stays quiet on look-alikes (URLs in text, WebFetch, node:crypto)', () => {
      const lookAlikes = "const u = 'https://example.com'; // WebFetch(url) prefetch()\nimport { createHash } from 'node:crypto';";
      expect(findEgress(lookAlikes)).toEqual([]);
      expect(EGRESS_PATTERNS.length).toBeGreaterThanOrEqual(6);
    });

    // `allow` exempts named patterns for ONE caller (pre-compact.js runs git through child_process);
    // the default is "everything forbidden", and an allowance must not leak into other patterns.
    it('the allow option drops exactly the named pattern and still flags the rest', () => {
      const sample = "import { execSync } from 'node:child_process';\nimport https from 'https';\nawait fetch(u);";
      const all = findEgress(sample);
      expect(all).toEqual(expect.arrayContaining(['child_process module', 'http / https / http2 module', 'fetch() call']));

      const allowed = findEgress(sample, { allow: ['child_process'] });

      expect(allowed).not.toContain('child_process module');
      expect(allowed).toEqual(all.filter((name) => name !== 'child_process module'));
    });

    it('the allow option rejects an id it does not know (a typo must not pass silently)', () => {
      expect(() => findEgress('', { allow: ['child-process'] })).toThrow(/unknown egress pattern id/);
    });
  });
});
