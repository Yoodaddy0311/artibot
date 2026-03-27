import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEATURES,
  createFeatureTracker,
  formatCompressedIndicator,
  formatDashboard,
  formatIndicator,
} from '../../lib/core/feature-tracker.js';
import { emit, reset as resetEventBus } from '../../lib/core/event-bus.js';

describe('feature-tracker', () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  // ---------------------------------------------------------------------------
  // FEATURES registry
  // ---------------------------------------------------------------------------

  describe('FEATURES registry', () => {
    it('contains expected feature definitions', () => {
      expect(FEATURES.length).toBeGreaterThanOrEqual(8);
      for (const f of FEATURES) {
        expect(f).toHaveProperty('id');
        expect(f).toHaveProperty('symbol');
        expect(f).toHaveProperty('label');
        expect(f).toHaveProperty('eventType');
      }
    });

    it('has unique ids', () => {
      const ids = FEATURES.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('has unique event types', () => {
      const types = FEATURES.map((f) => f.eventType);
      expect(new Set(types).size).toBe(types.length);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(FEATURES)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // formatIndicator
  // ---------------------------------------------------------------------------

  describe('formatIndicator', () => {
    it('formats with detail', () => {
      const def = FEATURES.find((f) => f.id === 'aci');
      const result = formatIndicator(def, 'tdd-guide → test tools');
      expect(result).toContain('ACI Constraints');
      expect(result).toContain('tdd-guide → test tools');
    });

    it('formats without detail', () => {
      const def = FEATURES.find((f) => f.id === 'guardrail');
      const result = formatIndicator(def, null);
      expect(result).toContain('Guardrail');
      expect(result).not.toContain(':');
    });
  });

  // ---------------------------------------------------------------------------
  // formatCompressedIndicator
  // ---------------------------------------------------------------------------

  describe('formatCompressedIndicator', () => {
    it('produces short bracketed form', () => {
      const def = FEATURES.find((f) => f.id === 'aci');
      const result = formatCompressedIndicator(def, 'test-tools');
      expect(result).toMatch(/^\[.+ACI.*:test-tools\]$/);
    });

    it('omits detail when null', () => {
      const def = FEATURES.find((f) => f.id === 'aci');
      const result = formatCompressedIndicator(def, null);
      expect(result).toMatch(/^\[.+ACI.*\]$/);
      expect(result).not.toContain(':');
    });
  });

  // ---------------------------------------------------------------------------
  // formatDashboard
  // ---------------------------------------------------------------------------

  describe('formatDashboard', () => {
    it('returns empty for empty store', () => {
      const store = new Map();
      expect(formatDashboard(store)).toBe('');
    });

    it('renders features in registry order', () => {
      const store = new Map([
        ['guardrail', { featureId: 'guardrail', count: 3, lastDetail: 'denied Bash', lastTimestamp: 1 }],
        ['aci', { featureId: 'aci', count: 12, lastDetail: 'accuracy +15%', lastTimestamp: 2 }],
      ]);
      const result = formatDashboard(store);
      expect(result).toContain('Session Intelligence Report');
      const aciIdx = result.indexOf('ACI');
      const guardIdx = result.indexOf('Guardrail');
      // ACI appears before Guardrail per registry order
      expect(aciIdx).toBeLessThan(guardIdx);
    });

    it('includes count and detail', () => {
      const store = new Map([
        ['aci', { featureId: 'aci', count: 5, lastDetail: 'accuracy +10%', lastTimestamp: 1 }],
      ]);
      const result = formatDashboard(store);
      expect(result).toContain('5x');
      expect(result).toContain('accuracy +10%');
    });
  });

  // ---------------------------------------------------------------------------
  // createFeatureTracker
  // ---------------------------------------------------------------------------

  describe('createFeatureTracker', () => {
    it('creates a tracker with auto-subscribe', () => {
      const tracker = createFeatureTracker();
      expect(tracker.getStore().size).toBe(0);
      expect(tracker.getStats()).toEqual({ totalActivations: 0, activeFeatures: 0 });
      tracker.destroy();
    });

    it('records activations via event-bus', () => {
      const tracker = createFeatureTracker({ now: () => 1000 });
      emit('feature:aci-applied', { detail: 'tdd-guide → test tools' });
      emit('feature:aci-applied', { detail: 'second activation' });

      const store = tracker.getStore();
      expect(store.get('aci').count).toBe(2);
      expect(store.get('aci').lastDetail).toBe('second activation');
      expect(tracker.getStats()).toEqual({ totalActivations: 2, activeFeatures: 1 });
      tracker.destroy();
    });

    it('records string event data as detail', () => {
      const tracker = createFeatureTracker({ now: () => 2000 });
      emit('feature:guardrail-applied', 'denied Bash');

      expect(tracker.getStore().get('guardrail').lastDetail).toBe('denied Bash');
      tracker.destroy();
    });

    it('records multiple feature types', () => {
      const tracker = createFeatureTracker({ now: () => 3000 });
      emit('feature:aci-applied', { detail: 'x' });
      emit('feature:cognitive-route', { detail: 'system1' });
      emit('feature:guardrail-applied', { detail: 'ok' });

      expect(tracker.getStats()).toEqual({ totalActivations: 3, activeFeatures: 3 });
      tracker.destroy();
    });

    it('manual record works without event-bus', () => {
      const tracker = createFeatureTracker({ autoSubscribe: false, now: () => 4000 });
      tracker.record('aci', 'manual test');

      expect(tracker.getStore().get('aci').count).toBe(1);
      expect(tracker.getStore().get('aci').lastDetail).toBe('manual test');
      tracker.destroy();
    });

    it('getIndicator returns formatted string', () => {
      const tracker = createFeatureTracker({ autoSubscribe: false });
      const result = tracker.getIndicator('aci', 'tdd-guide');
      expect(result).toContain('ACI Constraints');
      expect(result).toContain('tdd-guide');
      tracker.destroy();
    });

    it('getIndicator returns empty for unknown feature', () => {
      const tracker = createFeatureTracker({ autoSubscribe: false });
      expect(tracker.getIndicator('nonexistent')).toBe('');
      tracker.destroy();
    });

    it('getCompressedIndicator returns short form', () => {
      const tracker = createFeatureTracker({ autoSubscribe: false });
      const result = tracker.getCompressedIndicator('aci', 'test');
      expect(result).toMatch(/^\[/);
      expect(result).toMatch(/\]$/);
      tracker.destroy();
    });

    it('getDashboard returns formatted dashboard', () => {
      const tracker = createFeatureTracker({ now: () => 5000 });
      emit('feature:aci-applied', { detail: 'x' });
      emit('feature:guardrail-applied', { detail: 'y' });

      const dashboard = tracker.getDashboard();
      expect(dashboard).toContain('Session Intelligence Report');
      expect(dashboard).toContain('ACI');
      expect(dashboard).toContain('Guardrail');
      tracker.destroy();
    });

    it('getDashboard returns empty when no activations', () => {
      const tracker = createFeatureTracker();
      expect(tracker.getDashboard()).toBe('');
      tracker.destroy();
    });

    it('getFeatures returns the registry', () => {
      const tracker = createFeatureTracker({ autoSubscribe: false });
      expect(tracker.getFeatures()).toBe(FEATURES);
      tracker.destroy();
    });

    it('destroy cleans up subscriptions and store', () => {
      const tracker = createFeatureTracker({ now: () => 6000 });
      emit('feature:aci-applied', { detail: 'before' });
      expect(tracker.getStore().size).toBe(1);

      tracker.destroy();

      // After destroy, events should not be recorded
      emit('feature:aci-applied', { detail: 'after' });
      expect(tracker.getStore().size).toBe(0);
    });

    it('handles event data with message field', () => {
      const tracker = createFeatureTracker({ now: () => 7000 });
      emit('feature:source-fetched', { message: '3 skills loaded' });

      expect(tracker.getStore().get('source-fetched').lastDetail).toBe('3 skills loaded');
      tracker.destroy();
    });

    it('handles null/undefined event data gracefully', () => {
      const tracker = createFeatureTracker({ now: () => 8000 });
      emit('feature:aci-applied', null);
      emit('feature:aci-applied', undefined);
      emit('feature:aci-applied', { noDetail: true });

      expect(tracker.getStore().get('aci').count).toBe(3);
      expect(tracker.getStore().get('aci').lastDetail).toBeNull();
      tracker.destroy();
    });
  });
});
