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
      // Thresholds: aligned with CLAUDE.md's official "80%+ coverage target".
      // CI on Linux measures ~5-10% lower than Windows local due to v8 coverage
      // instrumentation differences across platforms. Windows local typically
      // shows 90/85/88/90; CI can dip to 84-85%. Setting to 80/78/80/80 keeps
      // the CI gate honest and matches the documented policy.
      thresholds: {
        statements: 80,
        branches: 78,
        functions: 80,
        lines: 80,
      },
    },
  },
});
