/**
 * Firewall — swarm-client must not have an allowlist looser than DATA POLICY.
 *
 * `swarm-client.js` carried its own SSRF allowlist alongside the policy guard in
 * `lib/core/data-egress-guard.js`, and the two disagreed. Its
 * `ALLOWED_HOST_PATTERNS` accepted `/^artibot-swarm-\d+\.[\w-]+\.run\.app$/`,
 * where the middle group is a Cloud Run PROJECT name — attacker-choosable.
 * Measured 2026-08-30: `artibot-swarm-1.attacker.run.app` matched, while
 * `lib/core/allowlist.json` lists only GitHub hosts and would have refused it.
 *
 * That gap was reachable. The hook paths (`scripts/hooks/swarm-sync.js`,
 * `swarm-download.js`) call `assertEgressAllowed` first, but
 * `scripts/swarm-sync-now.js` -> `sync-scheduler.js#forceSync` ->
 * `swarm-client` does not, so a force-sync consulted only the looser list.
 *
 * The run.app default was already removed from shipped config in v4.x; the
 * pattern was a leftover with no live consumer.
 *
 * WHAT THIS DOES NOT COVER:
 *   - Whether a request is actually issued. These assertions stop at URL
 *     validation; they do not prove `fetch` is never reached by another route.
 *   - The git backend. It moves data with the `git` binary, so no HTTP guard
 *     sees it at all (`swarm-download.js` skips the check when backend==='git').
 *   - Egress from anything that does not go through `validateUrl`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, validateUrl } from '../../lib/swarm/swarm-client.js';

/** Hosts that must never validate, whatever the two allowlists say. */
const ATTACKER_HOSTS = [
  'https://artibot-swarm-1.attacker.run.app/api/v1/weights',
  'https://artibot-swarm-999.evil-project.run.app/api/v1/weights',
  'https://artibot-swarm-0.a-b-c.run.app/api/v1/weights',
];

describe('swarm-client egress policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses attacker-controlled Cloud Run subdomains', () => {
    // NEGATIVE CONTROL for the fixture: these strings must actually match the
    // retired pattern, or this case would pass without exercising anything.
    const retired = /^artibot-swarm-\d+\.[\w-]+\.run\.app$/;
    const hosts = ATTACKER_HOSTS.map((u) => new URL(u).hostname);
    expect(hosts.every((h) => retired.test(h))).toBe(true);

    for (const url of ATTACKER_HOSTS) {
      expect(() => validateUrl(url), url).toThrow();
    }
  });

  it('still allows the legitimate self-hosted localhost endpoints', () => {
    expect(validateUrl('http://localhost:3000/api/v1/weights').hostname).toBe('localhost');
    expect(validateUrl('http://127.0.0.1:3000/api/v1/weights').hostname).toBe('127.0.0.1');
    expect(validateUrl('http://[::1]:3000/api/v1/weights').hostname).toBe('[::1]');
  });

  it('still refuses non-http protocols and embedded credentials', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow();
    expect(() => validateUrl('http://user:pass@localhost:3000/x')).toThrow();
  });

  it('does not follow a redirect off the allowlist (bearer token stays put)', async () => {
    // These requests carry `Authorization: Bearer` when ARTIBOT_SERVER_TOKEN is
    // set (swarm-client.js#buildHeaders). Validating only the first hop would
    // let an allowlisted host redirect the token anywhere, so the client goes
    // through safeFetch, which re-checks every hop.
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      seen.push(String(url));
      return {
        status: 302,
        ok: false,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://evil.example.com/steal' : null) },
      };
    }));

    const result = await checkHealth({ config: { serverUrl: 'http://localhost:3000' } });

    // NEGATIVE CONTROL: the first hop must actually have happened, or the
    // assertions below would pass on an empty list.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toContain('localhost');
    expect(seen.some((u) => u.includes('evil.example.com'))).toBe(false);

    // The load-bearing assertion. A stubbed `fetch` does not follow redirects,
    // so "we never called evil.example.com" is true either way and proves
    // nothing (measured: reverting to raw fetch left that check green). What
    // separates the two is what happens to the 302: safeFetch re-checks the
    // Location, the guard refuses it, and checkHealth's catch reports
    // 'unreachable'. Raw fetch would hand back the 302 as a response and
    // checkHealth would call it 'degraded'.
    expect(result.status).toBe('unreachable');
  });

  it('carries no host pattern that admits a non-localhost host', () => {
    // Ratchet. A future pattern that lets some external host through has to
    // fail here rather than quietly widen the surface again.
    for (const host of ['evil.com', 'artibot-swarm-2.x.run.app', 'swarm.example.org']) {
      expect(() => validateUrl(`https://${host}/api/v1/weights`), host).toThrow();
    }
  });
});
