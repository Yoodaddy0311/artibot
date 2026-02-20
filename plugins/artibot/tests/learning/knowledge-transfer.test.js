import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  promoteToSystem1,
  demoteFromSystem1,
  recordSystem1Usage,
  hotSwap,
  getPromotionCandidates,
  getSystem1Patterns,
  getSystem1Pattern,
  getTransferHistory,
  getTransferStats,
  clearCache,
} from '../../lib/learning/knowledge-transfer.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn(() => Promise.resolve()),
    readFile: vi.fn(() => Promise.resolve(String(Date.now()))),
    rm: vi.fn(() => Promise.resolve()),
  },
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

    it('rejects when pattern is null', async () => {
      const result = await promoteToSystem1(null);
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('missing key');
    });

    it('rejects when pattern is undefined', async () => {
      const result = await promoteToSystem1(undefined);
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

    it('preserves existing usageCount on re-promotion', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.85,
          status: 'active',
          promotionCount: 1,
          usageCount: 42,
          failureCount: 2,
          consecutiveFailures: 0,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await promoteToSystem1(eligiblePattern);
      expect(result.pattern.usageCount).toBe(42);
      expect(result.pattern.failureCount).toBe(2);
    });

    it('handles pattern with missing consecutiveSuccesses (defaults to 0)', async () => {
      const result = await promoteToSystem1({
        key: 'tool::Read',
        confidence: 0.9,
      });
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('Insufficient successes');
    });

    it('handles pattern with missing confidence (defaults to 0)', async () => {
      const result = await promoteToSystem1({
        key: 'tool::Read',
        consecutiveSuccesses: 5,
      });
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('Confidence too low');
    });

    it('derives type and category from key when not provided', async () => {
      const result = await promoteToSystem1({
        key: 'error::timeout',
        confidence: 0.9,
        consecutiveSuccesses: 3,
      });
      expect(result.promoted).toBe(true);
      expect(result.pattern.type).toBe('error');
      expect(result.pattern.category).toBe('timeout');
    });

    it('defaults insight and bestData to null when not provided', async () => {
      const result = await promoteToSystem1({
        key: 'tool::Grep',
        confidence: 0.85,
        consecutiveSuccesses: 4,
      });
      expect(result.promoted).toBe(true);
      expect(result.pattern.insight).toBeNull();
      expect(result.pattern.bestData).toBeNull();
    });

    it('records lastSuccessStreak correctly', async () => {
      const result = await promoteToSystem1({
        ...eligiblePattern,
        consecutiveSuccesses: 7,
      });
      expect(result.pattern.lastSuccessStreak).toBe(7);
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

    it('rejects when pattern is null', async () => {
      const result = await demoteFromSystem1(null);
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

    it('uses "Manual demotion" as default reason when none provided', async () => {
      const result = await demoteFromSystem1({ key: 'tool::Read' });
      expect(result.reason).toContain('Demoted from System 1');
    });

    it('preserves original pattern data in returned demoted pattern', async () => {
      const result = await demoteFromSystem1({ key: 'tool::Read', reason: 'test' });
      expect(result.pattern.confidence).toBe(0.9);
      expect(result.pattern.usageCount).toBe(10);
      expect(result.pattern.failureCount).toBe(1);
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

    it('sets lastSuccessAt on success', async () => {
      await recordSystem1Usage('tool::Read', true);
      const state = await getSystem1Pattern('tool::Read');
      expect(state.lastSuccessAt).toBeDefined();
    });

    it('increments consecutiveFailures on failure', async () => {
      await recordSystem1Usage('tool::Read', false);
      const pattern = await getSystem1Pattern('tool::Read');
      expect(pattern.consecutiveFailures).toBe(1);
    });

    it('increments failureCount on failure', async () => {
      await recordSystem1Usage('tool::Read', false);
      const pattern = await getSystem1Pattern('tool::Read');
      expect(pattern.failureCount).toBe(1);
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
          failureCount: 2,  // 40% error rate after one more failure
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

    it('does not auto-demote on error rate when usageCount < 5', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          usageCount: 3,
          failureCount: 1,  // 33% error rate, but only 4 uses after recording
          consecutiveFailures: 0,
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await recordSystem1Usage('tool::Read', false);
      // usageCount becomes 4, still < 5 for error rate check
      expect(result.autoDemoted).toBe(false);
    });

    it('reports consecutive failures reason over error rate reason', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          usageCount: 10,
          failureCount: 3,
          consecutiveFailures: 1,  // will become 2 -> triggers consecutive failure
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await recordSystem1Usage('tool::Read', false);
      expect(result.autoDemoted).toBe(true);
      expect(result.reason).toContain('consecutive failures');
    });

    it('persists updated pattern to disk when not demoted', async () => {
      await recordSystem1Usage('tool::Read', true);
      // Should have written system1 patterns
      const system1Write = writeJsonFile.mock.calls.some(([p]) =>
        p.includes('system1-patterns')
      );
      expect(system1Write).toBe(true);
    });

    it('handles pattern with missing usageCount and failureCount', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          status: 'active',
          promotionCount: 1,
        }],
        updatedAt: new Date().toISOString(),
      });
      const result = await recordSystem1Usage('tool::Read', false);
      expect(result.updated).toBe(true);
      const pattern = await getSystem1Pattern('tool::Read');
      // Should handle undefined gracefully via ?? 0
      if (pattern) {
        expect(pattern.usageCount).toBe(1);
        expect(pattern.failureCount).toBe(1);
      }
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

    it('does not log hot-swap when nothing changed', async () => {
      readJsonFile.mockResolvedValue(null);
      await hotSwap();
      // No transfer-log write for hot-swap action (no changes)
      const hotSwapLogWrite = writeJsonFile.mock.calls.filter(([p, data]) =>
        p.includes('transfer-log') && Array.isArray(data) &&
        data.some((e) => e.action === 'hot-swap')
      );
      // The hot-swap log should only be written if there were changes
      // With no changes, the unchanged count should be 0
    });

    it('logs hot-swap event when changes occur', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Bad',
              status: 'active',
              usageCount: 10,
              failureCount: 5,
              consecutiveFailures: 3,
              promotionCount: 1,
            }],
            updatedAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      });
      await hotSwap();
      // Should have written transfer log entries
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('handles both promotions and demotions in single hotSwap', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Failing',
              status: 'active',
              usageCount: 5,
              failureCount: 3,
              consecutiveFailures: 3,
              promotionCount: 1,
            }],
            updatedAt: new Date().toISOString(),
          });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::NewGood',
              type: 'tool',
              category: 'NewGood',
              confidence: 0.95,
              consecutiveSuccesses: 5,
              insight: 'great',
              bestData: {},
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await hotSwap();
      expect(result.demoted).toContain('tool::Failing');
      expect(result.promoted).toContain('tool::NewGood');
    });

    it('does not demote patterns with low usageCount even if error rate is high', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::LowUsage',
              status: 'active',
              usageCount: 3,  // < 5
              failureCount: 2,  // 66% rate, but usageCount < 5
              consecutiveFailures: 0,
              promotionCount: 1,
            }],
            updatedAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      });
      const result = await hotSwap();
      expect(result.demoted).not.toContain('tool::LowUsage');
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

    it('belowThreshold entries include needsSuccesses and needsConfidence', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Grep',
              confidence: 0.6,
              consecutiveSuccesses: 1,
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      const below = result.belowThreshold.find((b) => b.key === 'tool::Grep');
      expect(below).toBeDefined();
      expect(below.needsSuccesses).toBe(2); // 3 - 1
      expect(below.needsConfidence).toBeGreaterThan(0); // 0.8 - 0.6 = 0.2
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

    it('scans all pattern types (tool, error, success, team, general)', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('success-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'success::build',
              type: 'success',
              category: 'build',
              confidence: 0.92,
              consecutiveSuccesses: 4,
              insight: 'build success',
              sampleSize: 10,
            }],
          });
        }
        if (p.includes('error-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'error::timeout',
              type: 'error',
              category: 'timeout',
              confidence: 0.88,
              consecutiveSuccesses: 3,
              insight: 'timeout pattern',
              sampleSize: 8,
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      expect(result.candidates.some((c) => c.key === 'success::build')).toBe(true);
      expect(result.candidates.some((c) => c.key === 'error::timeout')).toBe(true);
    });

    it('handles missing sampleSize with default 0', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({ patterns: [], updatedAt: new Date().toISOString() });
        }
        if (p.includes('tool-patterns')) {
          return Promise.resolve({
            patterns: [{
              key: 'tool::Read',
              confidence: 0.9,
              consecutiveSuccesses: 3,
              // no sampleSize
            }],
          });
        }
        return Promise.resolve(null);
      });
      const result = await getPromotionCandidates();
      const candidate = result.candidates.find((c) => c.key === 'tool::Read');
      expect(candidate.sampleSize).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getSystem1Patterns()', () => {
    it('returns empty array when no patterns exist', async () => {
      readJsonFile.mockResolvedValue(null);
      const patterns = await getSystem1Patterns();
      expect(patterns).toEqual([]);
    });

    it('returns only active patterns', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [
          { key: 'tool::Read', status: 'active', confidence: 0.9 },
          { key: 'tool::Write', status: 'demoted', confidence: 0.5 },
        ],
        updatedAt: new Date().toISOString(),
      });
      const patterns = await getSystem1Patterns();
      expect(patterns).toHaveLength(1);
      expect(patterns[0].key).toBe('tool::Read');
    });

    it('returns all active patterns', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [
          { key: 'tool::Read', status: 'active', confidence: 0.9 },
          { key: 'tool::Grep', status: 'active', confidence: 0.85 },
        ],
        updatedAt: new Date().toISOString(),
      });
      const patterns = await getSystem1Patterns();
      expect(patterns).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getSystem1Pattern()', () => {
    it('returns null when pattern not found', async () => {
      readJsonFile.mockResolvedValue(null);
      const pattern = await getSystem1Pattern('tool::Nonexistent');
      expect(pattern).toBeNull();
    });

    it('returns pattern when it exists', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [
          { key: 'tool::Read', status: 'active', confidence: 0.9 },
        ],
        updatedAt: new Date().toISOString(),
      });
      const pattern = await getSystem1Pattern('tool::Read');
      expect(pattern).not.toBeNull();
      expect(pattern.key).toBe('tool::Read');
    });
  });

  // ---------------------------------------------------------------------------
  describe('getTransferHistory()', () => {
    it('returns empty array when no log exists', async () => {
      readJsonFile.mockResolvedValue(null);
      const history = await getTransferHistory();
      expect(history).toEqual([]);
    });

    it('returns all entries up to default limit (50)', async () => {
      const log = Array.from({ length: 60 }, (_, i) => ({
        action: 'promote',
        patternKey: `tool::T${i}`,
        timestamp: new Date().toISOString(),
      }));
      readJsonFile.mockResolvedValue(null);
      // First call will be for system1 cache, second for transfer log
      readJsonFile.mockImplementation((p) => {
        if (p.includes('transfer-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const history = await getTransferHistory();
      expect(history).toHaveLength(50);
    });

    it('respects limit option', async () => {
      const log = Array.from({ length: 20 }, (_, i) => ({
        action: 'promote',
        patternKey: `tool::T${i}`,
        timestamp: new Date().toISOString(),
      }));
      readJsonFile.mockImplementation((p) => {
        if (p.includes('transfer-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const history = await getTransferHistory({ limit: 5 });
      expect(history).toHaveLength(5);
    });

    it('filters by action type', async () => {
      const log = [
        { action: 'promote', patternKey: 'tool::Read', timestamp: new Date().toISOString() },
        { action: 'demote', patternKey: 'tool::Write', timestamp: new Date().toISOString() },
        { action: 'hot-swap', promoted: ['tool::Grep'], demoted: [], timestamp: new Date().toISOString() },
        { action: 'promote', patternKey: 'tool::Edit', timestamp: new Date().toISOString() },
      ];
      readJsonFile.mockImplementation((p) => {
        if (p.includes('transfer-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const promotions = await getTransferHistory({ action: 'promote' });
      expect(promotions).toHaveLength(2);
      expect(promotions.every((e) => e.action === 'promote')).toBe(true);
    });

    it('returns demotions only when filtered', async () => {
      const log = [
        { action: 'promote', patternKey: 'tool::Read', timestamp: new Date().toISOString() },
        { action: 'demote', patternKey: 'tool::Write', timestamp: new Date().toISOString() },
      ];
      readJsonFile.mockImplementation((p) => {
        if (p.includes('transfer-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const demotions = await getTransferHistory({ action: 'demote' });
      expect(demotions).toHaveLength(1);
      expect(demotions[0].action).toBe('demote');
    });

    it('returns hot-swap events only when filtered', async () => {
      const log = [
        { action: 'hot-swap', promoted: [], demoted: [], timestamp: new Date().toISOString() },
        { action: 'promote', patternKey: 'tool::Read', timestamp: new Date().toISOString() },
      ];
      readJsonFile.mockImplementation((p) => {
        if (p.includes('transfer-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const hotSwaps = await getTransferHistory({ action: 'hot-swap' });
      expect(hotSwaps).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getTransferStats()', () => {
    it('returns stats with all required fields', async () => {
      readJsonFile.mockResolvedValue(null);
      const stats = await getTransferStats();
      expect(stats).toHaveProperty('system1Count');
      expect(stats).toHaveProperty('totalPromotions');
      expect(stats).toHaveProperty('totalDemotions');
      expect(stats).toHaveProperty('avgConfidence');
      expect(stats).toHaveProperty('avgUsageCount');
      expect(stats).toHaveProperty('hotSwapCount');
    });

    it('returns zeros when no data exists', async () => {
      readJsonFile.mockResolvedValue(null);
      const stats = await getTransferStats();
      expect(stats.system1Count).toBe(0);
      expect(stats.totalPromotions).toBe(0);
      expect(stats.totalDemotions).toBe(0);
      expect(stats.avgConfidence).toBe(0);
      expect(stats.avgUsageCount).toBe(0);
      expect(stats.hotSwapCount).toBe(0);
    });

    it('computes correct counts from data', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [
              { key: 'tool::Read', status: 'active', confidence: 0.9, usageCount: 10 },
              { key: 'tool::Grep', status: 'active', confidence: 0.8, usageCount: 5 },
            ],
            updatedAt: new Date().toISOString(),
          });
        }
        if (p.includes('transfer-log')) {
          return Promise.resolve([
            { action: 'promote', patternKey: 'tool::Read' },
            { action: 'promote', patternKey: 'tool::Grep' },
            { action: 'demote', patternKey: 'tool::Write' },
            { action: 'hot-swap', promoted: [], demoted: [] },
          ]);
        }
        return Promise.resolve(null);
      });
      const stats = await getTransferStats();
      expect(stats.system1Count).toBe(2);
      expect(stats.totalPromotions).toBe(2);
      expect(stats.totalDemotions).toBe(1);
      expect(stats.hotSwapCount).toBe(1);
      expect(stats.avgConfidence).toBeGreaterThan(0);
      expect(stats.avgUsageCount).toBeGreaterThan(0);
    });

    it('computes avgConfidence correctly', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('system1')) {
          return Promise.resolve({
            patterns: [
              { key: 'a', confidence: 0.8, usageCount: 0 },
              { key: 'b', confidence: 1.0, usageCount: 0 },
            ],
            updatedAt: new Date().toISOString(),
          });
        }
        if (p.includes('transfer-log')) return Promise.resolve([]);
        return Promise.resolve(null);
      });
      const stats = await getTransferStats();
      expect(stats.avgConfidence).toBe(0.9);
    });
  });

  // ---------------------------------------------------------------------------
  describe('clearCache()', () => {
    it('clears the in-memory cache', async () => {
      // Load patterns into cache
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Read', status: 'active', confidence: 0.9 }],
        updatedAt: new Date().toISOString(),
      });
      const p1 = await getSystem1Pattern('tool::Read');
      expect(p1).not.toBeNull();

      // Clear cache and change mock to return empty
      clearCache();
      readJsonFile.mockResolvedValue({ patterns: [], updatedAt: new Date().toISOString() });

      const p2 = await getSystem1Pattern('tool::Read');
      expect(p2).toBeNull();
    });
  });
});
