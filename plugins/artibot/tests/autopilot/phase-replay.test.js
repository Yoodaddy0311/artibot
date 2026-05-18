/**
 * Unit tests for lib/autopilot/phase-replay.js
 */
import { describe, expect, it, vi } from 'vitest';
import { replayPhase } from '../../lib/autopilot/phase-replay.js';

const baseState = {
  sessionId: 'ap-test-replay',
  schemaVersion: 2,
  checkpoints: [
    { phase: 'EXECUTE', sha: 'aaaa1', status: 'passed', ts: 't1' },
    { phase: 'VERIFY', sha: 'bbbb1', status: 'failed', ts: 't2' },
    { phase: 'EXECUTE', sha: 'cccc1', status: 'passed', ts: 't3' },
  ],
};

describe('replayPhase — guards', () => {
  it('rejects invalid sessionId', async () => {
    const out = await replayPhase('', 'EXECUTE', { phaseRunner: () => ({}) });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid-session-id');
  });

  it('rejects invalid phaseName', async () => {
    const out = await replayPhase('x', '', { phaseRunner: () => ({}) });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid-phase-name');
  });

  it('rejects missing phaseRunner', async () => {
    const out = await replayPhase('x', 'EXECUTE', { state: baseState });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('missing-phase-runner');
  });

  it('returns session-not-found when state unavailable', async () => {
    const out = await replayPhase('ap-nonexistent', 'EXECUTE', { phaseRunner: () => ({}) });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('session-not-found');
  });

  it('returns phase-not-in-checkpoints when phase missing', async () => {
    const out = await replayPhase('x', 'NEVER_RAN', {
      state: baseState,
      phaseRunner: () => ({}),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('phase-not-in-checkpoints');
  });
});

describe('replayPhase — execution', () => {
  it('picks the LATEST checkpoint for the phase as original', async () => {
    const phaseRunner = vi.fn(() => ({ status: 'passed', sha: 'cccc1' }));
    const out = await replayPhase('x', 'EXECUTE', { state: baseState, phaseRunner });
    expect(out.ok).toBe(true);
    expect(out.originalOutcome.sha).toBe('cccc1');
    expect(out.diff.shaMatch).toBe(true);
    expect(out.diff.statusMatch).toBe(true);
    expect(out.diff.divergedFields).toEqual([]);
  });

  it('flags divergence when replay status differs', async () => {
    const phaseRunner = () => ({ status: 'failed', sha: 'cccc1' });
    const out = await replayPhase('x', 'EXECUTE', { state: baseState, phaseRunner });
    expect(out.ok).toBe(true);
    expect(out.diff.statusMatch).toBe(false);
    expect(out.diff.divergedFields).toContain('status');
  });

  it('defaults to dryRun=true (commit not set)', async () => {
    const phaseRunner = vi.fn(() => ({ status: 'passed' }));
    const out = await replayPhase('x', 'EXECUTE', { state: baseState, phaseRunner });
    expect(out.dryRun).toBe(true);
    expect(phaseRunner.mock.calls[0][0].dryRun).toBe(true);
  });

  it('opts.commit=true flips dryRun off', async () => {
    const phaseRunner = vi.fn(() => ({ status: 'passed' }));
    const out = await replayPhase('x', 'EXECUTE', {
      state: baseState, phaseRunner, commit: true,
    });
    expect(out.dryRun).toBe(false);
    expect(phaseRunner.mock.calls[0][0].dryRun).toBe(false);
  });

  it('invokes worktree.cleanup after run (even on success)', async () => {
    const cleanup = vi.fn();
    const phaseRunner = () => ({ status: 'passed' });
    await replayPhase('x', 'EXECUTE', {
      state: baseState,
      phaseRunner,
      worktreeFactory: () => ({ cwd: '/tmp/wt', cleanup }),
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up worktree even when phaseRunner throws', async () => {
    const cleanup = vi.fn();
    const out = await replayPhase('x', 'EXECUTE', {
      state: baseState,
      worktreeFactory: () => ({ cwd: '/tmp/wt', cleanup }),
      phaseRunner: () => { throw new Error('boom'); },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/phase-runner-failed/);
  });
});
