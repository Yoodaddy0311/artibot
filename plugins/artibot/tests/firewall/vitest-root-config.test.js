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
 * Three layers, because they fail differently:
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
 *   3. EXECUTION. A child `vitest run` started in the repository root with no
 *      `--config`, over two real suite files, must pass both:
 *      `tests/scripts/nightly-session-rollup-smoke.test.js` imports the
 *      shebang-bearing `scripts/hooks/nightly-session-rollup.mjs` through the
 *      vite transform pipeline (43 lines, the smallest of the 38 test files
 *      that import one of the 45 shebang `.mjs` files under `scripts/` and
 *      `lib/`, counted 2026-09-28), and
 *      `tests/firewall/autopilot-store-sandbox-required.test.js`, whose
 *      "resolves the store into a temp directory" case is red unless the
 *      sandbox setup ran IN THAT CHILD. Two positive controls repeat the run
 *      through a copy of the root config derived in memory and handed over
 *      with `--config` — one without the strip-shebang plugin, one without
 *      `setupFiles` — and each must go red on its own file.
 *
 * EVERY CHILD GETS A SCRUBBED ENV. This file runs inside a vitest worker whose
 * env carries what the setup file assigned (read from its source below, so a
 * variable added there later is scrubbed too) and what the runner injects
 * (`VITEST*`, `TEST`, `NODE_ENV`, `FORCE_TTY` from the pool; `BASE_URL`,
 * `MODE`, `DEV`, `PROD`, `SSR` mirrored from `import.meta.env` — all 18 keys
 * listed by a probe fixture on vitest 4.0.18, none present in the shell).
 * Inherited, the setup's pair makes a child look sandboxed whether or not ITS
 * config ran the setup. Measured 2026-09-28: the minus-`setupFiles` control
 * was GREEN under the inherited env (1 passed, 12 filtered) and red once
 * scrubbed; the real-config run, the minus-strip control and layer 2 gave the
 * same verdict under both envs.
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
 *     file or override the root this gate checks. The positive controls use
 *     `--config` only to prove layer 3 can go red; they say nothing about
 *     such runs.
 *   - **Any cwd other than the repository root.** npm and vitest resolve the
 *     config from the starting directory; only the root is exercised here.
 *   - **Setup in the autopilot project, or beyond one consumer.** Layer 3 runs
 *     one `main` file and observes the setup through the autopilot-store
 *     resolver alone. That every project inherits the setup is
 *     `tests/firewall/autopilot-store-sandbox-required.test.js` against the
 *     canonical config, plus layer 1's equality.
 *   - **Other shebang shapes.** One static import of one `scripts/hooks`
 *     `.mjs` is run; a dynamic `import()` or a shebang `.js` module is not.
 *   - **An injected key outside the scrub.** A later runner that injects a
 *     new variable passes it to the child. The minus-`setupFiles` control
 *     turns the gate red if that variable masks the autopilot-store resolver;
 *     masking of anything else is invisible.
 *   - **Coverage from the root.** `coverage` is compared as an object and its
 *     relative paths share the absolute `root`; no coverage run is made.
 *   - **Runtime serialism.** Project membership is observed, not whether two
 *     autopilot files actually stopped overlapping.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';

import rootConfig from '../../../../vitest.config.js';
import pluginConfig from '../../vitest.config.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const ROOT_CONFIG = path.join(REPO_ROOT, 'vitest.config.js');
const VITEST_BIN = path.join(PLUGIN_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SETUP_FILE = path.join(PLUGIN_ROOT, 'tests', 'setup', 'state-dir.js');

const AUTOPILOT_PROBE = 'tests/autopilot/goal-schema.test.js';
const MAIN_PROBE = 'tests/evals/routebench-replay-mode.test.js';
const SHEBANG_PROBE = 'tests/scripts/nightly-session-rollup-smoke.test.js';
const SANDBOX_PROBE = 'tests/firewall/autopilot-store-sandbox-required.test.js';
const SANDBOX_CASE = 'resolves the store into a temp directory, not the real one';

/** Every name the setup file assigns on `process.env`, read from its source. */
const SETUP_ENV_KEYS = [
  ...readFileSync(SETUP_FILE, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)\s*=(?!=)/g),
].map((m) => m[1]);

/** Runner-injected worker keys that carry no `VITEST`/`VITE_` prefix. */
const RUNNER_ENV_KEYS = ['TEST', 'NODE_ENV', 'FORCE_TTY', 'BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR'];

/** @param {string} key @returns {boolean} */
const isParentRunKey = (key) => SETUP_ENV_KEYS.includes(key) || RUNNER_ENV_KEYS.includes(key)
  || key.startsWith('VITEST') || key.startsWith('VITE_');

/** This worker's env minus what the parent run put there — see the header. */
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !isParentRunKey(key)),
);

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
      { cwd: REPO_ROOT, env: CHILD_ENV, encoding: 'utf8', timeout: 120_000 },
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

