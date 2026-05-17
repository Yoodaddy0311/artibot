/**
 * Unit tests for lib/autopilot/phase-diff.js
 *
 * Covers:
 *   - empty checkpoints / missing session → empty summary, no throw
 *   - DI gitRunner numstat parsing → per-phase aggregation
 *   - binary file (`-\t-\tpath`) → 0/0 counted
 *   - topFiles cap = 5, sorted by (ins+del) desc
 *   - git failure on a single phase → entry omitted, other phases unaffected
 *   - renderDiffTable GFM shape (header columns + separator) + Total footer
 *   - empty summary → "no diff" stub
 *   - malformed checkpoint (missing sha/phase) → safe skip
 *   - invalid sessionId (non-string) → safe empty
 *   - first-phase-only (single SHA) → no pair, no rows
 */
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { deleteSession, saveSession } from '../../lib/autopilot/session-store.js';
import {
  diffSession,
  renderDiffTable,
} from '../../lib/autopilot/phase-diff.js';

const createdSessions = [];

function uniqueSessionId(label) {
  const id = `ap-test-phasediff-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdSessions.push(id);
  return id;
}

function saveState(sessionId, partial) {
  saveSession({
    sessionId,
    phase: 'COMPLETED',
    mode: 'default',
    createdAt: '2026-05-17T00:00:00.000Z',
    ...partial,
  });
}

afterEach(() => {
  while (createdSessions.length) {
    const id = createdSessions.pop();
    try { deleteSession(id); } catch { /* ignore */ }
  }
});

describe('diffSession — missing or invalid input', () => {
  it('returns empty summary for a session that does not exist', () => {
    const id = `ap-test-phasediff-missing-${Date.now()}`;
    const out = diffSession(id, { gitRunner: () => '' });
    expect(out.sessionId).toBe(id);
    expect(out.phases).toEqual([]);
    expect(out.totalFilesChanged).toBe(0);
    expect(out.totalInsertions).toBe(0);
    expect(out.totalDeletions).toBe(0);
  });

  it('returns safe empty result on empty sessionId without throwing', () => {
    expect(() => diffSession('')).not.toThrow();
    const out = diffSession('');
    expect(out.phases).toEqual([]);
  });

  it('returns safe empty result on non-string sessionId', () => {
    // @ts-expect-error testing non-string path
    const out = diffSession(null);
    expect(out.phases).toEqual([]);
    expect(out.totalFilesChanged).toBe(0);
  });

  it('returns empty when checkpoints array is empty', () => {
    const id = uniqueSessionId('empty-cps');
    saveState(id, { checkpoints: [] });
    const out = diffSession(id, { gitRunner: () => '' });
    expect(out.phases).toEqual([]);
  });

  it('skips malformed checkpoints (missing sha or phase) safely', () => {
    const id = uniqueSessionId('malformed-cp');
    saveState(id, {
      checkpoints: [
        { phase: 'EXECUTE' }, // no sha
        { sha: 'abc123' }, // no phase
        { phase: 'IMPROVE', sha: '' }, // empty sha
        { phase: null, sha: 'def456' }, // null phase
      ],
    });
    const out = diffSession(id, { gitRunner: () => 'should not be called' });
    expect(out.phases).toEqual([]);
  });

  it('returns no rows when only a single phase has a SHA (no pair possible)', () => {
    const id = uniqueSessionId('single-sha');
    saveState(id, {
      checkpoints: [{ phase: 'EXECUTE', sha: 'aaaa1111' }],
    });
    const gitRunner = vi.fn(() => '');
    const out = diffSession(id, { gitRunner });
    expect(out.phases).toEqual([]);
    expect(gitRunner).not.toHaveBeenCalled();
  });
});

describe('diffSession — DI gitRunner aggregation', () => {
  it('aggregates per-phase numstat across two phases', () => {
    const id = uniqueSessionId('two-phase');
    saveState(id, {
      checkpoints: [
        { phase: 'PLAN', sha: 'sha-plan' },
        { phase: 'EXECUTE', sha: 'sha-execute' },
        { phase: 'IMPROVE', sha: 'sha-improve' },
      ],
    });
    const gitRunner = vi.fn((args) => {
      const [, , from, to] = args;
      if (from === 'sha-plan' && to === 'sha-execute') {
        return '10\t2\tsrc/a.js\n5\t1\tsrc/b.js\n';
      }
      if (from === 'sha-execute' && to === 'sha-improve') {
        return '3\t0\tsrc/c.js\n';
      }
      return '';
    });
    const out = diffSession(id, { gitRunner });
    expect(out.phases).toHaveLength(2);
    const ex = out.phases.find((p) => p.phase === 'EXECUTE');
    expect(ex.filesChanged).toBe(2);
    expect(ex.insertions).toBe(15);
    expect(ex.deletions).toBe(3);
    expect(ex.fromSha).toBe('sha-plan');
    expect(ex.toSha).toBe('sha-execute');
    const im = out.phases.find((p) => p.phase === 'IMPROVE');
    expect(im.filesChanged).toBe(1);
    expect(im.insertions).toBe(3);
    expect(im.deletions).toBe(0);
    expect(out.totalFilesChanged).toBe(3);
    expect(out.totalInsertions).toBe(18);
    expect(out.totalDeletions).toBe(3);
  });

  it('treats binary files (`-\\t-\\tpath`) as 0/0 changes', () => {
    const id = uniqueSessionId('binary');
    saveState(id, {
      checkpoints: [
        { phase: 'PLAN', sha: 's1' },
        { phase: 'EXECUTE', sha: 's2' },
      ],
    });
    const out = diffSession(id, {
      gitRunner: () => '12\t3\tsrc/a.js\n-\t-\tdocs/screenshot.png\n',
    });
    expect(out.phases).toHaveLength(1);
    const ex = out.phases[0];
    expect(ex.filesChanged).toBe(2);
    expect(ex.insertions).toBe(12);
    expect(ex.deletions).toBe(3);
    const binEntry = ex.topFiles.find((f) => f.path === 'docs/screenshot.png');
    expect(binEntry).toBeDefined();
    expect(binEntry.insertions).toBe(0);
    expect(binEntry.deletions).toBe(0);
  });

  it('caps topFiles at 5 and sorts by (ins+del) descending', () => {
    const id = uniqueSessionId('top5');
    saveState(id, {
      checkpoints: [
        { phase: 'PLAN', sha: 's1' },
        { phase: 'EXECUTE', sha: 's2' },
      ],
    });
    const lines = [
      '1\t0\tfile1.js', // 1
      '50\t10\tfile2.js', // 60
      '5\t5\tfile3.js', // 10
      '20\t0\tfile4.js', // 20
      '3\t3\tfile5.js', // 6
      '100\t0\tfile6.js', // 100
      '2\t0\tfile7.js', // 2
    ].join('\n');
    const out = diffSession(id, { gitRunner: () => `${lines}\n` });
    const ex = out.phases[0];
    expect(ex.filesChanged).toBe(7);
    expect(ex.topFiles).toHaveLength(5);
    expect(ex.topFiles.map((f) => f.path)).toEqual([
      'file6.js', 'file2.js', 'file4.js', 'file3.js', 'file5.js',
    ]);
  });

  it('omits a phase whose git diff fails and keeps other phases', () => {
    const id = uniqueSessionId('git-fail');
    saveState(id, {
      checkpoints: [
        { phase: 'PLAN', sha: 's1' },
        { phase: 'EXECUTE', sha: 's2' },
        { phase: 'IMPROVE', sha: 's3' },
      ],
    });
    const gitRunner = vi.fn((args) => {
      const [, , from] = args;
      if (from === 's1') throw new Error('git boom');
      return '4\t1\tsrc/x.js\n';
    });
    const out = diffSession(id, { gitRunner });
    expect(out.phases).toHaveLength(1);
    expect(out.phases[0].phase).toBe('IMPROVE');
    expect(out.totalFilesChanged).toBe(1);
  });

  it('omits a phase that produces zero changed files (filesChanged=0)', () => {
    const id = uniqueSessionId('no-change');
    saveState(id, {
      checkpoints: [
        { phase: 'PLAN', sha: 's1' },
        { phase: 'EXECUTE', sha: 's2' },
      ],
    });
    const out = diffSession(id, { gitRunner: () => '' });
    expect(out.phases).toEqual([]);
    expect(out.totalFilesChanged).toBe(0);
  });

  it('does not throw even when gitRunner always throws', () => {
    const id = uniqueSessionId('always-throw');
    saveState(id, {
      checkpoints: [
        { phase: 'PLAN', sha: 's1' },
        { phase: 'EXECUTE', sha: 's2' },
      ],
    });
    const gitRunner = () => { throw new Error('git unavailable'); };
    expect(() => diffSession(id, { gitRunner })).not.toThrow();
    const out = diffSession(id, { gitRunner });
    expect(out.phases).toEqual([]);
  });

  it('accepts an injected state via opts.state without disk load', () => {
    const state = {
      sessionId: 'inline-state',
      checkpoints: [
        { phase: 'PLAN', sha: 's1' },
        { phase: 'EXECUTE', sha: 's2' },
      ],
    };
    const out = diffSession('inline-state', {
      state,
      gitRunner: () => '7\t2\tsrc/inline.js\n',
    });
    expect(out.phases).toHaveLength(1);
    expect(out.phases[0].insertions).toBe(7);
    expect(out.phases[0].deletions).toBe(2);
  });
});

describe('renderDiffTable — GFM output', () => {
  it('produces a valid markdown table with 6-pipe header (5 columns)', () => {
    const summary = {
      sessionId: 'x',
      phases: [
        {
          phase: 'EXECUTE',
          fromSha: 's1',
          toSha: 's2',
          filesChanged: 2,
          insertions: 15,
          deletions: 3,
          topFiles: [
            { path: 'src/a.js', insertions: 10, deletions: 2 },
            { path: 'src/b.js', insertions: 5, deletions: 1 },
          ],
        },
      ],
      totalFilesChanged: 2,
      totalInsertions: 15,
      totalDeletions: 3,
    };
    const md = renderDiffTable(summary);
    expect(md).toContain('## Phase Diff');
    const header = md.split('\n').find((l) => l.startsWith('| Phase |'));
    expect(header).toBeDefined();
    // 5 columns → 6 pipes
    expect((header.match(/\|/g) || []).length).toBe(6);
    expect(md).toMatch(/\|---\|/);
    expect(md).toContain('src/a.js (+10/-2)');
    expect(md).toContain('**Total**: 2 files, +15 / -3');
  });

  it('returns a "no diff" stub when summary has zero phases', () => {
    const md = renderDiffTable({
      sessionId: 'x', phases: [], totalFilesChanged: 0, totalInsertions: 0, totalDeletions: 0,
    });
    expect(md).toContain('## Phase Diff');
    expect(md).toMatch(/없음/);
  });

  it('returns a stub when summary is null or non-object', () => {
    // @ts-expect-error testing null path
    const md = renderDiffTable(null);
    expect(md).toContain('## Phase Diff');
    expect(md).toMatch(/없음/);
  });

  it('renders `-` for top changes when topFiles is empty', () => {
    const summary = {
      sessionId: 'x',
      phases: [{
        phase: 'PLAN', fromSha: 's1', toSha: 's2',
        filesChanged: 0, insertions: 0, deletions: 0, topFiles: [],
      }],
      totalFilesChanged: 0,
      totalInsertions: 0,
      totalDeletions: 0,
    };
    const md = renderDiffTable(summary);
    expect(md).toMatch(/\| PLAN \| 0 \| 0 \| 0 \| - \|/);
  });
});
