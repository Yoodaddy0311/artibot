import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['bin/**/*.{js,mjs}', 'lib/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'server/**/*.js', 'tests/**/*.{js,mjs}', 'hooks/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'consistent-return': 'error',
      'eqeqeq': 'error',
      'max-depth': ['warn', 4],
      // max-params 6 + complexity 30 are the current measured upper bounds
      // for legacy GRPO + middleware functions (neural-policy.runIteration=6,
      // joint-policy.selectJointWith=28, session-capture middleware=25).
      // Refactoring is tracked separately; these caps prevent regression.
      'max-params': ['warn', 6],
      'complexity': ['warn', 30],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-shadow': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      'sort-imports': ['warn', {
        ignoreCase: true,
        ignoreDeclarationSort: true,
        ignoreMemberSort: false,
      }],
    },
  },
  {
    files: ['scripts/**/*.{js,mjs}'],
    rules: {
      'no-console': 'off',
      'complexity': 'off',
    },
  },
  // ---------------------------------------------------------------------------
  // 5-Layer architecture enforcement (see CLAUDE.md "5-Layer Architecture").
  // Upper layers import lower only: 5 Runtime -> 4 Cognitive -> 3 Learning
  // -> 2 Auxiliary -> 1 Core. A lower layer importing an upper layer is a
  // violation. Enforced via the built-in no-restricted-imports rule (zero new
  // deps). Patterns match the import specifier string with minimatch globs, so
  // `**/<layer>/**` catches relative imports at any nesting depth
  // (`../cognitive/x`, `../../cognitive/x`). JSDoc type-only `import('...')`
  // is not an import statement, so it is naturally exempt.
  // ---------------------------------------------------------------------------
  {
    // L1 Core: must not import from ANY higher layer (L2/L3/L4/L5).
    // utils/ = pure leaf helpers (core tier); imported downward by all layers.
    files: ['lib/core/**/*.{js,mjs}', 'lib/utils/**/*.{js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '**/adapters/**', '**/autopilot/**', '**/context/**',
              '**/dispatcher/**', '**/git/**', '**/handoff/**', '**/intent/**',
              '**/mcp/**', '**/observability/**', '**/orchestration/**',
              '**/planning/**', '**/privacy/**', '**/release/**', '**/sdk/**',
              '**/security/**', '**/swarm/**', '**/system/**', '**/tui/**',
              '**/visual/**',
              '**/learning/**', '**/cognitive/**', '**/runtime/**',
            ],
            message:
              'Layer violation: lib/core (L1) must not import from a higher layer. Upper layers import lower only (5->4->3->2->1).',
          },
        ],
      }],
    },
  },
  {
    // L2 Auxiliary: must not import from L3 Learning, L4 Cognitive, L5 Runtime.
    files: [
      'lib/adapters/**/*.{js,mjs}', 'lib/autopilot/**/*.{js,mjs}',
      'lib/context/**/*.{js,mjs}', 'lib/dispatcher/**/*.{js,mjs}',
      'lib/git/**/*.{js,mjs}',
      'lib/intent/**/*.{js,mjs}', 'lib/mcp/**/*.{js,mjs}',
      'lib/observability/**/*.{js,mjs}', 'lib/orchestration/**/*.{js,mjs}',
      'lib/planning/**/*.{js,mjs}', 'lib/privacy/**/*.{js,mjs}',
      'lib/release/**/*.{js,mjs}', 'lib/sdk/**/*.{js,mjs}',
      'lib/security/**/*.{js,mjs}', 'lib/swarm/**/*.{js,mjs}',
      'lib/system/**/*.{js,mjs}', 'lib/tui/**/*.{js,mjs}',
      'lib/visual/**/*.{js,mjs}',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/learning/**', '**/cognitive/**', '**/runtime/**'],
            message:
              'Layer violation: lib auxiliary (L2) must not import from the learning (L3), cognitive (L4), or runtime (L5) layers. Upper layers import lower only (5->4->3->2->1).',
          },
        ],
      }],
    },
  },
  {
    // L3 Learning: must not import from L4 Cognitive, L5 Runtime.
    // handoff/ is a session-handoff aggregation domain at the learning tier
    // (L3): its highest dependency is learning, and only commands consume it.
    // So L3->L3 (handoff->learning) is a sibling import, not a layer violation.
    files: ['lib/learning/**/*.{js,mjs}', 'lib/handoff/**/*.{js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/cognitive/**', '**/runtime/**'],
            message:
              'Layer violation: lib/learning (L3) must not import from the cognitive (L4) or runtime (L5) layers. Upper layers import lower only (5->4->3->2->1).',
          },
        ],
      }],
    },
  },
  {
    // L4 Cognitive: must not import from L5 Runtime.
    files: ['lib/cognitive/**/*.{js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/runtime/**'],
            message:
              'Layer violation: lib/cognitive (L4) must not import from the runtime (L5) layer. Upper layers import lower only (5->4->3->2->1).',
          },
        ],
      }],
    },
  },
  {
    files: ['tests/**/*.{js,mjs}'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'max-depth': 'off',
      'complexity': 'off',
    },
  },
  {
    files: ['tests/**/smoke/**/*.{js,mjs}', 'tests/**/*.smoke.{js,mjs}'],
    rules: {
      'no-console': 'off',
    },
  },
];
