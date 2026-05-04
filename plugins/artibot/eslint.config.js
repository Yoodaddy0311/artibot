import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['bin/**/*.{js,mjs}', 'lib/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'server/**/*.js', 'tests/**/*.{js,mjs}'],
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
