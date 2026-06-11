import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache } from '../../lib/learning/knowledge-transfer.js';
import { hotSwap } from '../../lib/learning/knowledge-demotion.js';

// File I/O is mocked so we can inspect on-disk writes without touching the FS.
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

// Lock uses node:fs/promises mkdir/rm — stub them so acquireLock() succeeds.
vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn(() => Promise.resolve()),
    readFile: vi.fn(() => Promise.resolve(String(Date.now()))),
    rm: vi.fn(() => Promise.resolve()),
  },
}));

const { readJsonFile, writeJsonFile } = await import('../../lib/core/file.js');

// Pattern that meets the demotion criteria (>= 2 consecutive failures).
const FAILING_PATTERN = {
  key: 'tool::FlakyRead',
  type: 'tool',
  category: 'FlakyRead',
  confidence: 0.85,
  status: 'active',
  usageCount: 4,
  failureCount: 2,
  consecutiveFailures: 2,
};

/**
 * Seed loadSystem1Cache() with exactly one demotable pattern, and return
 * empty/null for every other file read (so no promotion candidates exist).
 */
function seedSystem1WithFailingPattern() {
  readJsonFile.mockImplementation((filePath) => {
    if (typeof filePath === 'string' && filePath.includes('system1-patterns.json')) {
      return Promise.resolve({ patterns: [FAILING_PATTERN], updatedAt: new Date().toISOString() });
    }
    // Promotion source files (*-patterns.json) and transfer log: nothing.
    return Promise.resolve(null);
  });
}

/** Return the most recent writeJsonFile() call that targeted system1-patterns.json. */
function lastSystem1Write() {
  const calls = writeJsonFile.mock.calls.filter(
    ([p]) => typeof p === 'string' && p.includes('system1-patterns.json'),
  );
  return calls.length > 0 ? calls[calls.length - 1] : null;
}

describe('knowledge-demotion hotSwap() — demote-only persistence (audit #7-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it('persists the shrunk cache when a run ONLY demotes (no promotions)', async () => {
    seedSystem1WithFailingPattern();

    const result = await hotSwap();

    // The failing pattern was demoted, nothing was promoted.
    expect(result.demoted).toContain('tool::FlakyRead');
    expect(result.promoted).toHaveLength(0);

    // Regression guard: a demote-only run MUST reach disk. Previously
    // persistence was gated on promotions only, so this write was skipped
    // and the demotion was silently lost.
    const write = lastSystem1Write();
    expect(write).not.toBeNull();

    // The persisted snapshot must have shrunk — the demoted key is gone.
    const persisted = write[1];
    expect(Array.isArray(persisted.patterns)).toBe(true);
    expect(persisted.patterns).toHaveLength(0);
    expect(persisted.patterns.some((p) => p.key === 'tool::FlakyRead')).toBe(false);
  });

  it('does not persist when nothing changed (no demotions, no promotions)', async () => {
    // Seed a healthy pattern that does not qualify for demotion.
    readJsonFile.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath.includes('system1-patterns.json')) {
        return Promise.resolve({
          patterns: [{
            key: 'tool::SolidRead',
            type: 'tool',
            category: 'SolidRead',
            confidence: 0.9,
            status: 'active',
            usageCount: 10,
            failureCount: 0,
            consecutiveFailures: 0,
          }],
          updatedAt: new Date().toISOString(),
        });
      }
      return Promise.resolve(null);
    });

    const result = await hotSwap();

    expect(result.demoted).toHaveLength(0);
    expect(result.promoted).toHaveLength(0);
    // No-op run: the system1 cache file must not be rewritten.
    expect(lastSystem1Write()).toBeNull();
  });
});
