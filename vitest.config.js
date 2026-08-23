/**
 * Root-level vitest config that delegates to plugins/artibot/.
 * Allows running `npx vitest run` from the project root.
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
