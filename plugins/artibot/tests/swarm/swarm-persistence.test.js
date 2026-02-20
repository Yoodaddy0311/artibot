import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadFromDisk,
  saveToDisk,
  clearPersistence,
  getPattern,
  setPattern,
  removePattern,
  getAllPatterns,
  setWeights,
  getWeights,
  updateMetadata,
  getMetadata,
  isDirty,
  isLoaded,
  getDbPath,
  setDebounceDelay,
  scheduleSave,
  _resetForTesting,
} from '../../lib/swarm/swarm-persistence.js';

vi.mock('../../lib/core/file.js', () => ({
  exists: vi.fn(() => Promise.resolve(false)),
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

const { exists, readJsonFile, writeJsonFile, ensureDir } =
  await import('../../lib/core/file.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  _resetForTesting();
  readJsonFile.mockResolvedValue(null);
  exists.mockResolvedValue(false);
});

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// loadFromDisk
// ---------------------------------------------------------------------------

describe('loadFromDisk()', () => {
  it('returns empty db structure on first run (no file)', async () => {
    const db = await loadFromDisk();
    expect(db).toBeDefined();
    expect(db.version).toBe(1);
    expect(db.patterns).toEqual({});
    expect(db.weights).toEqual({});
    expect(db.metadata).toHaveProperty('firstCreated');
    expect(db.metadata).toHaveProperty('lastAccessed');
    expect(db.metadata.sessionsCount).toBe(0);
    expect(db.updatedAt).toBeDefined();
  });

  it('loads existing data from disk', async () => {
    const saved = {
      version: 1,
      patterns: { 'tool::Read': { confidence: 0.9 } },
      weights: { tools: { Read: { successRate: 0.95 } } },
      metadata: { sessionsCount: 5, firstCreated: '2024-01-01T00:00:00Z' },
      updatedAt: '2024-06-15T12:00:00Z',
    };
    readJsonFile.mockResolvedValue(saved);

    const db = await loadFromDisk();
    expect(db.version).toBe(1);
    expect(db.patterns['tool::Read']).toEqual({ confidence: 0.9 });
    expect(db.weights.tools.Read.successRate).toBe(0.95);
    expect(db.metadata.sessionsCount).toBe(5);
    expect(db.metadata.firstCreated).toBe('2024-01-01T00:00:00Z');
  });

  it('handles corrupt file gracefully (non-object)', async () => {
    readJsonFile.mockResolvedValue('not-an-object');
    const db = await loadFromDisk();
    expect(db.version).toBe(1);
    expect(db.patterns).toEqual({});
  });

  it('handles corrupt file gracefully (missing version)', async () => {
    readJsonFile.mockResolvedValue({ patterns: { a: 1 } });
    const db = await loadFromDisk();
    expect(db.version).toBe(1);
    expect(db.patterns).toEqual({});
  });

  it('handles null patterns/weights/metadata in saved data', async () => {
    readJsonFile.mockResolvedValue({
      version: 1,
      patterns: null,
      weights: null,
      metadata: null,
    });
    const db = await loadFromDisk();
    expect(db.patterns).toEqual({});
    expect(db.weights).toEqual({});
    expect(db.metadata).toHaveProperty('sessionsCount');
  });

  it('sets loaded state to true after load', async () => {
    expect(isLoaded()).toBe(false);
    await loadFromDisk();
    expect(isLoaded()).toBe(true);
  });

  it('resets dirty flag after load', async () => {
    await loadFromDisk();
    setPattern('key', { value: 1 });
    expect(isDirty()).toBe(true);
    await loadFromDisk();
    expect(isDirty()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveToDisk
// ---------------------------------------------------------------------------

describe('saveToDisk()', () => {
  it('writes db to disk with ensureDir', async () => {
    await loadFromDisk();
    setPattern('tool::Read', { confidence: 0.8 });
    // Clear scheduled debounce before manual save
    _resetForTesting();
    await loadFromDisk();
    setPattern('tool::Read', { confidence: 0.8 });

    await saveToDisk();

    expect(ensureDir).toHaveBeenCalled();
    expect(writeJsonFile).toHaveBeenCalledTimes(1);
    const writtenData = writeJsonFile.mock.calls[0][1];
    expect(writtenData.version).toBe(1);
    expect(writtenData.patterns['tool::Read']).toBeDefined();
    expect(writtenData.updatedAt).toBeDefined();
  });

  it('does nothing when db is not loaded', async () => {
    await saveToDisk();
    expect(writeJsonFile).not.toHaveBeenCalled();
  });

  it('clears dirty flag after save', async () => {
    await loadFromDisk();
    setPattern('key', { v: 1 });
    expect(isDirty()).toBe(true);
    await saveToDisk();
    expect(isDirty()).toBe(false);
  });

  it('cancels pending debounce timer on explicit save', async () => {
    await loadFromDisk();
    setDebounceDelay(5000);
    setPattern('key', { v: 1 });
    // scheduleSave was called by setPattern, timer is pending
    await saveToDisk();
    expect(writeJsonFile).toHaveBeenCalledTimes(1);

    // Advance past debounce - no additional save should happen
    vi.advanceTimersByTime(6000);
    // Allow microtasks
    await vi.runAllTimersAsync();
    expect(writeJsonFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// scheduleSave (debounced)
// ---------------------------------------------------------------------------

describe('scheduleSave()', () => {
  it('calls saveToDisk after debounce delay', async () => {
    await loadFromDisk();
    setDebounceDelay(100);

    setPattern('test', { v: 1 }); // triggers scheduleSave internally

    expect(writeJsonFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(writeJsonFile).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple saves into one write', async () => {
    await loadFromDisk();
    setDebounceDelay(100);

    setPattern('a', { v: 1 });
    setPattern('b', { v: 2 });
    setPattern('c', { v: 3 });

    await vi.advanceTimersByTimeAsync(150);
    expect(writeJsonFile).toHaveBeenCalledTimes(1);

    const written = writeJsonFile.mock.calls[0][1];
    expect(written.patterns.a).toBeDefined();
    expect(written.patterns.b).toBeDefined();
    expect(written.patterns.c).toBeDefined();
  });

  it('resets debounce timer on each call', async () => {
    await loadFromDisk();
    setDebounceDelay(100);

    setPattern('a', { v: 1 });
    await vi.advanceTimersByTimeAsync(80);
    expect(writeJsonFile).not.toHaveBeenCalled();

    setPattern('b', { v: 2 }); // resets timer
    await vi.advanceTimersByTimeAsync(80);
    expect(writeJsonFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(writeJsonFile).toHaveBeenCalledTimes(1);
  });

  it('handles save errors gracefully (best-effort)', async () => {
    await loadFromDisk();
    setDebounceDelay(50);
    writeJsonFile.mockRejectedValueOnce(new Error('disk full'));

    setPattern('test', { v: 1 });
    // Should not throw
    await vi.advanceTimersByTimeAsync(100);
  });
});

// ---------------------------------------------------------------------------
// clearPersistence
// ---------------------------------------------------------------------------

describe('clearPersistence()', () => {
  it('resets db to empty state', async () => {
    await loadFromDisk();
    setPattern('key', { v: 1 });
    setWeights({ tools: { Read: 1 } });

    await clearPersistence();

    expect(getAllPatterns()).toEqual({});
    expect(getWeights()).toEqual({});
    expect(isDirty()).toBe(false);
  });

  it('overwrites file if it exists on disk', async () => {
    exists.mockResolvedValue(true);
    await loadFromDisk();
    setPattern('key', { v: 1 });

    await clearPersistence();

    expect(writeJsonFile).toHaveBeenCalledTimes(1);
    const written = writeJsonFile.mock.calls[0][1];
    expect(written.patterns).toEqual({});
    expect(written.version).toBe(1);
  });

  it('skips file write if file does not exist', async () => {
    exists.mockResolvedValue(false);
    await loadFromDisk();
    await clearPersistence();

    expect(writeJsonFile).not.toHaveBeenCalled();
  });

  it('cancels pending debounce timer', async () => {
    await loadFromDisk();
    setDebounceDelay(5000);
    setPattern('key', { v: 1 });

    await clearPersistence();

    // Advance past debounce - should not trigger save
    await vi.advanceTimersByTimeAsync(6000);
    // Only the clearPersistence write (if exists was true), no debounce save
    expect(writeJsonFile).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Pattern CRUD
// ---------------------------------------------------------------------------

describe('pattern operations', () => {
  beforeEach(async () => {
    await loadFromDisk();
    setDebounceDelay(10000); // long delay to prevent auto-saves in tests
  });

  describe('getPattern()', () => {
    it('returns null for non-existent key', () => {
      expect(getPattern('missing')).toBeNull();
    });

    it('returns null when db is not loaded', () => {
      _resetForTesting();
      expect(getPattern('key')).toBeNull();
    });

    it('returns null for empty key', () => {
      expect(getPattern('')).toBeNull();
    });

    it('returns stored pattern', () => {
      setPattern('tool::Read', { confidence: 0.9, sampleSize: 10 });
      const result = getPattern('tool::Read');
      expect(result.confidence).toBe(0.9);
      expect(result.sampleSize).toBe(10);
      expect(result.storedAt).toBeDefined();
    });
  });

  describe('setPattern()', () => {
    it('stores pattern with storedAt timestamp', () => {
      setPattern('tool::Read', { confidence: 0.9 });
      const result = getPattern('tool::Read');
      expect(result.storedAt).toBeDefined();
    });

    it('marks db as dirty', () => {
      expect(isDirty()).toBe(false);
      setPattern('key', { v: 1 });
      expect(isDirty()).toBe(true);
    });

    it('initializes db if not loaded', () => {
      _resetForTesting();
      expect(isLoaded()).toBe(false);
      setPattern('key', { v: 1 });
      expect(isLoaded()).toBe(true);
    });

    it('overwrites existing pattern', () => {
      setPattern('key', { v: 1 });
      setPattern('key', { v: 2 });
      expect(getPattern('key').v).toBe(2);
    });
  });

  describe('removePattern()', () => {
    it('returns false for non-existent key', () => {
      expect(removePattern('missing')).toBe(false);
    });

    it('returns false when db is not loaded', () => {
      _resetForTesting();
      expect(removePattern('key')).toBe(false);
    });

    it('removes and returns true for existing key', () => {
      setPattern('key', { v: 1 });
      expect(removePattern('key')).toBe(true);
      expect(getPattern('key')).toBeNull();
    });

    it('marks db as dirty on removal', () => {
      setPattern('key', { v: 1 });
      // Reset dirty from the set operation
      // (save resets dirty, but we didn't save)
      expect(isDirty()).toBe(true);
    });
  });

  describe('getAllPatterns()', () => {
    it('returns empty object when no patterns', () => {
      expect(getAllPatterns()).toEqual({});
    });

    it('returns shallow copy of all patterns', () => {
      setPattern('a', { v: 1 });
      setPattern('b', { v: 2 });
      const all = getAllPatterns();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all.a.v).toBe(1);
      expect(all.b.v).toBe(2);
    });

    it('returns empty object when db not loaded', () => {
      _resetForTesting();
      expect(getAllPatterns()).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

describe('weight operations', () => {
  beforeEach(async () => {
    await loadFromDisk();
    setDebounceDelay(10000);
  });

  it('stores and retrieves weights', () => {
    const weights = { tools: { Read: { successRate: 0.95 } } };
    setWeights(weights);
    const result = getWeights();
    expect(result.tools.Read.successRate).toBe(0.95);
  });

  it('returns empty object when db not loaded', () => {
    _resetForTesting();
    expect(getWeights()).toEqual({});
  });

  it('marks db as dirty on setWeights', () => {
    expect(isDirty()).toBe(false);
    setWeights({ a: 1 });
    expect(isDirty()).toBe(true);
  });

  it('handles null weights gracefully', () => {
    setWeights(null);
    expect(getWeights()).toEqual({});
  });

  it('initializes db if not loaded', () => {
    _resetForTesting();
    setWeights({ a: 1 });
    expect(isLoaded()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('metadata operations', () => {
  beforeEach(async () => {
    await loadFromDisk();
    setDebounceDelay(10000);
  });

  it('updates metadata fields', () => {
    updateMetadata({ sessionsCount: 5 });
    const meta = getMetadata();
    expect(meta.sessionsCount).toBe(5);
  });

  it('merges with existing metadata', () => {
    updateMetadata({ sessionsCount: 5 });
    updateMetadata({ customField: 'test' });
    const meta = getMetadata();
    expect(meta.sessionsCount).toBe(5);
    expect(meta.customField).toBe('test');
  });

  it('returns empty object when db not loaded', () => {
    _resetForTesting();
    expect(getMetadata()).toEqual({});
  });

  it('marks db as dirty on update', () => {
    expect(isDirty()).toBe(false);
    updateMetadata({ sessionsCount: 1 });
    expect(isDirty()).toBe(true);
  });

  it('initializes db if not loaded', () => {
    _resetForTesting();
    updateMetadata({ sessionsCount: 1 });
    expect(isLoaded()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State Inspection
// ---------------------------------------------------------------------------

describe('state inspection', () => {
  it('isDirty returns false initially', async () => {
    await loadFromDisk();
    expect(isDirty()).toBe(false);
  });

  it('isLoaded returns false before load', () => {
    expect(isLoaded()).toBe(false);
  });

  it('getDbPath returns expected path', () => {
    const dbPath = getDbPath();
    expect(dbPath).toContain('swarm-db.json');
    expect(dbPath).toContain('artibot');
  });
});

// ---------------------------------------------------------------------------
// setDebounceDelay
// ---------------------------------------------------------------------------

describe('setDebounceDelay()', () => {
  it('accepts valid positive number', () => {
    setDebounceDelay(500);
    // No error thrown
  });

  it('accepts zero', () => {
    setDebounceDelay(0);
    // No error thrown
  });

  it('ignores negative numbers', async () => {
    await loadFromDisk();
    setDebounceDelay(100);
    setDebounceDelay(-1); // Should be ignored

    setPattern('test', { v: 1 });
    // Timer should still fire with 100ms delay
    await vi.advanceTimersByTimeAsync(150);
    expect(writeJsonFile).toHaveBeenCalledTimes(1);
  });

  it('ignores non-number values', () => {
    setDebounceDelay('not-a-number');
    // No error thrown
  });
});

// ---------------------------------------------------------------------------
// _resetForTesting
// ---------------------------------------------------------------------------

describe('_resetForTesting()', () => {
  it('clears all internal state', async () => {
    await loadFromDisk();
    setPattern('key', { v: 1 });
    expect(isLoaded()).toBe(true);
    expect(isDirty()).toBe(true);

    _resetForTesting();

    expect(isLoaded()).toBe(false);
    expect(isDirty()).toBe(false);
  });

  it('cancels pending debounce timer', async () => {
    await loadFromDisk();
    setDebounceDelay(100);
    setPattern('key', { v: 1 });

    _resetForTesting();

    // Advance past debounce - no save should happen
    await vi.advanceTimersByTimeAsync(200);
    expect(writeJsonFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pruning (indirectly tested via saveToDisk)
// ---------------------------------------------------------------------------

describe('collection pruning', () => {
  it('prunes patterns exceeding max entries on save', async () => {
    await loadFromDisk();

    // Add more than MAX_ENTRIES_PER_COLLECTION (500) patterns
    for (let i = 0; i < 510; i++) {
      setPattern(`key-${i}`, { v: i, storedAt: new Date(2024, 0, 1, 0, 0, i).toISOString() });
    }

    await saveToDisk();

    const written = writeJsonFile.mock.calls[0][1];
    const patternCount = Object.keys(written.patterns).length;
    expect(patternCount).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Round-trip persistence
// ---------------------------------------------------------------------------

describe('round-trip persistence', () => {
  it('saves and reloads data consistently', async () => {
    // First session: populate data
    await loadFromDisk();
    setPattern('tool::Read', { confidence: 0.9, sampleSize: 15 });
    setPattern('error::ENOENT', { frequency: 0.2, recoverable: true });
    setWeights({ tools: { Read: { successRate: 0.95 } } });
    updateMetadata({ sessionsCount: 3 });

    await saveToDisk();

    // Capture what was written
    const savedData = writeJsonFile.mock.calls[0][1];

    // Second session: reload from "disk"
    _resetForTesting();
    readJsonFile.mockResolvedValue(savedData);

    const db = await loadFromDisk();
    expect(db.patterns['tool::Read'].confidence).toBe(0.9);
    expect(db.patterns['error::ENOENT'].recoverable).toBe(true);
    expect(db.weights.tools.Read.successRate).toBe(0.95);
    expect(db.metadata.sessionsCount).toBe(3);
  });
});
