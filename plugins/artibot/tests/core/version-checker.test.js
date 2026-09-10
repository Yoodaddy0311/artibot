import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Mock egress guard so node:fs mock does not break allowlist loading.
// The actual DATA POLICY gate is tested in version-checker-egress.test.js.
vi.mock('../../lib/core/data-egress-guard.js', () => ({
  assertEgressAllowed: vi.fn(), // no-op: allow all in unit tests
  // version-checker fetches through safeFetch; the stub delegates straight to
  // the `globalThis.fetch` spy these tests already assert on, so the policy
  // layer stays out of the way here (it is covered in version-checker-egress).
  safeFetch: (url, init) => globalThis.fetch(url, init),
  EgressBlockedError: class EgressBlockedError extends Error {
    constructor(msg) { super(msg); this.name = 'EgressBlockedError'; }
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

const { isNewerVersion, checkForUpdate, resolveUpdateCheckPolicy } = await import(
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
const _CACHE_FILE_PATH =
  process.platform === 'win32'
    ? `${CACHE_DIR}\\update-check.json`
    : `${CACHE_DIR}/update-check.json`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('version-checker', () => {
  let originalFetch;
  let savedUpdateCheckEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    fsMock.writeFileSync.mockImplementation(() => {});
    fsMock.mkdirSync.mockImplementation(() => {});
    // Ambient-env isolation. A contributor who opted out of the update check
    // in their own shell must still get a green `npm test`: without this,
    // ARTIBOT_UPDATE_CHECK=0 in the environment silently disables the checker
    // and turns every network-path assertion below red. Same pattern as
    // tests/hooks/session-start.test.js.
    savedUpdateCheckEnv = process.env.ARTIBOT_UPDATE_CHECK;
    delete process.env.ARTIBOT_UPDATE_CHECK;
    // Save and replace global fetch
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedUpdateCheckEnv === undefined) delete process.env.ARTIBOT_UPDATE_CHECK;
    else process.env.ARTIBOT_UPDATE_CHECK = savedUpdateCheckEnv;
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
  //
  // Since v4.36.4 the PRIMARY source is master's plugin.json ({ version })
  // with the Releases API ({ tag_name }) as fallback. Mocks carry BOTH
  // fields so the primary succeeds in one fetch; fallback semantics get
  // their own dedicated tests below.
  // =========================================================================
  describe('checkForUpdate() - network fetch', () => {
    it('fetches from network when cache file does not exist', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '2.0.0', tag_name: 'v2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
      expect(result.currentVersion).toBe(CURRENT_VERSION);
    });

    it('reads the version from master plugin.json as the primary source', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch.mock.calls[0][0]).toMatch(/raw\.githubusercontent\.com/);
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('falls back to the Releases API when the master manifest fails', async () => {
      // Regression (2026-07-13): releases stopped being published after
      // v4.30.0, so neither source may be trusted alone — primary is master,
      // fallback is the release feed.
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn((url) =>
        String(url).includes('raw.githubusercontent.com')
          ? makeFetchResponse({}, false, 404)
          : makeFetchResponse({ tag_name: 'v2.0.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch.mock.calls[1][0]).toMatch(/api\.github\.com/);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
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
        makeFetchResponse({ version: '1.5.0', tag_name: 'v1.5.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe('1.5.0');
    });

    it('returns { hasUpdate: false } when current matches latest', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '1.4.0', tag_name: 'v1.4.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result.hasUpdate).toBe(false);
      expect(result.latestVersion).toBe('1.4.0');
    });

    it('writes cache to disk after successful fetch', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '2.0.0', tag_name: 'v2.0.0' }),
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
        makeFetchResponse({ version: '1.4.0', tag_name: 'v1.4.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      const fetchCall = globalThis.fetch.mock.calls[0];
      expect(fetchCall[1].headers['User-Agent']).toBe(`artibot/${CURRENT_VERSION}`);
    });

    it('passes an AbortSignal for timeout', async () => {
      fsMock.existsSync.mockReturnValue(false);
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '1.4.0', tag_name: 'v1.4.0' }),
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
        makeFetchResponse({ version: '1.5.0', tag_name: 'v1.5.0' }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result.hasUpdate).toBe(true);
    });

    it('fetches from network when cache has no checkedAt field', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ hasUpdate: false }));
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '1.4.0', tag_name: 'v1.4.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('fetches from network when cache has invalid checkedAt date', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(
        JSON.stringify({ hasUpdate: false, checkedAt: 'not-a-date' }),
      );
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '1.4.0', tag_name: 'v1.4.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('fetches from network when readFileSync throws', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      globalThis.fetch = vi.fn(() =>
        makeFetchResponse({ version: '1.4.0', tag_name: 'v1.4.0' }),
      );

      await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

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
        makeFetchResponse({ version: '2.0.0', tag_name: 'v2.0.0' }),
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
        makeFetchResponse({ version: '2.0.0', tag_name: 'v2.0.0' }),
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
        makeFetchResponse({ version: '2.0.0', tag_name: 'v2.0.0' }),
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

  // =========================================================================
  // resolveUpdateCheckPolicy() - pure opt-out resolver, no I/O
  // Precedence: env (allowlisted values only) > config > default ON.
  // =========================================================================
  describe('resolveUpdateCheckPolicy()', () => {
    it('enables the check by default when neither env nor config says otherwise', () => {
      expect(resolveUpdateCheckPolicy({ env: {}, config: {} })).toEqual({
        enabled: true,
        source: 'default',
        reason: 'default',
      });
    });

    it('enables the check by default when called with no arguments at all', () => {
      // The suite's beforeEach deletes ARTIBOT_UPDATE_CHECK from process.env,
      // so the zero-argument call resolves against a known-empty variable
      // rather than whatever the contributor happens to have exported. This
      // pins the shape session-start relies on.
      const policy = resolveUpdateCheckPolicy();
      expect(policy.enabled).toBe(true);
      expect(policy.source).toBe('default');
    });

    it.each(['0', 'false', 'off', 'no'])(
      'disables the check when ARTIBOT_UPDATE_CHECK=%s',
      (raw) => {
        expect(
          resolveUpdateCheckPolicy({ env: { ARTIBOT_UPDATE_CHECK: raw } }),
        ).toEqual({
          enabled: false,
          source: 'env',
          reason: `ARTIBOT_UPDATE_CHECK=${raw}`,
        });
      },
    );

    it.each(['1', 'true', 'on', 'yes'])(
      'enables the check when ARTIBOT_UPDATE_CHECK=%s',
      (raw) => {
        expect(
          resolveUpdateCheckPolicy({ env: { ARTIBOT_UPDATE_CHECK: raw } }),
        ).toEqual({
          enabled: true,
          source: 'env',
          reason: `ARTIBOT_UPDATE_CHECK=${raw}`,
        });
      },
    );

    it('matches env values case-insensitively and ignores surrounding whitespace', () => {
      expect(
        resolveUpdateCheckPolicy({ env: { ARTIBOT_UPDATE_CHECK: '  OFF  ' } }),
      ).toEqual({
        enabled: false,
        source: 'env',
        // reason echoes the RAW value so an operator can spot a stray space.
        reason: 'ARTIBOT_UPDATE_CHECK=  OFF  ',
      });
      expect(
        resolveUpdateCheckPolicy({ env: { ARTIBOT_UPDATE_CHECK: 'True' } }).enabled,
      ).toBe(true);
    });

    it.each(['maybe', '', '2', 'disabled'])(
      'ignores the unrecognised env value %j and falls through to config',
      (raw) => {
        // Allowlist, not denylist: an unknown value must NOT silently disable
        // or force-enable. It falls through so config keeps its say.
        expect(
          resolveUpdateCheckPolicy({
            env: { ARTIBOT_UPDATE_CHECK: raw },
            config: { updateCheck: { enabled: false } },
          }),
        ).toEqual({
          enabled: false,
          source: 'config',
          reason: 'artibot.config.json updateCheck.enabled=false',
        });
      },
    );

    it('falls back to the default when an unrecognised env value meets no config', () => {
      expect(
        resolveUpdateCheckPolicy({
          env: { ARTIBOT_UPDATE_CHECK: 'maybe' },
          config: {},
        }),
      ).toEqual({ enabled: true, source: 'default', reason: 'default' });
    });

    it('disables the check when config.updateCheck.enabled is false', () => {
      expect(
        resolveUpdateCheckPolicy({
          env: {},
          config: { updateCheck: { enabled: false } },
        }),
      ).toEqual({
        enabled: false,
        source: 'config',
        reason: 'artibot.config.json updateCheck.enabled=false',
      });
    });

    it.each([
      ['enabled: true', { updateCheck: { enabled: true } }],
      ['a missing updateCheck key', { team: {} }],
      ['a non-boolean enabled value', { updateCheck: { enabled: 'false' } }],
      ['a missing enabled key', { updateCheck: {} }],
    ])('keeps the check on for config with %s', (_label, config) => {
      // Strict === false only. The string "false" must NOT disable.
      expect(resolveUpdateCheckPolicy({ env: {}, config })).toEqual({
        enabled: true,
        source: 'default',
        reason: 'default',
      });
    });

    it('lets env=on win over config=off', () => {
      expect(
        resolveUpdateCheckPolicy({
          env: { ARTIBOT_UPDATE_CHECK: '1' },
          config: { updateCheck: { enabled: false } },
        }),
      ).toEqual({
        enabled: true,
        source: 'env',
        reason: 'ARTIBOT_UPDATE_CHECK=1',
      });
    });

    it('lets env=off win over config=on', () => {
      expect(
        resolveUpdateCheckPolicy({
          env: { ARTIBOT_UPDATE_CHECK: '0' },
          config: { updateCheck: { enabled: true } },
        }),
      ).toEqual({
        enabled: false,
        source: 'env',
        reason: 'ARTIBOT_UPDATE_CHECK=0',
      });
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not-an-object'],
      ['a number', 42],
      ['an array', []],
      ['a null updateCheck', { updateCheck: null }],
      ['a string updateCheck', { updateCheck: 'off' }],
    ])('does not throw for config that is %s', (_label, config) => {
      let policy;
      expect(() => {
        policy = resolveUpdateCheckPolicy({ env: {}, config });
      }).not.toThrow();
      expect(policy).toEqual({
        enabled: true,
        source: 'default',
        reason: 'default',
      });
    });

    it('does not throw when env is null', () => {
      expect(() => resolveUpdateCheckPolicy({ env: null, config: {} })).not.toThrow();
    });

    it('performs no I/O — no fs call of any kind', () => {
      resolveUpdateCheckPolicy({ env: { ARTIBOT_UPDATE_CHECK: '0' } });
      resolveUpdateCheckPolicy({ env: {}, config: { updateCheck: { enabled: false } } });
      expect(fsMock.existsSync).not.toHaveBeenCalled();
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
      expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // checkForUpdate() - opt-out short circuit
  // =========================================================================
  describe('checkForUpdate() - opt-out', () => {
    it('returns a disabled result without touching cache or network when env disables it', async () => {
      globalThis.fetch = vi.fn();

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR, {
        env: { ARTIBOT_UPDATE_CHECK: '0' },
      });

      expect(result).toEqual({
        hasUpdate: false,
        disabled: true,
        source: 'env',
        reason: 'ARTIBOT_UPDATE_CHECK=0',
      });
      expect(fsMock.existsSync).not.toHaveBeenCalled();
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
      expect(fsMock.mkdirSync).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns a disabled result when config disables it', async () => {
      globalThis.fetch = vi.fn();

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR, {
        env: {},
        config: { updateCheck: { enabled: false } },
      });

      expect(result).toEqual({
        hasUpdate: false,
        disabled: true,
        source: 'config',
        reason: 'artibot.config.json updateCheck.enabled=false',
      });
      expect(fsMock.existsSync).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('short-circuits even when a fresh cache entry exists — no cache read at all', async () => {
      // Opt-out must beat the cache path, not just the network path: a stale
      // "update available" entry would otherwise keep nagging forever.
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(
        JSON.stringify({
          hasUpdate: true,
          latestVersion: '9.9.9',
          currentVersion: CURRENT_VERSION,
          checkedAt: new Date().toISOString(),
        }),
      );

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR, {
        env: { ARTIBOT_UPDATE_CHECK: 'off' },
      });

      expect(result.disabled).toBe(true);
      expect(result.hasUpdate).toBe(false);
      expect(fsMock.existsSync).not.toHaveBeenCalled();
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
    });

    it('still performs the normal check when opts explicitly enable it', async () => {
      // Positive control: the gate must not pass by doing nothing.
      globalThis.fetch = vi.fn(() => makeFetchResponse({ version: '2.0.0' }));

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR, {
        env: { ARTIBOT_UPDATE_CHECK: '1' },
        config: { updateCheck: { enabled: false } },
      });

      expect(result).toEqual({
        hasUpdate: true,
        latestVersion: '2.0.0',
        currentVersion: CURRENT_VERSION,
      });
      expect(result.disabled).toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('behaves exactly as before for the legacy two-argument call', async () => {
      // Back-compat: session-start's existing `checkForUpdate(v, dir)` call
      // must be unchanged when no opt-out is present in the ambient env.
      globalThis.fetch = vi.fn(() => makeFetchResponse({ version: '2.0.0' }));

      const result = await checkForUpdate(CURRENT_VERSION, CACHE_DIR);

      expect(result).toEqual({
        hasUpdate: true,
        latestVersion: '2.0.0',
        currentVersion: CURRENT_VERSION,
      });
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });
});
