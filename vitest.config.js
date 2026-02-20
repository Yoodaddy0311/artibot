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
  },
};
