/**
 * Unit tests for lib/autopilot/engine-cleanup.js — worktree lifecycle helpers
 * extracted from engine.js (F2 refactor, no behavior change).
 *
 * Covers the non-git branches: attemptCreateWorktree opt-out, and
 * listActiveWorktrees normalization/error tolerance. Full git-backed
 * create/reap paths remain covered by engine.execute-worktree.test.js.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  attemptCreateWorktree,
  listActiveWorktrees,
  reapSessionArtifacts,
} from '../../lib/autopilot/engine-cleanup.js';
import { deleteSessionArtifacts } from '../../lib/autopilot/session-store.js';

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

describe('reapSessionArtifacts', () => {
  // ISOLATION: worktreeCwd points at a NON-git temp dir so the orphan sweep
  // can never touch the operator's real checkout (pruneOrphans early-returns).
  it('returns a report and never throws when there is no session worktree', () => {
    const sessionId = `ap-cleanup-unit-${process.pid}-${Date.now()}`;
    const nonGit = mkdtempSync(path.join(os.tmpdir(), 'artibot-cleanup-unit-'));
    try {
      const state = { sessionId, worktreePath: null, options: { worktreeCwd: nonGit } };
      let report;
      expect(() => { report = reapSessionArtifacts(state, { force: true }); }).not.toThrow();
      expect(report).toBeTruthy();
      expect(typeof report.at).toBe('string');
      expect(report.session).toBeNull();
      expect(state.cleanupReport).toBe(report);
      expect(state.resultHead).toBeNull();
    } finally {
      try { deleteSessionArtifacts(sessionId); } catch { /* ignore */ }
      rmSync(nonGit, { recursive: true, force: true });
    }
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
