import { describe, expect, it } from 'vitest';
import {
  renderAutopilotProgress,
  renderProgressBar,
  renderTeamProgress,
} from '../../lib/utils/progress-renderer.js';

// ─────────────────────────────────────────────
// renderProgressBar
// ─────────────────────────────────────────────

describe('renderProgressBar', () => {
  it('returns all empty blocks at 0%', () => {
    const bar = renderProgressBar(0);
    expect(bar).toBe('░░░░░░░░░░░░░░░░');
    expect(bar.length).toBe(16);
  });

  it('returns half filled at 50%', () => {
    const bar = renderProgressBar(50);
    expect(bar).toBe('████████░░░░░░░░');
  });

  it('returns all filled at 100%', () => {
    const bar = renderProgressBar(100);
    expect(bar).toBe('████████████████');
  });

  it('clamps negative values to 0%', () => {
    expect(renderProgressBar(-10)).toBe('░░░░░░░░░░░░░░░░');
  });

  it('clamps values above 100 to 100%', () => {
    expect(renderProgressBar(150)).toBe('████████████████');
  });

  it('respects custom width', () => {
    const bar = renderProgressBar(50, 10);
    expect(bar).toBe('█████░░░░░');
    expect(bar.length).toBe(10);
  });

  it('uses only unicode block characters', () => {
    const bar = renderProgressBar(75);
    for (const ch of bar) {
      expect(['█', '░']).toContain(ch);
    }
  });

  it('shows at least one filled cell for a tiny non-zero percentage', () => {
    // 1% of 16 rounds to 0 cells without boundary correction.
    const bar = renderProgressBar(1);
    expect(bar.indexOf('█')).toBe(0);
    expect(bar).toBe('█' + '░'.repeat(15));
  });

  it('leaves at least one empty cell for a near-complete percentage', () => {
    // 99% of 16 rounds to 16 cells without boundary correction.
    const bar = renderProgressBar(99);
    expect(bar.endsWith('░')).toBe(true);
    expect(bar).toBe('█'.repeat(15) + '░');
  });

  it('still renders a fully empty bar at exactly 0%', () => {
    expect(renderProgressBar(0)).toBe('░'.repeat(16));
  });

  it('still renders a fully filled bar at exactly 100%', () => {
    expect(renderProgressBar(100)).toBe('█'.repeat(16));
  });
});

// ─────────────────────────────────────────────
// renderTeamProgress
// ─────────────────────────────────────────────

describe('renderTeamProgress', () => {
  const singleMember = [
    { name: 'worker-1', description: 'Task A', progress: 100, status: 'completed' },
  ];

  const fourMembers = [
    { name: 'doc-worker', description: 'Documentation 개선', progress: 100, status: 'completed' },
    { name: 'security-worker', description: 'Security + 코어 코드', progress: 100, status: 'completed' },
    { name: 'skill-worker', description: '마케팅 스킬 깊이', progress: 60, status: 'in_progress' },
    { name: 'framework-worker', description: '프레임워크 + QA', progress: 45, status: 'in_progress' },
  ];

  it('renders a single member correctly', () => {
    const output = renderTeamProgress('test-team', singleMember);
    expect(output).toContain('TEAM PROGRESS — test-team');
    expect(output).toContain('#1 worker-1');
    expect(output).toContain('(Task A)');
    expect(output).toContain('100%');
    expect(output).toContain('1/1 완료');
  });

  it('renders four members with correct indices', () => {
    const output = renderTeamProgress('team-benchmark-adopt', fourMembers);
    expect(output).toContain('#1 doc-worker');
    expect(output).toContain('#2 security-worker');
    expect(output).toContain('#3 skill-worker');
    expect(output).toContain('#4 framework-worker');
  });

  it('shows overall progress with completed count', () => {
    const output = renderTeamProgress('team-benchmark-adopt', fourMembers);
    expect(output).toContain('2/4 완료');
  });

  it('shows correct overall percentage', () => {
    const output = renderTeamProgress('team-benchmark-adopt', fourMembers);
    const overallPercent = Math.round((100 + 100 + 60 + 45) / 4);
    expect(output).toContain(`(${overallPercent}%)`);
  });

  it('renders all-completed team', () => {
    const allDone = [
      { name: 'a', description: 'A', progress: 100, status: 'completed' },
      { name: 'b', description: 'B', progress: 100, status: 'completed' },
    ];
    const output = renderTeamProgress('done-team', allDone);
    expect(output).toContain('2/2 완료 (100%)');
  });

  it('contains separator line', () => {
    const output = renderTeamProgress('t', singleMember);
    expect(output).toContain('─'.repeat(48));
  });

  it('uses tilde prefix for non-100% values', () => {
    const output = renderTeamProgress('t', fourMembers);
    expect(output).toContain('~60%');
    expect(output).toContain('~45%');
  });
});

// ─────────────────────────────────────────────
// renderAutopilotProgress
// ─────────────────────────────────────────────

describe('renderAutopilotProgress', () => {
  it('renders autopilot goal and iterations', () => {
    const iterations = [
      { iteration: 1, total: 3, status: 'completed', description: 'Setup' },
      { iteration: 2, total: 3, status: 'completed', description: 'Build' },
      { iteration: 3, total: 3, status: 'pending', description: 'Verify' },
    ];
    const output = renderAutopilotProgress('Implement feature X', iterations);
    expect(output).toContain('AUTOPILOT — Implement feature X');
    expect(output).toContain('[x] Iteration 1/3: Setup');
    expect(output).toContain('[x] Iteration 2/3: Build');
    expect(output).toContain('[ ] Iteration 3/3: Verify');
    expect(output).toContain('2/3 (67%)');
  });

  it('handles empty iterations with an undetermined (--%) marker', () => {
    const output = renderAutopilotProgress('Empty goal', []);
    expect(output).toContain('AUTOPILOT — Empty goal');
    // total===0 is undetermined, not a genuine 0% — distinguish via --%.
    expect(output).toContain('0/0 (--%)');
  });
});
