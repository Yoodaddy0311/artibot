import { describe, expect, it } from 'vitest';
import {
  buildLedgerPrivacyChain, uploadLedgerCorpus,
} from '../../../lib/learning/ledger/learning-bridge.js';

describe('learning-bridge — F-06 R2 privacy enforcement (D3)', () => {
  it('always returns scrub + addNoise, even when config disables DP (R2 override)', () => {
    const { scrubPii, addNoise } = buildLedgerPrivacyChain({
      config: { differentialPrivacy: { enabled: false } },
    });
    expect(typeof scrubPii).toBe('function');
    expect(typeof addNoise).toBe('function'); // forced despite enabled:false
  });

  it('always returns addNoise when there is no DP config at all', () => {
    const { addNoise } = buildLedgerPrivacyChain({ config: {} });
    expect(typeof addNoise).toBe('function');
  });

  it('the forced noise actually perturbs numeric leaves (ε=1.0 default)', () => {
    const { addNoise } = buildLedgerPrivacyChain({ config: {} });
    const input = { route: { confidence: 0.5, successRate: 0.9 } };
    const out = addNoise(structuredClone(input));
    const changed = out.route.confidence !== 0.5 || out.route.successRate !== 0.9;
    expect(changed).toBe(true);
  });

  it('honours an explicit caller addNoise override', () => {
    const myNoise = (w) => w;
    const { addNoise } = buildLedgerPrivacyChain({
      config: { differentialPrivacy: { enabled: true } }, addNoise: myNoise,
    });
    expect(addNoise).toBe(myNoise);
  });

  it('uploadLedgerCorpus stamps source=ledger and passes scrub+addNoise to the uploader', async () => {
    let received;
    const fakeUpload = async (w, m, o) => { received = { w, m, o }; return { success: true }; };
    const res = await uploadLedgerCorpus(
      { x: 1 }, { clientId: 'c' }, { config: {} }, { uploadWeights: fakeUpload },
    );
    expect(res.success).toBe(true);
    expect(received.m.source).toBe('ledger');
    expect(received.m.clientId).toBe('c'); // existing metadata preserved
    expect(typeof received.o.scrubPii).toBe('function');
    expect(typeof received.o.addNoise).toBe('function');
  });
});
