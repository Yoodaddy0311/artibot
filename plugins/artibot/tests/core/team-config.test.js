/**
 * `lib/core/team-config.js#isTeamEnabled` — the enable/opt-out meaning, pinned
 * at its new home.
 *
 * WHY THIS FILE EXISTS. The predicate used to live in `lib/cognitive/` (L4),
 * which put it out of reach of two surfaces that legitimately need it:
 * `lib/learning/self-benchmark.js` (L3) and, more awkwardly, anything in L1/L2.
 * The 5-layer rule is "upper imports lower only", so an L3 module importing L4
 * is an eslint error — the practical consequence was that those surfaces
 * re-derived the meaning themselves (`Boolean(config?.team?.enabled)`), which
 * is a THIRD answer, not the same answer. Moving the owner down to L1 makes the
 * one owner reachable from every layer. `lib/cognitive/workflow-plan.js`
 * re-exports it so no consumer import path changed.
 *
 * WHAT THIS FILE DOES NOT SEE. It pins the predicate, not its reach: whether a
 * given surface actually calls it instead of computing `team.enabled` inline is
 * a separate check (a repo grep, plus the per-surface tests in
 * `tests/runtime/create-artibot-agent.test.js` and
 * `tests/learning/self-benchmark.test.js`).
 *
 * @module tests/core/team-config
 */

import { describe, expect, it } from 'vitest';

import { isTeamEnabled } from '../../lib/core/team-config.js';
import { isTeamEnabled as reExported } from '../../lib/cognitive/workflow-plan.js';

describe('isTeamEnabled()', () => {
  // The full truth table, not examples. `enabled` and `autoApply` are ANDed
  // (owner decision OD3, 2026-09-15); the absent-key rows matter most because
  // they are what every shipped config without these keys hits.
  it.each([
    ['both keys present and true', { enabled: true, autoApply: true }, true],
    ['enabled:false alone', { enabled: false }, false],
    ['autoApply:false alone', { autoApply: false }, false],
    ['both false', { enabled: false, autoApply: false }, false],
    ['enabled:false, autoApply:true', { enabled: false, autoApply: true }, false],
    ['enabled:true, autoApply:false', { enabled: true, autoApply: false }, false],
  ])('%s -> %s', (_label, team, expected) => {
    expect(isTeamEnabled(team)).toBe(expected);
  });

  it.each([
    ['undefined config', undefined],
    ['null config', null],
    ['empty object', {}],
    ['enabled present, autoApply absent', { enabled: true }],
    ['autoApply present, enabled absent', { autoApply: true }],
  ])('absent keys mean ON — %s', (_label, team) => {
    expect(isTeamEnabled(team)).toBe(true);
  });

  it('only the literal false disables — falsy non-booleans do not', () => {
    // The gate is `!== false`, not truthiness. A config holding `0` or `''`
    // does not silently turn the team off for someone who never asked for it.
    expect(isTeamEnabled({ enabled: 0 })).toBe(true);
    expect(isTeamEnabled({ autoApply: '' })).toBe(true);
  });

  it('the STRING "false" does NOT disable — pinned as-is, not as a wish', () => {
    // This is the shipped meaning, recorded deliberately rather than quietly
    // "fixed": a JSON config that writes `"autoApply": "false"` leaves the team
    // ON. The type-level defence belongs to the schema
    // (`lib/core/config-schema.js#team`, which rejects a string here), not to
    // this predicate. Changing this line changes behaviour for real configs and
    // needs an owner decision, so it is a pin, not an aspiration.
    expect(isTeamEnabled({ enabled: 'false' })).toBe(true);
    expect(isTeamEnabled({ autoApply: 'false' })).toBe(true);
  });

  it('matches the expression the auto-team hook shipped before unification', () => {
    // POSITIVE CONTROL for "one owner, one meaning": the hook's old inline
    // expression, reproduced here, must agree on every row.
    const legacy = (team) => team.autoApply !== false && team.enabled !== false;
    const rows = [
      {}, { enabled: true }, { enabled: false }, { autoApply: true },
      { autoApply: false }, { enabled: false, autoApply: false },
      { enabled: true, autoApply: false }, { enabled: false, autoApply: true },
    ];
    for (const team of rows) expect(isTeamEnabled(team)).toBe(legacy(team));
  });

  it('is the SAME function object the cognitive module re-exports', () => {
    // Identity, not equivalence: a copy that merely behaves the same today is
    // exactly the drift this move was meant to end.
    expect(reExported).toBe(isTeamEnabled);
  });
});
