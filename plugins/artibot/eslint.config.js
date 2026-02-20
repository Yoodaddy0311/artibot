import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'scripts/**/*.js', 'server/**/*.js', 'tests/**/*.js'],
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
      'max-params': ['warn', 5],
      'complexity': ['warn', 20],
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
    files: ['tests/**/*.js'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'max-depth': 'off',
      'complexity': 'off',
    },
  },
];
