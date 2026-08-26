/**
 * Firewall — `peerNotice` is advisory: it passes on EVERY path and has no
 * side effects.
 *
 * Why a gate for a check that "does nothing": preflight hard-fails abort an
 * autopilot start (`commands/autopilot.md` Step 1.5: "Hard fail = abort"). A
 * peer-awareness check that could fail or warn would turn the mere presence
 * of another Claude session — the normal state during `/split` — into a
 * start blocker, and a subagent context (where `ListAgents` does not exist at
 * all) into a permanent warning. The PRD therefore fixes it as "항상 pass".
 * This file makes that a property someone has to delete a test to change.
 *
 * `ListAgents` is a model-side tool, unreachable from node. The check's only
 * input is an injected `deps.listAgents` seam; with no seam it passes with
 * `peer-listing-unavailable`. Every branch below — no seam, seam returning
 * peers, seam returning garbage, seam throwing — must produce `status:'pass'`.
 *
 * Side effects are asserted structurally: the check may call `listAgents`
 * and nothing else. Every other seam in `deps` is a spy that must stay
 * uncalled, and `process.env` must be unchanged afterwards.
 *
 * WHAT THIS GATE DOES NOT SEE:
 *   - whether any caller wires a real `ListAgents` result into `deps.listAgents`
 *     (the markdown pre-flight prose is the consumer; prose ≠ execution);
 *   - filesystem writes made by code the check does not call — the assertion
 *     is "no other seam invoked", not an OS-level syscall trace;
 *   - the cwd-overlap heuristic's accuracy for peers in a linked worktree that
 *     lives OUTSIDE the repo directory (only containment is checked).
 */

import { describe, expect, it, vi } from 'vitest';
import { runIndividualCheck, runPreflight } from '../../lib/autopilot/preflight.js';

const ctx = { cwd: '/repo/main', featureKey: 'task-a', sessionId: 'sess-own' };

/** Every non-peer seam as a spy: any call is a side effect the check must not have. */
function otherSeams() {
  return {
    gitRunner: vi.fn(),
    statfs: vi.fn(),
    lockChecker: vi.fn(),
    telemetry: vi.fn(),
    resolveRepoIdentity: vi.fn(),
    listLocks: vi.fn(),
  };
}

function expectNoOtherSeamCalled(seams) {
  for (const [name, fn] of Object.entries(seams)) {
    expect(fn, `${name} must not be called by peerNotice`).not.toHaveBeenCalled();
  }
}

describe('peerNotice always passes', () => {
  it.each([
    ['no seam, no socket', { env: {} }],
    ['no seam, socket present', { env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock' } }],
    ['seam returns empty', { listAgents: () => [] }],
    ['seam returns overlapping peers', { listAgents: () => [{ name: 'limb-1', cwd: '/repo/main/.claude/worktrees/limb-1' }] }],
    ['seam returns non-array', { listAgents: () => ({ nope: true }) }],
    ['seam returns null entries', { listAgents: () => [null, undefined, 3, { cwd: null }] }],
    ['seam throws', { listAgents: () => { throw new Error('ListAgents unavailable'); } }],
    ['seam is not a function', { listAgents: 'ListAgents' }],
  ])('%s → pass', (_label, deps) => {
    const seams = otherSeams();
    const r = runIndividualCheck('peerNotice', ctx, { ...seams, ...deps });
    expect(r.name).toBe('peerNotice');
    expect(r.status).toBe('pass');
    expect(typeof r.detail).toBe('string');
    expectNoOtherSeamCalled(seams);
  });

  it('passes even with an empty ctx and empty deps', () => {
    expect(runIndividualCheck('peerNotice', {}, {}).status).toBe('pass');
    expect(runIndividualCheck('peerNotice', undefined, undefined).status).toBe('pass');
  });
});

describe('peerNotice detail is informative but never load-bearing', () => {
  it('says the listing is unavailable when no seam is injected, and names the socket when present', () => {
    const without = runIndividualCheck('peerNotice', ctx, { env: {} });
    expect(without.detail).toBe('peer-listing-unavailable');
    const withSocket = runIndividualCheck('peerNotice', ctx, { env: { CLAUDE_CODE_MESSAGING_SOCKET: 'x' } });
    expect(withSocket.detail).toMatch(/^peer-listing-unavailable \(messaging socket present/);
  });

  it('counts overlapping peers (same / inside / containing cwd) and ignores the rest', () => {
    const listAgents = vi.fn(() => [
      { name: 'same', cwd: '/repo/main' },
      { name: 'inside', cwd: '/repo/main/.claude/worktrees/limb-1' },
      { name: 'parent', cwd: '/repo' },
      { name: 'sibling', cwd: '/repo/other' },
      { name: 'far', cwd: '/elsewhere' },
    ]);
    const r = runIndividualCheck('peerNotice', ctx, { listAgents });
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(r.detail).toContain('3 peer session(s)');
    expect(r.detail).toContain('same');
    expect(r.detail).toContain('inside');
    expect(r.detail).toContain('parent');
    expect(r.detail).not.toContain('sibling');
    expect(r.detail).not.toContain('far');
  });

  it('reports a throwing seam in the detail while still passing', () => {
    const r = runIndividualCheck('peerNotice', ctx, { listAgents: () => { throw new Error('boom'); } });
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('peer-listing-failed: boom');
  });
});

describe('peerNotice never reaches warnings/errors in runPreflight', () => {
  it('contributes neither a warning nor an error even when the seam throws', () => {
    const r = runPreflight(ctx, {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [],
      listAgents: () => { throw new Error('boom'); },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.find((w) => w.check === 'peerNotice')).toBeUndefined();
    expect(r.errors.find((e) => e.check === 'peerNotice')).toBeUndefined();
    expect(r.checks.find((c) => c.name === 'peerNotice')).toMatchObject({ status: 'pass' });
  });

  it('leaves process.env untouched', () => {
    const before = JSON.stringify(process.env);
    runIndividualCheck('peerNotice', ctx, {});
    runIndividualCheck('peerNotice', ctx, { listAgents: () => [{ cwd: '/repo/main' }] });
    expect(JSON.stringify(process.env)).toBe(before);
  });
});
