import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  on,
  emit,
  getLastEvent,
  reset,
  getStats,
} from '../../lib/core/event-bus.js';

describe('event-bus', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    reset();
  });

  // ---------------------------------------------------------------------------
  describe('on()', () => {
    it('subscribes a handler and returns unsubscribe handle', () => {
      const handler = vi.fn();
      const sub = on('test', handler);
      expect(sub).toHaveProperty('unsubscribe');
      expect(typeof sub.unsubscribe).toBe('function');
    });

    it('throws TypeError for non-string eventType', () => {
      expect(() => on(null, () => {})).toThrow(TypeError);
      expect(() => on(123, () => {})).toThrow(TypeError);
      expect(() => on('', () => {})).toThrow(TypeError);
    });

    it('throws TypeError for non-function handler', () => {
      expect(() => on('test', null)).toThrow(TypeError);
      expect(() => on('test', 'not-a-fn')).toThrow(TypeError);
    });
  });

  // ---------------------------------------------------------------------------
  describe('emit()', () => {
    it('invokes subscribed handler with data', () => {
      const handler = vi.fn();
      on('greet', handler);
      const count = emit('greet', { msg: 'hello' });
      expect(count).toBe(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ msg: 'hello' }));
    });

    it('returns 0 when no listeners exist', () => {
      const count = emit('nobody-listening', { x: 1 });
      expect(count).toBe(0);
    });

    it('invokes multiple listeners on same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();
      on('multi', h1);
      on('multi', h2);
      on('multi', h3);
      const count = emit('multi', 42);
      expect(count).toBe(3);
      expect(h1).toHaveBeenCalledWith(42);
      expect(h2).toHaveBeenCalledWith(42);
      expect(h3).toHaveBeenCalledWith(42);
    });

    it('throws TypeError for invalid eventType', () => {
      expect(() => emit(null, {})).toThrow(TypeError);
      expect(() => emit('', {})).toThrow(TypeError);
    });

    it('handles primitive data (no freeze)', () => {
      const handler = vi.fn();
      on('prim', handler);
      emit('prim', 'hello');
      expect(handler).toHaveBeenCalledWith('hello');
    });

    it('handles null data', () => {
      const handler = vi.fn();
      on('nil', handler);
      emit('nil', null);
      expect(handler).toHaveBeenCalledWith(null);
    });

    it('handles undefined data', () => {
      const handler = vi.fn();
      on('undef', handler);
      emit('undef', undefined);
      expect(handler).toHaveBeenCalledWith(undefined);
    });
  });

  // ---------------------------------------------------------------------------
  describe('handler error isolation', () => {
    it('catches handler errors and continues to other handlers', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const badHandler = () => { throw new Error('boom'); };
      const goodHandler = vi.fn();

      on('err-test', badHandler);
      on('err-test', goodHandler);

      const count = emit('err-test', { data: 1 });

      expect(count).toBe(1); // only goodHandler counted
      expect(goodHandler).toHaveBeenCalledWith(expect.objectContaining({ data: 1 }));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('handler error on "err-test"'),
      );

      stderrSpy.mockRestore();
    });

    it('logs error message from thrown error', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      on('err-msg', () => { throw new Error('specific message'); });
      emit('err-msg', null);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('specific message'),
      );

      stderrSpy.mockRestore();
    });

    it('handles non-Error throws gracefully', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      on('err-str', () => { throw 'string-error'; }); // eslint-disable-line no-throw-literal
      emit('err-str', null);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('string-error'),
      );

      stderrSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  describe('unsubscribe()', () => {
    it('removes the handler so it is no longer called', () => {
      const handler = vi.fn();
      const sub = on('unsub-test', handler);

      emit('unsub-test', 'first');
      expect(handler).toHaveBeenCalledTimes(1);

      sub.unsubscribe();

      emit('unsub-test', 'second');
      expect(handler).toHaveBeenCalledTimes(1); // not called again
    });

    it('cleans up eventType entry when last listener removed', () => {
      const handler = vi.fn();
      const sub = on('cleanup', handler);

      expect(getStats().eventTypes).toBe(1);
      sub.unsubscribe();
      expect(getStats().eventTypes).toBe(0);
    });

    it('is safe to call unsubscribe multiple times', () => {
      const handler = vi.fn();
      const sub = on('double-unsub', handler);
      sub.unsubscribe();
      sub.unsubscribe(); // should not throw
      expect(getStats().totalListeners).toBe(0);
    });

    it('only removes the specific handler, not others', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const sub1 = on('partial', h1);
      on('partial', h2);

      sub1.unsubscribe();

      emit('partial', 'data');
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledWith('data');
    });
  });

  // ---------------------------------------------------------------------------
  describe('getLastEvent()', () => {
    it('returns undefined for never-emitted event types', () => {
      expect(getLastEvent('nonexistent')).toBeUndefined();
    });

    it('returns the most recent data for an emitted event', () => {
      emit('replay', { v: 1 });
      emit('replay', { v: 2 });
      expect(getLastEvent('replay')).toEqual({ v: 2 });
    });

    it('works even with no subscribers (replay scenario)', () => {
      emit('no-sub', { cached: true });
      expect(getLastEvent('no-sub')).toEqual({ cached: true });
    });

    it('stores primitive values correctly', () => {
      emit('prim', 42);
      expect(getLastEvent('prim')).toBe(42);
    });

    it('stores null correctly', () => {
      emit('null-ev', null);
      expect(getLastEvent('null-ev')).toBeNull();
    });

    it('returns frozen object (immutability)', () => {
      emit('frozen', { a: 1 });
      const last = getLastEvent('frozen');
      expect(Object.isFrozen(last)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('reset()', () => {
    it('clears all listeners and cached events', () => {
      on('a', vi.fn());
      on('b', vi.fn());
      emit('a', 1);
      emit('b', 2);

      expect(getStats().eventTypes).toBe(2);
      expect(getStats().cachedEvents).toBe(2);

      reset();

      expect(getStats().eventTypes).toBe(0);
      expect(getStats().totalListeners).toBe(0);
      expect(getStats().cachedEvents).toBe(0);
    });

    it('prevents previously registered handlers from firing', () => {
      const handler = vi.fn();
      on('pre-reset', handler);
      reset();
      emit('pre-reset', 'after');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('getStats()', () => {
    it('returns zeros on fresh bus', () => {
      expect(getStats()).toEqual({
        eventTypes: 0,
        totalListeners: 0,
        cachedEvents: 0,
      });
    });

    it('counts event types and listeners correctly', () => {
      on('x', vi.fn());
      on('x', vi.fn());
      on('y', vi.fn());

      expect(getStats()).toEqual({
        eventTypes: 2,
        totalListeners: 3,
        cachedEvents: 0,
      });
    });

    it('counts cached events correctly', () => {
      emit('a', 1);
      emit('b', 2);
      emit('c', 3);

      expect(getStats().cachedEvents).toBe(3);
    });

    it('reflects changes after unsubscribe', () => {
      const sub = on('z', vi.fn());
      expect(getStats().totalListeners).toBe(1);
      sub.unsubscribe();
      expect(getStats().totalListeners).toBe(0);
    });
  });
});
