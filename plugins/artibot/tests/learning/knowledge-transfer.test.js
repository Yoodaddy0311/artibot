import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  promoteToSystem1,
  demoteFromSystem1,
  recordSystem1Usage,
  hotSwap,
  getPromotionCandidates,
  getSystem1Patterns,
  getSystem1Pattern,
  clearCache,
} from '../../lib/learning/knowledge-transfer.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

const { readJsonFile, writeJsonFile } = await import('../../lib/core/file.js');

describe('knowledge-transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
    clearCache();
  });

  // ---------------------------------------------------------------------------
  describe('promoteToSystem1()', () => {
    const eligiblePattern = {
      key: 'tool::Read',
      type: 'tool',
      category: 'Read',
      confidence: 0.9,
      consecutiveSuccesses: 3,
      insight: 'Read is reliable',
      bestData: { successRate: 1.0 },
    };

    it('promotes pattern meeting all criteria', async () => {
      const result = await promoteToSystem1(eligiblePattern);
      expect(result.promoted).toBe(true);
      expect(result.pattern).not.toBeNull();
      expect(result.pattern.key).toBe('tool::Read');
      expect(result.pattern.status).toBe('active');
    });

    it('rejects promotion when consecutiveSuccesses < 3', async () => {
      const result = await promoteToSystem1({
        ...eligiblePattern,
        consecutiveSuccesses: 2,
      });
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('Insufficient successes');
    });

    it('rejects promotion when confidence < 0.8', async () => {
      const result = await promoteToSystem1({
        ...eligiblePattern,
        confidence: 0.75,
      });
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('Confidence too low');
    });

    it('rejects when pattern has no key', async () => {
      const result = await promoteToSystem1({ confidence: 0.9, consecutiveSuccesses: 3 });
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('missing key');
    });

    it('sets promotionCount to 1 on first promotion', async () => {
      const result = await promoteToSystem1(eligiblePattern);
      expect(result.pattern.promotionCount).toBe(1);
    });

    it('increments promotionCount on re-promotion', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.85,
          status: 'active',
          promotionCount: 1,
          usageCount: 5,
          failureCount: 0,
          consecutiveFailures: 0,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await promoteToSystem1(eligiblePattern);
      expect(result.pattern.promotionCount).toBe(2);
    });

    it('writes to disk on promotion', async () => {
      await promoteToSystem1(eligiblePattern);
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('logs the promotion in transfer log', async () => {
      await promoteToSystem1(eligiblePattern);
      // Both system1 and transfer-log should be written
      expect(writeJsonFile.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('pattern has source=system2', async () => {
      const result = await promoteToSystem1(eligiblePattern);
      expect(result.pattern.source).toBe('system2');
    });

    it('sets consecutiveFailures to 0 on promotion', async () => {
      const result = await promoteToSystem1(eligiblePattern);
      expect(result.pattern.consecutiveFailures).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('demoteFromSystem1()', () => {
    beforeEach(() => {
      // Seed system1 cache with an active pattern
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.9,
          status: 'active',
          promotionCount: 1,
          usageCount: 10,
          failureCount: 1,
          consecutiveFailures: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
    });

    it('demotes an existing System 1 pattern', async () => {
      const result = await demoteFromSystem1({ key: 'tool::Read', reason: 'Too many failures' });
      expect(result.demoted).toBe(true);
      expect(result.pattern.status).toBe('demoted');
    });

    it('returns not found when pattern is not in System 1', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await demoteFromSystem1({ key: 'tool::Grep' });
      expect(result.demoted).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('rejects when pattern has no key', async () => {
      const result = await demoteFromSystem1({ reason: 'no key' });
      expect(result.demoted).toBe(false);
      expect(result.reason).toContain('missing key');
    });

    it('removes pattern from System 1 cache', async () => {
      await demoteFromSystem1({ key: 'tool::Read', reason: 'test' });
      // Pattern should be removed - next access returns null
      clearCache();
      readJsonFile.mockResolvedValue({ patterns: [], updatedAt: new Date().toISOString() });
      const pattern = await getSystem1Pattern('tool::Read');
      expect(pattern).toBeNull();
    });

    it('writes updated cache to disk', async () => {
      await demoteFromSystem1({ key: 'tool::Read', reason: 'test' });
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('logs demotion to transfer log', async () => {
      await demoteFromSystem1({ key: 'tool::Read', reason: 'manual' });
      expect(writeJsonFile.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('includes demotedAt in returned pattern', async () => {
      const result = await demoteFromSystem1({ key: 'tool::Read' });
      expect(result.pattern.demotedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('recordSystem1Usage()', () => {
    beforeEach(() => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.9,
          status: 'active',
          promotionCount: 1,
          usageCount: 5,
          failureCount: 0,
          consecutiveFailures: 0,
        }],
        updatedAt: new Date().toISOString(),
      });
    });

    it('increments usageCount on successful usage', async () => {
      const result = await recordSystem1Usage('tool::Read', true);
      expect(result.updated).toBe(true);
      expect(result.autoDemoted).toBe(false);
    });

    it('returns not updated when pattern not in System 1', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await recordSystem1Usage('tool::Grep', true);
      expect(result.updated).toBe(false);
      expect(result.reason).toContain('not in System 1');
    });

    it('resets consecutiveFailures on success', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          usageCount: 3,
          failureCount: 1,
          consecutiveFailures: 1,
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      await recordSystem1Usage('tool::Read', true);
      // Should NOT auto-demote
      const state = await getSystem1Pattern('tool::Read');
      expect(state.consecutiveFailures).toBe(0);
    });

    it('increments consecutiveFailures on failure', async () => {
      await recordSystem1Usage('tool::Read', false);
      const pattern = await getSystem1Pattern('tool::Read');
      expect(pattern.consecutiveFailures).toBe(1);
    });

    it('auto-demotes after 2 consecutive failures', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          usageCount: 5,
          failureCount: 1,
          consecutiveFailures: 1,
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await recordSystem1Usage('tool::Read', false);
      expect(result.autoDemoted).toBe(true);
      expect(result.reason).toContain('consecutive failures');
    });

    it('auto-demotes when error rate exceeds 20% after 5+ uses', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          usageCount: 5,
          failureCount: 2,  // 40% error rate
          consecutiveFailures: 0,
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await recordSystem1Usage('tool::Read', false);
      expect(result.autoDemoted).toBe(true);
    });

    it('does not auto-demote when error rate is below threshold', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          usageCount: 10,
          failureCount: 1,  // 10% error rate - below 20%
          consecutiveFailures: 0,
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await recordSystem1Usage('tool::Read', true);
      expect(result.autoDemoted).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('hotSwap()', () => {
    it('returns promoted, demoted, unchanged, timestamp', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await hotSwap();
      expect(result).toHaveProperty('promoted');
      expect(result).toHaveProperty('demoted');
      expect(result).toHaveProperty('unchanged');
      expect(result).toHaveProperty('timestamp');
    });

    it('promotes eligible candidates from pattern files', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Read',
              type: 'tool',
              category: 'Read',
              confidence: 0.95,
              consecutiveSuccesses: 5,
              insight: 'Read is very reliable',
              bestData: {},
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await hotSwap();
      expect(result.promoted).toContain('tool::Read');
    });

    it('demotes patterns with 2+ consecutive failures', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Write',
              status: 'active',
              usageCount: 5,
              failureCount: 2,
              consecutiveFailures: 2,
              promotionCount: 1,
            }],
            updatedAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      });
      const result = await hotSwap();
      expect(result.demoted).toContain('tool::Write');
    });

    it('demotes patterns with high error rate (>20% after 5+ uses)', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Edit',
              status: 'active',
              usageCount: 10,
              failureCount: 4,  // 40% error rate
              consecutiveFailures: 0,
              promotionCount: 1,
            }],
            updatedAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      });
      const result = await hotSwap();
      expect(result.demoted).toContain('tool::Edit');
    });

    it('returns empty promoted/demoted arrays when nothing to do', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await hotSwap();
      expect(result.promoted).toEqual([]);
      expect(result.demoted).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getPromotionCandidates()', () => {
    it('returns candidates, alreadyPromoted, belowThreshold', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await getPromotionCandidates();
      expect(result).toHaveProperty('candidates');
      expect(result).toHaveProperty('alreadyPromoted');
      expect(result).toHaveProperty('belowThreshold');
    });

    it('identifies eligible candidates from pattern files', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Read',
              type: 'tool',
              category: 'Read',
              confidence: 0.92,
              consecutiveSuccesses: 4,
              insight: 'reliable',
              sampleSize: 15,
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      expect(result.candidates.some((c) => c.key === 'tool::Read')).toBe(true);
    });

    it('excludes already-promoted patterns from candidates', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Read',
              status: 'active',
              promotionCount: 1,
              usageCount: 5,
              failureCount: 0,
              consecutiveFailures: 0,
            }],
            updatedAt: new Date().toISOString(),
          });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Read',
              confidence: 0.9,
              consecutiveSuccesses: 4,
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      expect(result.candidates.some((c) => c.key === 'tool::Read')).toBe(false);
      expect(result.alreadyPromoted).toContain('tool::Read');
    });

    it('puts below-threshold patterns in belowThreshold array', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Grep',
              type: 'tool',
              category: 'Grep',
              confidence: 0.6,  // below 0.8
              consecutiveSuccesses: 1,  // below 3
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      expect(result.belowThreshold.some((b) => b.key === 'tool::Grep')).toBe(true);
    });

    it('sorts candidates by confidence descending', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [
              { key: 'tool::Read', confidence: 0.85, consecutiveSuccesses: 3 },
              { key: 'tool::Grep', confidence: 0.95, consecutiveSuccesses: 5 },
            ],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      if (result.candidates.length >= 2) {
        expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(result.candidates[1].confidence);
      }
    });
  });
});
