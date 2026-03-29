import { describe, expect, it } from 'vitest';
import { PlanTracker } from '../../lib/core/plan-tracker.js';

const SAMPLE_PLAN = `# Project Plan

## Phase 1
- [ ] Set up project structure
- [x] Initialize repository
- [ ] Configure ESLint

## Phase 2
- [ ] Implement core features
- [x] Write documentation
`;

describe('PlanTracker', () => {
  describe('parsePlan', () => {
    it('extracts unchecked and checked tasks from markdown', () => {
      const tracker = new PlanTracker();
      const tasks = tracker.parsePlan(SAMPLE_PLAN);

      expect(tasks).toHaveLength(5);
      expect(tasks[0]).toEqual({ text: 'Set up project structure', completed: false });
      expect(tasks[1]).toEqual({ text: 'Initialize repository', completed: true });
      expect(tasks[2]).toEqual({ text: 'Configure ESLint', completed: false });
      expect(tasks[3]).toEqual({ text: 'Implement core features', completed: false });
      expect(tasks[4]).toEqual({ text: 'Write documentation', completed: true });
    });

    it('returns empty array for non-string input', () => {
      const tracker = new PlanTracker();
      expect(tracker.parsePlan(null)).toEqual([]);
      expect(tracker.parsePlan(undefined)).toEqual([]);
      expect(tracker.parsePlan(42)).toEqual([]);
    });

    it('returns empty array for markdown without checkboxes', () => {
      const tracker = new PlanTracker();
      expect(tracker.parsePlan('# Just a heading\nSome text.')).toEqual([]);
    });

    it('handles uppercase [X] as completed', () => {
      const tracker = new PlanTracker();
      const tasks = tracker.parsePlan('- [X] Done task');
      expect(tasks).toEqual([{ text: 'Done task', completed: true }]);
    });

    it('trims whitespace from task text', () => {
      const tracker = new PlanTracker();
      const tasks = tracker.parsePlan('- [ ]   Spaces around   ');
      expect(tasks[0].text).toBe('Spaces around');
    });
  });

  describe('getProgress', () => {
    it('calculates correct progress for mixed tasks', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);
      const progress = tracker.getProgress();

      expect(progress.total).toBe(5);
      expect(progress.completed).toBe(2);
      expect(progress.percentage).toBe(40);
    });

    it('returns 0% for empty plan', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan('');
      const progress = tracker.getProgress();

      expect(progress).toEqual({ total: 0, completed: 0, percentage: 0 });
    });

    it('returns 100% when all tasks complete', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan('- [x] A\n- [x] B');
      expect(tracker.getProgress().percentage).toBe(100);
    });
  });

  describe('markCompleted', () => {
    it('checks off a specific unchecked task and returns new markdown', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);

      const updated = tracker.markCompleted(0); // "Set up project structure"
      expect(updated).toContain('- [x] Set up project structure');
      expect(tracker.getProgress().completed).toBe(3);
    });

    it('returns original content for out-of-range index', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);

      const updated = tracker.markCompleted(99);
      expect(updated).toBe(SAMPLE_PLAN);
    });

    it('returns original content for negative index', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);

      const updated = tracker.markCompleted(-1);
      expect(updated).toBe(SAMPLE_PLAN);
    });

    it('returns original content if task already completed', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);

      const updated = tracker.markCompleted(1); // already [x]
      expect(updated).toBe(SAMPLE_PLAN);
    });

    it('does not mutate other tasks', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);
      const updated = tracker.markCompleted(2); // "Configure ESLint"

      expect(updated).toContain('- [ ] Set up project structure');
      expect(updated).toContain('- [x] Configure ESLint');
      expect(updated).toContain('- [ ] Implement core features');
    });

    it('records completion in active session', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);
      tracker.addSession('sess-1');
      tracker.markCompleted(0);
      tracker.markCompleted(2);

      const history = tracker.getSessionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('sess-1');
      expect(history[0].completedIndices).toEqual([0, 2]);
    });
  });

  describe('addSession / getSessionHistory', () => {
    it('registers sessions and returns history', () => {
      const tracker = new PlanTracker();
      tracker.addSession('s1');
      tracker.addSession('s2');

      const history = tracker.getSessionHistory();
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('s1');
      expect(history[1].id).toBe('s2');
      expect(history[0].startedAt).toBeTruthy();
    });

    it('ignores empty or non-string session IDs', () => {
      const tracker = new PlanTracker();
      tracker.addSession('');
      tracker.addSession(null);
      tracker.addSession(undefined);

      expect(tracker.getSessionHistory()).toEqual([]);
    });

    it('returns defensive copies (no external mutation)', () => {
      const tracker = new PlanTracker();
      tracker.addSession('s1');

      const h1 = tracker.getSessionHistory();
      h1[0].completedIndices.push(999);
      h1.push({ id: 'fake' });

      const h2 = tracker.getSessionHistory();
      expect(h2).toHaveLength(1);
      expect(h2[0].completedIndices).toEqual([]);
    });
  });

  describe('toState / fromState', () => {
    it('round-trips state correctly', () => {
      const tracker = new PlanTracker();
      tracker.parsePlan(SAMPLE_PLAN);
      tracker.addSession('sess-rt');
      tracker.markCompleted(0);

      const state = tracker.toState('/plans/roadmap.md');
      expect(state.planFile).toBe('/plans/roadmap.md');
      expect(state.tasks).toHaveLength(5);
      expect(state.tasks[0].completed).toBe(true);
      expect(state.sessions).toHaveLength(1);
      expect(state.lastUpdated).toBeTruthy();

      const restored = new PlanTracker();
      restored.fromState(state);
      expect(restored.getProgress().completed).toBe(3); // 2 original + 1 marked
    });

    it('handles null/undefined input gracefully', () => {
      const tracker = new PlanTracker();
      tracker.fromState(null);
      tracker.fromState(undefined);
      expect(tracker.getProgress()).toEqual({ total: 0, completed: 0, percentage: 0 });
    });
  });
});
