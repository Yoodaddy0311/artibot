/**
 * Regression: version-checker must call assertEgressAllowed before fetch.
 * DATA POLICY fix — Task #10 F-02.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs so the module loads without disk access
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Spy on assertEgressAllowed from data-egress-guard
const mockAssertEgress = vi.fn();
vi.mock('../../lib/core/data-egress-guard.js', () => ({
  assertEgressAllowed: (...args) => mockAssertEgress(...args),
  EgressBlockedError: class EgressBlockedError extends Error {
    constructor(msg) { super(msg); this.name = 'EgressBlockedError'; }
  },
}));

const { checkForUpdate } = await import('../../lib/core/version-checker.js');

describe('version-checker: assertEgressAllowed gate', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tag_name: 'v99.0.0' }),
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls assertEgressAllowed with the GitHub API URL before fetch', async () => {
    await checkForUpdate('1.0.0', '/fake/cache');
    expect(mockAssertEgress).toHaveBeenCalledTimes(1);
    const [url, opts] = mockAssertEgress.mock.calls[0];
    expect(url).toMatch(/api\.github\.com/);
    expect(opts?.reason).toBe('version-check');
  });

  it('does NOT call fetch when assertEgressAllowed throws EgressBlockedError', async () => {
    mockAssertEgress.mockImplementationOnce(() => {
      const err = new Error('egress blocked');
      err.name = 'EgressBlockedError';
      throw err;
    });
    const result = await checkForUpdate('1.0.0', '/fake/cache');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ hasUpdate: false });
  });
});
