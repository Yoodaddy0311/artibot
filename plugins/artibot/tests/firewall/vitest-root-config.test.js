/**
 * Firewall — the repository-root `vitest.config.js` resolves to the same test
 * settings as the canonical `plugins/artibot/vitest.config.js`.
 *
 * Why it matters: vitest picks its config from the directory it is started in,
 * not from the package that owns the binary. `npm --prefix plugins/artibot exec
 * -- vitest run …` launched from the repository root keeps the root as its cwd
 * (npm exec does not change directory), so it loads the ROOT file. Measured
 * 2026-09-28 on vitest 4.0.18 against the root file as it stood then (a
 * hand-written copy: shebang stripping for `scripts/hooks` only, no
 * `setupFiles`, no `projects`, `.js`-only include):
 *   - `tests/evals/routebench-replay-mode.test.js`, which imports the
 *     shebang-bearing `scripts/bench/routebench.mjs`, failed with
 *     `SyntaxError: Invalid or unexpected token` and 0 tests;
 *   - the summary read `setup 0ms` — the state-dir sandbox never ran, so
 *     anything reaching a user-state writer touched the real `~/.claude`;
 *   - `tests/autopilot/**` was collected with no project name, i.e. with none
 *     of the autopilot project's file-serial execution.
 * The same files are green, sandboxed and serial from inside `plugins/artibot`.
 *
 * Two layers, because they fail differently:
 *   1. The config OBJECT. Every `test` key of the canonical config except
 *      `root` must be equal in the root config, `root` must be the plugin
 *      directory as an absolute path (a relative one is resolved against the
 *      caller's cwd, not against the config file), the top-level keys must
 *      match, and the root's strip-shebang plugin must actually strip a
 *      shebang outside `scripts/hooks`.
 *   2. RESOLUTION. A child `vitest list --filesOnly` started in the repository
 *      root with no `--config` must name the `autopilot` and `main` projects.
 *      Only this observes what the object cannot: that the root file loads at
 *      all from a directory with no `node_modules` (the only package import is
 *      the plugin file's `vitest/config`, resolved from the plugin directory),
 *      and that `extends: true` projects
 *      inherit the overridden absolute `root` rather than the cwd.
 *
 * The autopilot project's serial spelling is pinned on the root config too, by
 * `tests/firewall/vitest-autopilot-serial.test.js`.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **The runner version.** The child runs the plugin's pinned binary. A bare
 *     `npx vitest` from the root resolves no local binary (the root package
 *     declares no dependencies) and runs whatever the npx cache holds; this
 *     gate says nothing about that version or how it reads this config.
 *   - **A run given `--config` or `--root` explicitly.** Those pick another
 *     file or override the root this gate checks.
 *   - **Any cwd other than the repository root.** npm and vitest resolve the
 *     config from the starting directory; only the root is exercised here.
 *   - **Setup execution.** `--filesOnly` imports no test module, so no setup
 *     file runs in the child. That the root config REGISTERS the sandbox setup
 *     is layer 1 (equality with the canonical config); that the canonical
 *     config registers it once and every project inherits it is
 *     `tests/firewall/autopilot-store-sandbox-required.test.js`.
 *   - **Coverage from the root.** `coverage` is compared as an object and its
 *     relative paths share the absolute `root`; no coverage run is made.
 *   - **Runtime serialism.** Project membership is observed, not whether two
 *     autopilot files actually stopped overlapping.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import rootConfig from '../../../../vitest.config.js';
import pluginConfig from '../../vitest.config.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const VITEST_BIN = path.join(PLUGIN_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const AUTOPILOT_PROBE = 'tests/autopilot/goal-schema.test.js';
const MAIN_PROBE = 'tests/evals/routebench-replay-mode.test.js';

/** @param {string} p @returns {string} */
const norm = (p) => path.resolve(p).toLowerCase();

/** @param {object} config @returns {Array<{name: string, enforce: unknown}>} */
const pluginShape = (config) =>
  (config.plugins ?? []).map((p) => ({ name: p?.name, enforce: p?.enforce }));

describe('repo-root vitest config mirrors the canonical plugin config', () => {
  it('sits where this gate expects it', () => {
    expect(existsSync(path.join(REPO_ROOT, 'vitest.config.js'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'plugins', 'artibot', 'vitest.config.js'))).toBe(true);
  });

  it('pins test.root to the plugin directory as an absolute path', () => {
    const { root } = rootConfig.test;
    expect(typeof root).toBe('string');
    expect(path.isAbsolute(root)).toBe(true);
    expect(norm(root)).toBe(norm(PLUGIN_ROOT));
  });

  it('carries every other test key of the canonical config unchanged', () => {
    const { root: _rootRoot, ...rootRest } = rootConfig.test;
    const { root: _pluginRoot, ...pluginRest } = pluginConfig.test;
    // setupFiles, projects (autopilot + main, .mjs include), coverage,
    // timeouts — and the ABSENCE of a top-level include, whose presence
    // creates an implicit extra project that double-counts every test.
    expect(rootRest).toEqual(pluginRest);
  });

  it('has the same top-level keys and plugin order as the canonical config', () => {
    expect(Object.keys(rootConfig).sort()).toEqual(Object.keys(pluginConfig).sort());
    expect(pluginShape(rootConfig)).toEqual(pluginShape(pluginConfig));
  });

  it('strips a shebang outside scripts/hooks', () => {
    const strip = rootConfig.plugins.find((p) => p?.name === 'strip-shebang');
    expect(strip).toBeDefined();
    const id = path.join(PLUGIN_ROOT, 'scripts', 'bench', 'routebench.mjs').split(path.sep).join('/');
    const out = strip.transform('#!/usr/bin/env node\nexport const x = 1;\n', id);
    expect(out?.code).toBe('export const x = 1;\n');
  });
});

describe('vitest started in the repo root resolves the plugin projects', () => {
  /** @type {Array<{file: string, projectName?: string}>} */
  let listed;

  beforeAll(() => {
    // No `--config`, no `--root`: config discovery from the cwd is the subject.
    const res = spawnSync(
      process.execPath,
      [VITEST_BIN, 'list', '--json', '--filesOnly', AUTOPILOT_PROBE, MAIN_PROBE],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0) {
      throw new Error(
        `child vitest list exited ${res.status} (signal ${res.signal})\n`
        + `--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`,
      );
    }
    listed = JSON.parse(res.stdout.slice(res.stdout.indexOf('[')));
  }, 180_000);

  /** @param {string} rel @returns {string|undefined} */
  const projectOf = (rel) =>
    listed.find((e) => norm(e.file) === norm(path.join(PLUGIN_ROOT, rel)))?.projectName;

  it('collects both probe files under the plugin root', () => {
    expect(listed.map((e) => norm(e.file)).sort()).toEqual(
      [AUTOPILOT_PROBE, MAIN_PROBE].map((rel) => norm(path.join(PLUGIN_ROOT, rel))).sort(),
    );
  });

  it('puts tests/autopilot/** in the autopilot project', () => {
    expect(projectOf(AUTOPILOT_PROBE)).toBe('autopilot');
  });

  it('puts everything else in the main project', () => {
    expect(projectOf(MAIN_PROBE)).toBe('main');
  });
});
