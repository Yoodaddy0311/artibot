/**
 * Firewall — the per-worker `ARTIBOT_STATE_DIR` sandbox is removed by the run
 * that minted it, and only that one.
 *
 * `tests/setup/state-dir.js` mints `<tmpdir>/artibot-test-state-<pid>` when no
 * override is in force. The first implementation removed it from a
 * `process.once('exit')` listener, which never runs under vitest's pool
 * workers — measured 2026-09-21 by a probe writing a marker as the handler's
 * first statement: 0 markers across a 2-worker run. The observable cost was a
 * pile of abandoned directories in `os.tmpdir()` (32 counted 2026-09-21 05:22Z
 * in this worktree). The remover is now an `afterAll`, matching the autopilot
 * store block in the same file.
 *
 * WHY THIS SPAWNS A CHILD RUN. The hook under test is registered BY the setup
 * file, so it fires after the last test of whichever file is executing — there
 * is no point inside this file from which "after setup's afterAll" is
 * observable. A source-string pin would assert that the code says `afterAll`,
 * which is exactly the kind of evidence that stayed green while the exit
 * listener was never entered. So the subject is run for real: a child `vitest`
 * over two throwaway fixtures, loading the REAL setup file, and the assertions
 * look at the filesystem once that child has exited.
 *
 * The child uses a generated config rather than the repo's, because the fixture
 * files must not be reachable by the normal suite. That is the trade: this file
 * proves the setup file's own behaviour, and proves nothing about whether
 * `vitest.config.js` still registers it. That registration is pinned separately
 * by `tests/firewall/autopilot-store-sandbox-required.test.js` ("registers that
 * setup file with vitest, once, inherited by every project").
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **The real config's pool shape.** The child forces one reused worker,
 *     which is what makes the per-file/per-worker split below observable at
 *     all. The repo's own runs do NOT have that shape: measured 2026-09-21 on
 *     vitest 4.0.18, `main` AND `autopilot` both give every test file a fresh
 *     forks process (two files, two pids, in each project), so in the live
 *     suite each file mints and removes its own directory rather than sharing
 *     one. The remover is correct under both, but only the reused-worker case
 *     is measured here; the live case is an argument from the code.
 *   - **A worker killed mid-file.** `afterAll` does not run then either, so
 *     that worker's directory survives. One per killed worker, not one per run.
 *   - **Anything about the autopilot store.** Its own remover sits in the same
 *     setup file and is gated by the file named above.
 *   - **Whether a writer actually lands in the sandbox.** The fixtures write
 *     there by hand. `resolveArtibotDir()` honouring the override is pinned by
 *     `tests/core/state-dir-home-pairing.test.js`.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETUP_FILE = path.join(PLUGIN_ROOT, 'tests', 'setup', 'state-dir.js');
const VITEST_BIN = path.join(PLUGIN_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** Vite config values are parsed as source; backslashes there are escapes. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * A fixture that writes into whatever state dir is in force and reports it.
 *
 * `existedBefore` is sampled before the `mkdirSync`, which is what lets the
 * second fixture show that the first file's `afterAll` already removed the
 * directory out from under it — and that writing again is fine anyway.
 *
 * @param {string} name - Fixture id, also the marker file suffix.
 * @returns {string} Module source.
 */
function fixtureSource(name) {
  return [
    "import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "import { expect, it } from 'vitest';",
    '',
    `it('writes into the state dir in force (${name})', () => {`,
    '  const dir = process.env.ARTIBOT_STATE_DIR;',
    '  const existedBefore = existsSync(dir);',
    '  mkdirSync(dir, { recursive: true });',
    `  writeFileSync(path.join(dir, 'marker-${name}.txt'), '${name}');`,
    '  appendFileSync(',
    '    process.env.PROBE_REPORT,',
    `    \`\${JSON.stringify({ file: '${name}', dir, pid: process.pid, existedBefore })}\\n\`,`,
    '  );',
    '  expect(existsSync(dir)).toBe(true);',
    '});',
    '',
  ].join('\n');
}

/**
 * A standalone vitest config for the child: the real setup file over throwaway
 * fixtures, pinned to one worker so file order and the worker-scoped env are
 * both determinate.
 *
 * No `defineConfig` import — the config is loaded with the sandbox as root and
 * nothing resolvable next to it. `server.fs.allow` is what lets the child read
 * a setup file living outside that root.
 *
 * ONE WORKER FOR BOTH FIXTURES is what makes the per-file/per-worker split
 * observable, and it took measuring to get: `poolOptions.forks.singleFork` was
 * accepted in silence and ignored at both spellings tried (nested under
 * `test:`, and beside it as `vitest.config.js` does for its project entries) —
 * the two fixtures still reported two pids and two directories on 2026-09-21.
 * That is not local to this config: `vitest.config.js`'s own autopilot project
 * spells it the second way and does not get a single fork either, measured the
 * same day. The likely cause is that vitest 4 removed `poolOptions` in favour
 * of top-level options (`node_modules/vitest/dist/chunks/coverage.AVPTjMgw.js`
 * warns exactly that when it finds the key under `test:`); no such warning is
 * emitted for the sibling spelling, which is dropped without a word. That the
 * removal is the mechanism is INFERRED from those two observations, not
 * confirmed against the migration path.
 *
 * `isolate: false` is the form that holds: in the forks pool it reuses one
 * child across files, and `setupFiles` still re-runs per file, which is the
 * property under test.
 *
 * @param {string} root - Sandbox directory holding `fixtures/`.
 * @returns {string} Module source.
 */
