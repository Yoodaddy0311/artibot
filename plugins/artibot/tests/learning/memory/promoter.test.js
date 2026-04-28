import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

// ---------------------------------------------------------------------------
// File-system + append-file mock
// ---------------------------------------------------------------------------

const diskMap = new Map();
const appendLog = [];

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

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    default: {
      ...actual.default,
      appendFile: vi.fn(async (p, line) => { appendLog.push({ path: p, line }); }),
    },
    appendFile: vi.fn(async (p, line) => { appendLog.push({ path: p, line }); }),
  };
});

vi.mock('../../../lib/core/platform.js', () => ({
  getPluginRoot: () => '/tmp/plugin-root',
  getHomeDir: () => os.homedir(),
}));

// ---------------------------------------------------------------------------
// Minimal in-memory stores
// ---------------------------------------------------------------------------

function makeEpisodicStore(episodes) {
  const links = {};
  return {
    async listEpisodes() { return episodes.slice(); },
    async linkToSemantic(episodeId, sig) {
      if (!links[episodeId]) links[episodeId] = [];
      if (!links[episodeId].includes(sig)) links[episodeId].push(sig);
      return true;
    },
    async getLinks() { return { ...links }; },
  };
}

function makeSemanticStore() {
  const entries = [];
  return {
    entries,
    async put(entry) {
      const stored = { id: `sem-${entries.length + 1}`, ...entry };
      entries.push(stored);
      return stored;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function ep(over = {}) {
  return {
    id: over.id || `ep-${Math.random().toString(36).slice(2, 7)}`,
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? 'release-workflow',
    summary: over.summary ?? 'ship release via ci',
    keywords: over.keywords ?? ['release', 'ci'],
    timestamp: over.timestamp ?? 1_000,
    importanceScore: over.importanceScore ?? 0.8,
  };
}

// ---------------------------------------------------------------------------

let createPromoter;

beforeEach(async () => {
  diskMap.clear();
  appendLog.length = 0;
  vi.resetModules();
  ({ createPromoter } = await import('../../../lib/learning/memory/promoter.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('memory promoter', () => {
  it('requires episodicStore and semanticStore', () => {
    expect(() => createPromoter({})).toThrow();
    expect(() => createPromoter({ episodicStore: {} })).toThrow();
  });

  describe('minOccurrences gate', () => {
    it('skips signatures with fewer occurrences than threshold', async () => {
      const episodicStore = makeEpisodicStore([
        ep({ id: 'e1', title: 'unique-topic', sessionId: 's1' }),
      ]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({
        episodicStore,
        semanticStore,
        config: { learning: { hierarchicalMemory: { promotion: { minOccurrences: 3 } } } },
        now: () => 10_000,
      });
      const result = await promoter.runPromotionSweep();
      expect(result.promoted).toHaveLength(0);
      expect(result.skipped.length).toBeGreaterThan(0);
      expect(result.skipped[0].reason).toBe('below-threshold');
    });

    it('promotes when occurrences + distinct sessions pass', async () => {
      const episodicStore = makeEpisodicStore([
        ep({ id: 'e1', title: 'repeated-topic', summary: 'same body', sessionId: 's1' }),
        ep({ id: 'e2', title: 'repeated-topic', summary: 'same body', sessionId: 's2' }),
        ep({ id: 'e3', title: 'repeated-topic', summary: 'same body', sessionId: 's3' }),
      ]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({
        episodicStore,
        semanticStore,
        config: {
          learning: {
            hierarchicalMemory: {
              promotion: { minOccurrences: 3, confidenceFloor: 0.85, distinctSessions: 2 },
            },
          },
        },
        now: () => 10_000,
      });
      const result = await promoter.runPromotionSweep();
      expect(result.promoted).toHaveLength(1);
      expect(semanticStore.entries).toHaveLength(1);
      expect(semanticStore.entries[0].usageCount).toBe(3);
      expect(semanticStore.entries[0].distinctSessions).toBe(3);
      expect(semanticStore.entries[0].confidence).toBeGreaterThanOrEqual(0.85);
      expect(semanticStore.entries[0].provenance).toEqual(['e1', 'e2', 'e3']);
    });
  });

  describe('distinctSessions gate', () => {
    it('rejects when all occurrences share one session', async () => {
      const episodicStore = makeEpisodicStore([
        ep({ id: 'e1', title: 'echo', summary: 'once', sessionId: 's1' }),
        ep({ id: 'e2', title: 'echo', summary: 'once', sessionId: 's1' }),
        ep({ id: 'e3', title: 'echo', summary: 'once', sessionId: 's1' }),
      ]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({
        episodicStore,
        semanticStore,
        config: {
          learning: {
            hierarchicalMemory: {
              promotion: { minOccurrences: 2, distinctSessions: 2, confidenceFloor: 0.85 },
            },
          },
        },
        now: () => 10_000,
      });
      const result = await promoter.runPromotionSweep();
      expect(result.promoted).toHaveLength(0);
      expect(result.skipped[0].reason).toBe('below-threshold');
      expect(result.skipped[0].distinctSessions).toBe(1);
    });
  });

  describe('confidence floor', () => {
    it('skips when confidence cannot clear the configured floor', async () => {
      const episodicStore = makeEpisodicStore([
        ep({ id: 'e1', title: 'topic', summary: 'a', sessionId: 's1' }),
        ep({ id: 'e2', title: 'topic', summary: 'a', sessionId: 's2' }),
      ]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({
        episodicStore,
        semanticStore,
        config: {
          learning: {
            hierarchicalMemory: {
              promotion: { minOccurrences: 2, distinctSessions: 2, confidenceFloor: 0.99 },
            },
          },
        },
        now: () => 10_000,
      });
      const result = await promoter.runPromotionSweep();
      expect(result.promoted).toHaveLength(0);
      expect(result.skipped[0].reason).toBe('below-threshold');
    });
  });

  describe('rejection cooldown', () => {
    it('skips signatures rejected within window', async () => {
      const episodes = [
        ep({ id: 'e1', title: 'cooling', summary: 'core', sessionId: 'sA' }),
        ep({ id: 'e2', title: 'cooling', summary: 'core', sessionId: 'sB' }),
        ep({ id: 'e3', title: 'cooling', summary: 'core', sessionId: 'sC' }),
      ];
      const episodicStore = makeEpisodicStore(episodes);
      const semanticStore = makeSemanticStore();
      const now = () => Date.parse('2026-04-24T00:00:00Z');

      // First, register rejection — this seeds runtime/promotion-rejections.json.
      const promoter1 = createPromoter({
        episodicStore, semanticStore,
        config: {
          learning: {
            hierarchicalMemory: {
              promotion: {
                minOccurrences: 3, distinctSessions: 2,
                confidenceFloor: 0.85, rejectionWindowDays: 30,
              },
            },
          },
        },
        now,
        rejectionsPath: '/tmp/rej.json',
        ledgerPath: '/tmp/ledger.log',
      });
      await promoter1.registerRejection('e1', 'user-declined');

      // Second sweep with same signature must skip due to recent rejection.
      const promoter2 = createPromoter({
        episodicStore, semanticStore,
        config: {
          learning: {
            hierarchicalMemory: {
              promotion: {
                minOccurrences: 3, distinctSessions: 2,
                confidenceFloor: 0.85, rejectionWindowDays: 30,
              },
            },
          },
        },
        now,
        rejectionsPath: '/tmp/rej.json',
        ledgerPath: '/tmp/ledger.log',
      });
      const result = await promoter2.runPromotionSweep();
      expect(result.promoted).toHaveLength(0);
      expect(result.skipped[0].reason).toBe('recent-rejection');
      expect(semanticStore.entries).toHaveLength(0);
    });

    it('allows promotion once window has elapsed', async () => {
      const episodes = [
        ep({ id: 'e1', title: 'aged', summary: 'body', sessionId: 'sA' }),
        ep({ id: 'e2', title: 'aged', summary: 'body', sessionId: 'sB' }),
        ep({ id: 'e3', title: 'aged', summary: 'body', sessionId: 'sC' }),
      ];
      const episodicStore = makeEpisodicStore(episodes);
      const semanticStore = makeSemanticStore();

      const then = Date.parse('2026-01-01T00:00:00Z');
      const later = Date.parse('2026-06-01T00:00:00Z'); // > 30 days after

      const first = createPromoter({
        episodicStore, semanticStore,
        config: { learning: { hierarchicalMemory: { promotion: { minOccurrences: 3, distinctSessions: 2, confidenceFloor: 0.85, rejectionWindowDays: 30 } } } },
        now: () => then,
        rejectionsPath: '/tmp/rej2.json',
        ledgerPath: '/tmp/ledger2.log',
      });
      await first.registerRejection('e1', 'user-declined');

      const second = createPromoter({
        episodicStore, semanticStore,
        config: { learning: { hierarchicalMemory: { promotion: { minOccurrences: 3, distinctSessions: 2, confidenceFloor: 0.85, rejectionWindowDays: 30 } } } },
        now: () => later,
        rejectionsPath: '/tmp/rej2.json',
        ledgerPath: '/tmp/ledger2.log',
      });
      const result = await second.runPromotionSweep();
      expect(result.promoted).toHaveLength(1);
    });
  });

  describe('ledger', () => {
    it('appends promote lines to memory-transitions.log', async () => {
      const episodes = [
        ep({ id: 'e1', title: 'ledger-test', summary: 'body', sessionId: 'sA' }),
        ep({ id: 'e2', title: 'ledger-test', summary: 'body', sessionId: 'sB' }),
        ep({ id: 'e3', title: 'ledger-test', summary: 'body', sessionId: 'sC' }),
      ];
      const episodicStore = makeEpisodicStore(episodes);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({
        episodicStore, semanticStore,
        config: {},
        now: () => 100_000,
        ledgerPath: '/tmp/my-ledger.log',
        rejectionsPath: '/tmp/my-rej.json',
      });
      await promoter.runPromotionSweep();
      const line = appendLog.find((x) => x.path === '/tmp/my-ledger.log');
      expect(line).toBeDefined();
      const parsed = JSON.parse(line.line.trim());
      expect(parsed.kind).toBe('promote');
      expect(parsed.from).toBe('episodic');
      expect(parsed.to).toBe('semantic');
    });
  });

  describe('defaults & safety', () => {
    it('uses default promotion config when block missing', async () => {
      const episodicStore = makeEpisodicStore([]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({ episodicStore, semanticStore });
      expect(promoter.config.minOccurrences).toBe(3);
      expect(promoter.config.confidenceFloor).toBe(0.85);
      expect(promoter.config.distinctSessions).toBe(2);
    });

    it('registerRejection returns false for unknown episode', async () => {
      const episodicStore = makeEpisodicStore([]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({
        episodicStore,
        semanticStore,
        rejectionsPath: '/tmp/rej-safe.json',
        ledgerPath: '/tmp/ledger-safe.log',
      });
      expect(await promoter.registerRejection('missing', 'r')).toBe(false);
    });

    it('handles empty episodic store gracefully', async () => {
      const episodicStore = makeEpisodicStore([]);
      const semanticStore = makeSemanticStore();
      const promoter = createPromoter({ episodicStore, semanticStore });
      const result = await promoter.runPromotionSweep();
      expect(result.promoted).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });
});
