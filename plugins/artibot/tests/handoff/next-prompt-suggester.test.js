/**
 * Tests for lib/handoff/next-prompt-suggester.js
 */

import { describe, expect, it } from 'vitest';

import { suggestFirstPrompts } from '../../lib/handoff/next-prompt-suggester.js';

describe('next-prompt-suggester / suggestFirstPrompts', () => {
  it('promotes an in_progress task to P0', () => {
    const out = suggestFirstPrompts({
      tasks: [
        { id: 't1', subject: 'finish handoff module', status: 'in_progress' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe('P0');
    expect(out[0].prompt).toBe('/team P0 finish handoff module');
    expect(out[0].rationale).toContain('진행 중');
  });

  it('detects PR #N pattern in recent commits and emits a P0 prompt', () => {
    const out = suggestFirstPrompts({
      recentCommits: [
        { hash: 'abc1234', subject: 'feat: foo (PR #42)' },
        { hash: 'def5678', subject: 'chore: misc' },
      ],
    });
    const prItem = out.find((p) => p.prompt.includes('PR #42'));
    expect(prItem).toBeDefined();
    expect(prItem.priority).toBe('P0');
    expect(prItem.prompt).toBe('/team P0 PR #42 리뷰 응답');
  });

  it('caps output at max=3 even when more signals exist', () => {
    const out = suggestFirstPrompts(
      {
        tasks: [
          { id: 't1', subject: 's1', status: 'in_progress' },
          { id: 't2', subject: 's2', status: 'in_progress' },
          { id: 't3', subject: 's3', status: 'pending' },
          { id: 't4', subject: 's4', status: 'pending' },
        ],
        wip: { count: 50, oldestAgeMs: 5 * 60 * 60 * 1000 },
        gitStatus: { untracked: 99 },
      },
      { max: 3 },
    );
    expect(out).toHaveLength(3);
  });

  it('returns empty array when no signals match', () => {
    const out = suggestFirstPrompts({
      tasks: [{ id: 't1', subject: 's', status: 'completed' }],
      wip: { count: 0, oldestAgeMs: 0 },
      gitStatus: { untracked: 0 },
      recentCommits: [{ hash: 'a', subject: 'no PR here' }],
    });
    expect(out).toEqual([]);
  });

  it('preserves input order when priority ties (stable sort)', () => {
    const out = suggestFirstPrompts({
      tasks: [
        { id: 'A', subject: 'alpha', status: 'in_progress' },
        { id: 'B', subject: 'beta', status: 'in_progress' },
        { id: 'C', subject: 'gamma', status: 'in_progress' },
      ],
    });
    expect(out.map((p) => p.prompt)).toEqual([
      '/team P0 alpha',
      '/team P0 beta',
      '/team P0 gamma',
    ]);
  });
});
