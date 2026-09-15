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
import { resolveWorkflowMode } from '../../../lib/runtime/middleware/workflow-mode.js';

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

  it('returns a fresh reasons array each call (no shared mutable state)', () => {
    const a = resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: false });
    const b = resolveWorkflowMode({ routingSystem: 'system2', teamEnabled: false });
    expect(a.reasons).not.toBe(b.reasons);
    a.reasons.push('mutated');
    expect(b.reasons).toEqual(['team-disabled']);
  });
});
