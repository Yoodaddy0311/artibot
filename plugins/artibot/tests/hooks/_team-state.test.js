import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock } from '../../lib/core/file-lock.js';
import { initTeamContext, loadState, saveState, updateTeamState } from '../../scripts/hooks/_team-state.js';

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
});
