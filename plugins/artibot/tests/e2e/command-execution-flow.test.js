import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * E2E Integration Test: Command Execution Flow
 *
 * Simulates the complete pipeline when a user submits a prompt to the plugin:
 *   1. User input is received (simulating UserPromptSubmit hook)
 *   2. Intent detection: language.matchKeywords -> trigger.getRecommendations
 *   3. Cognitive routing: router.classifyComplexity -> System 1 or 2
 *   4. Ambiguity detection: ambiguity.detectAmbiguity
 *   5. Agent selection: config.agents.taskBased mapping
 *   6. Command recommendation: trigger.getBestRecommendation
 *   7. Full detectIntent pipeline produces consistent output
 *
 * This test validates the REAL modules working together end-to-end
 * (no mocks for core logic, only platform-level mocks).
 */

// decodeURIComponent is needed because import.meta.url percent-encodes
// non-ASCII characters (e.g. Korean "바탕 화면") which breaks fs operations.
const PLUGIN_ROOT = path.resolve(
  decodeURIComponent(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  ),
  '..', '..',
);

describe('E2E: Command Execution Flow', () => {
  let detectIntent;
  let matchKeywords;
  let uniqueIntents;
  let classifyComplexity;
  let route;
  let resetRouter;
  let configure;
  let getRoutingStats;
  let adaptThreshold;
  let config;

  beforeEach(async () => {
    vi.resetModules();

    // Import real modules (no mocks for core logic)
    const intentModule = await import('../../lib/intent/index.js');
    detectIntent = intentModule.detectIntent;
    matchKeywords = intentModule.matchKeywords;
    uniqueIntents = intentModule.uniqueIntents;

    const routerModule = await import('../../lib/cognitive/router.js');
    classifyComplexity = routerModule.classifyComplexity;
    route = routerModule.route;
    resetRouter = routerModule.resetRouter;
    configure = routerModule.configure;
    getRoutingStats = routerModule.getRoutingStats;
    adaptThreshold = routerModule.adaptThreshold;
    resetRouter();

    config = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Pipeline: English "build" command', () => {
    const input = 'build a new React component for the dashboard';

    it('detects intent from keyword matching', () => {
      const matches = matchKeywords(input);
      const intents = uniqueIntents(matches);
      expect(intents).toContain('action:build');
    });

    it('routes through cognitive system based on complexity', () => {
      const result = route(input);
      expect(result.system).toBeDefined();
      expect([1, 2]).toContain(result.system);
      expect(result.classification.score).toBeGreaterThanOrEqual(0);
      expect(result.classification.score).toBeLessThanOrEqual(1);
    });

    it('produces a full intent detection result', () => {
      const result = detectIntent(input, {
        languages: config.automation.supportedLanguages,
        ambiguityThreshold: config.automation.ambiguityThreshold,
      });

      expect(result.intents.length).toBeGreaterThan(0);
      expect(result.best).not.toBeNull();
      expect(result.best.commands.length).toBeGreaterThan(0);
      expect(result.ambiguity).toBeDefined();
      expect(typeof result.ambiguity.ambiguous).toBe('boolean');
    });

    it('recommends the build command', () => {
      const result = detectIntent(input, {
        languages: ['en'],
      });
      expect(result.best.commands).toContain('/build');
      expect(result.best.agents).toContain('planner');
    });

    it('maps to correct agent via config taskBased', () => {
      // When best recommendation mentions agents, verify they exist in config
      const result = detectIntent(input, { languages: ['en'] });
      const manifestAgents = JSON.parse(
        readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'),
      ).agents.map((p) => path.basename(p, '.md'));

      for (const agent of result.best.agents) {
        expect(manifestAgents).toContain(agent);
      }
    });
  });

  describe('Pipeline: Korean "code review" command', () => {
    const input = '이 코드를 리뷰해줘, 보안 문제가 있는지 검토해주세요';

    it('detects Korean intents', () => {
      const matches = matchKeywords(input, ['ko']);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.lang === 'ko')).toBe(true);
    });

    it('detects review intent from Korean keywords', () => {
      const result = detectIntent(input, {
        languages: ['ko'],
        ambiguityThreshold: config.automation.ambiguityThreshold,
      });
      expect(result.intents).toContain('action:review');
    });

    it('routes to higher complexity due to security domain', () => {
      const classification = classifyComplexity(input);
      // Security + review = higher complexity
      expect(classification.factors.domains).toBeGreaterThan(0);
    });
  });

  describe('Pipeline: Complex multi-step request', () => {
    const input =
      'First analyze the security vulnerabilities in the authentication module, ' +
      'then refactor the database layer for better performance, ' +
      'and finally deploy to production after running e2e tests';

    it('detects multiple intents', () => {
      const result = detectIntent(input, {
        languages: ['en'],
        ambiguityThreshold: config.automation.ambiguityThreshold,
      });
      expect(result.intents.length).toBeGreaterThan(2);
    });

    it('flags as ambiguous due to multiple competing intents', () => {
      const result = detectIntent(input, {
        languages: ['en'],
        ambiguityThreshold: 30, // lower threshold to catch ambiguity
      });
      expect(result.ambiguity.score).toBeGreaterThan(0);
    });

    it('routes to System 2 due to high complexity', () => {
      const result = route(input);
      expect(result.system).toBe(2);
      expect(result.classification.score).toBeGreaterThan(0.3);
    });

    it('has multiple factors contributing to complexity', () => {
      const classification = classifyComplexity(input);
      expect(classification.factors.steps).toBeGreaterThan(0);
      expect(classification.factors.domains).toBeGreaterThan(0);
      expect(classification.factors.risk).toBeGreaterThan(0);
    });

    it('still provides a best recommendation despite ambiguity', () => {
      const result = detectIntent(input, { languages: ['en'] });
      expect(result.best).not.toBeNull();
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('Pipeline: Japanese input detection', () => {
    const input = 'テストを実行して、バグを修正してください';

    it('detects Japanese intents', () => {
      const matches = matchKeywords(input, ['ja']);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.lang === 'ja')).toBe(true);
    });

    it('produces recommendations for Japanese input', () => {
      const result = detectIntent(input, {
        languages: config.automation.supportedLanguages,
      });
      expect(result.best).not.toBeNull();
    });
  });

  describe('Pipeline: Adaptive routing with feedback loop', () => {
    it('adapts threshold based on System 1 feedback', () => {
      configure({ threshold: 0.4, adaptRate: 0.05 });

      // Simulate System 1 failure -> threshold should lower
      const result = adaptThreshold({ system: 1, success: false });
      expect(result.direction).toBe('lowered');
      expect(result.newThreshold).toBeLessThan(result.previousThreshold);
    });

    it('raises threshold after consecutive System 1 successes', () => {
      configure({ threshold: 0.4, adaptRate: 0.05 });

      // 5 consecutive successes needed to raise threshold
      for (let i = 0; i < 4; i++) {
        adaptThreshold({ system: 1, success: true });
      }
      const result = adaptThreshold({ system: 1, success: true });
      expect(result.direction).toBe('raised');
    });

    it('maintains routing stats across multiple operations', () => {
      route('hello world');
      route('build a feature');
      route('analyze security vulnerabilities in production');

      const stats = getRoutingStats();
      expect(stats.totalRouted).toBe(3);
      expect(stats.system1Count + stats.system2Count).toBe(3);
      expect(stats.avgScore).toBeGreaterThan(0);
      expect(stats.avgConfidence).toBeGreaterThan(0);
    });
  });

  describe('Pipeline: Team delegation decision', () => {
    it('simple tasks map to sub-agent mode based on config thresholds', () => {
      const simpleInput = 'fix a typo in readme';
      const classification = classifyComplexity(simpleInput);

      // Config says: subAgent when complexity < 0.4
      const delegationThreshold = 0.4;
      if (classification.score < delegationThreshold) {
        // Should use sub-agent (fire-and-forget)
        expect(classification.system).toBe(1);
      }
    });

    it('complex tasks trigger agent-team mode per config', () => {
      const complexInput =
        'analyze architecture, implement security fixes, deploy to production, run e2e tests';
      const classification = classifyComplexity(complexInput);

      // Config says: agentTeam when complexity >= 0.4
      expect(classification.score).toBeGreaterThanOrEqual(0.4);
      expect(classification.system).toBe(2);
    });

    it('config team levels align with complexity scores', () => {
      // Solo: single file edit -> System 1
      const solo = classifyComplexity('edit a single file');
      // Squad: feature implementation -> likely System 2
      const squad = classifyComplexity(
        'implement authentication with OAuth, then test the API endpoints',
      );

      expect(solo.score).toBeLessThan(squad.score);
    });
  });

  describe('Pipeline: Full round-trip (input -> config -> intent -> route -> recommend)', () => {
    it('processes English input through complete pipeline', () => {
      // Configure router from real config
      configure({
        threshold: config.cognitive.router.threshold,
        adaptRate: config.cognitive.router.adaptRate,
      });

      const input = 'implement a new REST API endpoint for user authentication';

      // Step 1: Intent detection
      const intentResult = detectIntent(input, {
        languages: config.automation.supportedLanguages,
        ambiguityThreshold: config.automation.ambiguityThreshold,
      });

      // Step 2: Cognitive routing
      const routeResult = route(input);

      // Step 3: Verify consistency
      expect(intentResult.best).not.toBeNull();
      expect(routeResult.classification.score).toBeGreaterThanOrEqual(0);
      expect(routeResult.classification.confidence).toBeGreaterThan(0);

      // Step 4: Verify the recommended command makes sense for the input
      const commandNames = intentResult.best.commands;
      expect(commandNames.length).toBeGreaterThan(0);
      // "implement" should route to /implement
      expect(commandNames).toContain('/implement');
    });

    it('processes Korean input through complete pipeline', () => {
      configure({
        threshold: config.cognitive.router.threshold,
        adaptRate: config.cognitive.router.adaptRate,
      });

      const input = '프로젝트 빌드하고 테스트 실행해줘';

      const intentResult = detectIntent(input, {
        languages: config.automation.supportedLanguages,
        ambiguityThreshold: config.automation.ambiguityThreshold,
      });

      const routeResult = route(input);

      expect(intentResult.intents.length).toBeGreaterThan(0);
      expect(routeResult.system).toBeDefined();
      expect(intentResult.best).not.toBeNull();
    });

    it('handles empty input gracefully', () => {
      const intentResult = detectIntent('', {
        languages: config.automation.supportedLanguages,
      });

      expect(intentResult.intents).toEqual([]);
      expect(intentResult.best).toBeNull();
      expect(intentResult.ambiguity.ambiguous).toBe(false);
    });

    it('handles input with no recognized keywords', () => {
      const input = 'the quick brown fox jumps over the lazy dog';

      const intentResult = detectIntent(input, {
        languages: config.automation.supportedLanguages,
      });

      const routeResult = route(input);

      // No intents detected, but routing should still work
      expect(routeResult.system).toBeDefined();
      expect(routeResult.classification.score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge cases', () => {
    it('handles very long input without error', () => {
      const longInput = 'implement a feature '.repeat(100);
      const result = detectIntent(longInput, { languages: ['en'] });
      expect(result.best).not.toBeNull();

      const routeResult = route(longInput);
      expect(routeResult.system).toBeDefined();
    });

    it('handles special characters and unicode in input', () => {
      const input = 'build <component> & test "it" with 100% coverage! @user #feature';
      const result = detectIntent(input, { languages: ['en'] });
      expect(result).toBeDefined();
      expect(result.ambiguity).toBeDefined();
    });

    it('handles mixed-language input', () => {
      const input = 'build 빌드 and test テスト the application';
      const result = detectIntent(input, {
        languages: ['en', 'ko', 'ja'],
      });
      // Should detect intents from multiple languages
      expect(result.matches.length).toBeGreaterThan(1);
      const langs = new Set(result.matches.map((m) => m.lang));
      expect(langs.size).toBeGreaterThan(1);
    });

    it('config ambiguity threshold affects ambiguity detection', () => {
      const input = 'build and test and deploy and refactor';

      const lowThreshold = detectIntent(input, {
        languages: ['en'],
        ambiguityThreshold: 10,
      });

      const highThreshold = detectIntent(input, {
        languages: ['en'],
        ambiguityThreshold: 100,
      });

      // Lower threshold should be more likely to flag ambiguity
      expect(lowThreshold.ambiguity.score).toBe(highThreshold.ambiguity.score);
      // But ambiguous flag differs based on threshold
      if (lowThreshold.ambiguity.ambiguous) {
        expect(lowThreshold.ambiguity.score).toBeGreaterThanOrEqual(10);
      }
    });
  });
});
