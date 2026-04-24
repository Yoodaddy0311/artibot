import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

// ---------------------------------------------------------------------------
// File-system mock — in-memory store keyed by absolute path.
// ---------------------------------------------------------------------------

const diskMap = new Map();

vi.mock('../../../lib/core/file.js', () => ({
  ensureDir: vi.fn(async () => {}),
  readJsonFile: vi.fn(async (p) => {
    if (!diskMap.has(p)) return null;
    return JSON.parse(diskMap.get(p));
  }),
  atomicWriteJson: vi.fn(async (p, data) => {
    diskMap.set(p, JSON.stringify(data));
  }),
}));

vi.mock('../../../lib/core/config.js', () => ({
  ARTIBOT_DIR: path.join(os.tmpdir(), 'artibot-episodic-test'),
}));

let createEpisodicStore;

beforeEach(async () => {
  diskMap.clear();
  vi.resetModules();
  ({ createEpisodicStore } = await import('../../../lib/learning/memory/episodic.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('episodic memory store', () => {
  describe('appendEpisode()', () => {
    it('persists a normalised episode with id/hash/vector', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep1', now: () => 1_000 });
      const ep = await store.appendEpisode({
        sessionId: 's1',
        title: 'v3.0 release',
        summary: 'shipped autonomous agent OS',
      });
      expect(ep).toBeTruthy();
      expect(ep.id).toMatch(/^ep-/);
      expect(ep.sessionId).toBe('s1');
      expect(ep.timestamp).toBe(1_000);
      expect(ep.hash).toHaveLength(16);
      expect(Object.keys(ep.vector).length).toBeGreaterThan(0);
      expect(ep.keywords.length).toBeGreaterThan(0);
    });

    it('deduplicates by content hash', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep2', now: () => 2_000 });
      const a = await store.appendEpisode({ sessionId: 's', title: 'dupe', summary: 'same body' });
      const b = await store.appendEpisode({ sessionId: 's', title: 'dupe', summary: 'same body' });
      expect(a).toBeTruthy();
      expect(b).toBeNull();
      const list = await store.listEpisodes();
      expect(list).toHaveLength(1);
    });

    it('rejects non-object input gracefully', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep3' });
      expect(await store.appendEpisode(null)).toBeNull();
      expect(await store.appendEpisode('bad')).toBeNull();
    });

    it('coerces string timestamps', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep4', now: () => 5_000 });
      const ep = await store.appendEpisode({
        sessionId: 's',
        title: 'x',
        summary: 'y',
        timestamp: '2026-04-24T00:00:00Z',
      });
      expect(ep.timestamp).toBe(Date.parse('2026-04-24T00:00:00Z'));
    });
  });

  describe('findEpisodes()', () => {
    async function seed(store) {
      await store.appendEpisode({ sessionId: 's1', title: 'react hooks audit', summary: 'useState misuse found', timestamp: 1_000 });
      await store.appendEpisode({ sessionId: 's2', title: 'database migration', summary: 'postgres rollout', timestamp: 2_000 });
      await store.appendEpisode({ sessionId: 's1', title: 'vite build fix', summary: 'config path correction', timestamp: 3_000 });
    }

    it('ranks by cosine similarity', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-find1', now: () => 10_000 });
      await seed(store);
      const hits = await store.findEpisodes('react hooks');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].episode.title).toContain('react');
    });

    it('filters by session id', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-find2', now: () => 10_000 });
      await seed(store);
      const hits = await store.findEpisodes('', { sessionId: 's2' });
      expect(hits.length).toBe(1);
      expect(hits[0].episode.sessionId).toBe('s2');
    });

    it('filters by withinDays window', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-find3', now: () => 3_000 + 2 * 86_400_000 });
      await seed(store);
      // withinDays=1 (86_400_000 ms) — only episode at 3000 ms is inside cutoff.
      const hits = await store.findEpisodes('', { withinDays: 1 });
      // Explanation: cutoff = now - 1 day. All seeded timestamps are >=3000 ms,
      // so everything older than (now - 1 day) gets filtered out.
      // now is ~172,803,000; cutoff ~86,403,000 → all three filtered out.
      expect(hits.length).toBe(0);
    });

    it('returns empty array on empty store', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-find4' });
      const hits = await store.findEpisodes('whatever');
      expect(hits).toEqual([]);
    });

    it('respects limit', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-find5', now: () => 10_000 });
      await seed(store);
      const hits = await store.findEpisodes('', { limit: 2 });
      expect(hits.length).toBeLessThanOrEqual(2);
    });
  });

  describe('linkToSemantic()', () => {
    it('records signature provenance per episode', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-link', now: () => 10 });
      const ep = await store.appendEpisode({ sessionId: 's', title: 't', summary: 's' });
      const ok = await store.linkToSemantic(ep.id, 'sig-abc');
      expect(ok).toBe(true);
      const map = await store.getLinks();
      expect(map[ep.id]).toContain('sig-abc');
    });

    it('deduplicates links per episode', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-link2', now: () => 10 });
      const ep = await store.appendEpisode({ sessionId: 's', title: 't2', summary: 'body' });
      await store.linkToSemantic(ep.id, 'sig-x');
      await store.linkToSemantic(ep.id, 'sig-x');
      const map = await store.getLinks();
      expect(map[ep.id]).toEqual(['sig-x']);
    });

    it('rejects missing args', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-link3' });
      expect(await store.linkToSemantic('', 'sig')).toBe(false);
      expect(await store.linkToSemantic('ep-1', '')).toBe(false);
    });
  });

  describe('pruneBefore() — archive semantics (no hard delete)', () => {
    it('moves old episodes to archive/YYYY-MM bucket', async () => {
      const store = createEpisodicStore({
        storePath: '/tmp/ep-prune',
        now: () => Date.parse('2026-04-24T00:00:00Z'),
      });
      await store.appendEpisode({ sessionId: 's', title: 'old', summary: 'stale', timestamp: Date.parse('2024-01-01') });
      await store.appendEpisode({ sessionId: 's', title: 'new', summary: 'fresh', timestamp: Date.parse('2026-04-20') });
      const moved = await store.pruneBefore(new Date('2025-01-01'));
      expect(moved).toBe(1);
      const remaining = await store.listEpisodes();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].title).toBe('new');

      // Archive file should have been written with the old episode.
      // Path is built via path.join so it uses the platform separator.
      const archivePath = path.join('/tmp/ep-prune', 'archive', '2026-04', 'episodes.json');
      const archived = JSON.parse(diskMap.get(archivePath));
      expect(archived.episodes).toHaveLength(1);
      expect(archived.episodes[0].title).toBe('old');
    });

    it('returns 0 when nothing to prune', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-prune2', now: () => 100 });
      await store.appendEpisode({ sessionId: 's', title: 'a', summary: 'b', timestamp: 1_000 });
      expect(await store.pruneBefore(new Date(0))).toBe(0);
    });

    it('handles invalid date argument', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-prune3' });
      await store.appendEpisode({ sessionId: 's', title: 'a', summary: 'b' });
      expect(await store.pruneBefore('not-a-date')).toBe(0);
    });
  });

  describe('storage interaction', () => {
    it('uses configured storePath for episodes.json', async () => {
      const { atomicWriteJson } = await import('../../../lib/core/file.js');
      const store = createEpisodicStore({ storePath: '/tmp/ep-sp' });
      await store.appendEpisode({ sessionId: 's', title: 't', summary: 'body' });
      const writtenPaths = atomicWriteJson.mock.calls.map((c) => c[0]);
      expect(writtenPaths.some((p) => p.endsWith(path.join('ep-sp', 'episodes.json')))).toBe(true);
    });
  });

  describe('tmpdir round-trip (no mock)', () => {
    it('writes and reads episodes on a real temp dir', async () => {
      vi.doUnmock('../../../lib/core/file.js');
      vi.resetModules();
      const { createEpisodicStore: realCreate } = await import('../../../lib/learning/memory/episodic.js');
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-ep-'));
      try {
        const store = realCreate({ storePath: tmp, now: () => 1_000 });
        const ep = await store.appendEpisode({ sessionId: 's', title: 'real', summary: 'disk write' });
        expect(ep).toBeTruthy();
        const raw = await fs.readFile(path.join(tmp, 'episodes.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        expect(parsed.episodes).toHaveLength(1);
        expect(parsed.episodes[0].title).toBe('real');
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('v3.4 GRPO reward hook (Phase A)', () => {
    it('attaches reward and rewardComponents on append', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-rwd1', now: () => 10 });
      const ep = await store.appendEpisode({
        sessionId: 's', title: 't', summary: 'b',
        toolCalls: [{ exitCode: 0 }, { exitCode: 0 }],
        errors: 0, testPassRatio: 1.0, typecheckClean: true,
        importanceScore: 0.8,
      });
      expect(ep).toBeTruthy();
      expect(typeof ep.reward).toBe('number');
      expect(ep.reward).toBeGreaterThan(0);
      expect(ep.rewardComponents).toBeDefined();
      expect(ep.rewardComponents.timedOut).toBe(false);
    });

    it('defaults reward to 0 when no verifiable signals present', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-rwd2', now: () => 10 });
      const ep = await store.appendEpisode({
        sessionId: 's', title: 't2', summary: 'b2',
      });
      expect(ep.reward).toBe(0);
    });

    it('yields reward 0 for timedOut episodes', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-rwd3', now: () => 10 });
      const ep = await store.appendEpisode({
        sessionId: 's', title: 't3', summary: 'b3',
        toolCalls: [{ exitCode: 0 }],
        timedOut: true,
      });
      expect(ep.reward).toBe(0);
      expect(ep.rewardComponents.timedOut).toBe(true);
    });

    it('honours explicit reward if caller supplies one', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-rwd4', now: () => 10 });
      const ep = await store.appendEpisode({
        sessionId: 's', title: 't4', summary: 'b4',
        reward: 0.42,
        rewardComponents: { manual: true },
      });
      expect(ep.reward).toBe(0.42);
      expect(ep.rewardComponents.manual).toBe(true);
    });

    it('rewardComponents is a frozen object (immutability contract)', async () => {
      const store = createEpisodicStore({ storePath: '/tmp/ep-rwd5', now: () => 10 });
      const ep = await store.appendEpisode({
        sessionId: 's', title: 't5', summary: 'b5',
        toolCalls: [{ exitCode: 0 }],
      });
      expect(Object.isFrozen(ep.rewardComponents)).toBe(true);
    });
  });
});
