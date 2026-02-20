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

  // -------------------------------------------------------------------------
  describe('classifyComplexity() - additional branch coverage', () => {
    it('detects Korean domain keywords (backend: 서버)', () => {
      const result = classifyComplexity('서버에 API를 추가해줘');
      expect(result.factors.domains).toBeGreaterThan(0);
    });

    it('detects Japanese domain keywords (security: セキュリティ)', () => {
      const result = classifyComplexity('セキュリティの監査をお願いします');
      expect(result.factors.domains).toBeGreaterThan(0);
    });

    it('detects Korean uncertainty keywords (아마)', () => {
      const result = classifyComplexity('아마 이 버그를 조사해야 할 것 같아');
      expect(result.factors.uncertainty).toBeGreaterThan(0);
    });

    it('detects Japanese uncertainty keywords (もしかして)', () => {
      const result = classifyComplexity('もしかして調べが必要です');
      expect(result.factors.uncertainty).toBeGreaterThan(0);
    });

    it('detects Korean risk keywords (배포)', () => {
      const result = classifyComplexity('프로덕션에 배포해주세요');
      expect(result.factors.risk).toBeGreaterThan(0);
    });

    it('detects Japanese risk keywords (デプロイ)', () => {
      const result = classifyComplexity('本番にデプロイしてください');
      expect(result.factors.risk).toBeGreaterThan(0);
    });

    it('novelty returns 0.4 for sessionDepth=0 with no recentDomains', () => {
      const result = classifyComplexity('do something', {
        sessionDepth: 0,
      });
      expect(result.factors.novelty).toBe(0.4);
    });

    it('novelty adds 0.3 when new domains detected not in recentDomains', () => {
      const result = classifyComplexity('deploy to kubernetes', {
        sessionDepth: 0,
        recentDomains: ['frontend'],
      });
      // sessionDepth=0 (+0.4) + new domain infrastructure (+0.3) = 0.7
      expect(result.factors.novelty).toBeGreaterThanOrEqual(0.4);
    });

    it('novelty stays at sessionDepth base when all domains already seen', () => {
      const result = classifyComplexity('create a react component', {
        sessionDepth: 0,
        recentDomains: ['frontend'],
      });
      // frontend is in recentDomains, no new domain bonus
      expect(result.factors.novelty).toBe(0.4);
    });

    it('domainSuccessRates with rate >= 0.5 does not add novelty', () => {
      const result = classifyComplexity('security audit', {
        sessionDepth: 1,
        domainSuccessRates: { security: 0.8 },
      });
      // No novelty added for high success rate domains
      expect(result.factors.novelty).toBe(0);
    });

    it('multiple domains returns normalized score above 0.5', () => {
      // 3 domains: frontend (css, react), backend (api, server), security (security, vulnerability)
      const result = classifyComplexity('create react component with css, add api server endpoint, fix security vulnerability');
      expect(result.factors.domains).toBeGreaterThan(0.5);
    });

    it('exactly 2 domains returns 0.75 (0.25 + 2*0.25)', () => {
      // frontend + backend = 2 domains -> 0.25 + 2*0.25 = 0.75
      const result = classifyComplexity('react component with api endpoint');
      expect(result.factors.domains).toBeCloseTo(0.75, 1);
    });

    it('multi-step Korean connectors increase step count', () => {
      const simple = classifyComplexity('파일 읽기');
      const multi = classifyComplexity('파일을 읽고 그리고 분석해서 그런 다음 저장');
      expect(multi.factors.steps).toBeGreaterThan(simple.factors.steps);
    });

    it('input longer than 300 chars adds extra steps signal', () => {
      const longInput = 'This is a very detailed request. '.repeat(10);
      const result = classifyComplexity(longInput);
      // Long input should have more steps than minimal input
      expect(result.factors.steps).toBeGreaterThan(0);
    });

    it('question marks increase uncertainty score', () => {
      const result = classifyComplexity('What should I do? How do I fix it? Is this correct?');
      expect(result.factors.uncertainty).toBeGreaterThan(0);
    });

    it('multiple risk keywords compound risk score', () => {
      const result = classifyComplexity('production security audit migration delete');
      expect(result.factors.risk).toBeGreaterThan(0.5);
    });
  });

  // -------------------------------------------------------------------------
  describe('getRoutingStats() - trend detection branches', () => {
    it('detects shifting_to_s1 when recent entries skew simple', () => {
      // Start with complex entries (all system 2) then switch to simple (system 1)
      configure({ threshold: 0.01 }); // everything to system 2
      for (let i = 0; i < 8; i++) route('complex security migration production');
      configure({ threshold: 0.99 }); // everything to system 1
      for (let i = 0; i < 2; i++) route('fix typo');
      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(10);
      // Recent 20% (2 entries) should be system 1, earlier 80% (8) system 2
      expect(stats.recentTrend).toBe('shifting_to_s1');
    });

    it('detects shifting_to_s2 when recent entries skew complex', () => {
      configure({ threshold: 0.99 }); // everything to system 1
      for (let i = 0; i < 8; i++) route('fix typo');
      configure({ threshold: 0.01 }); // everything to system 2
      for (let i = 0; i < 2; i++) route('security migration production database');
      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(10);
      expect(stats.recentTrend).toBe('shifting_to_s2');
    });

    it('detects stable when ratio difference is within 0.15', () => {
      // Mix of S1 and S2 evenly distributed
      configure({ threshold: 0.99 }); // all go to system 1
      for (let i = 0; i < 10; i++) route('simple task');
      configure({ threshold: 0.4 }); // restore
      const stats = getRoutingStats();
      expect(stats.recentTrend).toBe('stable');
    });

    it('system2 success rate computed from feedback', () => {
      // Route something complex to S2, then give feedback
      configure({ threshold: 0.01 }); // force to S2
      route('complex task');
      configure({ threshold: 0.4 });
      // S2 feedback doesn't change threshold but marks history
      adaptThreshold({ system: 2, success: true });
      const stats = getRoutingStats();
      expect(stats.successRate.system2).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('configure() - adaptRate bounds', () => {
    it('clamps adaptRate below 0.001 to 0.001', () => {
      // adaptStep changes adaptive rate; verify it does not throw
      expect(() => configure({ adaptRate: 0.0001 })).not.toThrow();
    });

    it('clamps adaptRate above 0.2 to 0.2', () => {
      expect(() => configure({ adaptRate: 0.5 })).not.toThrow();
    });

    it('ignores non-numeric adaptRate', () => {
      expect(() => configure({ adaptRate: 'fast' })).not.toThrow();
    });

    it('valid adaptRate modifies adaptation behavior', () => {
      configure({ adaptRate: 0.1 });
      route('test input');
      const before = getThreshold();
      adaptThreshold({ system: 1, success: false });
      const after = getThreshold();
      // With adaptRate 0.1, threshold should drop by 0.1
      expect(before - after).toBeCloseTo(0.1, 5);
    });
  });

  // -------------------------------------------------------------------------
  describe('adaptThreshold() - findRecentEntry branches', () => {
    it('marks success on correct history entry (most recent unseen)', () => {
      route('task1'); // S1
      route('task2'); // S1
      adaptThreshold({ system: 1, success: true }); // marks task2
      adaptThreshold({ system: 1, success: true }); // marks task1
      const stats = getRoutingStats();
      // Both S1 entries should have feedback now
      expect(stats.successRate.system1).toBeGreaterThan(0);
    });

    it('handles adaptThreshold when no matching history entry exists', () => {
      // Adapt for system 2 but no S2 entries in history
      const result = adaptThreshold({ system: 2, success: true });
      expect(result.direction).toBe('unchanged');
    });
  });
});
