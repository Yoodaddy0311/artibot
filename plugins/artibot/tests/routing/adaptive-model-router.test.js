/**
 * Stem-matched pin for `lib/routing/adaptive-model-router.js` (Stop gate rule:
 * `<stem>.test.js`; the broader behavioural suite lives in `adaptive-router.test.js`).
 *
 * Pins the incumbent contract documented on `routeModel({ currentTier })`
 * (2026-09-15 wording): `models.current` is an identity only when the tier can be
 * evidenced through the catalog by exact id match; every unreadable or unknown
 * source yields `null`, which is NOT "no switch happened".
 *
 * @module tests/routing/adaptive-model-router.test
 */

import { describe, expect, it } from 'vitest';
import { modelIdentity, ROUTER_DECISIONS } from '../../lib/routing/adaptive-model-router.js';
import { MODELS } from '../../lib/core/model-catalog.js';

describe('adaptive-model-router — incumbent identity contract', () => {
  it('resolves a known tier to the catalog id (exact match, no aliasing)', () => {
    for (const tier of ['opus', 'fable', 'sonnet', 'haiku']) {
      const identity = modelIdentity(tier, undefined);
      expect(identity).not.toBeNull();
      expect(identity.tier).toBe(tier);
      expect(identity.model_id).toBe(MODELS[tier].id);
    }
  });

  it('yields null for every source that cannot be evidenced (absent, blank, non-string, unknown tier)', () => {
    for (const source of [undefined, null, '', '   ', 42, {}, 'claude-sonnet-4-6', 'opus[1m]']) {
      expect(modelIdentity(source, undefined)).toBeNull();
    }
  });

  it('exposes exactly the two decision types the receipt schema allows', () => {
    expect([...ROUTER_DECISIONS]).toEqual(['route', 'pin']);
    expect(Object.isFrozen(ROUTER_DECISIONS)).toBe(true);
  });
});
