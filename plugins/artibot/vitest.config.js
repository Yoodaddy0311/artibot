import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: './coverage',
      include: ['lib/**/*.js'],
      exclude: ['lib/**/index.js', 'lib/adapters/**', 'lib/core/tui.js', 'lib/core/skill-exporter.js', 'scripts/hooks/**'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
