import { describe, expect, it, beforeEach } from 'vitest';
import {
  recordScore,
  checkDrift,
  getHistory,
  resetAgent,
  resetAll,
  getSummary,
  WINDOW_SIZE,
  DRIFT_THRESHOLD,
  CRITICAL_STREAK,
  MIN_SAMPLES,
} from '../../lib/learning/drift-detector.js';

describe('drift-detector', () => {
  beforeEach(() => {
    resetAll();
  });

  // -----------------------------------------------------------------------
  // recordScore()
  // -----------------------------------------------------------------------

  describe('recordScore()', () => {
    it('records a score and returns metadata', () => {
      const result = recordScore('agent-1', 0.8);
      expect(result.recorded).toBe(true);
      expect(result.windowSize).toBe(1);
      expect(result.currentAvg).toBe(0.8);
    });

    it('clamps scores to 0-1 range', () => {
      const r1 = recordScore('agent-1', -0.5);
      expect(r1.currentAvg).toBe(0);

      resetAll();
      const r2 = recordScore('agent-1', 1.5);
      expect(r2.currentAvg).toBe(1);
    });

    it('handles NaN scores gracefully', () => {
      const result = recordScore('agent-1', NaN);
      expect(result.currentAvg).toBe(0);
    });

    it('accumulates scores in window', () => {
      recordScore('agent-1', 0.8);
      recordScore('agent-1', 0.6);
      const result = recordScore('agent-1', 0.7);
      expect(result.windowSize).toBe(3);
      expect(result.currentAvg).toBeCloseTo(0.7, 1);
    });

    it('rolls window at WINDOW_SIZE limit', () => {
      for (let i = 0; i < WINDOW_SIZE + 5; i++) {
        recordScore('agent-1', 0.9);
      }
      const result = recordScore('agent-1', 0.9);
      expect(result.windowSize).toBe(WINDOW_SIZE);
    });

    it('attaches metadata when provided', () => {
      recordScore('agent-1', 0.7, { task: 'build' });
      const history = getHistory('agent-1');
      expect(history[0].metadata).toEqual({ task: 'build' });
    });

    it('does not attach metadata field when not provided', () => {
      recordScore('agent-1', 0.7);
      const history = getHistory('agent-1');
      expect(history[0]).not.toHaveProperty('metadata');
    });

    it('tracks consecutive flags below threshold', () => {
      recordScore('agent-1', 0.5); // below 0.65
      recordScore('agent-1', 0.4); // below 0.65
      recordScore('agent-1', 0.3); // below 0.65
      const drift = checkDrift('agent-1');
      expect(drift.consecutiveFlags).toBe(3);
    });

    it('resets consecutive flags when score is above threshold', () => {
      recordScore('agent-1', 0.5);
      recordScore('agent-1', 0.4);
      recordScore('agent-1', 0.8); // above threshold -> reset
      const drift = checkDrift('agent-1');
      expect(drift.consecutiveFlags).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // checkDrift()
  // -----------------------------------------------------------------------

  describe('checkDrift()', () => {
    it('returns safe defaults for unknown agent', () => {
      const drift = checkDrift('nonexistent');
      expect(drift.drifting).toBe(false);
      expect(drift.score).toBe(0);
      expect(drift.trend).toBe('stable');
      expect(drift.severity).toBe('none');
      expect(drift.samples).toBe(0);
    });

    it('returns stable with insufficient samples', () => {
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.2);
      const drift = checkDrift('agent-1');
      expect(drift.drifting).toBe(false); // below MIN_SAMPLES
      expect(drift.samples).toBe(2);
    });

    it('detects drift when average below threshold', () => {
      for (let i = 0; i < 5; i++) {
        recordScore('agent-1', 0.4);
      }
      const drift = checkDrift('agent-1');
      expect(drift.drifting).toBe(true);
      expect(drift.score).toBeLessThan(DRIFT_THRESHOLD);
      expect(drift.severity).toBe('critical');
    });

    it('reports warning severity for drift below critical streak', () => {
      recordScore('agent-1', 0.8);
      recordScore('agent-1', 0.8);
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.3); // 3 consecutive flags, below CRITICAL_STREAK
      const drift = checkDrift('agent-1');
      // avg = (0.8+0.8+0.3+0.3+0.3)/5 = 0.5 < 0.65
      expect(drift.drifting).toBe(true);
      expect(drift.severity).toBe('warning');
    });

    it('reports critical severity when consecutive flags reach CRITICAL_STREAK', () => {
      for (let i = 0; i < CRITICAL_STREAK; i++) {
        recordScore('agent-1', 0.3);
      }
      const drift = checkDrift('agent-1');
      expect(drift.drifting).toBe(true);
      expect(drift.severity).toBe('critical');
      expect(drift.consecutiveFlags).toBe(CRITICAL_STREAK);
    });

    it('detects declining trend', () => {
      // First half high, second half low
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.4);
      recordScore('agent-1', 0.4);
      recordScore('agent-1', 0.4);
      recordScore('agent-1', 0.4);
      const drift = checkDrift('agent-1');
      expect(drift.trend).toBe('declining');
    });

    it('detects improving trend', () => {
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.3);
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.9);
      recordScore('agent-1', 0.9);
      const drift = checkDrift('agent-1');
      expect(drift.trend).toBe('improving');
    });

    it('detects stable trend when scores are consistent', () => {
      for (let i = 0; i < 8; i++) {
        recordScore('agent-1', 0.7);
      }
      const drift = checkDrift('agent-1');
      expect(drift.trend).toBe('stable');
    });

    it('reports no drift when average is above threshold', () => {
      for (let i = 0; i < 5; i++) {
        recordScore('agent-1', 0.8);
      }
      const drift = checkDrift('agent-1');
      expect(drift.drifting).toBe(false);
      expect(drift.severity).toBe('none');
    });
  });

  // -----------------------------------------------------------------------
  // getHistory()
  // -----------------------------------------------------------------------

  describe('getHistory()', () => {
    it('returns empty array for unknown agent', () => {
      expect(getHistory('nonexistent')).toEqual([]);
    });

    it('returns all entries when no limit', () => {
      recordScore('agent-1', 0.8);
      recordScore('agent-1', 0.7);
      recordScore('agent-1', 0.6);
      const history = getHistory('agent-1');
      expect(history).toHaveLength(3);
    });

    it('limits results to most recent entries', () => {
      recordScore('agent-1', 0.1);
      recordScore('agent-1', 0.2);
      recordScore('agent-1', 0.3);
      const history = getHistory('agent-1', 2);
      expect(history).toHaveLength(2);
      expect(history[0].score).toBe(0.2);
      expect(history[1].score).toBe(0.3);
    });

    it('returns a copy (no mutation)', () => {
      recordScore('agent-1', 0.8);
      const h1 = getHistory('agent-1');
      const h2 = getHistory('agent-1');
      expect(h1).not.toBe(h2);
    });
  });

  // -----------------------------------------------------------------------
  // resetAgent()
  // -----------------------------------------------------------------------

  describe('resetAgent()', () => {
    it('clears data for a specific agent', () => {
      recordScore('agent-1', 0.8);
      recordScore('agent-2', 0.7);
      resetAgent('agent-1');
      expect(getHistory('agent-1')).toEqual([]);
      expect(getHistory('agent-2')).toHaveLength(1);
    });

    it('handles resetting nonexistent agent gracefully', () => {
      expect(() => resetAgent('nonexistent')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // resetAll()
  // -----------------------------------------------------------------------

  describe('resetAll()', () => {
    it('clears all tracked agents', () => {
      recordScore('agent-1', 0.8);
      recordScore('agent-2', 0.7);
      resetAll();
      expect(getSummary()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getSummary()
  // -----------------------------------------------------------------------

  describe('getSummary()', () => {
    it('returns empty array when no agents tracked', () => {
      expect(getSummary()).toEqual([]);
    });

    it('returns summary for all tracked agents', () => {
      recordScore('agent-1', 0.8);
      recordScore('agent-2', 0.3);
      recordScore('agent-2', 0.3);
      recordScore('agent-2', 0.3);
      const summary = getSummary();
      expect(summary).toHaveLength(2);

      const a1 = summary.find((s) => s.agentId === 'agent-1');
      expect(a1.drifting).toBe(false); // below MIN_SAMPLES
      expect(a1.score).toBe(0.8);

      const a2 = summary.find((s) => s.agentId === 'agent-2');
      expect(a2.drifting).toBe(true); // 3 samples, avg 0.3 < 0.65
      expect(a2.score).toBe(0.3);
    });
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('WINDOW_SIZE is 20', () => {
      expect(WINDOW_SIZE).toBe(20);
    });

    it('DRIFT_THRESHOLD is 0.65', () => {
      expect(DRIFT_THRESHOLD).toBe(0.65);
    });

    it('CRITICAL_STREAK is 5', () => {
      expect(CRITICAL_STREAK).toBe(5);
    });

    it('MIN_SAMPLES is 3', () => {
      expect(MIN_SAMPLES).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-agent isolation
  // -----------------------------------------------------------------------

  describe('multi-agent isolation', () => {
    it('tracks agents independently', () => {
      for (let i = 0; i < 5; i++) {
        recordScore('good-agent', 0.9);
        recordScore('bad-agent', 0.2);
      }

      const goodDrift = checkDrift('good-agent');
      const badDrift = checkDrift('bad-agent');

      expect(goodDrift.drifting).toBe(false);
      expect(badDrift.drifting).toBe(true);
      expect(badDrift.severity).toBe('critical');
    });
  });
});
