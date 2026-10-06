import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock } from '../../lib/core/file-lock.js';
import {
  AGENT_MAX_ENTRIES,
  AGENT_RETENTION_MS,
  AGENT_STALE_ACTIVE_MS,
  initTeamContext,
  loadState,
  pruneAgents,
  saveState,
  updateTeamState,
} from '../../scripts/hooks/_team-state.js';

/**
 * The team-state helpers subagent-handler.js imports, against a real
 * filesystem and the real lock (no mocks). The hook-level consequence — a
 * contended lock still leaves the ledger lines written — is pinned end to end
 * by subagent-handler-lock-timeout.test.js; this file pins the helper's own
 * contract: which failures skip the update and which propagate.
 */
describe('_team-state', () => {
  let tmp;
  let statePath;
  let savedEnv;
  let stderr;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-team-state-')));
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    statePath = path.join(tmp, '.claude', 'artibot-state.json');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const stderrText = () => stderr.mock.calls.map((c) => String(c[0])).join('');

  describe('loadState / saveState', () => {
    it('returns an empty agent map when the file is missing or unparseable', () => {
      expect(loadState()).toEqual({ agents: {} });
      writeFileSync(statePath, 'not json{{', 'utf-8');
      expect(loadState()).toEqual({ agents: {} });
    });

    it('round-trips a state through the file under ~/.claude', () => {
      const state = { agents: { a: { active: true } }, teamId: 'team-x' };
      saveState(state);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual(state);
      expect(loadState()).toEqual(state);
    });
  });

  describe('updateTeamState', () => {
    it('runs mutate under the lock, releases it, and reports that it ran', () => {
      const mutate = vi.fn(() => {
        expect(existsSync(`${statePath}.lock`)).toBe(true);
        saveState({ agents: { a: {} } });
      });
      expect(updateTeamState(statePath, mutate)).toBe(true);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(existsSync(`${statePath}.lock`)).toBe(false);
      expect(loadState()).toEqual({ agents: { a: {} } });
      expect(stderrText()).toBe('');
    });

    it('skips mutate and returns false when the lock is not acquired (ELOCKREENTRANT)', () => {
      saveState({ agents: {}, marker: 1 });
      const before = readFileSync(statePath, 'utf-8');
      const mutate = vi.fn();
      const result = withFileLock(statePath, () => updateTeamState(statePath, mutate));
      expect(result).toBe(false);
      expect(mutate).not.toHaveBeenCalled();
      expect(readFileSync(statePath, 'utf-8')).toBe(before);
      expect(stderrText()).toContain('[artibot:subagent-handler] team state not updated: ');
      expect(stderrText()).toContain('re-entry refused');
    });

    it('skips mutate and returns false when the lock file cannot be created', () => {
      // A regular file where the state directory should be: the lock's mkdir fails.
      const blocker = path.join(tmp, 'blocker');
      writeFileSync(blocker, '', 'utf-8');
      const mutate = vi.fn();
      expect(updateTeamState(path.join(blocker, 'artibot-state.json'), mutate)).toBe(false);
      expect(mutate).not.toHaveBeenCalled();
      expect(stderrText()).toContain('[artibot:subagent-handler] team state not updated: ');
    });

    it('propagates an error thrown by mutate itself and still releases the lock', () => {
      const boom = new Error('mutate failed');
      expect(() => updateTeamState(statePath, () => { throw boom; })).toThrow(boom);
      expect(existsSync(`${statePath}.lock`)).toBe(false);
      expect(stderrText()).not.toContain('team state not updated');
    });
  });

  describe('initTeamContext', () => {
    it('keeps an existing teamId, domain and numeric startedAt', () => {
      const loaded = { teamId: 'team-old', domain: 'backend', startedAt: 123 };
      expect(initTeamContext(loaded, { session_id: 'sid', domain: 'x' }, 'role'))
        .toEqual({ teamId: 'team-old', domain: 'backend', startedAt: 123 });
    });

    it('derives missing fields and replaces a non-numeric startedAt', () => {
      const ctx = initTeamContext({ startedAt: '2026-01-01' }, { session_id: 'sid', agent_type: 'tdd-guide' }, 'role');
      expect(ctx.teamId).toBe('team-sid');
      expect(ctx.domain).toBe('tdd-guide');
      expect(typeof ctx.startedAt).toBe('number');
    });

    it('falls back from domain to agent_type to role to general', () => {
      expect(initTeamContext({}, { domain: 'd', agent_type: 't' }, 'r').domain).toBe('d');
      expect(initTeamContext({}, {}, 'r').domain).toBe('r');
      expect(initTeamContext({}, null, undefined).domain).toBe('general');
      expect(initTeamContext({}, null, undefined).teamId).toMatch(/^team-\d+$/);
    });
  });

  // The `agents` map is keyed by a per-spawn id and nothing removed a row, so the file
  // grew without bound (measured 2026-10-06: 1,666 rows / 453 KB five days after the
  // last wipe). Retention runs on the write path, so it is tested both as a pure
  // function (pinned clock) and through saveState (real file).
  describe('pruneAgents', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const NOW = Date.parse('2026-10-06T00:00:00.000Z');
    const ago = (ms) => new Date(NOW - ms).toISOString();
    // SubagentStop recorded: stoppedAt set, active flipped off by the stop handler.
    const stopped = (ms) => ({ role: 'teammate', active: false, startedAt: ago(ms + 1000), stoppedAt: ago(ms), updatedAt: ago(ms) });
    // TeammateIdle: inactive, but no stop was ever recorded.
    const idle = (ms) => ({ role: 'teammate', active: false, updatedAt: ago(ms) });
    // No stop recorded and still flagged active.
    const live = (ms) => ({ role: 'teammate', active: true, updatedAt: ago(ms) });
    const many = (count, make, prefix = 'agent') => Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`${prefix}-${i}`, make(i)]),
    );
    const ids = (state) => Object.keys(state.agents).sort();
    const deepFreeze = (value) => {
      for (const inner of Object.values(value)) {
        if (inner && typeof inner === 'object') deepFreeze(inner);
      }
      return Object.freeze(value);
    };

    describe('inactive agents (retention window)', () => {
      it('drops a stopped agent whose last activity is older than the retention window', () => {
        const state = { agents: { old: stopped(AGENT_RETENTION_MS + 1), recent: stopped(AGENT_RETENTION_MS - 60_000) } };
        expect(ids(pruneAgents(state, NOW))).toEqual(['recent']);
      });

      it('drops an idle agent that has no stoppedAt once it is past the window', () => {
        const state = { agents: { old: idle(AGENT_RETENTION_MS + 1), recent: idle(60_000) } };
        expect(ids(pruneAgents(state, NOW))).toEqual(['recent']);
      });

      it('keeps an inactive agent that is exactly as old as the window', () => {
        const state = { agents: { edge: stopped(AGENT_RETENTION_MS) } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('counts stoppedAt as inactive even when a later teammate-update flipped active back on', () => {
        // Until workflow-status recorded SubagentStop as inactive, its teammate-update ran beside
        // the stop handler and wrote active:true over it. 126 of the 142 stopped rows in the live
        // file (2026-10-06) look like this, and rows already on disk keep that shape.
        const reactivated = (ms) => ({ role: 'teammate', active: true, stoppedAt: ago(ms), updatedAt: ago(ms) });
        const state = { agents: { kept: reactivated(2 * DAY_MS), gone: reactivated(AGENT_RETENTION_MS + 1) } };
        expect(ids(pruneAgents(state, NOW))).toEqual(['kept']);
      });

      it('takes the newest of updatedAt, stoppedAt and startedAt as the last activity', () => {
        const state = {
          agents: {
            stoppedJustNow: { active: false, startedAt: ago(10 * DAY_MS), updatedAt: ago(10 * DAY_MS), stoppedAt: ago(60_000) },
            updatedJustNow: { active: false, startedAt: ago(10 * DAY_MS), stoppedAt: ago(10 * DAY_MS), updatedAt: ago(60_000) },
            allOld: { active: false, startedAt: ago(10 * DAY_MS), stoppedAt: ago(10 * DAY_MS), updatedAt: ago(10 * DAY_MS) },
          },
        };
        expect(ids(pruneAgents(state, NOW))).toEqual(['stoppedJustNow', 'updatedJustNow']);
      });
    });

    // The ghost rule is kept apart from the finished-row rules so it can be dropped on its own:
    // AGENT_STALE_ACTIVE_MS, isGhost() and this block (plus the one ghost test per writer).
    describe('ghosts (active, no stoppedAt, silent past the stale window)', () => {
      // `live` has no startedAt: a row only workflow-status ever wrote. `registered` is a row
      // subagent-handler stamped at SubagentStart, which handleStop reads back at the stop.
      const registered = (ms) => ({ ...live(ms), agentType: 'tdd-guide', startedAt: ago(ms) });

      it('keeps an active agent that was touched inside the stale window', () => {
        const state = { agents: { running: live(AGENT_STALE_ACTIVE_MS), fresh: live(60_000) } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('drops an active agent with no recorded stop once it has been silent past the stale window', () => {
        // 1,524 of the 1,666 live rows were active:true with no stoppedAt, 701 of them untouched
        // for 72h+ (2026-10-06): without this rule they sit in the file forever.
        const state = { agents: { ghost: live(AGENT_STALE_ACTIVE_MS + 1), fresh: live(60_000) } };
        expect(ids(pruneAgents(state, NOW))).toEqual(['fresh']);
      });

      it('treats a row with no active flag and no stoppedAt as active', () => {
        const state = { agents: { bare: { role: 'planner', updatedAt: ago(AGENT_STALE_ACTIVE_MS + 1) } } };
        expect(pruneAgents(state, NOW).agents).toEqual({});
      });

      it('keeps a row registered at SubagentStart past the stale window, since the stop handler reads it back', () => {
        // handleStop takes startedAt/agentType/canonicalModel from this row, and a named reviewer's
        // stop is recorded as a review only when `tracked.startedAt` is there (_review-stop-record.js).
        const state = { agents: { registered: registered(2 * DAY_MS) } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('drops a registered row once it has been silent past the retention window', () => {
        const state = {
          agents: { gone: registered(AGENT_RETENTION_MS + 1), kept: registered(AGENT_RETENTION_MS - 60_000) },
        };
        expect(ids(pruneAgents(state, NOW))).toEqual(['kept']);
      });

      it('applies the ghost rule before the cap so a ghost does not cost a stopped agent its slot', () => {
        const state = {
          agents: {
            ...many(AGENT_MAX_ENTRIES, (i) => stopped(60_000 * (i + 1))),
            ghost: live(AGENT_STALE_ACTIVE_MS + 1),
          },
        };
        const pruned = pruneAgents(state, NOW);
        // Cap first would see 501 rows, cannot drop the (active) ghost, and so drop the oldest
        // stopped agent; the ghost rule first removes the ghost and leaves the map at the cap.
        expect(Object.keys(pruned.agents)).toHaveLength(AGENT_MAX_ENTRIES);
        expect(pruned.agents).not.toHaveProperty('ghost');
        expect(pruned.agents).toHaveProperty(`agent-${AGENT_MAX_ENTRIES - 1}`);
      });
    });

    describe('unknown age (unknown is not old)', () => {
      it('keeps an agent whose timestamp does not parse', () => {
        const state = {
          agents: {
            inactive: { active: false, updatedAt: 'not-a-date' },
            ghost: { active: true, updatedAt: 'not-a-date' },
          },
        };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      // V8's Date.parse takes far more than ISO-8601 ('1' is the year 2001), so a hand-edited or
      // foreign stamp could read as ancient. Only an ISO-8601 date-time with a time and a Z or
      // offset is trusted to place a row in time; every writer here emits toISOString().
      it.each([
        ['a bare number string', '1'],
        ['a year only', '2020'],
        ['a date without a time', '2020-01-01'],
        ['a space instead of the T', '2020-01-01 00:00:00'],
        ['a month name', 'Oct 1 2020 00:00:00 GMT'],
        ['a time without a zone', '2020-01-01T00:00:00'],
        ['a field out of range', '2020-13-45T99:99:99Z'],
        ['a number', 1_577_836_800_000],
      ])('keeps an agent whose stamp is %s, which is not an ISO-8601 date-time', (_label, stamp) => {
        const state = { agents: { odd: { active: false, updatedAt: stamp } } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it.each([
        ['toISOString() output', '2020-01-01T00:00:00.000Z'],
        ['no fraction', '2020-01-01T00:00:00Z'],
        ['a longer fraction', '2020-01-01T00:00:00.123456Z'],
        ['an offset', '2020-01-01T09:00:00+09:00'],
      ])('still places a row in time by an ISO-8601 stamp with %s', (_label, stamp) => {
        const state = { agents: { old: { active: false, updatedAt: stamp } } };
        expect(pruneAgents(state, NOW).agents).toEqual({});
      });

      it('keeps an agent when any one of its stamps is unparseable, however old the others are', () => {
        const state = { agents: { mixed: { active: false, updatedAt: ago(30 * DAY_MS), stoppedAt: 'garbage' } } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('keeps an agent that carries no timestamp at all', () => {
        const state = { agents: { inactive: { active: false }, ghost: { active: true }, empty: {} } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('keeps an agent whose last activity is in the future (clock skew)', () => {
        const state = { agents: { skewed: { active: false, stoppedAt: ago(-AGENT_RETENTION_MS) } } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });
    });

    describe('count cap', () => {
      it('drops the oldest inactive agents first when the map is over the cap', () => {
        const state = { agents: many(AGENT_MAX_ENTRIES + 3, (i) => stopped(60_000 * (i + 1))) };
        const pruned = pruneAgents(state, NOW);
        expect(Object.keys(pruned.agents)).toHaveLength(AGENT_MAX_ENTRIES);
        // the larger the index, the older the agent
        for (const id of ['agent-500', 'agent-501', 'agent-502']) expect(pruned.agents).not.toHaveProperty(id);
        expect(pruned.agents).toHaveProperty('agent-0');
        expect(pruned.agents).toHaveProperty('agent-499');
      });

      it('never drops an active agent to get under the cap', () => {
        const state = {
          agents: {
            ...many(AGENT_MAX_ENTRIES, (i) => live(60_000 * (i + 1)), 'live'),
            ...many(5, (i) => stopped(60_000 * (i + 1)), 'done'),
          },
        };
        const pruned = pruneAgents(state, NOW);
        expect(Object.keys(pruned.agents)).toHaveLength(AGENT_MAX_ENTRIES);
        expect(Object.keys(pruned.agents).every((id) => id.startsWith('live-'))).toBe(true);
      });

      it('leaves the map above the cap when only active agents are left to drop', () => {
        const state = { agents: many(AGENT_MAX_ENTRIES + 20, (i) => live(60_000 * (i + 1))) };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('does not count an inactive agent of unknown age as old when it trims to the cap', () => {
        const state = {
          agents: {
            ...many(AGENT_MAX_ENTRIES, (i) => stopped(60_000 * (i + 1))),
            garbage: { active: false, updatedAt: 'not-a-date' },
            bare: { active: false },
          },
        };
        const pruned = pruneAgents(state, NOW);
        expect(Object.keys(pruned.agents)).toHaveLength(AGENT_MAX_ENTRIES);
        expect(pruned.agents).toHaveProperty('garbage');
        expect(pruned.agents).toHaveProperty('bare');
        expect(pruned.agents).not.toHaveProperty('agent-499');
        expect(pruned.agents).not.toHaveProperty('agent-498');
      });

      it('counts only the rows the retention window left, so an expired row does not cost another agent its slot', () => {
        const state = {
          agents: {
            ...many(AGENT_MAX_ENTRIES, (i) => stopped(60_000 * (i + 1))),
            ancient: stopped(AGENT_RETENTION_MS + 1),
          },
        };
        const pruned = pruneAgents(state, NOW);
        // 501 rows go in; `ancient` leaves by age, which already brings the map to the cap. A cap
        // that counted `ancient` as still there would drop one more stopped agent.
        expect(Object.keys(pruned.agents)).toHaveLength(AGENT_MAX_ENTRIES);
        expect(pruned.agents).not.toHaveProperty('ancient');
        expect(pruned.agents).toHaveProperty(`agent-${AGENT_MAX_ENTRIES - 1}`);
      });
    });

    describe('contract', () => {
      it('returns a new state and leaves the input untouched', () => {
        const state = deepFreeze({
          teamId: 'team-x',
          tasks: [{ id: '1' }],
          agents: { gone: stopped(AGENT_RETENTION_MS + 1), kept: live(60_000) },
        });
        const pruned = pruneAgents(state, NOW);
        expect(pruned).not.toBe(state);
        expect(pruned.agents).not.toBe(state.agents);
        expect(Object.keys(state.agents).sort()).toEqual(['gone', 'kept']);
        expect(ids(pruned)).toEqual(['kept']);
        expect(pruned.teamId).toBe('team-x');
        expect(pruned.tasks).toEqual([{ id: '1' }]);
      });

      it('returns the very same state when there is nothing to drop', () => {
        const state = { agents: { a: live(60_000), b: stopped(60_000) }, marker: 1 };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('defaults the clock to Date.now()', () => {
        const stamp = (ms) => new Date(Date.now() - ms).toISOString();
        const state = {
          agents: {
            gone: { active: false, stoppedAt: stamp(AGENT_RETENTION_MS + 60_000) },
            kept: { active: false, stoppedAt: stamp(60_000) },
          },
        };
        expect(ids(pruneAgents(state))).toEqual(['kept']);
      });

      it.each([[null], [undefined], [42], ['text'], [[]], [{}], [{ agents: null }], [{ agents: [] }], [{ agents: 'text' }]])(
        'returns %j as it came instead of throwing',
        (state) => {
          expect(() => pruneAgents(state, NOW)).not.toThrow();
          expect(pruneAgents(state, NOW)).toBe(state);
        },
      );

      it('keeps rows that are not objects', () => {
        const state = { agents: { nothing: null, text: 'x', num: 5, list: [] } };
        expect(pruneAgents(state, NOW)).toBe(state);
      });

      it('returns the state unchanged instead of throwing when the agent map cannot be read', () => {
        const agents = new Proxy({ a: live(60_000) }, { ownKeys() { throw new Error('boom'); } });
        const state = { agents, marker: 1 };
        expect(() => pruneAgents(state, NOW)).not.toThrow();
        expect(pruneAgents(state, NOW)).toBe(state);
      });
    });
  });

  describe('saveState agent retention', () => {
    const stamp = (ms) => new Date(Date.now() - ms).toISOString();

    it('drops retired agents from the file it writes and keeps the rest of the state', () => {
      saveState({
        teamId: 'team-x',
        agents: {
          gone: { role: 'teammate', active: false, stoppedAt: stamp(AGENT_RETENTION_MS + 60_000), updatedAt: stamp(AGENT_RETENTION_MS + 60_000) },
          stopped: { role: 'teammate', active: false, stoppedAt: stamp(60_000), updatedAt: stamp(60_000) },
          running: { role: 'teammate', active: true, updatedAt: stamp(60_000) },
        },
      });
      const written = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(Object.keys(written.agents).sort()).toEqual(['running', 'stopped']);
      expect(written.teamId).toBe('team-x');
    });

    it('drops a ghost from the file it writes', () => {
      saveState({
        agents: {
          ghost: { role: 'teammate', active: true, updatedAt: stamp(AGENT_STALE_ACTIVE_MS + 60_000) },
          running: { role: 'teammate', active: true, updatedAt: stamp(60_000) },
        },
      });
      expect(Object.keys(JSON.parse(readFileSync(statePath, 'utf-8')).agents)).toEqual(['running']);
    });

    it('does not mutate the state object it was given', () => {
      const state = { agents: { gone: { active: false, stoppedAt: stamp(AGENT_RETENTION_MS + 60_000) } } };
      saveState(state);
      expect(Object.keys(state.agents)).toEqual(['gone']);
    });

    it('still writes the state when pruning itself throws', () => {
      let enumerations = 0;
      const target = { fresh: { role: 'teammate', active: true, updatedAt: stamp(60_000) } };
      // The first enumeration is pruneAgents' own; the later ones are JSON serialization.
      const agents = new Proxy(target, {
        ownKeys(t) {
          if (enumerations++ === 0) throw new Error('prune blew up');
          return Reflect.ownKeys(t);
        },
      });
      expect(() => saveState({ agents, marker: 'kept' })).not.toThrow();
      expect(enumerations).toBeGreaterThan(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({ agents: target, marker: 'kept' });
    });
  });
});
