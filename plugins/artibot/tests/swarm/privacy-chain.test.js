/**
 * Regression tests for the swarm privacy chain (audit 2026-06-10, Critical #1).
 *
 * Defect: differential-privacy noise was built ONLY in the SessionEnd hook, so
 * force-sync / scheduled-sync paths uploaded weights with no noise — and the git
 * backend (the multi-device default) applied neither scrub nor noise — despite
 * config.differentialPrivacy.enabled being on by default.
 *
 * Fix: sync-scheduler.resolvePrivacyChain() builds scrub + noise once from config
 * so EVERY sync path applies it; git-backend.gitUploadWeights now runs the same
 * scrub→noise chain as swarm-client.uploadWeights.
 */

import { describe, expect, it } from 'vitest';
import { resolvePrivacyChain } from '../../lib/swarm/sync-scheduler.js';

describe('resolvePrivacyChain — DP applies on every sync path, not just SessionEnd', () => {
  it('builds an addNoise fn from config when differentialPrivacy.enabled (no caller override)', () => {
    const { scrubPii, addNoise } = resolvePrivacyChain({
      config: { differentialPrivacy: { enabled: true, epsilon: 1, delta: 1e-5 } },
    });
    expect(typeof scrubPii).toBe('function');
    expect(typeof addNoise).toBe('function');

    // Noise actually perturbs numeric leaves (delta != 0 with overwhelming probability).
    const input = { route: { confidence: 0.5, successRate: 0.9 } };
    const noised = addNoise(structuredClone(input));
    const changed =
      noised.route.confidence !== input.route.confidence ||
      noised.route.successRate !== input.route.successRate;
    expect(changed).toBe(true);
  });

  it('omits addNoise when DP is disabled (so no silent no-op cost), scrub still defaults on', () => {
    const { scrubPii, addNoise } = resolvePrivacyChain({
      config: { differentialPrivacy: { enabled: false } },
    });
    expect(addNoise).toBeUndefined();
    expect(typeof scrubPii).toBe('function');
  });

  it('omits addNoise when there is no differentialPrivacy config at all', () => {
    const { addNoise } = resolvePrivacyChain({ config: {} });
    expect(addNoise).toBeUndefined();
  });

  it('honours an explicit caller override for both scrubPii and addNoise', () => {
    const myScrub = (w) => w;
    const myNoise = (w) => w;
    const { scrubPii, addNoise } = resolvePrivacyChain({
      config: { differentialPrivacy: { enabled: true } },
      scrubPii: myScrub,
      addNoise: myNoise,
    });
    expect(scrubPii).toBe(myScrub);
    expect(addNoise).toBe(myNoise);
  });

  it('defaults scrubPii to the real PII scrubber that removes planted PII', () => {
    const { scrubPii } = resolvePrivacyChain({ config: {} });
    // The default scrubber operates on pattern objects; assert it returns an
    // object and does not throw on a planted email-bearing key.
    const out = scrubPii({ note: 'contact me at alice@example.com' });
    expect(out).toBeTypeOf('object');
    expect(JSON.stringify(out)).not.toContain('alice@example.com');
  });
});
