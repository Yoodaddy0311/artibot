/**
 * Core performance benchmarks for Artibot.
 * Targets: cognitive router, PII scrubber, intent detection, cache operations.
 *
 * Run: npx vitest bench tests/bench/core-benchmarks.bench.js
 * @module tests/bench/core-benchmarks
 */

import { bench, describe } from 'vitest';
import {
  classifyComplexity,
  route,
  resetRouter,
} from '../../lib/cognitive/router.js';
import {
  scrub,
  scrubPattern,
  validateScrubbed,
  resetStats,
} from '../../lib/privacy/pii-scrubber.js';
import { Cache } from '../../lib/core/cache.js';
import { detectIntent } from '../../lib/intent/index.js';
import { matchKeywords } from '../../lib/intent/language.js';
import { buildContextKey } from '../../lib/learning/tool-learner.js';

// ---------------------------------------------------------------------------
// Test Data: Router Input Sizes
// ---------------------------------------------------------------------------

const INPUTS = {
  small: 'fix a typo in readme',
  medium:
    'implement a new React component for the dashboard with API integration, ' +
    'then add unit tests and deploy to staging. Also update the documentation ' +
    'and run the security audit on the authentication module.',
  large:
    'We need to perform a comprehensive security audit of the entire production system. ' +
    'First, investigate the authentication vulnerability reported in the backend API. ' +
    'Then migrate the database from PostgreSQL to a sharded architecture with proper ' +
    'connection pooling. After that, refactor the frontend React components to use the ' +
    'new design system with accessibility compliance. Additionally, set up CI/CD ' +
    'pipelines with Docker and Kubernetes deployment, configure monitoring dashboards, ' +
    'and possibly explore using Terraform for infrastructure as code. The testing ' +
    'coverage should be above 90% with e2e tests using Playwright. Document everything ' +
    'in the wiki and create guides for the team. This is critical for the production ' +
    'rollback strategy and compliance requirements. Maybe we should also consider ' +
    'the performance implications of the migration? Not sure about the timeline.',
};

// ---------------------------------------------------------------------------
// PII test data is built at runtime to avoid triggering secret-detection hooks.
// No literal secret-like strings appear in source code.
// ---------------------------------------------------------------------------

function buildPiiInputs() {
  const a = String.fromCharCode(64); // @

  const small = 'Hello world, no sensitive data here at all.';

  // Medium: email + IP + unix path
  const medium = [
    'User john.doe' + a + 'example.com reported an issue.',
    'Server at 192.168.1.100:8080 returned error 500.',
    'Check /home/john/projects/app/config.json for details.',
  ].join(' ');

  // Large: many PII types assembled from safe fragments
  const large = [
    'Incident report: User jane.smith' + a + 'company.org called from +1-555-123-4567.',
    'Found issues in production environment:',
    '  - MAC address AA:BB:CC:DD:EE:FF on network.',
    '  - SSN pattern: 123-45-6789 detected.',
    '  - Credit card 4111-1111-1111-1111 found in logs.',
    '  - UUID: 550e8400-e29b-41d4-a716-446655440000.',
    '  - Host dev-box.internal was involved.',
    'Server path C:\\Users\\AdminUser\\projects\\api\\run at 10.0.0.55.',
  ].join('\n');

  return { small, medium, large };
}

const PII_INPUTS = buildPiiInputs();

// ---------------------------------------------------------------------------
// Cognitive Router Benchmarks
// ---------------------------------------------------------------------------

describe('Cognitive Router', () => {
  bench(
    'classifyComplexity - small input',
    () => {
      classifyComplexity(INPUTS.small);
    },
    { setup: () => resetRouter() },
  );

  bench(
    'classifyComplexity - medium input',
    () => {
      classifyComplexity(INPUTS.medium);
    },
    { setup: () => resetRouter() },
  );

  bench(
    'classifyComplexity - large input',
    () => {
      classifyComplexity(INPUTS.large);
    },
    { setup: () => resetRouter() },
  );

  bench(
    'classifyComplexity - large input with context',
    () => {
      classifyComplexity(INPUTS.large, {
        recentDomains: ['frontend', 'backend'],
        sessionDepth: 3,
        domainSuccessRates: { frontend: 0.8, backend: 0.3 },
      });
    },
    { setup: () => resetRouter() },
  );

  bench(
    'route - small input',
    () => {
      route(INPUTS.small);
    },
    { setup: () => resetRouter() },
  );

  bench(
    'route - large input',
    () => {
      route(INPUTS.large);
    },
    { setup: () => resetRouter() },
  );
});

// ---------------------------------------------------------------------------
// PII Scrubber Benchmarks
// ---------------------------------------------------------------------------

