import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'error',
      'consistent-return': 'error',
      'eqeqeq': 'error',
    },
  },
];
