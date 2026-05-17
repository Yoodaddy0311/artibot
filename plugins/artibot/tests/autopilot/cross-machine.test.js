/**
 * Unit tests for lib/autopilot/cross-machine.js
 */
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import {
  computeMachineId,
  detectMachineDrift,
  prepareRebase,
  recordMachineId,
} from '../../lib/autopilot/cross-machine.js';

describe('computeMachineId', () => {
  it('returns hostname_username string', () => {
    const id = computeMachineId();
    expect(typeof id).toBe('string');
    expect(id).toContain('_');
  });

  it('sanitizes non-safe chars in hostname', () => {
    const spy = vi.spyOn(os, 'hostname').mockReturnValue('my host!');
    const userSpy = vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'alice' });
    const id = computeMachineId();
    expect(id).toBe('my_host__alice');
    spy.mockRestore();
    userSpy.mockRestore();
  });

  it('falls back to "unknown" when hostname throws', () => {
    const spy = vi.spyOn(os, 'hostname').mockImplementation(() => { throw new Error('x'); });
    const userSpy = vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'bob' });
    const id = computeMachineId();
    expect(id).toBe('unknown_bob');
    spy.mockRestore();
    userSpy.mockRestore();
  });
});

describe('recordMachineId', () => {
  it('stamps machineId on a state without one', () => {
    const next = recordMachineId({ sessionId: 'x' }, { machineId: 'host_user' });
    expect(next.machineId).toBe('host_user');
  });

  it('does not mutate input', () => {
    const state = { sessionId: 'x' };
    recordMachineId(state, { machineId: 'host_user' });
    expect(state.machineId).toBeUndefined();
  });

  it('preserves existing machineId by default', () => {
    const next = recordMachineId({ sessionId: 'x', machineId: 'old' }, { machineId: 'new' });
    expect(next.machineId).toBe('old');
  });

  it('overwrites with force=true', () => {
    const next = recordMachineId(
      { sessionId: 'x', machineId: 'old' },
      { machineId: 'new', force: true },
    );
    expect(next.machineId).toBe('new');
  });

  it('throws TypeError on non-object input', () => {
    expect(() => recordMachineId(null)).toThrow(TypeError);
  });

  it('uses computeMachineId when machineId opt omitted', () => {
    const next = recordMachineId({ sessionId: 'x' });
    expect(typeof next.machineId).toBe('string');
    expect(next.machineId.length).toBeGreaterThan(0);
  });
});

describe('detectMachineDrift', () => {
  it('returns needsRebase=false when machineId matches', () => {
    const out = detectMachineDrift({ machineId: 'host_user' }, { machineId: 'host_user' });
    expect(out.needsRebase).toBe(false);
    expect(out.driftedFrom).toBeNull();
    expect(out.hasPriorMachine).toBe(true);
  });

  it('returns needsRebase=true when machineId differs', () => {
    const out = detectMachineDrift({ machineId: 'pc-A_alice' }, { machineId: 'pc-B_alice' });
    expect(out.needsRebase).toBe(true);
    expect(out.driftedFrom).toBe('pc-A_alice');
    expect(out.currentMachine).toBe('pc-B_alice');
  });

  it('returns hasPriorMachine=false when state has no machineId', () => {
    const out = detectMachineDrift({ sessionId: 'x' }, { machineId: 'pc-B_alice' });
    expect(out.hasPriorMachine).toBe(false);
    expect(out.needsRebase).toBe(false);
  });

  it('handles null state safely', () => {
    const out = detectMachineDrift(null, { machineId: 'pc-A' });
    expect(out.needsRebase).toBe(false);
    expect(out.hasPriorMachine).toBe(false);
  });
});

describe('prepareRebase', () => {
  it('returns default fetch + rebase sequence for origin/main', () => {
    const seq = prepareRebase();
    expect(seq).toHaveLength(2);
    expect(seq[0]).toEqual({ cmd: 'git', args: ['fetch', 'origin', 'main'] });
    expect(seq[1]).toEqual({ cmd: 'git', args: ['rebase', 'origin/main'] });
  });

  it('honors custom baseBranch and remote', () => {
    const seq = prepareRebase({ baseBranch: 'develop', remote: 'upstream' });
    expect(seq[0].args).toEqual(['fetch', 'upstream', 'develop']);
    expect(seq[1].args).toEqual(['rebase', 'upstream/develop']);
  });

  it('rejects unsafe ref names', () => {
    expect(() => prepareRebase({ baseBranch: '--evil' })).toThrow(RangeError);
    expect(() => prepareRebase({ remote: '-x' })).toThrow(RangeError);
  });

  it('does NOT execute commands — pure planning', () => {
    const seq = prepareRebase();
    expect(seq.every((s) => s.cmd === 'git')).toBe(true);
    expect(seq.every((s) => Array.isArray(s.args))).toBe(true);
  });
});
