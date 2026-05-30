import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Regression lock for the swarm-download hook helper extraction
 * (swarm 9-day stale fix). checkHttpEgressAllowed / checkHttpServerHealthy
 * were extracted out of main() to keep nesting within the lint depth limit;
 * these tests prove the extraction is behaviour-preserving:
 *  - egress: allowed -> true, EgressBlockedError -> false+stderr (no log),
 *    unexpected error -> false+log, URL precedence env > serverUrl > default.
 *  - health: absent/import-fail -> true (graceful proceed), healthy -> true,
 *    unhealthy -> false+stderr, throw -> false+log.
 * Importing the module must NOT fire main() — guarded by isMainEntry.
 */

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

vi.mock('../../lib/privacy/data-egress-guard.js', () => {
  class EgressBlockedError extends Error {
    constructor(message) {
      super(message);
      this.name = 'EgressBlockedError';
    }
  }
  return {
    EgressBlockedError,
    assertEgressAllowed: vi.fn(),
    loadAllowlist: vi.fn(() => ['api.github.com']),
  };
});

const { logHookError } = await import('../../lib/core/hook-utils.js');
const { assertEgressAllowed, EgressBlockedError } = await import(
  '../../lib/privacy/data-egress-guard.js'
);
const { checkHttpEgressAllowed, checkHttpServerHealthy } = await import(
  '../../scripts/hooks/swarm-download.js'
);

let healthyRoot;
let noHealthRoot;
let stderrSpy;

beforeAll(() => {
  // Fixture A: a plugin root whose swarm-client exposes a checkHealth that
  // mirrors the runtime contract, driven by an env var so each case controls it.
  healthyRoot = mkdtempSync(path.join(tmpdir(), 'swdl-health-'));
  mkdirSync(path.join(healthyRoot, 'lib', 'swarm'), { recursive: true });
  writeFileSync(
    path.join(healthyRoot, 'lib', 'swarm', 'swarm-client.js'),
    "export async function checkHealth() {\n" +
      "  const s = process.env.__TEST_HEALTH_STATUS;\n" +
      "  if (s === 'throw') throw new Error('health boom');\n" +
      '  return { status: s };\n' +
      '}\n',
  );

  // Fixture B: a plugin root whose swarm-client has NO checkHealth export.
  noHealthRoot = mkdtempSync(path.join(tmpdir(), 'swdl-nohealth-'));
  mkdirSync(path.join(noHealthRoot, 'lib', 'swarm'), { recursive: true });
  writeFileSync(
    path.join(noHealthRoot, 'lib', 'swarm', 'swarm-client.js'),
    'export const noop = true;\n',
  );
});

afterAll(() => {
  rmSync(healthyRoot, { recursive: true, force: true });
  rmSync(noHealthRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  assertEgressAllowed.mockReset();
  delete process.env.__TEST_HEALTH_STATUS;
  delete process.env.ARTIBOT_SWARM_SERVER;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('checkHttpEgressAllowed', () => {
  it('returns true and passes serverUrl + allowlist + reason when egress is allowed', () => {
    const result = checkHttpEgressAllowed({ serverUrl: 'https://swarm.example.com' });

    expect(result).toBe(true);
    expect(assertEgressAllowed).toHaveBeenCalledWith(
      'https://swarm.example.com',
      expect.objectContaining({ reason: 'swarm-download', allowlist: ['api.github.com'] }),
    );
    expect(logHookError).not.toHaveBeenCalled();
  });

  it('returns false and writes a DATA POLICY stderr line (no error log) on EgressBlockedError', () => {
    assertEgressAllowed.mockImplementation(() => {
      throw new EgressBlockedError('host not on allowlist');
    });

    const result = checkHttpEgressAllowed({ serverUrl: 'https://blocked.example.com' });

    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[swarm-download] Skipped by DATA POLICY'),
    );
    expect(logHookError).not.toHaveBeenCalled();
  });

  it('returns false and logs an error on an unexpected (non-egress) throw', () => {
    assertEgressAllowed.mockImplementation(() => {
      throw new Error('unexpected boom');
    });

    const result = checkHttpEgressAllowed({ serverUrl: 'https://x.example.com' });

    expect(result).toBe(false);
    expect(logHookError).toHaveBeenCalledWith(
      'swarm-download',
      'egress guard threw unexpectedly',
      expect.any(Error),
    );
  });

  it('prefers ARTIBOT_SWARM_SERVER over config.serverUrl', () => {
    process.env.ARTIBOT_SWARM_SERVER = 'https://env-override.example.com';

    checkHttpEgressAllowed({ serverUrl: 'https://config.example.com' });

    expect(assertEgressAllowed).toHaveBeenCalledWith(
      'https://env-override.example.com',
      expect.any(Object),
    );
  });

  it('falls back to localhost:3000 when neither env nor config provides a URL', () => {
    checkHttpEgressAllowed({});

    expect(assertEgressAllowed).toHaveBeenCalledWith('http://localhost:3000', expect.any(Object));
  });
});

describe('checkHttpServerHealthy', () => {
  it('returns true when the swarm-client exposes no checkHealth (proceed by default)', async () => {
    const result = await checkHttpServerHealthy(noHealthRoot, {});
    expect(result).toBe(true);
  });

  it('returns true when the client import fails (graceful degrade)', async () => {
    const bogusRoot = path.join(tmpdir(), 'swdl-does-not-exist-xyz');
    const result = await checkHttpServerHealthy(bogusRoot, {});
    expect(result).toBe(true);
  });

  it('returns true when checkHealth reports status healthy', async () => {
    process.env.__TEST_HEALTH_STATUS = 'healthy';
    const result = await checkHttpServerHealthy(healthyRoot, {});
    expect(result).toBe(true);
  });

  it('returns false and writes stderr when the server is unhealthy', async () => {
    process.env.__TEST_HEALTH_STATUS = 'down';
    const result = await checkHttpServerHealthy(healthyRoot, {});

    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[swarm-download] Server unhealthy'),
    );
  });

  it('returns false and logs an error when checkHealth throws', async () => {
    process.env.__TEST_HEALTH_STATUS = 'throw';
    const result = await checkHttpServerHealthy(healthyRoot, {});

    expect(result).toBe(false);
    expect(logHookError).toHaveBeenCalledWith(
      'swarm-download',
      'health check threw',
      expect.any(Error),
    );
  });
});
