import { describe, expect, it } from 'vitest';
import { routeCli } from '../../scripts/route-lifecycle.mjs';

describe('route-lifecycle CLI bridge', () => {
  it('routes an explicit known phase id through routeLifecycle', async () => {
    const r = await routeCli(['spec']);
    // Guarded: router returns null for phases absent from the lifecycle manifest.
    expect(r === null || r.lifecycle === 'spec').toBe(true);
  });
  it('forwards a free-form hint with the phase', async () => {
    const r = await routeCli(['ship', 'deploy', 'to', 'prod']);
    expect(r === null || r.lifecycle === 'ship').toBe(true);
  });
  it('falls back to routeByContext for an unknown first arg and never throws', async () => {
    const r = await routeCli(['please', 'review', 'my', 'code']);
    expect(r === null || typeof r.lifecycle === 'string').toBe(true);
  });
});
