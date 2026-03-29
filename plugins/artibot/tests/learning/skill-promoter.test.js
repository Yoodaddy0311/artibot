import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _findCandidates,
  _generateDraft,
  _isDuplicate,
  _patternKey,
  _recordInStore,
  _toSlug,
  _trimStore,
  _weightedConfidence,
  createSkillPromoter,
} from '../../lib/learning/skill-promoter.js';
import { on, reset as resetEventBus } from '../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePattern(overrides = {}) {
  return {
    trigger: 'fix typescript error',
    context: 'TypeScript compilation failure in src/',
    tools: ['Read', 'Edit', 'Bash'],
    outcome: 'Fixed type error and tests pass',
    ...overrides,
  };
}

function makeRecord(overrides = {}) {
  return {
    key: 'fix typescript error::Bash,Edit,Read',
    pattern: Object.freeze(makePattern()),
    count: 5,
    confidence: 0.9,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-03-27T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('skill-promoter', () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  describe('patternKey', () => {
    it('generates stable key from trigger + sorted tools', () => {
      const key = _patternKey(makePattern());
      expect(key).toBe('fix typescript error::Bash,Edit,Read');
    });

    it('normalizes trigger case and trims', () => {
      const key = _patternKey({ trigger: '  FIX Bug  ', tools: ['Grep', 'Bash'] });
      expect(key).toBe('fix bug::Bash,Grep');
    });

    it('handles empty tools', () => {
      const key = _patternKey({ trigger: 'test', tools: [] });
      expect(key).toBe('test::');
    });

    it('handles missing fields', () => {
      const key = _patternKey({});
      expect(key).toBe('::');
    });
  });

  describe('weightedConfidence', () => {
    it('computes running average', () => {
      // prev=0.8 with count=4, new=1.0 → (0.8*4 + 1.0)/5 = 4.2/5 = 0.84
      expect(_weightedConfidence(0.8, 4, 1.0)).toBe(0.84);
    });

    it('first entry returns new confidence', () => {
      // prev=0.5 count=0 is edge case; but our code calls with count=prev.count
      // For count=1, prev=0.9, new=0.7 → (0.9 + 0.7)/2 = 0.8
      expect(_weightedConfidence(0.9, 1, 0.7)).toBe(0.8);
    });
  });

  describe('recordInStore', () => {
    it('adds new pattern to empty store', () => {
      const store = new Map();
      const result = _recordInStore(store, makePattern(), 0.9, '2026-01-01T00:00:00.000Z');
      expect(result.size).toBe(1);
      const record = [...result.values()][0];
      expect(record.count).toBe(1);
      expect(record.confidence).toBe(0.9);
    });

    it('increments count for existing pattern', () => {
      let store = new Map();
      store = _recordInStore(store, makePattern(), 0.9, '2026-01-01T00:00:00.000Z');
      store = _recordInStore(store, makePattern(), 0.8, '2026-01-02T00:00:00.000Z');
      const record = [...store.values()][0];
      expect(record.count).toBe(2);
      expect(record.lastSeen).toBe('2026-01-02T00:00:00.000Z');
    });

    it('returns new Map reference (immutability)', () => {
      const store = new Map();
      const result = _recordInStore(store, makePattern(), 0.9, '2026-01-01T00:00:00.000Z');
      expect(result).not.toBe(store);
      expect(store.size).toBe(0);
    });

    it('freezes pattern object', () => {
      const store = new Map();
      const result = _recordInStore(store, makePattern(), 0.9, '2026-01-01T00:00:00.000Z');
      const record = [...result.values()][0];
      expect(Object.isFrozen(record.pattern)).toBe(true);
    });
  });

  describe('trimStore', () => {
    it('returns store unchanged when under limit', () => {
      const store = new Map([['a', makeRecord({ key: 'a' })]]);
      expect(_trimStore(store, 100)).toBe(store);
    });

    it('trims oldest entries when over limit', () => {
      const store = new Map([
        ['old', makeRecord({ key: 'old', lastSeen: '2025-01-01T00:00:00.000Z' })],
        ['mid', makeRecord({ key: 'mid', lastSeen: '2026-01-01T00:00:00.000Z' })],
        ['new', makeRecord({ key: 'new', lastSeen: '2026-03-01T00:00:00.000Z' })],
      ]);
      const result = _trimStore(store, 2);
      expect(result.size).toBe(2);
      expect(result.has('old')).toBe(false);
      expect(result.has('mid')).toBe(true);
      expect(result.has('new')).toBe(true);
    });
  });

  describe('isDuplicate', () => {
    it('detects duplicate trigger', () => {
      const record = makeRecord();
      const existing = new Set(['fix typescript error']);
      expect(_isDuplicate(record, existing)).toBe(true);
    });

    it('returns false for non-duplicate', () => {
      const record = makeRecord();
      const existing = new Set(['deploy to staging']);
      expect(_isDuplicate(record, existing)).toBe(false);
    });

    it('handles empty trigger', () => {
      const record = makeRecord({ pattern: Object.freeze({ trigger: '', tools: [] }) });
      expect(_isDuplicate(record, new Set(['']))).toBe(false);
    });
  });

  describe('findCandidates', () => {
    it('returns patterns meeting thresholds', () => {
      const store = new Map([
        ['a', makeRecord({ key: 'a', count: 5, confidence: 0.9 })],
        ['b', makeRecord({ key: 'b', count: 1, confidence: 0.95 })],
        ['c', makeRecord({ key: 'c', count: 5, confidence: 0.5 })],
      ]);
      const result = _findCandidates(store, 3, 0.8, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('a');
    });

    it('excludes duplicates', () => {
      const store = new Map([
        ['a', makeRecord({ key: 'a', count: 5, confidence: 0.9 })],
      ]);
      const existing = new Set(['fix typescript error']);
      const result = _findCandidates(store, 3, 0.8, existing);
      expect(result).toHaveLength(0);
    });

    it('sorts by count descending', () => {
      const store = new Map([
        ['a', makeRecord({ key: 'a', count: 3, confidence: 0.85 })],
        ['b', makeRecord({ key: 'b', count: 10, confidence: 0.9, pattern: Object.freeze({ trigger: 'deploy', tools: [], context: '', outcome: '' }) })],
      ]);
      const result = _findCandidates(store, 3, 0.8, new Set());
      expect(result[0].count).toBe(10);
    });

    it('returns empty for empty store', () => {
      expect(_findCandidates(new Map(), 3, 0.8, new Set())).toEqual([]);
    });
  });

  describe('toSlug', () => {
    it('converts to kebab-case', () => {
      expect(_toSlug('Fix TypeScript Error')).toBe('fix-typescript-error');
    });

    it('strips special characters', () => {
      expect(_toSlug('API endpoint (REST)')).toBe('api-endpoint-rest');
    });

    it('defaults on empty', () => {
      expect(_toSlug('')).toBe('auto-skill');
    });

    it('truncates long strings', () => {
      const long = 'a'.repeat(100);
      expect(_toSlug(long).length).toBeLessThanOrEqual(60);
    });
  });

  describe('generateDraft', () => {
    it('produces valid SKILL.md content', () => {
      const candidate = makeRecord();
      const draft = _generateDraft(candidate);

      expect(draft.slug).toBe('fix-typescript-error');
      expect(draft.suggestedPath).toBe('skills/fix-typescript-error/SKILL.md');
      expect(draft.content).toContain('---');
      expect(draft.content).toContain('context: fork');
      expect(draft.content).toContain('name: fix-typescript-error');
      expect(draft.content).toContain('triggers:');
      expect(draft.content).toContain('## When This Skill Applies');
      expect(draft.content).toContain('## Core Guidance');
      expect(draft.content).toContain('## Quick Reference');
    });

    it('includes tools in draft', () => {
      const draft = _generateDraft(makeRecord());
      expect(draft.content).toContain('`Read`');
      expect(draft.content).toContain('`Edit`');
      expect(draft.content).toContain('`Bash`');
    });

    it('includes stats in quick reference', () => {
      const draft = _generateDraft(makeRecord({ count: 7, confidence: 0.92 }));
      expect(draft.content).toContain('7');
      expect(draft.content).toContain('0.92');
    });

    it('handles pattern with no tools', () => {
      const candidate = makeRecord({
        pattern: Object.freeze({ trigger: 'test', tools: [], context: '', outcome: '' }),
      });
      const draft = _generateDraft(candidate);
      expect(draft.content).toContain('(none recorded)');
    });
  });

  // ---------------------------------------------------------------------------
  // Factory integration tests
  // ---------------------------------------------------------------------------

  describe('createSkillPromoter', () => {
    it('creates with default config', () => {
      const promoter = createSkillPromoter();
      const stats = promoter.getPromotionStats();
      expect(stats).toEqual({ totalPatterns: 0, candidates: 0, promoted: 0 });
    });

    it('records success and counts', () => {
      const promoter = createSkillPromoter({ now: () => 1000 });
      promoter.recordSuccess(makePattern());
      promoter.recordSuccess(makePattern());

      expect(promoter.getStore().size).toBe(1);
      const record = [...promoter.getStore().values()][0];
      expect(record.count).toBe(2);
    });

    it('records different patterns separately', () => {
      const promoter = createSkillPromoter({ now: () => 2000 });
      promoter.recordSuccess(makePattern());
      promoter.recordSuccess(makePattern({ trigger: 'deploy to staging' }));

      expect(promoter.getStore().size).toBe(2);
    });

    it('tracks custom confidence', () => {
      const promoter = createSkillPromoter({ now: () => 3000 });
      promoter.recordSuccess(makePattern(), 0.7);

      const record = [...promoter.getStore().values()][0];
      expect(record.confidence).toBe(0.7);
    });

    it('identifyPromotionCandidates meets thresholds', () => {
      const promoter = createSkillPromoter({
        minSuccessCount: 2,
        minConfidence: 0.7,
        now: () => 4000,
      });

      promoter.recordSuccess(makePattern(), 0.9);
      expect(promoter.identifyPromotionCandidates()).toHaveLength(0);

      promoter.recordSuccess(makePattern(), 0.8);
      expect(promoter.identifyPromotionCandidates()).toHaveLength(1);
    });

    it('identifyPromotionCandidates excludes existing triggers', () => {
      const promoter = createSkillPromoter({
        minSuccessCount: 1,
        minConfidence: 0.5,
        existingTriggers: new Set(['fix typescript error']),
        now: () => 5000,
      });

      promoter.recordSuccess(makePattern(), 0.9);
      expect(promoter.identifyPromotionCandidates()).toHaveLength(0);
    });

    it('generateSkillDraft returns valid draft', () => {
      const promoter = createSkillPromoter({ now: () => 6000 });
      promoter.recordSuccess(makePattern(), 0.95);

      const store = promoter.getStore();
      const record = [...store.values()][0];
      const draft = promoter.generateSkillDraft(record);

      expect(draft.content).toContain('context: fork');
      expect(draft.suggestedPath).toMatch(/^skills\//);
    });

    it('promoteToSkill emits event', () => {
      const events = [];
      const sub = on('skill:promoted', (data) => events.push(data));

      const promoter = createSkillPromoter({
        minSuccessCount: 1,
        minConfidence: 0.5,
        now: () => 7000,
      });

      promoter.recordSuccess(makePattern(), 0.9);
      const candidates = promoter.identifyPromotionCandidates();
      const draft = promoter.promoteToSkill(candidates[0]);

      expect(events).toHaveLength(1);
      expect(events[0].detail).toContain('fix typescript error');
      expect(events[0].draft.suggestedPath).toContain('fix-typescript-error');
      expect(draft.content).toContain('---');

      sub.unsubscribe();
    });

    it('promoteToSkill increments promoted count', () => {
      const promoter = createSkillPromoter({
        minSuccessCount: 1,
        minConfidence: 0.5,
        now: () => 8000,
      });

      promoter.recordSuccess(makePattern(), 0.9);
      const candidates = promoter.identifyPromotionCandidates();
      promoter.promoteToSkill(candidates[0]);

      expect(promoter.getPromotionStats().promoted).toBe(1);
    });

    it('getPromotionStats reflects state', () => {
      const promoter = createSkillPromoter({
        minSuccessCount: 3,
        minConfidence: 0.8,
        now: () => 9000,
      });

      for (let i = 0; i < 5; i++) {
        promoter.recordSuccess(makePattern(), 0.9);
      }
      promoter.recordSuccess(makePattern({ trigger: 'deploy' }), 0.5);

      const stats = promoter.getPromotionStats();
      expect(stats.totalPatterns).toBe(2);
      expect(stats.candidates).toBe(1); // only the 5x pattern meets thresholds
      expect(stats.promoted).toBe(0);
    });

    it('getStore returns a copy (immutability)', () => {
      const promoter = createSkillPromoter({ now: () => 10000 });
      promoter.recordSuccess(makePattern());

      const store1 = promoter.getStore();
      const store2 = promoter.getStore();
      expect(store1).not.toBe(store2);
      expect(store1.size).toBe(store2.size);
    });
  });
});
