/**
 * Root-level vitest config: the canonical plugins/artibot/vitest.config.js,
 * re-exported with an absolute `test.root`.
 *
 * Prefer `npm test` from the repo root — it runs the workspace's own pinned
 * runner. This file takes effect whenever vitest is STARTED here: a bare
 * `npx vitest`, and also `npm --prefix plugins/artibot exec -- vitest`, because
 * npm exec keeps the caller's cwd and vitest looks for its config there. For a
 * bare `npx vitest` this package declares no dependencies, so that invocation
 * resolves no local binary: npm runs whatever version its _npx cache happens to
 * hold (measured 2026-08-23: 4.1.11, against a declared 4.0.18). That is not
 * fixed here. CI is unaffected — it runs with
 * `working-directory: plugins/artibot` (.github/workflows/ci.yml).
 *
 * Why re-export instead of a copy: until 2026-09-28 this file was a
 * hand-written subset (shebang stripping only under `scripts/hooks`, a
 * `.js`-only include, no `setupFiles`, no `projects`). Root-started runs then
 * failed on any test importing a shebang `.mjs` script, ran without the
 * state-dir sandbox, and ran `tests/autopilot/**` without its file-serial
 * project. Importing the canonical file leaves `root` as the only setting the
 * two can disagree on, and the gate named below pins that one.
 *
 * Why `root` is overridden: the canonical `root: '.'` is resolved against the
 * process cwd, which here is the repository root, and `setupFiles`, the
 * project includes and the coverage paths are resolved against `root`.
 * Absolute, so the result does not depend on where vitest was started. The
 * `extends: true` projects inherit it (measured 2026-09-28: root-started runs
 * label `tests/autopilot/**` as `autopilot`, and `--coverage` reports `lib/`
 * into plugins/artibot/coverage).
 *
 * The canonical file's `vitest/config` import resolves from its own directory
 * (plugins/artibot/node_modules); nothing here needs a root `node_modules`.
 * Pinned by plugins/artibot/tests/firewall/vitest-root-config.test.js.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pluginConfig from './plugins/artibot/vitest.config.js';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins', 'artibot');

export default {
  ...pluginConfig,
  test: {
    ...pluginConfig.test,
    root: PLUGIN_ROOT,
  },
};
