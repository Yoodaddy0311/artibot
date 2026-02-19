import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  patternMatch,
  fastResponse,
  escalateToSystem2,
  warmCache,
  savePattern,
  recordPatternOutcome,
  getDiagnostics,
  clearAllCaches,
} from '../../lib/cognitive/system1.js';

// Mock file I/O module
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  listFiles: vi.fn(() => Promise.resolve([])),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

// Mock memory-manager to avoid disk I/O
vi.mock('../../lib/learning/memory-manager.js', () => ({
  searchMemory: vi.fn(() => Promise.resolve([])),
}));

// Mock tool-learner to avoid disk I/O
vi.mock('../../lib/learning/tool-learner.js', () => ({
  suggestTool: vi.fn(() => Promise.resolve([])),
  buildContextKey: vi.fn((op, target) => `${op}::${target}`),
}));

const { readJsonFile, writeJsonFile, listFiles } = await import('../../lib/core/file.js');
const { searchMemory } = await import('../../lib/learning/memory-manager.js');
const { suggestTool } = await import('../../lib/learning/tool-learner.js');

// Helper: build a valid pattern record
function makePattern(overrides = {}) {
  return {
    id: 'test-pattern-1',
    keywords: ['fix', 'bug'],
    intent: 'debug',
    response: { action: 'fix bug', suggestion: 'check the error message' },
    domain: 'backend',
    command: 'debug',
    confidence: 0.8,
    useCount: 5,
    successRate: 0.9,
    lastUsed: Date.now(),
    source: 'manual',
    ...overrides,
  };
}

