/**
 * Root-level vitest config that delegates to plugins/artibot/.
 *
 * Prefer `npm test` from the repo root — it runs the workspace's own pinned
 * runner. This file only takes effect for a bare `npx vitest` here, and this
 * package declares no dependencies, so that invocation resolves no local
 * binary: npm runs whatever version its _npx cache happens to hold (measured
 * 2026-08-23: 4.1.11, against a declared 4.0.18). CI is unaffected — it runs
 * with `working-directory: plugins/artibot` (.github/workflows/ci.yml).
 *
 * The strip-shebang plugin is needed because hook scripts start with
 * #!/usr/bin/env node which vitest's VM evaluator cannot parse.
 */
export default {
  plugins: [
    {
      name: 'strip-shebang',
      transform(code, id) {
        if (id.includes('scripts/hooks') && code.startsWith('#!')) {
          return { code: code.replace(/^#![^\n]*\n/, ''), map: null };
        }
      },
    },
  ],
  test: {
    root: 'plugins/artibot',
    include: ['tests/**/*.test.js'],
    // Must match plugins/artibot/vitest.config.js — that file is the canonical
    // config and states the reason (Windows child-process cold start blows past
    // vitest's 5s default). Delegating `root` does NOT inherit its settings, so
    // omitting these silently gave the same suite two different ceilings
    // depending on the directory `vitest` was invoked from. Observed 2026-08-23:
    // cowork-plugin-zip-drift's pack-and-compare takes ~5.4s, so it passed from
    // plugins/artibot and timed out from here — and the timeout was misread as
    // a byte-drift failure. Keep the two files in lockstep.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
