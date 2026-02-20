import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STATES,
  createLifecycle,
  getCurrentState,
  defaultLifecycle,
} from '../../lib/core/lifecycle.js';

describe('lifecycle', () => {
  let lc;

  beforeEach(() => {
    lc = createLifecycle();
    defaultLifecycle.reset();
  });

  // ---------------------------------------------------------------------------
  describe('STATES', () => {
    it('exports all six states', () => {
      expect(Object.keys(STATES)).toEqual([
        'UNINITIALIZED',
        'INITIALIZING',
        'READY',
        'ACTIVE',
        'SHUTTING_DOWN',
        'STOPPED',
      ]);
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(STATES)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('createLifecycle()', () => {
    it('starts in UNINITIALIZED state', () => {
      expect(lc.getState()).toBe(STATES.UNINITIALIZED);
    });

    it('returns an object with the expected API', () => {
      expect(typeof lc.getState).toBe('function');
      expect(typeof lc.transition).toBe('function');
      expect(typeof lc.onStateChange).toBe('function');
      expect(typeof lc.getHistory).toBe('function');
      expect(typeof lc.canTransition).toBe('function');
      expect(typeof lc.reset).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  describe('transition()', () => {
    it('transitions UNINITIALIZED -> INITIALIZING', () => {
      const result = lc.transition(STATES.INITIALIZING);
      expect(result.from).toBe(STATES.UNINITIALIZED);
      expect(result.to).toBe(STATES.INITIALIZING);
      expect(lc.getState()).toBe(STATES.INITIALIZING);
    });

    it('transitions INITIALIZING -> READY', () => {
      lc.transition(STATES.INITIALIZING);
      const result = lc.transition(STATES.READY);
      expect(result.from).toBe(STATES.INITIALIZING);
      expect(result.to).toBe(STATES.READY);
    });

    it('transitions READY -> ACTIVE', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      const result = lc.transition(STATES.ACTIVE);
      expect(result.from).toBe(STATES.READY);
      expect(result.to).toBe(STATES.ACTIVE);
    });

    it('transitions ACTIVE -> SHUTTING_DOWN', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.transition(STATES.ACTIVE);
      const result = lc.transition(STATES.SHUTTING_DOWN);
      expect(result.from).toBe(STATES.ACTIVE);
      expect(result.to).toBe(STATES.SHUTTING_DOWN);
    });

    it('transitions SHUTTING_DOWN -> STOPPED', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.transition(STATES.ACTIVE);
      lc.transition(STATES.SHUTTING_DOWN);
      const result = lc.transition(STATES.STOPPED);
      expect(result.from).toBe(STATES.SHUTTING_DOWN);
      expect(result.to).toBe(STATES.STOPPED);
    });

    it('transitions ACTIVE -> READY (deactivation)', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.transition(STATES.ACTIVE);
      const result = lc.transition(STATES.READY);
      expect(result.from).toBe(STATES.ACTIVE);
      expect(result.to).toBe(STATES.READY);
    });

    it('transitions READY -> SHUTTING_DOWN (skip ACTIVE)', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      const result = lc.transition(STATES.SHUTTING_DOWN);
      expect(result.from).toBe(STATES.READY);
      expect(result.to).toBe(STATES.SHUTTING_DOWN);
    });

    it('transitions INITIALIZING -> STOPPED (init failure)', () => {
      lc.transition(STATES.INITIALIZING);
      const result = lc.transition(STATES.STOPPED);
      expect(result.from).toBe(STATES.INITIALIZING);
      expect(result.to).toBe(STATES.STOPPED);
    });

    it('returns a result with timestamp', () => {
      const result = lc.transition(STATES.INITIALIZING);
      expect(() => new Date(result.timestamp)).not.toThrow();
    });

    // Invalid transitions
    it('throws for UNINITIALIZED -> READY (must go through INITIALIZING)', () => {
      expect(() => lc.transition(STATES.READY)).toThrow('Invalid transition');
    });

    it('throws for UNINITIALIZED -> ACTIVE', () => {
      expect(() => lc.transition(STATES.ACTIVE)).toThrow('Invalid transition');
    });

    it('throws for STOPPED -> ACTIVE', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.STOPPED);
      expect(() => lc.transition(STATES.ACTIVE)).toThrow('Invalid transition');
    });

    it('throws for STOPPED -> UNINITIALIZED', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.STOPPED);
      expect(() => lc.transition(STATES.UNINITIALIZED)).toThrow('Invalid transition');
    });

    it('throws for SHUTTING_DOWN -> ACTIVE', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.transition(STATES.SHUTTING_DOWN);
      expect(() => lc.transition(STATES.ACTIVE)).toThrow('Invalid transition');
    });

    it('throws for invalid state name', () => {
      expect(() => lc.transition('BOGUS')).toThrow('Invalid state: "BOGUS"');
    });

    it('error message lists valid states for invalid state name', () => {
      expect(() => lc.transition('NOPE')).toThrow('Valid states:');
    });

    it('error message lists allowed transitions for invalid transition', () => {
      expect(() => lc.transition(STATES.ACTIVE)).toThrow('Allowed transitions from UNINITIALIZED');
    });

    it('error includes "none" when no transitions are available', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.STOPPED);
      expect(() => lc.transition(STATES.READY)).toThrow('none');
    });
  });

  // ---------------------------------------------------------------------------
  describe('canTransition()', () => {
    it('returns true for valid next states', () => {
      expect(lc.canTransition(STATES.INITIALIZING)).toBe(true);
    });

    it('returns false for invalid next states', () => {
      expect(lc.canTransition(STATES.ACTIVE)).toBe(false);
    });

    it('returns false for unknown state names', () => {
      expect(lc.canTransition('INVALID')).toBe(false);
    });

    it('returns false when in STOPPED state', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.STOPPED);
      expect(lc.canTransition(STATES.UNINITIALIZED)).toBe(false);
      expect(lc.canTransition(STATES.INITIALIZING)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('onStateChange()', () => {
    it('calls listener on transition', () => {
      const listener = vi.fn();
      lc.onStateChange(listener);
      lc.transition(STATES.INITIALIZING);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          from: STATES.UNINITIALIZED,
          to: STATES.INITIALIZING,
        }),
      );
    });

    it('calls multiple listeners', () => {
      const a = vi.fn();
      const b = vi.fn();
      lc.onStateChange(a);
      lc.onStateChange(b);
      lc.transition(STATES.INITIALIZING);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = lc.onStateChange(listener);
      unsub();
      lc.transition(STATES.INITIALIZING);
      expect(listener).not.toHaveBeenCalled();
    });

    it('throws if callback is not a function', () => {
      expect(() => lc.onStateChange('not a function')).toThrow('requires a function');
    });

    it('provides copies of entry to listeners (no mutation)', () => {
      let captured;
      lc.onStateChange((e) => { captured = e; });
      lc.transition(STATES.INITIALIZING);
      captured.from = 'MUTATED';
      expect(lc.getHistory()[0].from).toBe(STATES.UNINITIALIZED);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getHistory()', () => {
    it('starts with empty history', () => {
      expect(lc.getHistory()).toEqual([]);
    });

    it('records each transition', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      const history = lc.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual(expect.objectContaining({ from: STATES.UNINITIALIZED, to: STATES.INITIALIZING }));
      expect(history[1]).toEqual(expect.objectContaining({ from: STATES.INITIALIZING, to: STATES.READY }));
    });

    it('returns copies (no mutation of internal state)', () => {
      lc.transition(STATES.INITIALIZING);
      const history = lc.getHistory();
      history.push({ from: 'FAKE', to: 'FAKE' });
      expect(lc.getHistory()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('reset()', () => {
    it('resets state to UNINITIALIZED', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.reset();
      expect(lc.getState()).toBe(STATES.UNINITIALIZED);
    });

    it('clears history', () => {
      lc.transition(STATES.INITIALIZING);
      lc.reset();
      expect(lc.getHistory()).toEqual([]);
    });

    it('clears listeners', () => {
      const listener = vi.fn();
      lc.onStateChange(listener);
      lc.reset();
      lc.transition(STATES.INITIALIZING);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('full lifecycle path', () => {
    it('completes init -> ready -> active -> shutdown -> stopped', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.transition(STATES.ACTIVE);
      lc.transition(STATES.SHUTTING_DOWN);
      lc.transition(STATES.STOPPED);
      expect(lc.getState()).toBe(STATES.STOPPED);
      expect(lc.getHistory()).toHaveLength(5);
    });

    it('supports active -> ready -> active cycle', () => {
      lc.transition(STATES.INITIALIZING);
      lc.transition(STATES.READY);
      lc.transition(STATES.ACTIVE);
      lc.transition(STATES.READY);
      lc.transition(STATES.ACTIVE);
      expect(lc.getState()).toBe(STATES.ACTIVE);
      expect(lc.getHistory()).toHaveLength(5);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getCurrentState() / defaultLifecycle', () => {
    it('returns UNINITIALIZED by default', () => {
      expect(getCurrentState()).toBe(STATES.UNINITIALIZED);
    });

    it('reflects transitions on the singleton', () => {
      defaultLifecycle.transition(STATES.INITIALIZING);
      expect(getCurrentState()).toBe(STATES.INITIALIZING);
    });

    it('defaultLifecycle has the same API as createLifecycle()', () => {
      expect(typeof defaultLifecycle.getState).toBe('function');
      expect(typeof defaultLifecycle.transition).toBe('function');
      expect(typeof defaultLifecycle.onStateChange).toBe('function');
      expect(typeof defaultLifecycle.getHistory).toBe('function');
      expect(typeof defaultLifecycle.canTransition).toBe('function');
      expect(typeof defaultLifecycle.reset).toBe('function');
    });
  });
});