describe('child env scrub', () => {
  it('reads the setup variables from the setup file itself', () => {
    // A regex that stopped matching would scrub nothing and fail open.
    expect(SETUP_ENV_KEYS).toEqual(expect.arrayContaining([
      'ARTIBOT_STATE_DIR', 'ARTIBOT_AUTOPILOT_STORE_DIR', 'ARTIBOT_DECISIONS_STORE_DIR',
    ]));
  });

  it('hands children none of the parent run keys present in this worker', () => {
    expect(Object.keys(process.env).filter(isParentRunKey)).toContain('VITEST');
    expect(Object.keys(CHILD_ENV).filter(isParentRunKey)).toEqual([]);
  });
});

describe('vitest run started in the repo root executes through the root config', () => {
  /** @type {string} */
  let scratch;
  /** @type {{status: number|null, files: Array<object>}} */
  let real;
  /** @type {{status: number|null, files: Array<object>}} */
  let noStrip;
  /** @type {{status: number|null, files: Array<object>}} */
  let noSetup;

  /**
   * One child `vitest run` from the repo root with a JSON report. A missing
   * report throws with both streams, so a child that never started cannot
   * read as a red control.
   * @param {string} label @param {string[]} args
   * @returns {{status: number|null, files: Array<object>}}
   */
  const runChild = (label, args) => {
    const report = path.join(scratch, `${label}.json`);
    const res = spawnSync(
      process.execPath,
      [VITEST_BIN, 'run', ...args, '--reporter=json', `--outputFile=${report}`],
      { cwd: REPO_ROOT, env: CHILD_ENV, encoding: 'utf8', timeout: 120_000 },
    );
    if (!existsSync(report)) {
      throw new Error(
        `child vitest ${label} wrote no report: exit ${res.status} (signal ${res.signal})\n`
        + `--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`,
      );
    }
    return { status: res.status, files: JSON.parse(readFileSync(report, 'utf8')).testResults };
  };

  /**
   * The root config minus one piece, as a module importing the real file.
   * @param {string} label @param {string} body - Expression over `c`.
   * @returns {string} Config path.
   */
  const derivedConfig = (label, body) => {
    const file = path.join(scratch, `${label}.vitest.config.mjs`);
    const url = JSON.stringify(pathToFileURL(ROOT_CONFIG).href);
    writeFileSync(file, `import c from ${url};\nexport default ${body};\n`, 'utf8');
    return file;
  };

  /** @param {{files: Array<{name: string}>}} run @param {string} rel */
  const fileOf = (run, rel) => run.files.find((f) => norm(f.name) === norm(path.join(PLUGIN_ROOT, rel)));

  beforeAll(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'vitest-root-config-'));
    // No `--config`: config discovery from the cwd is the subject.
    real = runChild('real', [SHEBANG_PROBE, SANDBOX_PROBE]);
    noStrip = runChild('no-strip', [
      '--config',
      derivedConfig('no-strip', "{ ...c, plugins: c.plugins.filter((p) => p?.name !== 'strip-shebang') }"),
      SHEBANG_PROBE,
    ]);
    // Filtered to the resolver case: the file's other cases write a real
    // session, and without the sandbox that write would land in the real store.
    noSetup = runChild('no-setup', [
      '--config',
      derivedConfig('no-setup', '{ ...c, test: { ...c.test, setupFiles: [] } }'),
      SANDBOX_PROBE,
      '-t', SANDBOX_CASE,
    ]);
  }, 360_000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('exits 0 with both files passing', () => {
    expect(real.status).toBe(0);
    for (const rel of [SHEBANG_PROBE, SANDBOX_PROBE]) {
      const file = fileOf(real, rel);
      expect(file?.status, rel).toBe('passed');
      expect(file.assertionResults.length, rel).toBeGreaterThan(0);
      expect(file.assertionResults.every((a) => a.status === 'passed'), rel).toBe(true);
    }
  });

  it('imports a shebang .mjs, and fails to without the strip-shebang plugin', () => {
    expect(fileOf(real, SHEBANG_PROBE)?.status).toBe('passed');
    const bare = fileOf(noStrip, SHEBANG_PROBE);
    expect(noStrip.status).not.toBe(0);
    expect(bare?.status).toBe('failed');
    expect(bare.message).toMatch(/Invalid or unexpected token/);
  });

  it('runs the sandbox setup in the child, and goes red without setupFiles', () => {
    const titled = (run) => fileOf(run, SANDBOX_PROBE)?.assertionResults
      .find((a) => a.title === SANDBOX_CASE)?.status;
    expect(titled(real)).toBe('passed');
    expect(noSetup.status).not.toBe(0);
    expect(titled(noSetup)).toBe('failed');
  });
});
