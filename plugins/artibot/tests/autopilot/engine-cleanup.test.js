/**
 * Unit tests for lib/autopilot/engine-cleanup.js — worktree lifecycle helpers
 * extracted from engine.js (F2 refactor, no behavior change).
 *
 * Covers the non-git branches: attemptCreateWorktree opt-out, and
 * listActiveWorktrees normalization/error tolerance. Full git-backed
 * create/reap paths remain covered by engine.execute-worktree.test.js.
 */

import { describe, expect, it } from 'vitest';
import {
  attemptCreateWorktree,
  listActiveWorktrees,
} from '../../lib/autopilot/engine-cleanup.js';

describe('attemptCreateWorktree', () => {
  it('returns null and mutates nothing when useWorktree is unset', () => {
    const state = { sessionId: 's1', options: {} };
    expect(attemptCreateWorktree(state)).toBeNull();
    expect(state.worktreePath).toBeUndefined();
  });

  it('returns null when options is absent', () => {
    const state = { sessionId: 's2' };
    expect(attemptCreateWorktree(state)).toBeNull();
  });
});

describe('listActiveWorktrees', () => {
  it('returns an array (empty or normalized) and never throws', () => {
    const result = listActiveWorktrees();
    expect(Array.isArray(result)).toBe(true);
    for (const t of result) {
      expect(t).toHaveProperty('path');
      expect(t).toHaveProperty('branch');
      expect(t).toHaveProperty('sessionId');
    }
  });
});