function configSource(root) {
  return [
    'export default {',
    "  pool: 'forks',",
    '  test: {',
    `    root: ${JSON.stringify(toPosix(root))},`,
    "    include: ['fixtures/*.probe.mjs'],",
    `    setupFiles: [${JSON.stringify(toPosix(SETUP_FILE))}],`,
    '    fileParallelism: false,',
    '    isolate: false,',
    '    testTimeout: 30000,',
    '    hookTimeout: 30000,',
    '  },',
    `  server: { fs: { allow: [${JSON.stringify(toPosix(root))}, ${JSON.stringify(toPosix(PLUGIN_ROOT))}] } },`,
    '};',
    '',
  ].join('\n');
}

/**
 * Run the real setup file in a child vitest over two fixtures and return what
 * they reported, in execution order.
 *
 * The child's environment is scrubbed of the state-dir pair this process is
 * itself running under: inherited, it would suppress the very block under test.
 * A non-zero exit throws with both streams attached — a child that crashed and
 * reported nothing would otherwise read as "the directory was cleaned up".
 *
 * @param {string} sandbox - Empty directory this call may fill.
 * @param {string} [stateDirOverride] - Operator-supplied `ARTIBOT_STATE_DIR`.
 * @returns {Array<{file: string, dir: string, pid: number, existedBefore: boolean}>}
 */
function runProbeSuite(sandbox, stateDirOverride) {
  const fixtures = path.join(sandbox, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  for (const name of ['a', 'b']) {
    writeFileSync(path.join(fixtures, `${name}.probe.mjs`), fixtureSource(name), 'utf8');
  }
  const configFile = path.join(sandbox, 'probe.vitest.config.mjs');
  writeFileSync(configFile, configSource(sandbox), 'utf8');
  const report = path.join(sandbox, 'report.ndjson');
  writeFileSync(report, '', 'utf8');

  const env = { ...process.env, PROBE_REPORT: report };
  delete env.ARTIBOT_STATE_DIR;
  delete env.ARTIBOT_STATE_DIR_HOME;
  if (stateDirOverride) env.ARTIBOT_STATE_DIR = stateDirOverride;

  const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '--config', configFile], {
    cwd: PLUGIN_ROOT, env, encoding: 'utf8', timeout: 300_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `child vitest exited ${res.status} (signal ${res.signal})\n`
      + `--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`,
    );
  }
  const entries = readFileSync(report, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (entries.length !== 2) {
    throw new Error(`expected 2 fixture reports, got ${entries.length}\n${res.stdout ?? ''}`);
  }
  return entries;
}

describe('the per-worker state dir is cleaned up by the run that minted it', () => {
  /** @type {string} */
  let sandbox;
  /** @type {ReturnType<typeof runProbeSuite>} */
  let minted;
  /** @type {ReturnType<typeof runProbeSuite>} */
  let supplied;
  /** @type {string} */
  let operatorDir;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'artibot-state-cleanup-'));
    operatorDir = path.join(sandbox, 'operator-state');
    minted = runProbeSuite(path.join(sandbox, 'minted'), undefined);
    supplied = runProbeSuite(path.join(sandbox, 'supplied'), operatorDir);
  }, 600_000);

  afterAll(() => {
    // Everything this file created lives under its own mkdtemp, including the
    // operator-supplied directory the setup is required NOT to remove.
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('removes the directory it minted once the run is over', () => {
    const { dir } = minted[0];
    // Preconditions, or "absent" below would be satisfied by never existing.
    expect(path.basename(dir)).toMatch(/^artibot-test-state-\d+$/);
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    expect(minted[1].dir).toBe(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('keeps an operator-supplied directory, contents and all', () => {
    const { dir } = supplied[0];
    expect(dir).toBe(operatorDir);

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(dir, 'marker-a.txt'))).toBe(true);
    expect(existsSync(path.join(dir, 'marker-b.txt'))).toBe(true);
  });

  it('removes per FILE while the env stays per WORKER, and the next file rewrites', () => {
    // The consequence of registering the hook for every file rather than only
    // the one that entered the mint block. Both fixtures ran in one worker, so
    // the env — and therefore the path — is identical; the second still found
    // the directory gone, because the first file's `afterAll` had removed it.
    // That is the intended shape, not a leak: every writer makes its parents.
    expect(minted[1].pid).toBe(minted[0].pid);
    expect(minted[1].dir).toBe(minted[0].dir);
    expect(minted[1].existedBefore).toBe(false);
  });
});
