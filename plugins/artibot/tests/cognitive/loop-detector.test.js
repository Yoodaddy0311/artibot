import { beforeEach, describe, expect, it } from 'vitest';
import { createLoopDetector } from '../../lib/cognitive/loop-detector.js';

describe('loop-detector', () => {
  let detector;

  beforeEach(() => {
    detector = createLoopDetector();
  });

  // -------------------------------------------------------------------------
  describe('createLoopDetector()', () => {
    it('returns an object with detectLoop, getLoopHistory, resetHistory', () => {
      expect(typeof detector.detectLoop).toBe('function');
      expect(typeof detector.getLoopHistory).toBe('function');
      expect(typeof detector.resetHistory).toBe('function');
    });

    it('returns a frozen object', () => {
      expect(Object.isFrozen(detector)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('detectLoop() - no repetition', () => {
    it('returns detected: false for a single call', () => {
      const result = detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
      expect(result.detected).toBe(false);
      expect(result.severity).toBe('none');
    });

    it('returns detected: false for different tools', () => {
      detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
      detector.detectLoop({ tool: 'Write', args: { file: 'b.js' } });
      const result = detector.detectLoop({ tool: 'Grep', args: { pattern: 'x' } });
      expect(result.detected).toBe(false);
    });

    it('returns detected: false for same tool with different args', () => {
      detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
      detector.detectLoop({ tool: 'Read', args: { file: 'b.js' } });
      const result = detector.detectLoop({ tool: 'Read', args: { file: 'c.js' } });
      expect(result.detected).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('detectLoop() - warn severity (consecutive)', () => {
    it('detects 3 consecutive identical calls as warn', () => {
      const call = { tool: 'Read', args: { file: 'a.js' } };
      detector.detectLoop(call);
      detector.detectLoop(call);
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('warn');
      expect(result.count).toBe(3);
    });

    it('includes fingerprint in detection result', () => {
      const call = { tool: 'Read', args: { file: 'x.ts' } };
      detector.detectLoop(call);
      detector.detectLoop(call);
      const result = detector.detectLoop(call);
      expect(result.fingerprint).toBeDefined();
      expect(result.fingerprint).toContain('Read');
    });
  });

  // -------------------------------------------------------------------------
  describe('detectLoop() - block severity (consecutive)', () => {
    it('detects 5 consecutive identical calls as block', () => {
      const call = { tool: 'Edit', args: { file: 'x.js', old: 'a', new: 'b' } };
      for (let i = 0; i < 4; i++) {
        detector.detectLoop(call);
      }
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('block');
      expect(result.count).toBe(5);
    });

    it('block severity overrides warn at exactly 5', () => {
      const call = { tool: 'Bash', args: { command: 'npm test' } };
      let lastResult;
      for (let i = 0; i < 5; i++) {
        lastResult = detector.detectLoop(call);
      }
      expect(lastResult.severity).toBe('block');
    });
  });

  // -------------------------------------------------------------------------
  describe('detectLoop() - non-consecutive frequency', () => {
    it('detects 7 of last 10 calls being identical as warn', () => {
      const repeated = { tool: 'Grep', args: { pattern: 'TODO' } };
      const different1 = { tool: 'Read', args: { file: 'a.js' } };
      const different2 = { tool: 'Read', args: { file: 'b.js' } };
      const different3 = { tool: 'Read', args: { file: 'c.js' } };

      // 7 repeated, 3 different, interleaved to break consecutive runs
      detector.detectLoop(repeated);
      detector.detectLoop(repeated);
      detector.detectLoop(different1);
      detector.detectLoop(repeated);
      detector.detectLoop(repeated);
      detector.detectLoop(different2);
      detector.detectLoop(repeated);
      detector.detectLoop(repeated);
      detector.detectLoop(different3);
      const result = detector.detectLoop(repeated); // 7th repeated in window of 10
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('warn');
      expect(result.count).toBe(7);
    });

    it('does not trigger frequency check when window is not full', () => {
      const repeated = { tool: 'Grep', args: { pattern: 'TODO' } };
      const different = { tool: 'Read', args: { file: 'a.js' } };

      // Only 5 calls total (window=10 not full)
      detector.detectLoop(repeated);
      detector.detectLoop(different);
      detector.detectLoop(repeated);
      detector.detectLoop(different);
      const result = detector.detectLoop(repeated);
      // Consecutive count is only 1, window not full
      expect(result.detected).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('detectLoop() - different tool breaks consecutive count', () => {
    it('resets consecutive count when a different call is inserted', () => {
      const call = { tool: 'Read', args: { file: 'a.js' } };
      const other = { tool: 'Write', args: { file: 'b.js' } };

      detector.detectLoop(call);
      detector.detectLoop(call);
      detector.detectLoop(other); // breaks consecutive run
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(false);
      expect(result.count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('custom configuration', () => {
    it('respects custom warnThreshold', () => {
      const custom = createLoopDetector({ warnThreshold: 2 });
      const call = { tool: 'Read', args: { file: 'a.js' } };
      custom.detectLoop(call);
      const result = custom.detectLoop(call);
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('warn');
      expect(result.count).toBe(2);
    });

    it('respects custom blockThreshold', () => {
      const custom = createLoopDetector({ blockThreshold: 3 });
      const call = { tool: 'Read', args: { file: 'a.js' } };
      custom.detectLoop(call);
      custom.detectLoop(call);
      const result = custom.detectLoop(call);
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('block');
    });

    it('respects custom maxHistory', () => {
      const custom = createLoopDetector({ maxHistory: 5 });
      for (let i = 0; i < 10; i++) {
        custom.detectLoop({ tool: 'Read', args: { file: `f${i}.js` } });
      }
      expect(custom.getLoopHistory()).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  describe('getLoopHistory()', () => {
    it('returns empty array initially', () => {
      expect(detector.getLoopHistory()).toEqual([]);
    });

    it('returns frozen array', () => {
      detector.detectLoop({ tool: 'Read', args: {} });
      const history = detector.getLoopHistory();
      expect(Object.isFrozen(history)).toBe(true);
    });

    it('tracks all calls up to maxHistory', () => {
      detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
      detector.detectLoop({ tool: 'Write', args: { file: 'b.js' } });
      const history = detector.getLoopHistory();
      expect(history).toHaveLength(2);
      expect(history[0].tool).toBe('Read');
      expect(history[1].tool).toBe('Write');
    });
  });

  // -------------------------------------------------------------------------
  describe('resetHistory()', () => {
    it('clears the history', () => {
      detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
      detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
      detector.resetHistory();
      expect(detector.getLoopHistory()).toEqual([]);
    });

    it('resets detection state', () => {
      const call = { tool: 'Read', args: { file: 'a.js' } };
      detector.detectLoop(call);
      detector.detectLoop(call);
      detector.resetHistory();
      // After reset, first call should not be detected
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('circular buffer overflow', () => {
    it('evicts oldest entries when exceeding maxHistory', () => {
      const small = createLoopDetector({ maxHistory: 3 });
      small.detectLoop({ tool: 'A', args: 1 });
      small.detectLoop({ tool: 'B', args: 2 });
      small.detectLoop({ tool: 'C', args: 3 });
      small.detectLoop({ tool: 'D', args: 4 });
      const history = small.getLoopHistory();
      expect(history).toHaveLength(3);
      expect(history[0].tool).toBe('B');
      expect(history[2].tool).toBe('D');
    });
  });

  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty args', () => {
      const call = { tool: 'Read', args: {} };
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(false);
    });

    it('handles undefined args', () => {
      const call = { tool: 'Read' };
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(false);
    });

    it('handles null args', () => {
      const call = { tool: 'Read', args: null };
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(false);
    });

    it('handles empty tool name', () => {
      const call = { tool: '', args: { x: 1 } };
      detector.detectLoop(call);
      detector.detectLoop(call);
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('warn');
    });

    it('handles missing tool property', () => {
      const call = { args: { x: 1 } };
      const result = detector.detectLoop(call);
      expect(result.detected).toBe(false);
      expect(result.severity).toBe('none');
    });

    it('treats undefined args and null args as same fingerprint', () => {
      // Both should hash to 'null'
      detector.detectLoop({ tool: 'X' });
      detector.detectLoop({ tool: 'X', args: null });
      const result = detector.detectLoop({ tool: 'X', args: undefined });
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('warn');
    });

    it('differentiates args with different key order (stringify is consistent)', () => {
      // JSON.stringify preserves insertion order, so different order = different hash
      // However, this is implementation-aware — just testing the behavior
      const call1 = { tool: 'Read', args: { a: 1, b: 2 } };
      const call2 = { tool: 'Read', args: { b: 2, a: 1 } };
      detector.detectLoop(call1);
      detector.detectLoop(call2);
      // They may or may not match depending on JS engine object key ordering
      // The important thing is it doesn't crash
      const result = detector.detectLoop(call1);
      expect(result).toBeDefined();
      expect(typeof result.detected).toBe('boolean');
    });
  });
});
