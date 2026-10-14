import { describe, expect, it } from 'vitest';
import { payloadKeyRecord, withIdlePayloadRecord } from '../../scripts/hooks/team-idle-handler.js';

/**
 * team-idle-handler.js, the payload-shape record, on the real module. The hook as a process (the
 * idle message, the pending-task count, the state guard, a leftover team.autoStopIdle) is in
 * team-idle-handler-state-guard.test.js.
 */

describe('team-idle-handler / payloadKeyRecord (real module)', () => {
  it('keeps sorted key names and drops every value', () => {
    const rec = payloadKeyRecord({ zeta: 'secret-value', alpha: 1, idle_reason: 'turn_complete' });
    expect(rec.keys).toEqual(['alpha', 'idle_reason', 'zeta']);
    expect(JSON.stringify(rec)).not.toContain('secret-value');
    expect(Number.isFinite(Date.parse(rec.at))).toBe(true);
  });

  it('returns an empty key list for a null or non-object payload', () => {
    expect(payloadKeyRecord(null).keys).toEqual([]);
    expect(payloadKeyRecord('x').keys).toEqual([]);
  });
});

describe('team-idle-handler / withIdlePayloadRecord (real module)', () => {
  it('records the key names of a teammate_name-shaped firing (no agent_id)', () => {
    const before = { tasks: [] };
    const after = withIdlePayloadRecord(before, { hook_event_name: 'TeammateIdle', teammate_name: 'm', team_name: 't' });
    expect(after.idlePayloadWithoutAgentId.keys).toEqual(['hook_event_name', 'team_name', 'teammate_name']);
    expect(before).toEqual({ tasks: [] });
  });

  it('leaves the state untouched when the firing carries agent_id', () => {
    const before = { tasks: [] };
    expect(withIdlePayloadRecord(before, { agent_id: 'a1', agent_type: 'x' })).toBe(before);
  });
});
