import { defineConfig } from 'vitest/config';

/** Strip shebang lines so hook scripts can be imported in tests on Windows. */
function stripShebangPlugin() {
  return {
    name: 'strip-shebang',
    transform(code, id) {
      if (id.includes('scripts/hooks') && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*\n/, ''), map: null };
      }
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
