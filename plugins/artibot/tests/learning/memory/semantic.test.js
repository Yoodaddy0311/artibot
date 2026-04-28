/**
 * Tests for lib/learning/memory/semantic.js — L3 hierarchical memory store.
 *
 * Covers:
 *   - put / find / match / occurrences / archive
 *   - Dedup by data.key and by signatureHash
 *   - Frozen output invariants
 *   - TF-IDF cosine tokenisation
 *   - Migration helper idempotency
 *   - Metrics recorder side-effect free
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fs mock
// ---------------------------------------------------------------------------

const stores = {};
const dirs = new Set();
const writtenFiles = {};

vi.mock('../../../lib/core/file.js', () => ({
  ensureDir: vi.fn(async (p) => { dirs.add(p); }),
  readJsonFile: vi.fn(async (p) => {
    return stores[p] ? JSON.parse(JSON.stringify(stores[p])) : null;
  }),
  writeJsonFile: vi.fn(async (p, data) => { stores[p] = data; }),
  atomicWriteJson: vi.fn(async (p, data) => { stores[p] = data; }),
}));

// Mock node:fs/promises so archive() can write .gz without real disk touch.
vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: vi.fn(async (p, buf) => { writtenFiles[p] = buf; }),
    copyFile: vi.fn(async (src, dst) => {
      writtenFiles[dst] = stores[src] ? JSON.stringify(stores[src]) : '';
    }),
  },
  writeFile: vi.fn(async (p, buf) => { writtenFiles[p] = buf; }),
  copyFile: vi.fn(async (src, dst) => {
    writtenFiles[dst] = stores[src] ? JSON.stringify(stores[src]) : '';
  }),
}));

function resetAll() {
  for (const k of Object.keys(stores)) delete stores[k];
  for (const k of Object.keys(writtenFiles)) delete writtenFiles[k];
  dirs.clear();
}

const STORE_PATH = '/tmp/artibot-test/memory/semantic.json';

async function makeStore(now = () => 1_700_000_000_000) {
  const { createSemanticStore } = await import('../../../lib/learning/memory/semantic.js');
  return createSemanticStore({ storePath: STORE_PATH, now });
}

// ---------------------------------------------------------------------------
// Pure-helper tests (cheap + no fs)
// ---------------------------------------------------------------------------

describe('semantic pure helpers', () => {
  it('tokenize removes stop-words and short tokens', async () => {
    const { tokenize } = await import('../../../lib/learning/memory/semantic.js');
    const freq = tokenize('the user prefers Korean language');
    expect(freq.the).toBeUndefined();
    expect(freq.user).toBe(1);
    expect(freq.korean).toBe(1);
  });

  it('signatureHash is deterministic for same payload', async () => {
    const { signatureHash } = await import('../../../lib/learning/memory/semantic.js');
    const a = signatureHash({ key: 'lang', value: 'ko' });
    const b = signatureHash({ value: 'ko', key: 'lang' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cosineSimilarity returns 0 for empty vectors', async () => {
    const { cosineSimilarity } = await import('../../../lib/learning/memory/semantic.js');
    expect(cosineSimilarity({}, { a: 1 })).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  it('cosineSimilarity is 1.0 for identical vectors', async () => {
    const { cosineSimilarity } = await import('../../../lib/learning/memory/semantic.js');
    expect(cosineSimilarity({ a: 2, b: 3 }, { a: 2, b: 3 })).toBeCloseTo(1.0, 6);
  });

  it('extractSearchText walks nested strings', async () => {
    const { extractSearchText } = await import('../../../lib/learning/memory/semantic.js');
    const text = extractSearchText({
      key: 'lang',
      value: 'korean',
      nested: { tag: 'preference' },
    });
    expect(text).toContain('korean');
    expect(text).toContain('preference');
  });
});

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

describe('createSemanticStore', () => {
  beforeEach(() => {
    resetAll();
    vi.clearAllMocks();
  });

  it('rejects missing storePath', async () => {
    const { createSemanticStore } = await import('../../../lib/learning/memory/semantic.js');
    expect(() => createSemanticStore({})).toThrow(/storePath/);
  });

  it('put creates a new entry with layer="semantic"', async () => {
    const store = await makeStore();
    const entry = await store.put({ data: { key: 'lang', value: 'ko' } });
    expect(entry.layer).toBe('semantic');
    expect(entry.signatureHash).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.usageCount).toBe(0);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('put dedups by data.key (updates existing, keeps id)', async () => {
    const store = await makeStore();
    const first = await store.put({ data: { key: 'theme', value: 'light' } });
    const second = await store.put({ data: { key: 'theme', value: 'dark' } });
    expect(second.id).toBe(first.id);
    expect(second.data.value).toBe('dark');
    expect(second.occurrenceCount).toBe(2);

    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  it('put dedups by signatureHash when no data.key present', async () => {
    const store = await makeStore();
    const a = await store.put({ data: { note: 'avoid force push' } });
    const b = await store.put({ data: { note: 'avoid force push' } });
    expect(a.signatureHash).toBe(b.signatureHash);
    expect(b.occurrenceCount).toBe(2);

    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  it('find returns ranked results tagged with layer', async () => {
    const store = await makeStore();
    await store.put({ data: { key: 'lang', value: 'korean preference' } });
    await store.put({ data: { key: 'editor', value: 'vscode dark theme' } });

    const results = await store.find('korean');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].layer).toBe('semantic');
    expect(results[0].entry.data.value).toContain('korean');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('find respects limit', async () => {
    const store = await makeStore();
    for (let i = 0; i < 5; i += 1) {
       
      await store.put({ data: { key: `k${i}`, value: 'korean' } });
    }
    const results = await store.find('korean', { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('find returns empty for unknown query', async () => {
    const store = await makeStore();
    await store.put({ data: { key: 'x', value: 'alpha' } });
    const results = await store.find('zzzzz nonexistent');
    expect(results).toEqual([]);
  });

  it('match looks up by signatureHash', async () => {
    const store = await makeStore();
    const entry = await store.put({ data: { key: 'lang', value: 'ko' } });
    const hit = await store.match(entry.signatureHash);
    expect(hit?.id).toBe(entry.id);
  });

  it('match returns null for unknown hash', async () => {
    const store = await makeStore();
    expect(await store.match('deadbeef00000000')).toBeNull();
    expect(await store.match(null)).toBeNull();
  });

  it('occurrences returns occurrenceCount', async () => {
    const store = await makeStore();
    const e = await store.put({ data: { key: 'a', value: 'v' } });
    await store.put({ data: { key: 'a', value: 'v' } });
    expect(await store.occurrences(e.signatureHash)).toBe(2);
  });

  it('archive marks entry and creates gzipped record', async () => {
    const store = await makeStore();
    const e = await store.put({ data: { key: 'lang', value: 'ko' } });
    const { archivedPath } = await store.archive(e.id);
    expect(archivedPath).toContain('archive');
    expect(archivedPath.endsWith('.json.gz')).toBe(true);

    // entry still present but flagged; list excludes it
    const listed = await store.list();
    expect(listed.find((x) => x.id === e.id)).toBeUndefined();
  });

  it('archive returns null for unknown id', async () => {
    const store = await makeStore();
    expect(await store.archive('missing-id')).toBeNull();
  });

  it('export returns signatures only, no raw data', async () => {
    const store = await makeStore();
    await store.put({ data: { key: 'lang', value: 'ko secret' } });
    const rows = await store.export();
    expect(rows[0]).toHaveProperty('signature');
    expect(rows[0]).toHaveProperty('usageCount');
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('export with DP stub annotates rows', async () => {
    const store = await makeStore();
    await store.put({ data: { key: 'x', value: 'v' } });
    const rows = await store.export({ withDifferentialPrivacy: true });
    expect(rows[0]).toHaveProperty('dp', 'stub');
  });

  it('returned store interface is frozen', async () => {
    const store = await makeStore();
    expect(Object.isFrozen(store)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

describe('migrate.runMigration', () => {
  beforeEach(() => {
    resetAll();
    vi.clearAllMocks();
  });

  it('tags legacy preference entries with layer="semantic"', async () => {
    const { runMigration } = await import('../../../lib/learning/memory/migrate.js');
    const dir = path.join('/tmp/artibot-test', 'memory');
    const prefPath = path.join(dir, 'user-preferences.json');
    stores[prefPath] = {
      entries: [
        { id: 'pref_1', type: 'preference', data: { key: 'lang', value: 'ko' } },
      ],
      metadata: {},
    };
    const result = await runMigration({ memoryDir: dir });
    const report = result.reports.find((r) => r.file.endsWith('user-preferences.json'));
    expect(report.status).toBe('migrated');
    expect(report.tagged).toBe(1);
    expect(stores[prefPath].entries[0].layer).toBe('semantic');
    expect(stores[prefPath].entries[0].migratedAt).toBeDefined();
  });

  it('tags legacy context entries with layer="episodic"', async () => {
    const { runMigration } = await import('../../../lib/learning/memory/migrate.js');
    const dir = path.join('/tmp/artibot-test', 'memory');
    const ctxPath = path.join(dir, 'project-contexts.json');
    stores[ctxPath] = {
      entries: [{ id: 'ctx_1', type: 'context', data: { project: 'artibot' } }],
      metadata: {},
    };
    await runMigration({ memoryDir: dir });
    expect(stores[ctxPath].entries[0].layer).toBe('episodic');
  });

  it('is idempotent — second run skips already-tagged entries', async () => {
    const { runMigration } = await import('../../../lib/learning/memory/migrate.js');
    const dir = path.join('/tmp/artibot-test', 'memory');
    const prefPath = path.join(dir, 'user-preferences.json');
    stores[prefPath] = {
      entries: [{ id: 'pref_1', type: 'preference', data: { key: 'x', value: 'v' } }],
      metadata: {},
    };
    await runMigration({ memoryDir: dir });
    const second = await runMigration({ memoryDir: dir });
    const r = second.reports.find((x) => x.file.endsWith('user-preferences.json'));
    expect(r.status).toBe('skipped');
    expect(r.tagged).toBe(0);
  });

  it('reports missing files gracefully', async () => {
    const { runMigration } = await import('../../../lib/learning/memory/migrate.js');
    const result = await runMigration({ memoryDir: path.join('/tmp/artibot-test', 'empty') });
    for (const r of result.reports) {
      expect(['missing', 'skipped']).toContain(r.status);
    }
    expect(result.totalTagged).toBe(0);
  });

  it('handles malformed stores by quarantining', async () => {
    const { runMigration } = await import('../../../lib/learning/memory/migrate.js');
    const dir = path.join('/tmp/artibot-test', 'memory');
    const errPath = path.join(dir, 'error-patterns.json');
    stores[errPath] = { entries: 'not-an-array' };
    const result = await runMigration({ memoryDir: dir });
    const r = result.reports.find((x) => x.file.endsWith('error-patterns.json'));
    expect(r.status).toBe('corrupted');
    expect(r.backup).toBeDefined();
  });

  it('rejects missing memoryDir', async () => {
    const { runMigration } = await import('../../../lib/learning/memory/migrate.js');
    await expect(runMigration({})).rejects.toThrow(/memoryDir/);
  });
});
