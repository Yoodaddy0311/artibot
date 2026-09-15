/**
 * Truth table for the execution-topology resolver.
 *
 * Tested here rather than through the tasks middleware on purpose: the
 * middleware reads `artibot.config.json` from disk, compiles a mission and
 * writes a decision row, so a table of 16 combinations run through it would be
 * measuring the filesystem. The middleware's own suite pins that it CALLS this
 * resolver and honours the answer; this file pins what the answer is.
 */

import { describe, expect, it } from 'vitest';
import {
  FOLLOW_WORKFLOW_PLAN_CONFIG_KEY,
  readFollowWorkflowPlan,
  resolveWorkflowMode,
} from '../../../lib/runtime/middleware/workflow-mode.js';
import { FOLLOW_WORKFLOW_PLAN_CONFIG_KEY as REEXPORTED_KEY } from '../../../lib/runtime/middleware/tasks.js';

describe('FOLLOW_WORKFLOW_PLAN_CONFIG_KEY', () => {
  it('is still importable from tasks.js, where it used to be defined', () => {
    // The definition moved here in F04(b) to sit beside its consumer, and
    // `tasks.js` re-exports it. A re-export that silently stopped working
    // would break importers by PATH while every behaviour test stayed green,
    // so the path is pinned rather than assumed.
    expect(REEXPORTED_KEY).toBe(FOLLOW_WORKFLOW_PLAN_CONFIG_KEY);
    expect(FOLLOW_WORKFLOW_PLAN_CONFIG_KEY).toBe('team.followWorkflowPlan');
  });
});

describe('readFollowWorkflowPlan', () => {
  it('reads the literal true at the dotted path', () => {
    expect(readFollowWorkflowPlan({ team: { followWorkflowPlan: true } })).toBe(true);
  });

  it.each([
    ['the key is absent', { team: {} }],
    ['the key is false', { team: { followWorkflowPlan: false } }],
    ['the value is the STRING "true"', { team: { followWorkflowPlan: 'true' } }],
    ['the value is 1', { team: { followWorkflowPlan: 1 } }],
    ['the team section is missing', {}],
    ['the config is empty', undefined],
  ])('returns false when %s', (_label, cfg) => {
    // Fail-closed on anything that is not the literal `true`: a config value
    // that failed to parse must not switch the consumer on, and a missing
    // section must not throw on the way down the path.
    expect(readFollowWorkflowPlan(cfg)).toBe(false);
  });

  it('follows the constant, not a hand-typed path', () => {
    // Builds the fixture FROM the constant. If someone renames the key without
    // renaming the lookup, this goes red; a fixture with `team` and
    // `followWorkflowPlan` typed out would not.
    const [section, field] = FOLLOW_WORKFLOW_PLAN_CONFIG_KEY.split('.');
    expect(readFollowWorkflowPlan({ [section]: { [field]: true } })).toBe(true);
  });
});

