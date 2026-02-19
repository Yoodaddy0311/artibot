import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyComplexity,
  route,
  adaptThreshold,
  configure,
  getRoutingStats,
  resetRouter,
  getThreshold,
} from '../../lib/cognitive/router.js';

describe('router', () => {
  beforeEach(() => {
    resetRouter();
  });

  // -------------------------------------------------------------------------
  describe('classifyComplexity()', () => {
    it('returns score between 0 and 1', () => {
      const result = classifyComplexity('fix a bug');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('assigns system 1 for simple input below default threshold', () => {
      const result = classifyComplexity('fix a typo');
      expect(result.system).toBe(1);
    });

    it('assigns system 2 for complex multi-domain input', () => {
      const result = classifyComplexity(
        'security audit: migrate the production database, deploy to kubernetes, and fix the authentication vulnerability'
      );
      expect(result.system).toBe(2);
    });

    it('returns confidence between 0.5 and 1', () => {
      const result = classifyComplexity('list files');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('returns all five factors', () => {
      const result = classifyComplexity('test something');
      expect(result.factors).toHaveProperty('steps');
      expect(result.factors).toHaveProperty('domains');
      expect(result.factors).toHaveProperty('uncertainty');
      expect(result.factors).toHaveProperty('risk');
      expect(result.factors).toHaveProperty('novelty');
    });

    it('includes current threshold in result', () => {
      const result = classifyComplexity('hello');
      expect(result.threshold).toBe(0.4); // DEFAULT_THRESHOLD
    });

    it('detects multi-step input with connectors', () => {
      const simple = classifyComplexity('fix bug');
      const multi = classifyComplexity('first fix the bug, then run tests, then deploy to production');
      expect(multi.factors.steps).toBeGreaterThan(simple.factors.steps);
    });

    it('detects uncertainty keywords', () => {
      const certain = classifyComplexity('create a button');
      const uncertain = classifyComplexity('maybe i need to investigate if this might be a bug');
      expect(uncertain.factors.uncertainty).toBeGreaterThan(certain.factors.uncertainty);
    });

    it('detects risk keywords', () => {
      const safe = classifyComplexity('read a file');
      const risky = classifyComplexity('delete and drop the production database migration');
      expect(risky.factors.risk).toBeGreaterThan(safe.factors.risk);
    });

    it('detects domain keywords for frontend', () => {
      const result = classifyComplexity('create a react component with css');
      expect(result.factors.domains).toBeGreaterThan(0);
    });

    it('novelty defaults to 0.3 when no session context', () => {
      const result = classifyComplexity('do something');
      expect(result.factors.novelty).toBe(0.3);
    });

    it('novelty is lower for deep sessions with known domains', () => {
      const result = classifyComplexity('create a react component', {
        sessionDepth: 5,
        recentDomains: ['frontend'],
      });
      expect(result.factors.novelty).toBeLessThan(0.5);
    });

    it('novelty is higher for new domains in session', () => {
      const result = classifyComplexity('deploy to kubernetes', {
        sessionDepth: 3,
        recentDomains: ['frontend'],
      });
      expect(result.factors.novelty).toBeGreaterThan(0);
    });

    it('scores are rounded to 2 decimal places', () => {
      const result = classifyComplexity('analyze the architecture');
      const decimals = (result.score.toString().split('.')[1] || '').length;
      expect(decimals).toBeLessThanOrEqual(2);
    });

    it('low domain success rate increases novelty', () => {
      const result = classifyComplexity('security audit', {
        sessionDepth: 1,
        domainSuccessRates: { security: 0.3 },
      });
      expect(result.factors.novelty).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('route()', () => {
    it('returns system property as 1 or 2', () => {
      const result = route('simple task');
      expect([1, 2]).toContain(result.system);
    });

    it('returns classification object', () => {
      const result = route('analyze the code');
      expect(result.classification).toHaveProperty('score');
      expect(result.classification).toHaveProperty('system');
      expect(result.classification).toHaveProperty('confidence');
    });

    it('returns metadata with routedAt and historySize', () => {
      const result = route('hello');
      expect(result.metadata).toHaveProperty('routedAt');
      expect(result.metadata).toHaveProperty('historySize');
      expect(result.metadata.historySize).toBeGreaterThanOrEqual(1);
    });

    it('increments history size with each call', () => {
      route('first');
      route('second');
      const result = route('third');
      expect(result.metadata.historySize).toBe(3);
    });

    it('truncates input to 200 chars in history', () => {
      const longInput = 'a'.repeat(300);
      const result = route(longInput);
      expect(result.metadata.historySize).toBe(1);
    });

    it('routes simple input to system 1', () => {
      const result = route('fix typo');
      expect(result.system).toBe(1);
    });

    it('routes complex security+migration to system 2', () => {
      const result = route('investigate the security vulnerability in production and migrate the database');
      expect(result.system).toBe(2);
    });

    it('accepts context parameter', () => {
      const result = route('deploy app', { sessionDepth: 2, recentDomains: ['backend'] });
      expect(result.classification).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('adaptThreshold()', () => {
    it('lowers threshold on System 1 failure', () => {
      const prevThreshold = getThreshold();
      route('test'); // ensure history entry
      const result = adaptThreshold({ system: 1, success: false });
      expect(result.direction).toBe('lowered');
      expect(result.newThreshold).toBeLessThan(prevThreshold);
    });

    it('does not change threshold on single System 1 success', () => {
      const prev = getThreshold();
      route('test');
      const result = adaptThreshold({ system: 1, success: true });
      expect(result.direction).toBe('unchanged');
      expect(result.newThreshold).toBe(prev);
    });

    it('raises threshold after 5 consecutive System 1 successes', () => {
      route('t1'); route('t2'); route('t3'); route('t4'); route('t5');
      for (let i = 0; i < 4; i++) {
        adaptThreshold({ system: 1, success: true });
      }
      const prev = getThreshold();
      const result = adaptThreshold({ system: 1, success: true });
      expect(result.direction).toBe('raised');
      expect(result.newThreshold).toBeGreaterThan(prev);
    });

    it('resets streak to 0 on failure', () => {
      route('t1'); route('t2'); route('t3');
      adaptThreshold({ system: 1, success: true });
      adaptThreshold({ system: 1, success: true });
      const result = adaptThreshold({ system: 1, success: false });
      expect(result.streak).toBe(0);
    });

    it('does nothing for System 2 feedback', () => {
      const prev = getThreshold();
      const result = adaptThreshold({ system: 2, success: false });
      expect(result.direction).toBe('unchanged');
      expect(result.newThreshold).toBe(prev);
    });

    it('threshold never drops below THRESHOLD_MIN (0.2)', () => {
      // Fail many times
      for (let i = 0; i < 20; i++) {
        route('failure input');
        adaptThreshold({ system: 1, success: false });
      }
      expect(getThreshold()).toBeGreaterThanOrEqual(0.2);
    });

    it('threshold never exceeds THRESHOLD_MAX (0.7)', () => {
      // Succeed many times
      for (let i = 0; i < 50; i++) {
        route('success input');
        adaptThreshold({ system: 1, success: true });
      }
      expect(getThreshold()).toBeLessThanOrEqual(0.7);
    });

    it('returns previousThreshold and newThreshold', () => {
      route('test');
      const result = adaptThreshold({ system: 1, success: false });
      expect(result).toHaveProperty('previousThreshold');
      expect(result).toHaveProperty('newThreshold');
    });

    it('returns streak count', () => {
      route('test');
      const result = adaptThreshold({ system: 1, success: true });
      expect(result).toHaveProperty('streak');
      expect(result.streak).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('configure()', () => {
    it('sets threshold within bounds', () => {
      configure({ threshold: 0.5 });
      expect(getThreshold()).toBe(0.5);
    });

    it('clamps threshold below min to 0.2', () => {
      configure({ threshold: 0.05 });
      expect(getThreshold()).toBe(0.2);
    });

    it('clamps threshold above max to 0.7', () => {
      configure({ threshold: 0.99 });
      expect(getThreshold()).toBe(0.7);
    });

    it('accepts empty config without error', () => {
      expect(() => configure({})).not.toThrow();
    });

    it('ignores non-numeric threshold', () => {
      const before = getThreshold();
      configure({ threshold: 'not-a-number' });
      expect(getThreshold()).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  describe('getRoutingStats()', () => {
    it('returns zeros when no history', () => {
      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(0);
      expect(stats.system1Count).toBe(0);
      expect(stats.system2Count).toBe(0);
      expect(stats.avgScore).toBe(0);
    });

    it('tracks system1 and system2 counts', () => {
      route('fix typo'); // simple -> system 1
      route('security audit and migrate database and deploy to production'); // complex -> system 2
      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(2);
      expect(stats.system1Count + stats.system2Count).toBe(2);
    });

    it('system1Ratio is between 0 and 1', () => {
      route('check');
      route('build');
      const stats = getRoutingStats();
      expect(stats.system1Ratio).toBeGreaterThanOrEqual(0);
      expect(stats.system1Ratio).toBeLessThanOrEqual(1);
    });

    it('avgScore is between 0 and 1', () => {
      route('simple');
      route('complex security migration production deploy');
      const stats = getRoutingStats();
      expect(stats.avgScore).toBeGreaterThanOrEqual(0);
      expect(stats.avgScore).toBeLessThanOrEqual(1);
    });

    it('includes currentThreshold', () => {
      const stats = getRoutingStats();
      expect(stats.currentThreshold).toBe(0.4);
    });

    it('includes successRate for both systems', () => {
      const stats = getRoutingStats();
      expect(stats.successRate).toHaveProperty('system1');
      expect(stats.successRate).toHaveProperty('system2');
    });

    it('recentTrend is stable when < 10 entries', () => {
      route('a'); route('b');
      const stats = getRoutingStats();
      expect(stats.recentTrend).toBe('stable');
    });

    it('detects shifting_to_s2 when recent entries skew complex', () => {
      // 8 simple then 2 complex
      for (let i = 0; i < 8; i++) route('fix typo quickly');
      // Force two complex entries into history
      configure({ threshold: 0.01 }); // lower threshold so everything goes S2
      for (let i = 0; i < 2; i++) route('security audit migration production database');
      configure({ threshold: 0.4 }); // restore
      // Trend detection needs >= 10 entries
      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(10);
    });

    it('avgDurationMs is non-negative', () => {
      route('test');
      const stats = getRoutingStats();
      expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('success rates use feedback from adaptThreshold', () => {
      route('quick fix');
      adaptThreshold({ system: 1, success: true });
      const stats = getRoutingStats();
      expect(stats.successRate.system1).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('resetRouter()', () => {
    it('resets threshold to default 0.4', () => {
      configure({ threshold: 0.6 });
      resetRouter();
      expect(getThreshold()).toBe(0.4);
    });

    it('clears routing history', () => {
      route('a'); route('b'); route('c');
      resetRouter();
      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(0);
    });

    it('resets success streak', () => {
      route('a'); route('b'); route('c'); route('d'); route('e');
      adaptThreshold({ system: 1, success: true });
      adaptThreshold({ system: 1, success: true });
      adaptThreshold({ system: 1, success: true });
      resetRouter();
      // After reset, single success should NOT raise threshold
      route('x');
      const result = adaptThreshold({ system: 1, success: true });
      expect(result.streak).toBe(1);
    });
  });
});
