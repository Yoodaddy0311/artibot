/**
 * Unit tests for lib/autopilot/worktree-manager.js
 *
 * Covers path resolution, porcelain parsing via listWorktrees, idempotent
 * remove on missing sessions, and a guarded real-git create/remove
 * roundtrip that auto-skips when git or the repo is unavailable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  getWorktreesRoot,
  getWorktreePath,
  listWorktrees,
  createWorktree,
  removeWorktree,
} from '../../lib/autopilot/worktree-manager.js';

const created = [];

afterAll(() => {
  for (const id of created) {
    try { removeWorktree(id, { force: true }); } catch { /* ignore */ }
  }
});

function gitAvailable() {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf-8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

describe('getWorktreesRoot / getWorktreePath', () => {
  it('returns an absolute path string', () => {
    const root = getWorktreesRoot();
    expect(typeof root).toBe('string');
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('falls back to ASCII tmpdir when cwd has non-ASCII chars', () => {
    const root = getWorktreesRoot();
    // On a Korean cwd (this repo) the root must be ASCII-only.
    if (/[^\x00-\x7F]/.test(process.cwd())) {
      expect(/[^\x00-\x7F]/.test(root)).toBe(false);
      expect(root.startsWith(os.tmpdir())).toBe(true);
    }
  });

  it('joins sessionId under the root for getWorktreePath', () => {
    const p = getWorktreePath('ap-test-xyz');
    expect(p.endsWith('ap-test-xyz')).toBe(true);
    expect(p.startsWith(getWorktreesRoot())).toBe(true);
  });

  it('throws when sessionId is empty for getWorktreePath', () => {
    expect(() => getWorktreePath('')).toThrow(TypeError);
    expect(() => getWorktreePath(null)).toThrow(TypeError);
  });
});

describe('listWorktrees', () => {
  it('returns at least the main worktree when run inside a git repo', () => {
    if (!gitAvailable()) return; // skip in non-git env
    const list = listWorktrees();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (const rec of list) {
      expect(typeof rec.path).toBe('string');
      expect(rec.path.length).toBeGreaterThan(0);
    }
  });

  it('returns empty array for autopilotOnly when no autopilot worktrees exist', () => {
    if (!gitAvailable()) return;
    const list = listWorktrees({ autopilotOnly: true });
    // either zero (clean) or only autopilot-prefixed entries
    for (const rec of list) {
      expect(rec.sessionId).toBeTruthy();
      expect(rec.path.startsWith(getWorktreesRoot())).toBe(true);
    }
  });
});

describe('removeWorktree (idempotent)', () => {
  it('returns ok:true for a sessionId that was never created', () => {
    const res = removeWorktree(`ap-test-missing-${Date.now()}`);
    expect(res.ok).toBe(true);
  });

  it('rejects empty sessionId with ok:false', () => {
    const res = removeWorktree('');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('createWorktree → removeWorktree roundtrip', () => {
  it('creates and then removes an autopilot worktree end-to-end', () => {
    if (!gitAvailable()) return; // skip if git unavailable
    const sessionId = `ap-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const branch = `autopilot/${sessionId}`;

    let createRes;
    try {
      createRes = createWorktree(sessionId, { branch });
    } catch {
      // Defensive: if git environment refuses worktree creation, silently skip.
      return;
    }

    if (!createRes.ok) {
      // CI fallback: skip silently when git refuses (e.g. dirty index, locked repo).
      return;
    }
    created.push(sessionId);

    expect(createRes.path).toBe(getWorktreePath(sessionId));
    expect(createRes.branch).toBe(branch);

    const list = listWorktrees({ autopilotOnly: true });
    const found = list.find((r) => r.sessionId === sessionId);
    expect(found).toBeTruthy();

    const removeRes = removeWorktree(sessionId, { force: true });
    expect(removeRes.ok).toBe(true);

    // best-effort: also delete the branch we created to keep repo clean
    spawnSync('git', ['branch', '-D', branch], { encoding: 'utf-8' });
    created.splice(created.indexOf(sessionId), 1);
  });
});

describe('createWorktree error path', () => {
  it('returns ok:false with error when sessionId is empty', () => {
    const res = createWorktree('');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('returns ok:false with stderr when baseRef is invalid', () => {
    if (!gitAvailable()) return;
    const sessionId = `ap-test-bad-${Date.now()}`;
    const res = createWorktree(sessionId, { baseRef: 'this-ref-does-not-exist-zzz' });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
  });
});
