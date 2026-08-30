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

// The seam moved: version-checker now routes through `safeFetch` instead of
// calling `assertEgressAllowed` itself and then reaching for a raw `fetch`.
// That is the point of the change — a guard the caller can forget to pair with
// its fetch is a guard that only covers the first URL (redirects escaped it).
// The stub below models the real safeFetch (assert, then fetch) so every
// assertion in this file keeps its original meaning.
const mockAssertEgress = vi.fn();
const mockSafeFetch = vi.fn(async (url, init, guardOptions) => {
  mockAssertEgress(url, guardOptions);
  return globalThis.fetch(url, init);
});
vi.mock('../../lib/core/data-egress-guard.js', () => ({
  assertEgressAllowed: (...args) => mockAssertEgress(...args),
  safeFetch: (...args) => mockSafeFetch(...args),
  EgressBlockedError: class EgressBlockedError extends Error {
    constructor(msg) { super(msg); this.name = 'EgressBlockedError'; }
  },
}));

const { checkForUpdate } = await import('../../lib/core/version-checker.js');

describe('version-checker: assertEgressAllowed gate', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes recorded calls but KEEPS implementations, so the
    // throwing impl one test installs would leak into the next. Reset just the
    // policy seam; mockSafeFetch must keep its delegating implementation.
    mockAssertEgress.mockReset();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ version: '99.0.0', tag_name: 'v99.0.0' }),
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls assertEgressAllowed with the master manifest URL before fetch', async () => {
    // Primary source since v4.36.4 is master's plugin.json on
    // raw.githubusercontent.com; the Releases API is only the fallback.
    await checkForUpdate('1.0.0', '/fake/cache');
    expect(mockAssertEgress).toHaveBeenCalledTimes(1);
    const [url, opts] = mockAssertEgress.mock.calls[0];
    expect(url).toMatch(/raw\.githubusercontent\.com/);
    expect(opts?.reason).toBe('version-check');
  });

  it('gates the Releases-API fallback through assertEgressAllowed too', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    );
    await checkForUpdate('1.0.0', '/fake/cache');
    expect(mockAssertEgress).toHaveBeenCalledTimes(2);
    expect(mockAssertEgress.mock.calls[0][0]).toMatch(/raw\.githubusercontent\.com/);
    expect(mockAssertEgress.mock.calls[1][0]).toMatch(/api\.github\.com/);
  });

  it('does NOT call fetch when assertEgressAllowed throws EgressBlockedError', async () => {
    // Block EVERY egress attempt — primary and fallback alike must respect it.
    mockAssertEgress.mockImplementation(() => {
      const err = new Error('egress blocked');
      err.name = 'EgressBlockedError';
      throw err;
    });
    const result = await checkForUpdate('1.0.0', '/fake/cache');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ hasUpdate: false });
  });

  it('never reaches for a raw fetch — every request goes through safeFetch', async () => {
    // The original defect class: a module that asserts and then fetches on its
    // own only ever checks the first URL. Pin the routing, not just the check.
    await checkForUpdate('1.0.0', '/fake/cache');
    expect(mockSafeFetch).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(mockSafeFetch.mock.calls.length);
  });
});
