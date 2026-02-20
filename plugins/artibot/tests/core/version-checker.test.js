import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const fsMock = {
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
};

vi.mock('node:fs', () => ({
  readFileSync: (...args) => fsMock.readFileSync(...args),
  writeFileSync: (...args) => fsMock.writeFileSync(...args),
  mkdirSync: (...args) => fsMock.mkdirSync(...args),
  existsSync: (...args) => fsMock.existsSync(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

const { isNewerVersion, checkForUpdate } = await import(
  '../../lib/core/version-checker.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

const CURRENT_VERSION = '1.4.0';
const CACHE_DIR = '/fake/cache';
const CACHE_FILE_PATH =
  process.platform === 'win32'
    ? `${CACHE_DIR}\\update-check.json`
    : `${CACHE_DIR}/update-check.json`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('version-checker', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    fsMock.writeFileSync.mockImplementation(() => {});
    fsMock.mkdirSync.mockImplementation(() => {});
    // Save and replace global fetch
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // isNewerVersion() - pure function, no I/O
  // =========================================================================
  describe('isNewerVersion()', () => {
    it('returns false when versions are identical', () => {
      expect(isNewerVersion('1.4.0', '1.4.0')).toBe(false);
    });

    it('returns true when latest has higher major version', () => {
      expect(isNewerVersion('1.4.0', '2.0.0')).toBe(true);
    });

    it('returns true when latest has higher minor version', () => {
      expect(isNewerVersion('1.4.0', '1.5.0')).toBe(true);
    });

    it('returns true when latest has higher patch version', () => {
      expect(isNewerVersion('1.4.0', '1.4.1')).toBe(true);
    });

    it('returns false when current has higher major version', () => {
      expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false);
    });

    it('returns false when current has higher minor version', () => {
      expect(isNewerVersion('1.5.0', '1.4.9')).toBe(false);
    });

    it('returns false when current has higher patch version', () => {
      expect(isNewerVersion('1.4.2', '1.4.1')).toBe(false);
    });

    it('strips leading "v" from both inputs', () => {
      expect(isNewerVersion('v1.4.0', 'v1.5.0')).toBe(true);
      expect(isNewerVersion('v1.5.0', 'v1.4.0')).toBe(false);
    });

    it('handles versions with missing parts (e.g. "1.0")', () => {
      expect(isNewerVersion('1.0', '1.0.1')).toBe(true);
      expect(isNewerVersion('1', '1.0.1')).toBe(true);
    });

    it('treats non-numeric parts as 0', () => {
      expect(isNewerVersion('1.abc.0', '1.0.1')).toBe(true);
      expect(isNewerVersion('1.0.0', '1.abc.0')).toBe(false);
    });

    it('handles completely non-numeric strings gracefully', () => {
      // Both parse to [0, 0, 0] so neither is newer
      expect(isNewerVersion('abc', 'def')).toBe(false);
    });
  });

  // =========================================================================
  // checkForUpdate() - cache hit path
  // =========================================================================
  describe('checkForUpdate() - cache hits', () => {
    it('returns cached result when cache is fresh (<24h)', async () => {
      const cachedData = {
        hasUpdate: true,
        latestVersion: '2.0.0',
        currentVersion: '1.4.0',
        checkedAt: new Date().toISOString(),
      };
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(cachedData));

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
      // Should NOT call fetch when cache is valid
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns cached { hasUpdate: false } when cache says no update', async () => {
      const cachedData = {
        hasUpdate: false,
        latestVersion: '1.4.0',
        currentVersion: '1.4.0',
        checkedAt: new Date().toISOString(),
      };
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(cachedData));

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.hasUpdate).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // checkForUpdate() - stale / missing cache -> network fetch
  // =========================================================================
  describe('checkForUpdate() - network fetch', () => {
    it('fetches from network when cache file does not exist', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
      expect(result.currentVersion).toBe(CURRENT_VERSION);
    });

    it('fetches from network when cache is stale (>24h)', async () => {
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const cachedData = {
        hasUpdate: false,
        checkedAt: staleDate,
      };
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify(cachedData));
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.5.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('1.5.0');
    });

    it('returns { hasUpdate: false } when current matches latest', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.4.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.hasUpdate).toBe(false);
      expect(result.latestVersion).toBe('1.4.0');
    });

    it('writes cache to disk after successful fetch', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v2.0.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      // mkdirSync receives path.dirname(cacheFilePath) which is platform-dependent
      expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
      const mkdirArg = fsMock.mkdirSync.mock.calls[0][0];
      // Normalize to forward slashes for comparison on Windows
      expect(mkdirArg.replace(/\\/g, '/')).toBe(CACHE_DIR);
      expect(fsMock.mkdirSync.mock.calls[0][1]).toEqual({ recursive: true });
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1]);
      expect(writtenData.hasUpdate).toBe(true);
      expect(writtenData.latestVersion).toBe('2.0.0');
      expect(writtenData.checkedAt).toBeTruthy();
    });

    it('sends User-Agent header with current version', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.4.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      const fetchCall = globalThis.fetch.mock.calls[0];
      expect(fetchCall[1].headers['User-Agent']).toBe(`artibot/${CURRENT_VERSION}`);
    });

    it('passes an AbortSignal for timeout', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.4.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      const fetchCall = globalThis.fetch.mock.calls[0];
      expect(fetchCall[1].signal).toBeInstanceOf(AbortSignal);
    });
  });

  // =========================================================================
  // checkForUpdate() - error handling
  // =========================================================================
  describe('checkForUpdate() - error handling', () => {
    it('returns { hasUpdate: false } on network timeout (AbortError)', async () => {
      fsMock.existsSync.mockReturnValue(false);
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = vi.fn(() => Promise.reject(abortError));

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } on generic fetch error', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } on non-2xx response (e.g. 403 rate limit)', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({}, false, 403),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } on non-2xx response (e.g. 404 not found)', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({}, false, 404),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } when API returns invalid JSON', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token')),
        }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } when tag_name is missing from response', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ name: 'release' }), // no tag_name
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } when tag_name is empty string', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: '' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });
  });

  // =========================================================================
  // checkForUpdate() - malformed cache file handling
  // =========================================================================
  describe('checkForUpdate() - malformed cache', () => {
    it('fetches from network when cache contains invalid JSON', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('not valid json {{{');
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.5.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result.hasUpdate).toBe(true);
    });

    it('fetches from network when cache has no checkedAt field', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ hasUpdate: false }));
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.4.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('fetches from network when cache has invalid checkedAt date', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(
        JSON.stringify({ hasUpdate: false, checkedAt: 'not-a-date' }),
      );
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.4.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('fetches from network when readFileSync throws', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v1.4.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // checkForUpdate() - cache write failure
  // =========================================================================
  describe('checkForUpdate() - cache write failure', () => {
    it('still returns result when writeFileSync throws', async () => {
      fsMock.existsSync.mockReturnValue(false);
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('still returns result when mkdirSync throws', async () => {
      fsMock.existsSync.mockReturnValue(false);
      fsMock.mkdirSync.mockImplementation(() => {
        throw new Error('ENOSPC: no space left');
      });
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
    });
  });

  // =========================================================================
  // checkForUpdate() - tag_name parsing edge cases
  // =========================================================================
  describe('checkForUpdate() - tag_name parsing', () => {
    it('strips "v" prefix from tag_name', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: 'v2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.latestVersion).toBe('2.0.0');
    });

    it('handles tag_name without "v" prefix', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: '2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.latestVersion).toBe('2.0.0');
    });

    it('returns { hasUpdate: false } when tag_name is null', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ tag_name: null }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });

    it('returns { hasUpdate: false } when tag_name is undefined', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({}),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({ hasUpdate: false });
    });
  });
});
