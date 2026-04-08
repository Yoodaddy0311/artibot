import { defineConfig } from 'vitest/config';

/** Strip shebang lines so CLI scripts can be imported in tests on Windows. */
function stripShebangPlugin() {
  return {
    name: 'strip-shebang',
    enforce: 'pre',
    transform(code) {
      if (typeof code === 'string' && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*\n?/, ''), map: null };
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [stripShebangPlugin()],
  test: {
    root: '.',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      reporter: ['text', 'json', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['lib/**/*.js'],
      exclude: [
        'lib/**/index.js',
        'lib/core/tui.js',
        'lib/core/skill-exporter.js',
        'scripts/hooks/**',
        'tests/**',
        'node_modules/**',
        'templates/**',
        '_reports/**',
        '_benchmarks/**',
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 88,
        lines: 90,
      },
    },
  },
});
