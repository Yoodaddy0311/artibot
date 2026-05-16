/**
 * Tests for the DATA POLICY runtime egress guard.
 *
 * Contract:
 *   - fail-closed: empty allowlist blocks every non-localhost host
 *   - localhost variants always pass
 *   - exact hostname match only (no subdomain wildcards)
 *   - env-var override merges with on-disk allowlist
 *   - invalid URLs throw EgressBlockedError (never silently pass)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertEgressAllowed,
  EgressBlockedError,
  isLocalhost,
  loadAllowlist,
  safeFetch,
} from '../../lib/privacy/data-egress-guard.js';

// ---------------------------------------------------------------------------
// EgressBlockedError
// ---------------------------------------------------------------------------

describe('EgressBlockedError', () => {
  it('is a subclass of Error with a stable name property', () => {
    const err = new EgressBlockedError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(err.name).toBe('EgressBlockedError');
    expect(err.message).toBe('boom');
  });

  it('carries a stack trace', () => {
    const err = new EgressBlockedError('boom');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('EgressBlockedError');
  });
});

// ---------------------------------------------------------------------------
// isLocalhost()
// ---------------------------------------------------------------------------

describe('isLocalhost()', () => {
  it('recognizes the literal localhost name', () => {
    expect(isLocalhost('localhost')).toBe(true);
    expect(isLocalhost('LOCALHOST')).toBe(true);
  });

  it('recognizes the IPv4 loopback range', () => {
    expect(isLocalhost('127.0.0.1')).toBe(true);
    expect(isLocalhost('127.1.2.3')).toBe(true);
  });

  it('recognizes IPv6 loopback in both bracketed and bare forms', () => {
    expect(isLocalhost('::1')).toBe(true);
    expect(isLocalhost('[::1]')).toBe(true);
  });

  it('recognizes .local mDNS hostnames', () => {
    expect(isLocalhost('mybox.local')).toBe(true);
    expect(isLocalhost('printer.local')).toBe(true);
  });

  it('rejects empty / non-string inputs', () => {
    expect(isLocalhost('')).toBe(false);
    expect(isLocalhost(null)).toBe(false);
    expect(isLocalhost(undefined)).toBe(false);
    expect(isLocalhost(123)).toBe(false);
  });

  it('rejects public hostnames that merely contain "local"', () => {
    expect(isLocalhost('locallike.com')).toBe(false);
    expect(isLocalhost('example.com')).toBe(false);
    expect(isLocalhost('localhost.evil.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadAllowlist()
// ---------------------------------------------------------------------------

describe('loadAllowlist()', () => {
  const originalEnv = process.env.ARTIBOT_ALLOW_EGRESS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ARTIBOT_ALLOW_EGRESS;
    } else {
      process.env.ARTIBOT_ALLOW_EGRESS = originalEnv;
    }
  });

  it('returns a Set including the disk-baked defaults', () => {
    delete process.env.ARTIBOT_ALLOW_EGRESS;
    const list = loadAllowlist();
    expect(list).toBeInstanceOf(Set);
    expect(list.has('api.github.com')).toBe(true);
  });

  it('merges the ARTIBOT_ALLOW_EGRESS env var with on-disk entries', () => {
    process.env.ARTIBOT_ALLOW_EGRESS = 'example.com, extra.host';
    const list = loadAllowlist();
    expect(list.has('api.github.com')).toBe(true);
    expect(list.has('example.com')).toBe(true);
    expect(list.has('extra.host')).toBe(true);
  });

  it('normalizes env entries to lowercase and trims whitespace', () => {
    process.env.ARTIBOT_ALLOW_EGRESS = '  Example.COM ,  HELLO.test  ';
    const list = loadAllowlist();
    expect(list.has('example.com')).toBe(true);
    expect(list.has('hello.test')).toBe(true);
  });

  it('ignores empty entries in the env var', () => {
    process.env.ARTIBOT_ALLOW_EGRESS = ',,, ,';
    const list = loadAllowlist();
    // No env additions, but disk defaults still load
    expect(list.has('api.github.com')).toBe(true);
  });

  it('treats an unset env var as empty', () => {
    delete process.env.ARTIBOT_ALLOW_EGRESS;
    const list = loadAllowlist();
    expect(list.has('api.github.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertEgressAllowed()
// ---------------------------------------------------------------------------

describe('assertEgressAllowed()', () => {
  it('blocks every non-localhost host when the allowlist is empty', () => {
    expect(() =>
      assertEgressAllowed('https://api.example.com/path', {
        allowlist: new Set(),
        reason: 'test',
      }),
    ).toThrow(EgressBlockedError);
  });

  it('allows localhost regardless of allowlist contents', () => {
    expect(
      assertEgressAllowed('http://localhost:3000/api', { allowlist: new Set() }),
    ).toBe(true);
    expect(
      assertEgressAllowed('http://127.0.0.1:8080/x', { allowlist: new Set() }),
    ).toBe(true);
    expect(
      assertEgressAllowed('http://[::1]/y', { allowlist: new Set() }),
    ).toBe(true);
    expect(
      assertEgressAllowed('http://mybox.local/z', { allowlist: new Set() }),
    ).toBe(true);
  });

  it('allows explicitly listed hosts', () => {
    expect(
      assertEgressAllowed('https://api.github.com/repos/foo/bar', {
        allowlist: new Set(['api.github.com']),
      }),
    ).toBe(true);
  });

  it('honors env-var-derived allowlist entries via loadAllowlist()', () => {
    const original = process.env.ARTIBOT_ALLOW_EGRESS;
    process.env.ARTIBOT_ALLOW_EGRESS = 'allowed.test';
    try {
      expect(
        assertEgressAllowed('https://allowed.test/path', {
          allowlist: loadAllowlist(),
        }),
      ).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.ARTIBOT_ALLOW_EGRESS;
      } else {
        process.env.ARTIBOT_ALLOW_EGRESS = original;
      }
    }
  });

  it('rejects subdomains when only the parent is allowlisted (exact match only)', () => {
    expect(() =>
      assertEgressAllowed('https://evil.api.github.com/exfil', {
        allowlist: new Set(['github.com']),
      }),
    ).toThrow(EgressBlockedError);
    expect(() =>
      assertEgressAllowed('https://api.github.com/foo', {
        allowlist: new Set(['github.com']),
      }),
    ).toThrow(EgressBlockedError);
  });

  it('rejects non-http(s) protocols even when the host would be allowed', () => {
    expect(() =>
      assertEgressAllowed('file:///etc/passwd', {
        allowlist: new Set(['localhost']),
      }),
    ).toThrow(EgressBlockedError);
    expect(() =>
      assertEgressAllowed('ftp://api.github.com/x', {
        allowlist: new Set(['api.github.com']),
      }),
    ).toThrow(EgressBlockedError);
  });

  it('throws EgressBlockedError on malformed URLs', () => {
    expect(() =>
      assertEgressAllowed('not a url', { allowlist: new Set() }),
    ).toThrow(EgressBlockedError);
    expect(() =>
      assertEgressAllowed('://broken', { allowlist: new Set() }),
    ).toThrow(EgressBlockedError);
  });

  it('throws EgressBlockedError on empty or non-string URLs', () => {
    expect(() => assertEgressAllowed('', { allowlist: new Set() })).toThrow(
      EgressBlockedError,
    );
    expect(() => assertEgressAllowed(null, { allowlist: new Set() })).toThrow(
      EgressBlockedError,
    );
    expect(() =>
      assertEgressAllowed(undefined, { allowlist: new Set() }),
    ).toThrow(EgressBlockedError);
  });

  it('includes the reason tag in the error message', () => {
    try {
      assertEgressAllowed('https://blocked.example.com/', {
        allowlist: new Set(),
        reason: 'update-check',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EgressBlockedError);
      expect(err.message).toContain('[update-check]');
      expect(err.message).toContain('blocked.example.com');
    }
  });

  it('treats hostname comparison as case-insensitive', () => {
    expect(
      assertEgressAllowed('https://API.GitHub.com/repos', {
        allowlist: new Set(['api.github.com']),
      }),
    ).toBe(true);
  });

  it('defaults the allowlist to loadAllowlist() when no option is provided', () => {
    // Default disk allowlist contains api.github.com
    expect(assertEgressAllowed('https://api.github.com/anything')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// safeFetch()
// ---------------------------------------------------------------------------

describe('safeFetch()', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      // Minimal Response-shaped stub; tests assert call shape, not body
      /** @type {any} */ ({ ok: true, status: 200, async json() { return {}; }, async text() { return ''; } }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('invokes fetch when the URL is allowed', async () => {
    const res = await safeFetch('https://api.github.com/repos', undefined, {
      allowlist: new Set(['api.github.com']),
      reason: 'unit-test',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.github.com/repos', undefined);
    expect(res.ok).toBe(true);
  });

  it('throws EgressBlockedError WITHOUT invoking fetch when blocked', async () => {
    await expect(
      safeFetch('https://forbidden.example.com/x', undefined, {
        allowlist: new Set(),
        reason: 'unit-test',
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards init options to fetch unchanged', async () => {
    const init = { method: 'POST', body: 'payload' };
    await safeFetch('http://localhost:3000/hook', init, {
      allowlist: new Set(),
      reason: 'unit-test',
    });
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/hook', init);
  });
});
