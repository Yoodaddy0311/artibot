import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  describe('cacheDir()', () => {
    it('resolves under runtime/cache/webfetch relative to repo root', () => {
      const fakeRoot = '/tmp/fake-plugin/plugins/artibot';
      const dir = cacheDir(fakeRoot);
      expect(dir.replace(/\\/g, '/')).toContain('/runtime/cache/webfetch');
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
    beforeEach(() => {
      tmpRoot = makeTempDir();
    });
    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('truncates content above MAX_BYTES and sets the truncated flag', () => {
      const big = 'x'.repeat(300 * 1024);
      const rec = buildRecord({ url: 'https://x', content: big, etag: null, lastModified: null });
      expect(rec.truncated).toBe(true);
      expect(rec.content.length).toBeLessThanOrEqual(256 * 1024);
    });

    it('persists an entry to disk under runtime/cache/webfetch', async () => {
      // Set up a fake plugin-root layout: <tmpRoot>/plugins/artibot
      const fakePluginRoot = path.join(tmpRoot, 'plugins', 'artibot');
      mkdirSync(fakePluginRoot, { recursive: true });
      const url = 'https://example.com/persist-test';
      const result = await persistCacheEntry(url, 'hello world', { etag: null, lastModified: null }, fakePluginRoot);
      expect(result.persisted).toBe(true);
      expect(result.key).toMatch(/^[0-9a-f]{40}$/);
      // Confirm round-trip via the pre-hook reader
      const meta = await loadCachedMeta(cacheDir(fakePluginRoot), result.key);
      expect(meta).not.toBeNull();
    });
  });

  describe('no-egress invariant', () => {
    it('webfetch-cache-pre.js must not import or call HTTP/fetch APIs', () => {
      const src = readFileSync(path.join(HOOKS_DIR, 'webfetch-cache-pre.js'), 'utf-8');
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
      expect(src).not.toMatch(/require\(['"]node:https?['"]\)/);
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
    });

    it('webfetch-cache-post.js must not import or call HTTP/fetch APIs', () => {
      const src = readFileSync(path.join(HOOKS_DIR, 'webfetch-cache-post.js'), 'utf-8');
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
      expect(src).not.toMatch(/require\(['"]node:https?['"]\)/);
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
    });
  });
});
