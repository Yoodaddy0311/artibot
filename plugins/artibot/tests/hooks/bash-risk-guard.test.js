/**
 * Unit tests for scripts/hooks/bash-risk-guard.js — the PreToolUse Bash risk
 * guard that wires lib/autopilot/safety.js#classifyRisk into runtime.
 *
 * main() is guarded by isMainEntry(), so importing the module here does NOT
 * consume stdin — the exported pure functions can be exercised directly.
 */
import { describe, expect, it } from 'vitest';
import { evaluateBashRisk, findActiveSession } from '../../scripts/hooks/bash-risk-guard.js';

describe('evaluateBashRisk', () => {
  it('blocks a danger command (git push --force)', () => {
    const r = evaluateBashRisk({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
    expect(r).not.toBeNull();
    expect(r.decision).toBe('block');
    expect(r.matchedId).toBe('git-force-push');
    expect(r.reason).toContain('Dangerous command blocked');
  });

  it('blocks another danger command (rm -rf *)', () => {
    const r = evaluateBashRisk({ tool_name: 'Bash', tool_input: { command: 'rm -rf *' } });
    expect(r.decision).toBe('block');
    expect(r.matchedId).toBe('rm-rf-broad');
  });

  it('warns (non-blocking) on a caution command (curl external)', () => {
    const r = evaluateBashRisk({ tool_name: 'Bash', tool_input: { command: 'curl https://api.example.com/data' } });
    expect(r).not.toBeNull();
    expect(r.decision).toBeUndefined();
    expect(r.message).toContain('Caution');
    expect(r.message).toContain('curl-external');
  });

  it('stays silent (approve) on a safe command', () => {
    const r = evaluateBashRisk({ tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' } });
    expect(r).toBeNull();
  });

  it('passes through non-Bash tools untouched', () => {
    const r = evaluateBashRisk({ tool_name: 'Write', tool_input: { command: 'rm -rf *' } });
    expect(r).toBeNull();
  });

  it('stays silent when the Bash command is empty', () => {
    expect(evaluateBashRisk({ tool_name: 'Bash', tool_input: {} })).toBeNull();
    expect(evaluateBashRisk({ tool_name: 'Bash' })).toBeNull();
  });

  it('never throws on malformed payloads (fail-open at the pure layer)', () => {
    expect(() => evaluateBashRisk(null)).not.toThrow();
    expect(() => evaluateBashRisk({})).not.toThrow();
    expect(() => evaluateBashRisk({ tool_name: 'Bash', tool_input: null })).not.toThrow();
    expect(evaluateBashRisk(null)).toBeNull();
  });

  it('truncates very long commands in the block reason', () => {
    const long = `git push --force ${'x'.repeat(500)}`;
    const r = evaluateBashRisk({ tool_name: 'Bash', tool_input: { command: long } });
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('…');
  });
});

describe('findActiveSession', () => {
  const makeStore = (sessions, mtimes = {}) => ({
    listSessions: () => Object.keys(sessions),
    loadSession: (id) => sessions[id],
    getSessionPath: (id) => `/store/${id}.json`,
    _mtimes: mtimes,
  });
  const makeFs = (mtimes) => ({
    statSync: (p) => {
      const id = p.replace('/store/', '').replace('.json', '');
      if (!(id in mtimes)) throw new Error('ENOENT');
      return { mtimeMs: mtimes[id] };
    },
  });

  it('returns the most-recently-modified active session', () => {
    const store = makeStore({
      a: { phase: 'EXECUTE' },
      b: { phase: 'VERIFY' },
    });
    const fs = makeFs({ a: 100, b: 200 });
    expect(findActiveSession(store, fs)).toBe(store.loadSession('b'));
  });

  it('skips terminal/paused sessions', () => {
    const store = makeStore({
      done: { phase: 'COMPLETED' },
      aborted: { phase: 'ABORTED' },
      paused: { phase: 'PAUSED' },
    });
    const fs = makeFs({ done: 300, aborted: 200, paused: 100 });
    expect(findActiveSession(store, fs)).toBeNull();
  });

  it('returns null when there are no sessions', () => {
    expect(findActiveSession(makeStore({}), makeFs({}))).toBeNull();
  });

  it('tolerates statSync errors (treats mtime as 0)', () => {
    const store = makeStore({ a: { phase: 'EXECUTE' } });
    const fs = makeFs({}); // statSync always throws
    expect(findActiveSession(store, fs)).toBe(store.loadSession('a'));
  });

  it('ignores sessions with no phase', () => {
    const store = makeStore({ a: {}, b: { phase: 'PLAN' } });
    const fs = makeFs({ a: 500, b: 100 });
    expect(findActiveSession(store, fs)).toBe(store.loadSession('b'));
  });
});
