import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildIndex,
  cosineSimilarity,
  createSessionMemory,
  extractKeywords,
  tokenize,
} from '../../lib/learning/session-memory.js';

// ---------------------------------------------------------------------------
// Mock file I/O — in-memory store
// ---------------------------------------------------------------------------

const stores = {};

vi.mock('../../lib/core/file.js', () => ({
  ensureDir: vi.fn(async () => {}),
  readJsonFile: vi.fn(async (p) => stores[p] || null),
  writeJsonFile: vi.fn(async (p, data) => { stores[p] = data; }),
}));

vi.mock('../../lib/core/config.js', () => ({
  ARTIBOT_DIR: '/tmp/artibot-test',
}));

function clearStores() {
  for (const k of Object.keys(stores)) delete stores[k];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session-memory', () => {
  beforeEach(() => {
    clearStores();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('tokenize()', () => {
    it('splits text into term frequencies', () => {
      const freq = tokenize('hello world hello');
      expect(freq.hello).toBe(2);
      expect(freq.world).toBe(1);
    });

    it('filters stop words', () => {
      const freq = tokenize('the quick brown fox is a fast animal');
      expect(freq.the).toBeUndefined();
      expect(freq.is).toBeUndefined();
      expect(freq.quick).toBe(1);
    });

    it('handles Korean text', () => {
      const freq = tokenize('인지 라우팅 시스템 인지');
      expect(freq['인지']).toBe(2);
      expect(freq['라우팅']).toBe(1);
    });

    it('returns empty for null/empty input', () => {
      expect(tokenize('')).toEqual({});
      expect(tokenize(null)).toEqual({});
    });

    it('filters short words (< 2 chars)', () => {
      const freq = tokenize('a b cd ef');
      expect(freq.a).toBeUndefined();
      expect(freq.b).toBeUndefined();
      expect(freq.cd).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('cosineSimilarity()', () => {
    it('returns 1 for identical vectors', () => {
      const vec = { hello: 2, world: 1 };
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity({ alpha: 1 }, { beta: 1 })).toBe(0);
    });

    it('returns value between 0 and 1 for partial overlap', () => {
      const a = { hello: 2, world: 1, foo: 1 };
      const b = { hello: 1, bar: 3 };
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it('returns 0 for empty vectors', () => {
      expect(cosineSimilarity({}, { hello: 1 })).toBe(0);
      expect(cosineSimilarity(null, { hello: 1 })).toBe(0);
    });

    it('is commutative', () => {
      const a = { react: 3, hooks: 2 };
      const b = { react: 1, state: 2, hooks: 1 };
      expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
    });
  });

  // -------------------------------------------------------------------------
  describe('extractKeywords()', () => {
    it('returns top keywords by frequency', () => {
      const freq = { react: 5, hooks: 3, state: 1, component: 2 };
      const kw = extractKeywords(freq, 2);
      expect(kw).toEqual(['react', 'hooks']);
    });

    it('returns empty for empty input', () => {
      expect(extractKeywords({})).toEqual([]);
    });

    it('respects max count', () => {
      const freq = { a: 5, b: 4, c: 3, d: 2, e: 1 };
      expect(extractKeywords(freq, 3)).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('buildIndex()', () => {
    it('builds reverse index from memories', () => {
      const memories = [
        { id: 'm1', keywords: ['react', 'hooks'] },
        { id: 'm2', keywords: ['react', 'state'] },
      ];
      const index = buildIndex(memories);
      expect(index.react).toEqual(['m1', 'm2']);
      expect(index.hooks).toEqual(['m1']);
      expect(index.state).toEqual(['m2']);
    });

    it('handles empty array', () => {
      expect(buildIndex([])).toEqual({});
    });

    it('deduplicates memory ids per keyword', () => {
      const memories = [
        { id: 'm1', keywords: ['react', 'react'] },
      ];
      const index = buildIndex(memories);
      expect(index.react).toEqual(['m1']);
    });
  });

  // -------------------------------------------------------------------------
  describe('createSessionMemory()', () => {
    it('returns a frozen object with expected API', () => {
      const sm = createSessionMemory();
      expect(Object.isFrozen(sm)).toBe(true);
      expect(typeof sm.capture).toBe('function');
      expect(typeof sm.compress).toBe('function');
      expect(typeof sm.recall).toBe('function');
      expect(typeof sm.promote).toBe('function');
      expect(typeof sm.prune).toBe('function');
      expect(typeof sm.getStats).toBe('function');
    });

    it('generates a session id', () => {
      const sm = createSessionMemory();
      expect(sm.sessionId).toMatch(/^sess-/);
    });

    it('accepts custom session id', () => {
      const sm = createSessionMemory({ sessionId: 'test-123' });
      expect(sm.sessionId).toBe('test-123');
    });
  });

  // -------------------------------------------------------------------------
  describe('capture()', () => {
    it('adds event to buffer and returns frozen entry', () => {
      const sm = createSessionMemory({ now: () => 1000 });
      const entry = sm.capture({ type: 'tool', tool: 'Read' });
      expect(entry.type).toBe('tool');
      expect(entry.tool).toBe('Read');
      expect(entry.timestamp).toBe(1000);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(sm.bufferSize).toBe(1);
    });

    it('returns null for invalid input', () => {
      const sm = createSessionMemory();
      expect(sm.capture(null)).toBeNull();
      expect(sm.capture('string')).toBeNull();
    });

    it('respects buffer limit', () => {
      const sm = createSessionMemory();
      for (let i = 0; i < 250; i++) {
        sm.capture({ type: 'test', index: i });
      }
      expect(sm.bufferSize).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('compress()', () => {
    it('returns null for empty buffer', async () => {
      const sm = createSessionMemory();
      expect(await sm.compress()).toBeNull();
    });

    it('compresses buffer into a memory record', async () => {
      const sm = createSessionMemory({
        sessionId: 'compress-test',
        now: () => 5000,
        memoriesPath: '/tmp/artibot-test/session-memories.json',
        indexPath: '/tmp/artibot-test/session-memories-index.json',
      });

      sm.capture({ type: 'prompt', text: 'fix authentication bug' });
      sm.capture({ type: 'tool', tool: 'Read', message: 'reading auth module' });
      sm.capture({ type: 'success', message: 'auth bug fixed' });

      const memory = await sm.compress();
      expect(memory).not.toBeNull();
      expect(memory.sessionId).toBe('compress-test');
      expect(memory.id).toMatch(/^smem-/);
      expect(memory.summary).toContain('Events:');
      expect(memory.keywords.length).toBeGreaterThan(0);
      expect(memory.vector).toBeDefined();
      expect(memory.eventCount).toBe(3);
      expect(Object.isFrozen(memory)).toBe(true);
    });

    it('persists to storage and clears buffer', async () => {
      const sm = createSessionMemory({
        memoriesPath: '/tmp/artibot-test/session-memories.json',
        indexPath: '/tmp/artibot-test/session-memories-index.json',
      });
      sm.capture({ type: 'tool', tool: 'Edit' });
      await sm.compress();

      expect(sm.bufferSize).toBe(0);
      const stored = stores['/tmp/artibot-test/session-memories.json'];
      expect(stored.memories).toHaveLength(1);
    });

    it('deduplicates by hash', async () => {
      const sm = createSessionMemory({
        now: () => 1000,
        memoriesPath: '/tmp/artibot-test/session-memories.json',
        indexPath: '/tmp/artibot-test/session-memories-index.json',
      });

      sm.capture({ type: 'tool', tool: 'Read' });
      const first = await sm.compress();

      sm.capture({ type: 'tool', tool: 'Read' });
      const second = await sm.compress();

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('recall()', () => {
    const MEM_PATH = '/tmp/artibot-test/recall-memories.json';
    const IDX_PATH = '/tmp/artibot-test/recall-index.json';

    beforeEach(() => {
      stores[MEM_PATH] = {
        memories: [
          {
            id: 'r1',
            summary: 'Fixed React hooks bug',
            keywords: ['react', 'hooks', 'bug', 'fixed'],
            vector: tokenize('react hooks bug fixed component state'),
            createdAt: 1000,
          },
          {
            id: 'r2',
            summary: 'Set up PostgreSQL database',
            keywords: ['postgresql', 'database', 'setup'],
            vector: tokenize('postgresql database setup migration schema'),
            createdAt: 2000,
          },
          {
            id: 'r3',
            summary: 'Deployed to Vercel',
            keywords: ['vercel', 'deploy', 'production'],
            vector: tokenize('vercel deploy production build next'),
            createdAt: 3000,
          },
        ],
      };
    });

    it('returns relevant memories sorted by similarity', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      const results = await sm.recall('react hooks state management');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.id).toBe('r1');
      expect(results[0].similarity).toBeGreaterThan(0);
    });

    it('returns empty for unrelated query', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      const results = await sm.recall('zzzz xxxx yyyy');
      expect(results).toEqual([]);
    });

    it('respects topK parameter', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      const results = await sm.recall('database react deploy', 1);
      expect(results).toHaveLength(1);
    });

    it('returns empty for null/empty query', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      expect(await sm.recall('')).toEqual([]);
      expect(await sm.recall(null)).toEqual([]);
    });

    it('returns empty when no memories exist', async () => {
      const sm = createSessionMemory({
        memoriesPath: '/tmp/artibot-test/empty.json',
        indexPath: IDX_PATH,
      });
      expect(await sm.recall('anything')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('promote()', () => {
    const MEM_PATH = '/tmp/artibot-test/promote-memories.json';
    const IDX_PATH = '/tmp/artibot-test/promote-index.json';

    beforeEach(() => {
      stores[MEM_PATH] = {
        memories: [{
          id: 'p1',
          summary: 'Auth pattern',
          keywords: ['auth'],
          vector: tokenize('auth login session token'),
          createdAt: 1000,
        }],
      };
    });

    it('returns null if recall threshold not met', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      expect(await sm.promote('p1')).toBeNull();
    });

    it('promotes after reaching recall threshold', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });

      // Recall 3 times to reach threshold
      await sm.recall('auth login');
      await sm.recall('auth session');
      await sm.recall('auth token');

      const result = await sm.promote('p1');
      expect(result).not.toBeNull();
      expect(result.type).toBe('session-memory-promotion');
      expect(result.memoryId).toBe('p1');
      expect(result.recallCount).toBe(3);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('returns null for unknown memory id', async () => {
      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      expect(await sm.promote('nonexistent')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('prune()', () => {
    const MEM_PATH = '/tmp/artibot-test/prune-memories.json';
    const IDX_PATH = '/tmp/artibot-test/prune-index.json';

    it('removes memories older than maxAgeDays', async () => {
      const DAY = 24 * 60 * 60 * 1000;
      const NOW = 100 * DAY;

      stores[MEM_PATH] = {
        memories: [
          { id: 'old', keywords: ['old'], createdAt: 10 * DAY },
          { id: 'recent', keywords: ['recent'], createdAt: 90 * DAY },
        ],
      };

      const sm = createSessionMemory({
        now: () => NOW,
        memoriesPath: MEM_PATH,
        indexPath: IDX_PATH,
      });

      const pruned = await sm.prune(30);
      expect(pruned).toBe(1);

      const stored = stores[MEM_PATH];
      expect(stored.memories).toHaveLength(1);
      expect(stored.memories[0].id).toBe('recent');
    });

    it('returns 0 when nothing to prune', async () => {
      stores[MEM_PATH] = {
        memories: [{ id: 'fresh', keywords: [], createdAt: Date.now() }],
      };

      const sm = createSessionMemory({ memoriesPath: MEM_PATH, indexPath: IDX_PATH });
      expect(await sm.prune(30)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('getStats()', () => {
    it('returns correct statistics', async () => {
      const MEM_PATH = '/tmp/artibot-test/stats-memories.json';
      stores[MEM_PATH] = {
        memories: [
          { id: 's1', sessionId: 'a', eventCount: 5, score: 0.8, createdAt: 1000 },
          { id: 's2', sessionId: 'b', eventCount: 3, score: 0.6, createdAt: 2000 },
          { id: 's3', sessionId: 'a', eventCount: 7, score: 1.0, createdAt: 3000 },
        ],
      };

      const sm = createSessionMemory({ memoriesPath: MEM_PATH });
      const stats = await sm.getStats();

      expect(stats.totalMemories).toBe(3);
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalEvents).toBe(15);
      expect(stats.avgScore).toBe(0.8);
      expect(stats.oldestAt).toBe(1000);
      expect(stats.newestAt).toBe(3000);
      expect(Object.isFrozen(stats)).toBe(true);
    });

    it('handles empty store', async () => {
      const sm = createSessionMemory({
        memoriesPath: '/tmp/artibot-test/empty-stats.json',
      });
      const stats = await sm.getStats();
      expect(stats.totalMemories).toBe(0);
      expect(stats.oldestAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('integration', () => {
    it('full lifecycle: capture -> compress -> recall -> promote', async () => {
      const MEM_PATH = '/tmp/artibot-test/integration-memories.json';
      const IDX_PATH = '/tmp/artibot-test/integration-index.json';
      let clock = 1000;

      const sm = createSessionMemory({
        sessionId: 'integ-1',
        now: () => clock++,
        memoriesPath: MEM_PATH,
        indexPath: IDX_PATH,
      });

      // Capture
      sm.capture({ type: 'prompt', text: 'implement authentication with JWT' });
      sm.capture({ type: 'tool', tool: 'Read', message: 'reading auth module' });
      sm.capture({ type: 'tool', tool: 'Edit', message: 'adding JWT validation' });
      sm.capture({ type: 'success', message: 'JWT auth implemented' });
      expect(sm.bufferSize).toBe(4);

      // Compress
      const memory = await sm.compress();
      expect(memory).not.toBeNull();
      expect(memory.keywords).toContain('jwt');
      expect(sm.bufferSize).toBe(0);

      // Recall
      const results = await sm.recall('JWT authentication token');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.id).toBe(memory.id);

      // Recall more times to reach promote threshold
      await sm.recall('JWT auth');
      await sm.recall('authentication JWT');

      // Promote
      const promotion = await sm.promote(memory.id);
      expect(promotion).not.toBeNull();
      expect(promotion.recallCount).toBe(3);
      expect(promotion.keywords).toContain('jwt');
    });
  });
});