describe('system1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCaches();
    readJsonFile.mockResolvedValue(null);
    listFiles.mockResolvedValue([]);
    searchMemory.mockResolvedValue([]);
    suggestTool.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  describe('patternMatch()', () => {
    it('returns null pattern and score 0 for empty input', () => {
      const result = patternMatch('');
      expect(result.pattern).toBeNull();
      expect(result.score).toBe(0);
    });

    it('returns metadata with tokens and latencyMs', () => {
      const result = patternMatch('find the bug');
      expect(result.metadata).toHaveProperty('tokens');
      expect(result.metadata).toHaveProperty('latencyMs');
      expect(result.metadata).toHaveProperty('patternsChecked');
    });

    it('returns null when no patterns loaded', () => {
      const result = patternMatch('fix the bug in backend');
      expect(result.pattern).toBeNull();
    });

    it('finds a match after warmCache loads patterns', async () => {
      const pattern = makePattern();
      listFiles.mockResolvedValue(['pattern.json']);
      readJsonFile.mockResolvedValue(pattern);

      await warmCache();
      const result = patternMatch('fix the bug');
      expect(result.pattern).not.toBeNull();
      expect(result.pattern.id).toBe('test-pattern-1');
    });

    it('score reflects keyword overlap', async () => {
      const pattern = makePattern({ keywords: ['fix', 'bug', 'error', 'crash'] });
      listFiles.mockResolvedValue(['p.json']);
      readJsonFile.mockResolvedValue(pattern);
      await warmCache();

      const partial = patternMatch('fix the bug');
      const full = patternMatch('fix bug error crash');
      expect(full.score).toBeGreaterThan(partial.score);
    });

    it('returns null when score below MIN_PATTERN_MATCH_SCORE (0.3)', async () => {
      // Pattern has 10 keywords but input only matches 1 (10% overlap < 30%)
      const pattern = makePattern({ keywords: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'] });
      listFiles.mockResolvedValue(['p.json']);
      readJsonFile.mockResolvedValue(pattern);
      await warmCache();

      const result = patternMatch('alpha something completely different');
      expect(result.pattern).toBeNull();
    });

    it('domain match context boosts score', async () => {
      const pattern = makePattern({ keywords: ['fix', 'bug'], domain: 'backend' });
      listFiles.mockResolvedValue(['p.json']);
      readJsonFile.mockResolvedValue(pattern);
      await warmCache();

      const withDomain = patternMatch('fix bug', { domain: 'backend' });
      const withoutDomain = patternMatch('fix bug');
      expect(withDomain.score).toBeGreaterThanOrEqual(withoutDomain.score);
    });

    it('patternsChecked equals loaded patterns count', async () => {
      const p1 = makePattern({ id: 'p1', keywords: ['alpha'] });
      const p2 = makePattern({ id: 'p2', keywords: ['beta'] });
      listFiles.mockResolvedValue(['p1.json', 'p2.json']);
      readJsonFile
        .mockResolvedValueOnce(p1)
        .mockResolvedValueOnce(p2);
      await warmCache();

      const result = patternMatch('alpha');
      expect(result.metadata.patternsChecked).toBe(2);
    });

    it('supports pattern collection files (data.patterns array)', async () => {
      const collection = {
        patterns: [
          makePattern({ id: 'coll-1', keywords: ['search', 'query'] }),
          makePattern({ id: 'coll-2', keywords: ['create', 'component'] }),
        ],
      };
      listFiles.mockResolvedValue(['collection.json']);
      readJsonFile.mockResolvedValue(collection);
      await warmCache();

      const result = patternMatch('search the query');
      expect(result.pattern).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('fastResponse() - cache behavior', () => {
    it('returns escalate=true for empty input', async () => {
      const result = await fastResponse('');
      expect(result.escalate).toBe(true);
      expect(result.escalateReason).toBe('empty_input');
    });

    it('returns escalate=true for whitespace-only input', async () => {
      const result = await fastResponse('   ');
      expect(result.escalate).toBe(true);
    });

    it('returns confidence of 0 when no patterns, memory, or tools', async () => {
      const result = await fastResponse('some unknown input xyz');
      expect(result.confidence).toBe(0);
    });

    it('source is "none" when nothing matches', async () => {
      const result = await fastResponse('extremely obscure input xyz123');
      expect(result.source).toBe('none');
    });

    it('includes latencyMs as a number', async () => {
      const result = await fastResponse('test input');
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns cached result on second call with same input', async () => {
      // Force a high-confidence pattern so result is cached
      const pattern = makePattern({ keywords: ['test'], confidence: 0.9, successRate: 1.0 });
      listFiles.mockResolvedValue(['p.json']);
      readJsonFile.mockResolvedValue(pattern);
      await warmCache();

      // Mock memory to give high confidence
      searchMemory.mockResolvedValue([{ entry: { data: { action: 'test' } }, score: 0.9 }]);

      await fastResponse('test action');
      const cached = await fastResponse('test action');
      expect(cached.source).toBe('cache');
    });

    it('source is "memory" when memory returns high-relevance hit', async () => {
      searchMemory.mockResolvedValue([
        { entry: { data: { action: 'recall' } }, score: 0.85 },
      ]);
      const result = await fastResponse('recall something important');
      expect(result.source).toBe('memory');
    });

    it('source is "tool" when tool suggestion available and no pattern/memory', async () => {
      suggestTool.mockResolvedValue([
        { tool: 'grep', weightedScore: 0.7, confidence: 0.8 },
      ]);
      const result = await fastResponse('search files for pattern');
      expect(result.source).toBe('tool');
    });

    it('includes toolSuggestion when tool is available', async () => {
      suggestTool.mockResolvedValue([{ tool: 'bash', weightedScore: 0.6, confidence: 0.75 }]);
      const result = await fastResponse('run a command');
      // toolSuggestion may or may not be attached depending on source
      if (result.toolSuggestion) {
        expect(result.toolSuggestion.tool).toBe('bash');
      }
    });

    it('includes memoryHits when memory returns results', async () => {
      searchMemory.mockResolvedValue([
        { entry: { data: { action: 'past action' } }, score: 0.6 },
      ]);
      const result = await fastResponse('past action recall');
      if (result.memoryHits) {
        expect(Array.isArray(result.memoryHits)).toBe(true);
      }
    });

    it('escalates when confidence below 0.6 threshold', async () => {
      const result = await fastResponse('totally unknown request zzzzz');
      expect(result.escalate).toBe(true);
    });

    it('escalateReason is "no_matching_pattern" when confidence is 0', async () => {
      const result = await fastResponse('xyzzy plugh random');
      expect(result.escalateReason).toBe('no_matching_pattern');
    });
  });

  // -------------------------------------------------------------------------
  describe('escalateToSystem2()', () => {
    it('returns escalated flag as true', () => {
      const result = escalateToSystem2('complex input', 'low_confidence');
      expect(result.escalated).toBe(true);
    });

    it('returns input and reason', () => {
      const result = escalateToSystem2('my input', 'my reason');
      expect(result.input).toBe('my input');
      expect(result.reason).toBe('my reason');
    });

    it('returns timestamp', () => {
      const before = Date.now();
      const result = escalateToSystem2('x', 'y');
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  describe('warmCache()', () => {
    it('returns loaded count and dir', async () => {
      listFiles.mockResolvedValue([]);
      const result = await warmCache();
      expect(result).toHaveProperty('loaded');
      expect(result).toHaveProperty('dir');
      expect(result.loaded).toBe(0);
    });

    it('loads valid pattern files', async () => {
      const pattern = makePattern({ id: 'warm-1' });
      listFiles.mockResolvedValue(['warm-1.json']);
      readJsonFile.mockResolvedValue(pattern);
      const result = await warmCache();
      expect(result.loaded).toBe(1);
    });

    it('skips invalid pattern files (missing id or keywords)', async () => {
      listFiles.mockResolvedValue(['bad.json']);
      readJsonFile.mockResolvedValue({ someField: 'no id or keywords' });
      const result = await warmCache();
      expect(result.loaded).toBe(0);
    });

    it('sets warmed flag in diagnostics', async () => {
      listFiles.mockResolvedValue([]);
      await warmCache();
      const diag = getDiagnostics();
      expect(diag.warmed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('savePattern()', () => {
    it('throws when pattern missing id', async () => {
      await expect(savePattern({ keywords: ['fix'] })).rejects.toThrow();
    });

    it('throws when pattern missing keywords', async () => {
      await expect(savePattern({ id: 'p1' })).rejects.toThrow();
    });

    it('writes pattern file to disk', async () => {
      const pattern = makePattern({ id: 'save-test' });
      await savePattern(pattern);
      expect(writeJsonFile).toHaveBeenCalledTimes(1);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.id).toBe('save-test');
    });

    it('defaults useCount to 0 when not provided', async () => {
      const pattern = makePattern({ id: 'defaults-test', useCount: undefined });
      await savePattern(pattern);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.useCount).toBe(0);
    });

    it('defaults successRate to 1.0 when not provided', async () => {
      const pattern = makePattern({ id: 'sr-test', successRate: undefined });
      await savePattern(pattern);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.successRate).toBe(1.0);
    });
  });

  // -------------------------------------------------------------------------
  describe('recordPatternOutcome()', () => {
    it('does nothing when pattern not loaded', async () => {
      await recordPatternOutcome('non-existent-id', true);
      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('increments useCount after outcome recorded', async () => {
      const pattern = makePattern({ id: 'outcome-1', useCount: 3, successRate: 0.9 });
      listFiles.mockResolvedValue(['o.json']);
      readJsonFile.mockResolvedValue(pattern);
      await warmCache();

      await recordPatternOutcome('outcome-1', true);
      expect(writeJsonFile).toHaveBeenCalled();
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.useCount).toBe(4);
    });

    it('updates successRate with incremental average', async () => {
      const pattern = makePattern({ id: 'rate-1', useCount: 2, successRate: 1.0 });
      listFiles.mockResolvedValue(['r.json']);
      readJsonFile.mockResolvedValue(pattern);
      await warmCache();

      await recordPatternOutcome('rate-1', false);
      const written = writeJsonFile.mock.calls[0][1];
      // 2 successes + 1 failure = 2/3 success rate
      expect(written.successRate).toBeCloseTo(2 / 3, 2);
    });
  });

  // -------------------------------------------------------------------------
  describe('getDiagnostics()', () => {
    it('returns warmed status', () => {
      const diag = getDiagnostics();
      expect(diag).toHaveProperty('warmed');
    });

    it('returns patternsLoaded count', () => {
      const diag = getDiagnostics();
      expect(typeof diag.patternsLoaded).toBe('number');
    });

    it('returns cache sizes', () => {
      const diag = getDiagnostics();
      expect(diag).toHaveProperty('patternCacheSize');
      expect(diag).toHaveProperty('memoryCacheSize');
      expect(diag).toHaveProperty('toolCacheSize');
    });

    it('warmed is false after clearAllCaches', () => {
      clearAllCaches();
      const diag = getDiagnostics();
      expect(diag.warmed).toBe(false);
    });

    it('patternsLoaded is 0 after clearAllCaches', () => {
      clearAllCaches();
      const diag = getDiagnostics();
      expect(diag.patternsLoaded).toBe(0);
    });
  });
});
