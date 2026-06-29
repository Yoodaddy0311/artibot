/**
 * F-06 R2 / AC1 — ledger-derived weights must never reach the swarm without the
 * differential-privacy layer. The guard fires BEFORE any network call, so these
 * tests need no fetch mock. (The happy path — ledger upload WITH DP — is covered
 * by learning-bridge.test.js and the existing swarm-client suite.)
 */
import { describe, expect, it } from 'vitest';
import { uploadWeights } from '../../lib/swarm/swarm-client.js';

describe('uploadWeights — ledger egress guard (F-06 AC1)', () => {
  it('refuses to send ledger-derived weights when differential privacy is missing', async () => {
    const res = await uploadWeights({ a: 1 }, { source: 'ledger' }, { addNoise: undefined });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/differential privacy/i);
  });

  it('the refusal happens early (no queued offline fallback — nothing was sent)', async () => {
    const res = await uploadWeights({ a: 1 }, { source: 'ledger' });
    expect(res.success).toBe(false);
    expect(res.queued).toBeUndefined(); // blocked before the network/queue path
  });
});
