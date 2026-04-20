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
      // Thresholds: aspirational targets are 90/85/88/90 (matched on Windows
      // local development where v8 coverage attribution is more generous).
      // CI on Linux measures ~5% lower for branches and lines on the same
      // codebase due to v8 coverage instrumentation differences across
      // platforms. Setting to the lower envelope so CI gates match reality
      // without lying about coverage.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 85,
        lines: 85,
      },
    },
  },
});
