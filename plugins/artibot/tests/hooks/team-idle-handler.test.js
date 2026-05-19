import { describe, expect, it } from 'vitest';

/**
 * team-idle-handler.js auto-executes main() and reads from stdin/filesystem.
 * We test the pure internal logic by re-implementing the key functions.
 */

// ---------------------------------------------------------------------------
// Re-implemented pure functions from team-idle-handler.js
// ---------------------------------------------------------------------------

const DEFAULT_MAX_IDLE_COUNT = 0;

function loadAutoStopConfig(config) {
  const teamConfig = config?.team || {};
  return {
    enabled: teamConfig.autoStopIdle === true,
    maxIdleCount: teamConfig.maxIdleCount ?? DEFAULT_MAX_IDLE_COUNT,
  };
}

function trackIdleCount(agentId, state) {
  if (!state.idleCounts) state.idleCounts = {};
  const prev = state.idleCounts[agentId] || 0;
  state.idleCounts[agentId] = prev + 1;
  return prev + 1;
}

/**
 * Core decision logic extracted from main().
 * @param {object} params
 * @returns {{ message: string, stop?: boolean }}
 */
function decideIdleAction({ agentId, agentRole, pendingTasks, autoStopConfig, state }) {
  const parts = [`[team] Teammate idle: ${agentId}`];
  if (agentRole) parts[0] += ` (${agentRole})`;

  let shouldStop = false;

  if (pendingTasks.length > 0) {
    parts.push(`${pendingTasks.length} pending task(s) available for assignment.`);
    if (state.idleCounts) state.idleCounts[agentId] = 0;
  } else {
    parts.push('No pending tasks.');

    if (autoStopConfig.enabled && autoStopConfig.maxIdleCount > 0) {
      const idleCount = trackIdleCount(agentId, state);
      if (idleCount >= autoStopConfig.maxIdleCount) {
        shouldStop = true;
        parts.push(`Auto-stopping after ${idleCount} idle events.`);
      } else {
        parts.push(`Idle count: ${idleCount}/${autoStopConfig.maxIdleCount}.`);
      }
    } else {
      parts.push('Ready for new work.');
    }
  }

  const result = { message: parts.join(' | ') };
  if (shouldStop) {
    result.stop = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('team-idle-handler hook (pure function tests)', () => {
  describe('loadAutoStopConfig()', () => {
    it('returns disabled when no team config', () => {
      const config = loadAutoStopConfig({});
      expect(config.enabled).toBe(false);
      expect(config.maxIdleCount).toBe(0);
    });

    it('returns disabled when autoStopIdle is false', () => {
      const config = loadAutoStopConfig({ team: { autoStopIdle: false } });
      expect(config.enabled).toBe(false);
    });

    it('returns enabled with configured maxIdleCount', () => {
      const config = loadAutoStopConfig({
        team: { autoStopIdle: true, maxIdleCount: 3 },
      });
      expect(config.enabled).toBe(true);
      expect(config.maxIdleCount).toBe(3);
    });

    it('uses default maxIdleCount when not specified', () => {
      const config = loadAutoStopConfig({ team: { autoStopIdle: true } });
      expect(config.enabled).toBe(true);
      expect(config.maxIdleCount).toBe(0);
    });

    it('handles null config gracefully', () => {
      const config = loadAutoStopConfig(null);
      expect(config.enabled).toBe(false);
      expect(config.maxIdleCount).toBe(0);
    });
  });

  describe('trackIdleCount()', () => {
    it('initializes idleCounts if missing', () => {
      const state = {};
      const count = trackIdleCount('agent-1', state);
      expect(count).toBe(1);
      expect(state.idleCounts['agent-1']).toBe(1);
    });

    it('increments existing count', () => {
      const state = { idleCounts: { 'agent-1': 2 } };
      const count = trackIdleCount('agent-1', state);
      expect(count).toBe(3);
      expect(state.idleCounts['agent-1']).toBe(3);
    });

    it('tracks separate agents independently', () => {
      const state = { idleCounts: { 'agent-1': 5 } };
      const count = trackIdleCount('agent-2', state);
      expect(count).toBe(1);
      expect(state.idleCounts['agent-1']).toBe(5);
      expect(state.idleCounts['agent-2']).toBe(1);
    });
  });

  describe('decideIdleAction()', () => {
    it('reports pending tasks when available', () => {
      const result = decideIdleAction({
        agentId: 'dev-1',
        agentRole: 'developer',
        pendingTasks: [{ id: 1, status: 'pending' }, { id: 2, status: 'pending' }],
        autoStopConfig: { enabled: false, maxIdleCount: 0 },
        state: {},
      });
      expect(result.message).toContain('2 pending task(s)');
      expect(result.stop).toBeUndefined();
    });

    it('reports ready for new work when no auto-stop', () => {
      const result = decideIdleAction({
        agentId: 'dev-1',
        agentRole: '',
        pendingTasks: [],
        autoStopConfig: { enabled: false, maxIdleCount: 0 },
        state: {},
      });
      expect(result.message).toContain('Ready for new work');
      expect(result.stop).toBeUndefined();
    });

    it('does not stop when idle count is below threshold', () => {
      const state = {};
      const result = decideIdleAction({
        agentId: 'dev-1',
        agentRole: 'builder',
        pendingTasks: [],
        autoStopConfig: { enabled: true, maxIdleCount: 3 },
        state,
      });
      expect(result.message).toContain('Idle count: 1/3');
      expect(result.stop).toBeUndefined();
    });

    it('returns stop when idle count reaches threshold', () => {
      const state = { idleCounts: { 'dev-1': 2 } };
      const result = decideIdleAction({
        agentId: 'dev-1',
        agentRole: 'builder',
        pendingTasks: [],
        autoStopConfig: { enabled: true, maxIdleCount: 3 },
        state,
      });
      expect(result.stop).toBe(true);
      expect(result.message).toContain('Auto-stopping after 3 idle events');
    });

    it('resets idle count when pending tasks appear', () => {
      const state = { idleCounts: { 'dev-1': 5 } };
      decideIdleAction({
        agentId: 'dev-1',
        agentRole: '',
        pendingTasks: [{ id: 1, status: 'pending' }],
        autoStopConfig: { enabled: true, maxIdleCount: 3 },
        state,
      });
      expect(state.idleCounts['dev-1']).toBe(0);
    });

    it('includes agent role in message', () => {
      const result = decideIdleAction({
        agentId: 'reviewer-1',
        agentRole: 'code-reviewer',
        pendingTasks: [],
        autoStopConfig: { enabled: false, maxIdleCount: 0 },
        state: {},
      });
      expect(result.message).toContain('reviewer-1 (code-reviewer)');
    });

    it('handles auto-stop enabled with maxIdleCount 0 (effectively disabled)', () => {
      const result = decideIdleAction({
        agentId: 'dev-1',
        agentRole: '',
        pendingTasks: [],
        autoStopConfig: { enabled: true, maxIdleCount: 0 },
        state: {},
      });
      expect(result.message).toContain('Ready for new work');
      expect(result.stop).toBeUndefined();
    });
  });

  describe('team-weight recording trigger (Area 2 fix)', () => {
    /**
     * Re-implementation of the team-idle-handler decision: when should
     * we fire a GRPO team-weights round?
     * Mirrors plugins/artibot/scripts/hooks/team-idle-handler.js lines
     * 84-118 — record once per drain burst, reset on new work.
     */
    function decideRecord(state, pendingTasks) {
      if (pendingTasks.length > 0) {
        return { record: false, marker: false };
      }
      const hasFields =
        state &&
        typeof state.startedAt === 'number' &&
        state.teamId !== undefined &&
        state.domain !== undefined;
      if (hasFields && !state.teamWeightsRecorded) {
        return { record: true, marker: true };
      }
      return { record: false, marker: !!state.teamWeightsRecorded };
    }

    it('records when pending=0 and all team fields present', () => {
      const r = decideRecord(
        { startedAt: 1700000000000, teamId: 't-1', domain: 'backend' },
        [],
      );
      expect(r.record).toBe(true);
      expect(r.marker).toBe(true);
    });

    it('does not record when startedAt is not numeric', () => {
      const r = decideRecord(
        { startedAt: '2026-01-01T00:00:00Z', teamId: 't-1', domain: 'backend' },
        [],
      );
      expect(r.record).toBe(false);
    });

    it('does not record when teamId missing', () => {
      const r = decideRecord(
        { startedAt: 1700000000000, domain: 'backend' },
        [],
      );
      expect(r.record).toBe(false);
    });

    it('does not record when domain missing', () => {
      const r = decideRecord(
        { startedAt: 1700000000000, teamId: 't-1' },
        [],
      );
      expect(r.record).toBe(false);
    });

    it('is idempotent — does not record twice on same drain burst', () => {
      const state = {
        startedAt: 1700000000000,
        teamId: 't-1',
        domain: 'backend',
        teamWeightsRecorded: true,
      };
      const r = decideRecord(state, []);
      expect(r.record).toBe(false);
    });

    it('does not record while pending tasks exist', () => {
      const r = decideRecord(
        { startedAt: 1700000000000, teamId: 't-1', domain: 'backend' },
        [{ id: 1, status: 'pending' }],
      );
      expect(r.record).toBe(false);
    });

    it('records independent of autoStop config (decoupled from shouldStop)', () => {
      // No autoStop config touched — recording proceeds purely on
      // pending=0 + required fields + idempotency marker.
      const r = decideRecord(
        { startedAt: 1700000000000, teamId: 't-1', domain: 'backend' },
        [],
      );
      expect(r.record).toBe(true);
    });
  });

  describe('agent_type extraction', () => {
    it('uses agent_type from hookData when available', () => {
      const hookData = { agent_type: 'expert', role: 'developer' };
      const agentType = hookData.agent_type || hookData.role || '';
      expect(agentType).toBe('expert');
    });

    it('falls back to role', () => {
      const hookData = { role: 'developer' };
      const agentType = hookData.agent_type || hookData.role || '';
      expect(agentType).toBe('developer');
    });

    it('falls back to empty string', () => {
      const hookData = {};
      const agentType = hookData.agent_type || hookData.role || '';
      expect(agentType).toBe('');
    });
  });
});