describe('resolveWorkflowMode', () => {
  describe('team ON, no opt-out — routing decides, as it always did', () => {
    it('routes system2 to agentTeam', () => {
      expect(resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: true, optOut: false }))
        .toEqual({ mode: 'agentTeam', reasons: [] });
    });

    it('routes system1 to subAgent', () => {
      expect(resolveWorkflowMode({ routingSystem: 'system1', teamEnabled: true, optOut: false }))
        .toEqual({ mode: 'subAgent', reasons: [] });
    });

    it('treats an unknown routing system as system1', () => {
      // The caller already defaults to 'system1'; this pins that a value the
      // router starts emitting tomorrow does not silently become a team.
      expect(resolveWorkflowMode({ routingSystem: 'system3', teamEnabled: true }).mode)
        .toBe('subAgent');
    });
  });

  describe('OFF outranks routing (owner decision OD2)', () => {
    it('drops system2 to subAgent when the team is disabled', () => {
      expect(resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: false, optOut: false }))
        .toEqual({ mode: 'subAgent', reasons: ['team-disabled'] });
    });

    it('drops system2 to subAgent on the --no-team flag', () => {
      expect(resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: true, optOut: true }))
        .toEqual({ mode: 'subAgent', reasons: ['no-team-flag'] });
    });

    it('records BOTH reasons when both apply', () => {
      // Two different facts. Collapsing them would lose the ability to tell a
      // user who configured the team off from one who typed the flag once.
      expect(resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: false, optOut: true }))
        .toEqual({ mode: 'subAgent', reasons: ['team-disabled', 'no-team-flag'] });
    });

    it('still reports the reason on system1, where the mode was already subAgent', () => {
      // The mode is unchanged, the RECORD is not: a system1 prompt under an
      // OFF setting is not the same event as a system1 prompt under an ON one,
      // and the mismatch denominator has to be able to see the difference.
      expect(resolveWorkflowMode({ routingSystem: 'system1', teamEnabled: false, optOut: false }))
        .toEqual({ mode: 'subAgent', reasons: ['team-disabled'] });
    });
  });

  describe('fails closed on a missing input', () => {
    it('treats an absent teamEnabled as OFF', () => {
      // Guessing wrong in this direction costs a team that was not spawned.
      // Guessing wrong in the other spawns a team against a stated opt-out.
      expect(resolveWorkflowMode({ routingSystem: 'system2' }))
        .toEqual({ mode: 'subAgent', reasons: ['team-disabled'] });
    });

    it('survives being called with no arguments at all', () => {
      expect(resolveWorkflowMode()).toEqual({ mode: 'subAgent', reasons: ['team-disabled'] });
    });
  });

  describe('only the literal true counts as an opt-out', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['false', false],
      ['the empty string', ''],
    ])('does not read %s as an opt-out', (_label, value) => {
      // `optOut` arrives from `NO_TEAM_FLAG.test(...)`, which always returns a
      // boolean. A non-boolean here means a caller passed something unparsed,
      // and inventing an opt-out from it would disable a team nobody opted out
      // of.
      expect(resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: true, optOut: value }))
        .toEqual({ mode: 'agentTeam', reasons: [] });
    });
  });

  // -------------------------------------------------------------------------
  // F04(b) — `team.followWorkflowPlan`. Until this key had a consumer the mode
  // was a restatement of `routing.system`, and the plan — the thing that
  // actually weighs sub-objectives, files and complexity — was recorded and
  // then thrown away. With the key ON the plan decides, in BOTH directions: a
  // system1 prompt whose plan elects a team gets one, and a system2 prompt
  // whose plan says `inline` does not. Owner decision OD5 (2026-09-15): the
  // key ships OFF, so every row with the key absent or false below must be the
  // behaviour of the rows above it, unchanged.
  // -------------------------------------------------------------------------
  describe('followWorkflowPlan ON — the plan decides, in both directions', () => {
    it('promotes system1 to agentTeam when the plan elected a team', () => {
      expect(resolveWorkflowMode({
        routingSystem: 'system1',
        teamEnabled: true,
        optOut: false,
        followWorkflowPlan: true,
        plan: { runner: 'team' },
      })).toEqual({ mode: 'agentTeam', reasons: ['follow-plan'] });
    });

    it('demotes system2 to subAgent when the plan says inline', () => {
      // The direction that is easy to forget. Following the plan only upward
      // would leave `routing.system` as a second, silent owner of the mode.
      expect(resolveWorkflowMode({
        routingSystem: 'system2',
        teamEnabled: true,
        optOut: false,
        followWorkflowPlan: true,
        plan: { runner: 'inline' },
      })).toEqual({ mode: 'subAgent', reasons: ['follow-plan'] });
    });

    it('ignores routing entirely — one plan yields one mode on either system', () => {
      const plan = { runner: 'team' };
      expect(resolveWorkflowMode({
        routingSystem: 'system1', teamEnabled: true, followWorkflowPlan: true, plan,
      }).mode).toBe(resolveWorkflowMode({
        routingSystem: 'system2', teamEnabled: true, followWorkflowPlan: true, plan,
      }).mode);
    });

    it.each([
      ['an absent plan', undefined],
      ['a null plan', null],
      ['a plan with no runner', {}],
      ['a runner the planner does not emit', { runner: 'swarm' }],
    ])('falls back to subAgent for %s', (_label, plan) => {
      // Fail-closed, the same direction as the missing `teamEnabled` above: an
      // unreadable plan must not be read as "spawn a team".
      expect(resolveWorkflowMode({
        routingSystem: 'system2', teamEnabled: true, followWorkflowPlan: true, plan,
      })).toEqual({ mode: 'subAgent', reasons: ['follow-plan'] });
    });
  });

  describe('followWorkflowPlan OFF or absent — routing decides, unchanged (OD5)', () => {
    it.each([
      ['absent', undefined],
      ['false', false],
      ['a truthy non-boolean', 'yes'],
      ['the number 1', 1],
    ])('keeps the legacy routing rule when the key is %s', (_label, key) => {
      // Only the literal `true` turns the consumer on, for the same reason
      // only the literal `true` counts as an opt-out: a config value that
      // failed to parse must not change what runs.
      expect(resolveWorkflowMode({
        routingSystem: 'system1',
        teamEnabled: true,
        optOut: false,
        followWorkflowPlan: key,
        plan: { runner: 'team' },
      })).toEqual({ mode: 'subAgent', reasons: [] });
      expect(resolveWorkflowMode({
        routingSystem: 'system2',
        teamEnabled: true,
        optOut: false,
        followWorkflowPlan: key,
        plan: { runner: 'inline' },
      })).toEqual({ mode: 'agentTeam', reasons: [] });
    });
  });

  describe('OFF still outranks the key (OD2 above OD5)', () => {
    it.each([
      ['team disabled', { teamEnabled: false, optOut: false }, ['team-disabled']],
      ['--no-team', { teamEnabled: true, optOut: true }, ['no-team-flag']],
      ['both', { teamEnabled: false, optOut: true }, ['team-disabled', 'no-team-flag']],
    ])('%s beats followWorkflowPlan:true with a runner=team plan', (_label, off, reasons) => {
      // The whole point of ordering the OFF gate above both branches: turning
      // the consumer on must not resurrect a team the user switched off.
      for (const routingSystem of ['system1', 'system2']) {
        expect(resolveWorkflowMode({
          routingSystem, ...off, followWorkflowPlan: true, plan: { runner: 'team' },
        })).toEqual({ mode: 'subAgent', reasons });
      }
    });
  });

  it('returns a fresh reasons array each call (no shared mutable state)', () => {
    const a = resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: false });
    const b = resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: false });
    expect(a.reasons).not.toBe(b.reasons);
    a.reasons.push('mutated');
    expect(b.reasons).toEqual(['team-disabled']);
  });
});
