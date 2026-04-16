import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  canCancel,
  isTerminal,
  STATUS,
  transition,
} from '../../lib/orchestration/status.js';

describe('status', () => {
  // ---------------------------------------------------------------------------
  describe('STATUS enum', () => {
    it('exports all eight statuses', () => {
      expect(Object.keys(STATUS)).toEqual([
        'PENDING',
        'WAITING_ON_DEPS',
        'RUNNING',
        'SUCCESS',
        'FAILURE',
        'ERROR',
        'KILLED',
        'SKIPPED',
      ]);
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(STATUS)).toBe(true);
    });

    it('has string values matching keys', () => {
      for (const [key, value] of Object.entries(STATUS)) {
        expect(key).toBe(value);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('transition()', () => {
    // --- PENDING transitions ---
    it('PENDING -> WAITING_ON_DEPS', () => {
      expect(transition(STATUS.PENDING, STATUS.WAITING_ON_DEPS))
        .toBe(STATUS.WAITING_ON_DEPS);
    });

    it('PENDING -> RUNNING', () => {
      expect(transition(STATUS.PENDING, STATUS.RUNNING)).toBe(STATUS.RUNNING);
    });

    it('PENDING -> SKIPPED', () => {
      expect(transition(STATUS.PENDING, STATUS.SKIPPED)).toBe(STATUS.SKIPPED);
    });

    it('PENDING -> SUCCESS throws', () => {
      expect(() => transition(STATUS.PENDING, STATUS.SUCCESS))
        .toThrow('Invalid transition');
    });

    // --- WAITING_ON_DEPS transitions ---
    it('WAITING_ON_DEPS -> RUNNING', () => {
      expect(transition(STATUS.WAITING_ON_DEPS, STATUS.RUNNING))
        .toBe(STATUS.RUNNING);
    });

    it('WAITING_ON_DEPS -> SKIPPED', () => {
      expect(transition(STATUS.WAITING_ON_DEPS, STATUS.SKIPPED))
        .toBe(STATUS.SKIPPED);
    });

    it('WAITING_ON_DEPS -> FAILURE throws', () => {
      expect(() => transition(STATUS.WAITING_ON_DEPS, STATUS.FAILURE))
        .toThrow('Invalid transition');
    });

    // --- RUNNING transitions ---
    it('RUNNING -> SUCCESS', () => {
      expect(transition(STATUS.RUNNING, STATUS.SUCCESS)).toBe(STATUS.SUCCESS);
    });

    it('RUNNING -> FAILURE', () => {
      expect(transition(STATUS.RUNNING, STATUS.FAILURE)).toBe(STATUS.FAILURE);
    });

    it('RUNNING -> ERROR', () => {
      expect(transition(STATUS.RUNNING, STATUS.ERROR)).toBe(STATUS.ERROR);
    });

    it('RUNNING -> KILLED', () => {
      expect(transition(STATUS.RUNNING, STATUS.KILLED)).toBe(STATUS.KILLED);
    });

    it('RUNNING -> PENDING throws', () => {
      expect(() => transition(STATUS.RUNNING, STATUS.PENDING))
        .toThrow('Invalid transition');
    });

    // --- Terminal states ---
    const terminalStates = ['SUCCESS', 'FAILURE', 'ERROR', 'KILLED', 'SKIPPED'];

    it.each(terminalStates)('%s cannot transition to anything', (state) => {
      const allTargets = Object.values(STATUS);
      for (const target of allTargets) {
        expect(() => transition(STATUS[state], target))
          .toThrow(/Invalid transition|terminal state/);
      }
    });

    // --- Invalid inputs ---
    it('throws on invalid current status', () => {
      expect(() => transition('INVALID', STATUS.RUNNING))
        .toThrow('Invalid current status');
    });

    it('throws on invalid target status', () => {
      expect(() => transition(STATUS.PENDING, 'INVALID'))
        .toThrow('Invalid target status');
    });
  });

  // ---------------------------------------------------------------------------
  describe('isTerminal()', () => {
    it('returns true for SUCCESS', () => {
      expect(isTerminal(STATUS.SUCCESS)).toBe(true);
    });

    it('returns true for FAILURE', () => {
      expect(isTerminal(STATUS.FAILURE)).toBe(true);
    });

    it('returns true for ERROR', () => {
      expect(isTerminal(STATUS.ERROR)).toBe(true);
    });

    it('returns true for KILLED', () => {
      expect(isTerminal(STATUS.KILLED)).toBe(true);
    });

    it('returns true for SKIPPED', () => {
      expect(isTerminal(STATUS.SKIPPED)).toBe(true);
    });

    it('returns false for PENDING', () => {
      expect(isTerminal(STATUS.PENDING)).toBe(false);
    });

    it('returns false for WAITING_ON_DEPS', () => {
      expect(isTerminal(STATUS.WAITING_ON_DEPS)).toBe(false);
    });

    it('returns false for RUNNING', () => {
      expect(isTerminal(STATUS.RUNNING)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('canCancel()', () => {
    it('returns true for PENDING', () => {
      expect(canCancel(STATUS.PENDING)).toBe(true);
    });

    it('returns true for WAITING_ON_DEPS', () => {
      expect(canCancel(STATUS.WAITING_ON_DEPS)).toBe(true);
    });

    it('returns true for RUNNING', () => {
      expect(canCancel(STATUS.RUNNING)).toBe(true);
    });

    it('returns false for SUCCESS', () => {
      expect(canCancel(STATUS.SUCCESS)).toBe(false);
    });

    it('returns false for FAILURE', () => {
      expect(canCancel(STATUS.FAILURE)).toBe(false);
    });

    it('returns false for ERROR', () => {
      expect(canCancel(STATUS.ERROR)).toBe(false);
    });

    it('returns false for KILLED', () => {
      expect(canCancel(STATUS.KILLED)).toBe(false);
    });

    it('returns false for SKIPPED', () => {
      expect(canCancel(STATUS.SKIPPED)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('allowedTransitions()', () => {
    it('returns correct transitions for PENDING', () => {
      expect(allowedTransitions(STATUS.PENDING)).toEqual([
        STATUS.WAITING_ON_DEPS,
        STATUS.RUNNING,
        STATUS.SKIPPED,
      ]);
    });

    it('returns correct transitions for WAITING_ON_DEPS', () => {
      expect(allowedTransitions(STATUS.WAITING_ON_DEPS)).toEqual([
        STATUS.RUNNING,
        STATUS.SKIPPED,
      ]);
    });

    it('returns correct transitions for RUNNING', () => {
      expect(allowedTransitions(STATUS.RUNNING)).toEqual([
        STATUS.SUCCESS,
        STATUS.FAILURE,
        STATUS.ERROR,
        STATUS.KILLED,
      ]);
    });

    it('returns empty for terminal states', () => {
      expect(allowedTransitions(STATUS.SUCCESS)).toEqual([]);
      expect(allowedTransitions(STATUS.FAILURE)).toEqual([]);
      expect(allowedTransitions(STATUS.ERROR)).toEqual([]);
      expect(allowedTransitions(STATUS.KILLED)).toEqual([]);
      expect(allowedTransitions(STATUS.SKIPPED)).toEqual([]);
    });

    it('returns a fresh array (non-mutating)', () => {
      const a1 = allowedTransitions(STATUS.PENDING);
      const a2 = allowedTransitions(STATUS.PENDING);
      expect(a1).not.toBe(a2);
      expect(a1).toEqual(a2);
    });

    it('throws on invalid status', () => {
      expect(() => allowedTransitions('BOGUS')).toThrow('Invalid status');
    });
  });

  // ---------------------------------------------------------------------------
  describe('integration', () => {
    it('models a complete task lifecycle', () => {
      let state = STATUS.PENDING;
      state = transition(state, STATUS.WAITING_ON_DEPS);
      expect(canCancel(state)).toBe(true);
      expect(isTerminal(state)).toBe(false);

      state = transition(state, STATUS.RUNNING);
      expect(canCancel(state)).toBe(true);

      state = transition(state, STATUS.SUCCESS);
      expect(isTerminal(state)).toBe(true);
      expect(canCancel(state)).toBe(false);
    });

    it('models a failed task lifecycle', () => {
      let state = STATUS.PENDING;
      state = transition(state, STATUS.RUNNING);
      state = transition(state, STATUS.FAILURE);
      expect(isTerminal(state)).toBe(true);
      expect(allowedTransitions(state)).toEqual([]);
    });

    it('models a skipped task', () => {
      let state = STATUS.PENDING;
      state = transition(state, STATUS.SKIPPED);
      expect(isTerminal(state)).toBe(true);
    });

    it('models a killed task', () => {
      let state = STATUS.PENDING;
      state = transition(state, STATUS.RUNNING);
      state = transition(state, STATUS.KILLED);
      expect(isTerminal(state)).toBe(true);
      expect(canCancel(state)).toBe(false);
    });
  });
});
