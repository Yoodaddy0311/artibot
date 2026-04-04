import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  atomicWriteSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
});

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import pure functions for unit testing
// ---------------------------------------------------------------------------
const {
  estimateTokens,
  calcUsagePercent,
  calcDelta,
  buildStatusMessage,
  formatNumber,
  getSessionFilePath,
  loadSessionState,
  saveSessionState,
} = await import('../../scripts/hooks/context-tracker.js');

const { readStdin, writeStdout, atomicWriteSync } = await import('../../scripts/utils/index.js');
const { readFileSync, existsSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('context-tracker hook', () => {
  let stderrSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // estimateTokens
  // -----------------------------------------------------------------------
  describe('estimateTokens', () => {
    it('uses explicit current_tokens and max_tokens when available', () => {
      const result = estimateTokens(
        { current_tokens: 45000, max_tokens: 128000 },
        '',
      );
      expect(result).toEqual({ current: 45000, max: 128000 });
    });

    it('falls back to char-based heuristic when current_tokens is missing', () => {
      const input = 'a'.repeat(4000); // 4000 chars = ~1000 tokens
      const result = estimateTokens(null, input);
      expect(result.current).toBe(1000);
      expect(result.max).toBe(128000); // default
    });

    it('uses max_tokens from context_window even with heuristic fallback', () => {
      const input = 'a'.repeat(800); // 200 tokens
      const result = estimateTokens({ max_tokens: 200000 }, input);
      expect(result.current).toBe(200);
      expect(result.max).toBe(200000);
    });

    it('handles empty input gracefully', () => {
      const result = estimateTokens(null, '');
      expect(result.current).toBe(0);
      expect(result.max).toBe(128000);
    });

    it('handles null input gracefully', () => {
      const result = estimateTokens(null, null);
      expect(result.current).toBe(0);
      expect(result.max).toBe(128000);
    });

    it('handles current_tokens of zero', () => {
      const result = estimateTokens({ current_tokens: 0, max_tokens: 128000 }, '');
      expect(result.current).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // calcUsagePercent
  // -----------------------------------------------------------------------
  describe('calcUsagePercent', () => {
    it('calculates correct percentage', () => {
      expect(calcUsagePercent(45000, 128000)).toBeCloseTo(35.15625, 2);
    });

    it('returns 0 when max is 0', () => {
      expect(calcUsagePercent(100, 0)).toBe(0);
    });

    it('caps at 100%', () => {
      expect(calcUsagePercent(200000, 128000)).toBe(100);
    });

    it('returns 0 for zero current', () => {
      expect(calcUsagePercent(0, 128000)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // calcDelta
  // -----------------------------------------------------------------------
  describe('calcDelta', () => {
    it('calculates positive delta', () => {
      expect(calcDelta(5000, 3000)).toBe(2000);
    });

    it('calculates negative delta', () => {
      expect(calcDelta(2000, 5000)).toBe(-3000);
    });

    it('returns 0 when previous is null (first turn)', () => {
      expect(calcDelta(5000, null)).toBe(0);
    });

    it('returns 0 when previous is undefined', () => {
      expect(calcDelta(5000, undefined)).toBe(0);
    });

    it('returns 0 when both are equal', () => {
      expect(calcDelta(3000, 3000)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // formatNumber
  // -----------------------------------------------------------------------
  describe('formatNumber', () => {
    it('formats thousands with commas', () => {
      expect(formatNumber(45000)).toBe('45,000');
    });

    it('formats small numbers without commas', () => {
      expect(formatNumber(500)).toBe('500');
    });

    it('formats zero', () => {
      expect(formatNumber(0)).toBe('0');
    });
  });

  // -----------------------------------------------------------------------
  // buildStatusMessage
  // -----------------------------------------------------------------------
  describe('buildStatusMessage', () => {
    it('builds normal status message with positive delta', () => {
      const msg = buildStatusMessage(45000, 128000, 2300);
      expect(msg).toContain('45,000 tokens');
      expect(msg).toContain('35.2% used');
      expect(msg).toContain('83,000 remaining');
      expect(msg).toContain('+2,300');
      expect(msg).not.toContain('70%');
      expect(msg).not.toContain('90%');
    });

    it('includes 70% warning when usage crosses threshold', () => {
      const msg = buildStatusMessage(90000, 128000, 1000);
      expect(msg).toContain('70%+');
      expect(msg).toContain('consider /compact');
      expect(msg).not.toContain('90%+');
    });

    it('includes 90% critical warning when usage crosses threshold', () => {
      const msg = buildStatusMessage(120000, 128000, 500);
      expect(msg).toContain('90%+');
      expect(msg).toContain('compact urgently');
    });

    it('handles negative delta', () => {
      const msg = buildStatusMessage(30000, 128000, -5000);
      expect(msg).toContain('-5,000');
    });

    it('handles zero delta', () => {
      const msg = buildStatusMessage(30000, 128000, 0);
      expect(msg).toContain('+0');
    });

    it('shows exactly 70% as warning', () => {
      const msg = buildStatusMessage(89600, 128000, 0);
      expect(msg).toContain('70%+');
    });

    it('shows exactly 90% as critical', () => {
      const msg = buildStatusMessage(115200, 128000, 0);
      expect(msg).toContain('90%+');
    });
  });

  // -----------------------------------------------------------------------
  // Session state persistence
  // -----------------------------------------------------------------------
  describe('session state', () => {
    it('getSessionFilePath includes session ID', () => {
      const filePath = getSessionFilePath('abc123');
      expect(filePath).toContain('artibot-context-tracker-abc123.json');
    });

    it('loadSessionState returns defaults when no file exists', () => {
      existsSync.mockReturnValue(false);
      const state = loadSessionState('test-session');
      expect(state).toEqual({ previousTokens: null, turnCount: 0 });
    });

    it('loadSessionState reads previous state from file', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({
        sessionId: 'test-session',
        currentTokens: 30000,
        turnCount: 5,
        updatedAt: '2026-03-29T10:00:00Z',
      }));
      const state = loadSessionState('test-session');
      expect(state.previousTokens).toBe(30000);
      expect(state.turnCount).toBe(5);
    });

    it('loadSessionState returns defaults on corrupt file', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('not valid json');
      const state = loadSessionState('test-session');
      expect(state).toEqual({ previousTokens: null, turnCount: 0 });
    });

    it('loadSessionState returns defaults when sessionId is empty', () => {
      const state = loadSessionState('');
      expect(state).toEqual({ previousTokens: null, turnCount: 0 });
    });

    it('saveSessionState calls atomicWriteSync with correct data', () => {
      saveSessionState('test-session', 50000, 3);
      expect(atomicWriteSync).toHaveBeenCalledWith(
        expect.stringContaining('artibot-context-tracker-test-session.json'),
        expect.objectContaining({
          sessionId: 'test-session',
          currentTokens: 50000,
          turnCount: 3,
        }),
      );
    });

    it('saveSessionState does nothing when sessionId is empty', () => {
      saveSessionState('', 50000, 3);
      expect(atomicWriteSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Integration: main() flow via module re-import
  // -----------------------------------------------------------------------
  describe('main flow', () => {
    it('passes through input to stdout and logs status to stderr', async () => {
      const input = {
        session_id: 'integration-test',
        context_window: { current_tokens: 45000, max_tokens: 128000 },
      };
      readStdin.mockResolvedValue(JSON.stringify(input));
      // turnCount 4 → newTurnCount 5 → hits EMIT_INTERVAL → emits to stderr
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ currentTokens: 45000, turnCount: 4 }));

      vi.resetModules();
      await import('../../scripts/hooks/context-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      // Stdout pass-through
      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ session_id: 'integration-test' }),
      );

      // Stderr status output (only emitted every 5 turns or at thresholds)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('45,000 tokens'),
      );
    });

    it('outputs 70% warning when context is high', async () => {
      const input = {
        session_id: 'warn-test',
        context_window: { current_tokens: 100000, max_tokens: 128000 },
      };
      readStdin.mockResolvedValue(JSON.stringify(input));
      existsSync.mockReturnValue(false);

      vi.resetModules();
      await import('../../scripts/hooks/context-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('70%+'),
      );
    });

    it('outputs 90% critical warning when context is very high', async () => {
      const input = {
        session_id: 'critical-test',
        context_window: { current_tokens: 120000, max_tokens: 128000 },
      };
      readStdin.mockResolvedValue(JSON.stringify(input));
      existsSync.mockReturnValue(false);

      vi.resetModules();
      await import('../../scripts/hooks/context-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('90%+'),
      );
    });

    it('calculates delta from previous session state', async () => {
      const input = {
        session_id: 'delta-test',
        context_window: { current_tokens: 50000, max_tokens: 128000 },
      };
      readStdin.mockResolvedValue(JSON.stringify(input));
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({
        currentTokens: 47000,
        turnCount: 4,
      }));

      vi.resetModules();
      await import('../../scripts/hooks/context-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('+3,000'),
      );
    });
  });
});