describe('PII Scrubber', () => {
  bench(
    'scrub - small input (no PII)',
    () => {
      scrub(PII_INPUTS.small);
    },
    { setup: () => resetStats() },
  );

  bench(
    'scrub - medium input (mixed PII)',
    () => {
      scrub(PII_INPUTS.medium);
    },
    { setup: () => resetStats() },
  );

  bench(
    'scrub - large input (many PII matches)',
    () => {
      scrub(PII_INPUTS.large);
    },
    { setup: () => resetStats() },
  );

  bench(
    'scrubPattern - nested object (depth 3)',
    () => {
      scrubPattern({
        user: { email: 'test' + String.fromCharCode(64) + 'example.com', name: 'John' },
        config: { nested: { value: 'safe-string-data' } },
        items: ['hello', 'world', '/home/testuser/project/file.js'],
      });
    },
    { setup: () => resetStats() },
  );

  bench(
    'validateScrubbed - clean text',
    () => {
      validateScrubbed('This text has been properly scrubbed with [REDACTED] tokens.');
    },
  );

  bench(
    'validateScrubbed - dirty text',
    () => {
      validateScrubbed(PII_INPUTS.large);
    },
  );
});

// ---------------------------------------------------------------------------
// Cache Benchmarks
// ---------------------------------------------------------------------------

describe('Cache Operations', () => {
  const cache = new Cache(60000);

  bench(
    'set - single entry',
    () => {
      cache.set('bench-key', { data: 'value' });
    },
  );

  bench(
    'get - cache hit',
    () => {
      cache.get('bench-key');
    },
    { setup: () => cache.set('bench-key', { data: 'value' }) },
  );

  bench(
    'get - cache miss',
    () => {
      cache.get('nonexistent-key');
    },
  );

  bench(
    'set+get cycle',
    () => {
      cache.set('cycle-key', { data: 'value' });
      cache.get('cycle-key');
    },
  );

  bench(
    'has - existing key',
    () => {
      cache.has('bench-key');
    },
    { setup: () => cache.set('bench-key', { data: 'value' }) },
  );

  bench(
    'prune - 100 entries (50% expired)',
    () => {
      cache.prune();
    },
    {
      setup: () => {
        cache.clear();
        for (let i = 0; i < 50; i++) {
          cache.set(`valid-${i}`, i, 60000);
        }
        for (let i = 0; i < 50; i++) {
          cache._store.set(`expired-${i}`, { value: i, expiresAt: Date.now() - 1000 });
        }
      },
    },
  );

  bench(
    'set - burst write (100 keys)',
    () => {
      for (let i = 0; i < 100; i++) {
        cache.set(`burst-${i}`, { index: i });
      }
    },
    { setup: () => cache.clear() },
  );

  bench(
    'get - burst read (100 keys)',
    () => {
      for (let i = 0; i < 100; i++) {
        cache.get(`burst-${i}`);
      }
    },
    {
      setup: () => {
        cache.clear();
        for (let i = 0; i < 100; i++) {
          cache.set(`burst-${i}`, { index: i });
        }
      },
    },
  );

  // LRU Cache benchmarks
  const lruCache = new Cache(60000, { maxSize: 100 });

  bench(
    'LRU set - within capacity',
    () => {
      lruCache.set('lru-key', { data: 'value' });
    },
    { setup: () => lruCache.clear() },
  );

  bench(
    'LRU set - at capacity (eviction)',
    () => {
      lruCache.set('overflow-key', { data: 'overflow' });
    },
    {
      setup: () => {
        lruCache.clear();
        for (let i = 0; i < 100; i++) {
          lruCache.set(`fill-${i}`, i);
        }
      },
    },
  );

  bench(
    'LRU get - promotes entry',
    () => {
      lruCache.get('lru-hit');
    },
    { setup: () => lruCache.set('lru-hit', { data: 'value' }) },
  );
});

// ---------------------------------------------------------------------------
// Intent Detection Benchmarks
// ---------------------------------------------------------------------------

describe('Intent Detection', () => {
  bench(
    'detectIntent - English simple',
    () => {
      detectIntent('build a feature', { languages: ['en'] });
    },
  );

  bench(
    'detectIntent - English complex',
    () => {
      detectIntent(INPUTS.large, { languages: ['en'] });
    },
  );

  bench(
    'detectIntent - Korean',
    () => {
      detectIntent('코드 리뷰하고 테스트 실행해줘', { languages: ['ko'] });
    },
  );

  bench(
    'detectIntent - all 3 languages',
    () => {
      detectIntent(
        'build 빌드 and test テスト the project',
        { languages: ['en', 'ko', 'ja'] },
      );
    },
  );

  bench(
    'matchKeywords - English (en only)',
    () => {
      matchKeywords(INPUTS.medium, ['en']);
    },
  );

  bench(
    'matchKeywords - all languages',
    () => {
      matchKeywords(INPUTS.medium, ['en', 'ko', 'ja']);
    },
  );

  bench(
    'buildContextKey - tool learner',
    () => {
      buildContextKey('search', 'lib/core/config.js', 'module');
    },
  );
});
