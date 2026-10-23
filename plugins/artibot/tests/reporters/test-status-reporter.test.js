import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deterministicLayerFrom, readSnapshotIdentity } from '../../lib/verification/deterministic-source.js';
import { defaultReadGitIdentity as readGitIdentityOfThisCheckout } from './test-status-reporter.js';

/**
 * tests/reporters/test-status-reporter.js — the vitest reporter that writes
 * `runtime/last-test-result.json`, the single input of the deterministic
 * verification layer (`lib/verification/deterministic-source.js`).
 *
 * ── HOW THE REAL STORE IS KEPT OUT OF THIS ──────────────────────────────────
 * The reporter has NO output-path injection point: `OUTPUT_PATH` is a
 * module-level constant derived from `import.meta.url` (:50-52), so calling the
 * real module here would overwrite this checkout's own
 * `runtime/last-test-result.json` — the file the Stop gate reads as its
 * numerator — with two fake modules' counts. Instead each case COPIES the
 * reporter source into a throwaway root at the same relative depth
 * (`<tmp>/tests/reporters/`) and imports that copy, which makes its
 * `PLUGIN_ROOT` the temp root and its writes land in `<tmp>/runtime/`. The
 * bytes under test are therefore the real file's, and nothing outside the temp
 * directory is touched. A cache-busting query string keeps repeated imports
 * from sharing one module instance across cases.
 *
 * WHAT THESE CANNOT SEE: whether vitest itself passes `testModules` in the
 * shape assumed below, and whether a run was the whole suite or a filtered
 * subset. The first is the reporter API's contract, checked only by a real run;
 * the second is exactly what `modules` reports but does not decide — a filtered
 * run of every file is indistinguishable from an unfiltered one by count alone.
 *
 * The same blind spot covers the other two `onTestRunEnd` arguments —
 * `unhandledErrors` and `reason` — which the `completion` cases below feed from
 * fakes. Their real shapes were read off vitest 4.0.18 on 2026-10-06 with a
 * scratch micro-suite and a probe reporter (each case below says what it
 * measured). A vitest upgrade that changes them is invisible here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTER_SRC = path.join(HERE, 'test-status-reporter.js');

/** Every temp root made here, removed in `afterAll`. @type {string[]} */
const roots = [];

let importCounter = 0;

/**
 * A module that reports the plugin root exactly as the reporter computes it
 * (`test-status-reporter.js:50-51`). It is written beside the reporter copy and
 * imported the same way, so it observes whatever normalisation the ESM loader
 * applied to the path.
 */
const ROOT_PROBE_SRC = [
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'export const PLUGIN_ROOT = path.resolve(',
  "  path.dirname(fileURLToPath(import.meta.url)), '..', '..',",
  ');',
  '',
].join('\n');

/**
 * Copy the reporter into a fresh throwaway plugin root and load it from there.
 *
 * `loadedRoot` is NOT always `root`. On Windows `os.tmpdir()` can be an 8.3
 * short path (`…/HEECHA~1/AppData/…`) that the ESM loader expands to the long
 * form when it resolves the module, and `realpathSync` does not expand it
 * because nothing here is a symlink. The reporter's
 * `path.relative(PLUGIN_ROOT, moduleId)` (:69) sees only the loader's form, so
 * fake `moduleId` values must be built from `loadedRoot`; feeding it `root`
 * instead makes every label come back as `../../../…` rather than
 * `tests/x.test.js`. Measured 2026-09-17: that mismatch failed two cases here
 * before the probe was added.
 *
 * @returns {Promise<{ root: string, loadedRoot: string, outputPath: string, Reporter: any }>}
 */
async function loadIsolatedReporter() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'artibot-reporter-')));
  roots.push(root);
  const reportersDir = path.join(root, 'tests', 'reporters');
  mkdirSync(reportersDir, { recursive: true });
  const dest = path.join(reportersDir, 'test-status-reporter.js');
  cpSync(REPORTER_SRC, dest);
  const probe = path.join(reportersDir, 'root-probe.js');
  writeFileSync(probe, ROOT_PROBE_SRC, 'utf-8');

  importCounter += 1;
  const bust = `?case=${importCounter}`;
  const mod = await import(`${pathToFileURL(dest).href}${bust}`);
  const { PLUGIN_ROOT: loadedRoot } = await import(`${pathToFileURL(probe).href}${bust}`);

  return {
    root,
    loadedRoot,
    outputPath: path.join(root, 'runtime', 'last-test-result.json'),
    Reporter: mod.default,
    mod,
  };
}

/**
 * A fake `TestModule` in the shape the reporter reads (:101-122).
 *
 * @param {string} moduleId
 * @param {string[]} states Result state per test in the module.
 * @param {any[]} [collectionErrors]
 * @returns {object}
 */
function fakeModule(moduleId, states, collectionErrors = []) {
  return {
    moduleId,
    errors: () => collectionErrors,
    children: {
      allTests: () => states.map((state) => ({ result: () => ({ state }) })),
    },
  };
}

/**
 * @param {string} outputPath
 * @returns {Record<string, any>}
 */
function readSnapshot(outputPath) {
  return JSON.parse(readFileSync(outputPath, 'utf-8'));
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('test-status-reporter — module count in the snapshot', () => {
  it('records how many test modules the run covered', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd([
      fakeModule(path.join(loadedRoot, 'tests', 'a.test.js'), ['passed', 'passed']),
      fakeModule(path.join(loadedRoot, 'tests', 'b.test.js'), ['passed']),
    ]);

    expect(readSnapshot(outputPath).modules).toBe(2);
  });

  it('records zero modules when the run collected none', async () => {
    const { outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd();

    expect(readSnapshot(outputPath).modules).toBe(0);
  });

  /**
   * The additions are ADDITIVE. `deterministic-source.js#parseResult` rejects a
   * payload missing any of the four counts, so dropping or renaming an existing
   * key here would make every snapshot read as `corrupt`. This list is the whole
   * schema: the eight keys that existed before 2026-10-06, `schemaVersion` and
   * `completion` (v2), and since v3 the git identity of the tree the run covered —
   * `gitSha` and `gitDirty` — which the REPORT gate's SHA binding reads
   * (practicality-improvement-20261023/05_REVISED_DESIGN.md D-04: a verdict must
   * name the commit it measured, or a stale green survives a later edit). Nothing
   * else — `selection`, `source`, `environment` and `runId` are in
   * VERIFICATION-ECONOMICS-DESIGN §3.2 but were deferred.
   *
   * The identity is INJECTED here: the copied reporter's `PLUGIN_ROOT` is a temp
   * directory outside any repository, so its default reader finds no git and
   * omits both keys (the case right below pins that degradation).
   */
  it('keeps the eight pre-existing keys and adds exactly schemaVersion, completion, gitSha and gitDirty', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter({ readGitIdentity: () => ({ gitSha: 'a'.repeat(40), gitDirty: false }) });
    reporter.onTestRunStart();
    reporter.onTestRunEnd([fakeModule(path.join(loadedRoot, 'tests', 'a.test.js'), ['passed'])]);

    expect(Object.keys(readSnapshot(outputPath)).sort()).toEqual([
      'completion',
      'durationMs',
      'failed',
      'failedFiles',
      'gitDirty',
      'gitSha',
      'modules',
      'passed',
      'schemaVersion',
      'skipped',
      'timestamp',
      'totalTests',
    ]);
  });

  it('omits both identity keys, and nothing else, when the plugin root is not inside a repository', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd([fakeModule(path.join(loadedRoot, 'tests', 'a.test.js'), ['passed'])]);

    expect(Object.keys(readSnapshot(outputPath)).sort()).toEqual([
      'completion',
      'durationMs',
      'failed',
      'failedFiles',
      'modules',
      'passed',
      'schemaVersion',
      'skipped',
      'timestamp',
      'totalTests',
    ]);
  });

  it('counts modules independently of how many tests they hold', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd([
      fakeModule(path.join(loadedRoot, 'tests', 'many.test.js'), ['passed', 'passed', 'skipped', 'failed']),
    ]);

    const snapshot = readSnapshot(outputPath);
    expect(snapshot.modules, 'one file, four tests').toBe(1);
    expect(snapshot.totalTests).toBe(4);
  });
});

describe('test-status-reporter — the counts the module count sits beside', () => {
  it('tallies passed, failed and skipped states across modules', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd([
      fakeModule(path.join(loadedRoot, 'tests', 'ok.test.js'), ['passed', 'skipped']),
      fakeModule(path.join(loadedRoot, 'tests', 'bad.test.js'), ['failed', 'passed']),
    ]);

    const snapshot = readSnapshot(outputPath);
    expect(snapshot).toMatchObject({
      modules: 2,
      totalTests: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
      failedFiles: ['tests/bad.test.js'],
    });
  });

  it('counts a collection error as one failure for its file', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd([
      fakeModule(path.join(loadedRoot, 'tests', 'broken.test.js'), [], [new Error('import failed')]),
    ]);

    const snapshot = readSnapshot(outputPath);
    expect(snapshot, 'a module that collected nothing still counts as a module').toMatchObject({
      modules: 1,
      totalTests: 0,
      failed: 1,
      failedFiles: ['tests/broken.test.js'],
    });
  });

  /**
   * The reporter swallows everything (:143-146) so a reporter bug can never
   * fail a test run. That contract has to hold for the new field too.
   */
  it('never throws when a module does not match the expected shape', async () => {
    const { outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    expect(() => reporter.onTestRunEnd([{ moduleId: 'x' }])).not.toThrow();
    expect(() => readSnapshot(outputPath), 'no snapshot is written on the throw path').toThrow();
  });
});

/**
 * `completion` — what the RUN did, beside what the individual tests did.
 *
 * WHY IT EXISTS. The four test counts cannot tell a clean suite from a run that
 * ended badly, because most ways of ending badly do not fail a test. Measured
 * 2026-10-06 on vitest 4.0.18 (scratch micro-suite; a probe reporter printed the
 * raw `onTestRunEnd(testModules, unhandledErrors, reason)` arguments; the vitest
 * exit code is in brackets):
 *
 *   unobserved promise rejection     [1]  reason 'passed', 1 unhandled error, test 'passed'
 *   exception thrown from a timer    [1]  reason 'passed', 1 unhandled error, test 'passed'
 *   worker process killed mid-file   [1]  reason 'passed', 1 unhandled error, 3 tests 'pending'
 *   beforeAll throws inside describe [1]  reason 'failed', 0 unhandled, 3 tests 'skipped'
 *   afterAll throws inside describe  [1]  reason 'failed', 0 unhandled, 2 tests 'passed'
 *   --bail=1 after a failing test    [1]  reason 'interrupted'
 *
 * Three of those end with `reason: 'passed'`, so `reason` does not carry the
 * unhandled errors and both have to be recorded. Five of them leave `failed: 0`
 * in the pre-completion snapshot, which is how a run that vitest itself exited 1
 * on read as a pass downstream.
 */
describe('test-status-reporter — the completion record', () => {
  const onePass = () => [fakeModule('/x/tests/a.test.js', ['passed'])];

  /**
   * Run the reporter the way vitest 4 does: `(testModules, unhandledErrors, reason)`.
   *
   * @param {any[]} endArgs
   * @returns {Promise<Record<string, any>>}
   */
  async function snapshotOf(...endArgs) {
    const { outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd(...endArgs);
    return readSnapshot(outputPath);
  }

  it('stamps a schema version so a reader can tell a record that has completion from one that cannot', async () => {
    // 2 added `completion`; 3 added the git identity (`gitSha`, `gitDirty`). The
    // reader keys its completion rules on "version >= 2 or a completion key", so
    // the bump cannot demote a v3 record to the v1 reading.
    expect((await snapshotOf(onePass(), [], 'passed')).schemaVersion).toBe(3);
  });

  it('records vitest\'s reason and the unhandled-error count side by side, neither derived from the other', async () => {
    // Measured: an unobserved rejection ends with reason 'passed' AND one unhandled error.
    const snapshot = await snapshotOf(onePass(), [new Error('a'), new Error('b')], 'passed');

    expect(snapshot.completion).toEqual({ reason: 'passed', unhandledErrorCount: 2, unfinishedCount: 0 });
  });

  it('keeps every reason vitest can report exactly as it was reported', async () => {
    for (const reason of ['passed', 'interrupted', 'failed']) {
      const snapshot = await snapshotOf(onePass(), [], reason);
      expect(snapshot.completion.reason, reason).toBe(reason);
    }
  });

  it('records zero unhandled errors as zero — a measured nothing, not an unknown', async () => {
    const snapshot = await snapshotOf(onePass(), [], 'passed');

    expect(snapshot.completion.unhandledErrorCount).toBe(0);
  });

  /**
   * UNKNOWN IS `null`, NEVER A VALUE THAT CLAIMS A CLEAN RUN. A caller that hands
   * over only the modules (this reporter's own earlier call shape, or an API that
   * stops passing the rest) has told us nothing about errors or the end state.
   * Writing `0` / `'passed'` there would be a measurement nobody made.
   */
  it('records unknown, not zero or passed, when only the modules were handed over', async () => {
    const snapshot = await snapshotOf(onePass());

    expect(snapshot.completion).toEqual({ reason: null, unhandledErrorCount: null, unfinishedCount: 0 });
  });

  it('records a reason outside vitest\'s vocabulary as unknown instead of passing it through', async () => {
    for (const reason of ['cancelled', '', 'PASSED', 42, null, {}]) {
      const snapshot = await snapshotOf(onePass(), [], reason);
      expect(snapshot.completion.reason, `reason=${JSON.stringify(reason)}`).toBeNull();
    }
  });

  it('records an unhandled-errors argument that is not a list as unknown', async () => {
    for (const bad of ['boom', 3, { length: 2 }, null]) {
      const snapshot = await snapshotOf(onePass(), bad, 'passed');
      expect(snapshot.completion.unhandledErrorCount, `unhandledErrors=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  /**
   * Measured: after a worker process was killed mid-file, vitest reported ALL
   * three tests of that file as 'pending' — including the one that had passed
   * before the kill — and still ended with reason 'passed'. The old snapshot read
   * `total 3 / passed 0 / failed 0 / skipped 0`: three tests no bucket claims.
   */
  it('counts tests that never reached a final state as unfinished, not as passed', async () => {
    const snapshot = await snapshotOf(
      [fakeModule('/x/tests/killed.test.js', ['pending', 'pending', 'pending'])],
      [],
      'passed',
    );

    expect(snapshot).toMatchObject({ totalTests: 3, passed: 0, failed: 0, skipped: 0 });
    expect(snapshot.completion.unfinishedCount).toBe(3);
  });

  it('counts a missing or unrecognised test result as unfinished too', async () => {
    const odd = {
      moduleId: '/x/tests/odd.test.js',
      errors: () => [],
      children: {
        allTests: () => [
          { result: () => undefined },
          { result: () => ({ state: 'novel-state' }) },
          { result: () => ({ state: 'passed' }) },
        ],
      },
    };
    const snapshot = await snapshotOf([odd], [], 'passed');

    expect(snapshot).toMatchObject({ totalTests: 3, passed: 1 });
    expect(snapshot.completion.unfinishedCount).toBe(2);
  });

  /**
   * A skip is a FINAL state. Measured: one green run (vitest exit 0) held all
   * three kinds below, and vitest reported every one as state 'skipped':
   *
   *   it.skip(...)             options.mode 'skip'
   *   it.todo(...)             options.mode 'todo'
   *   ctx.skip() in the body   options.mode 'run'
   *
   * The third is why this keys on the STATE and not on the mode. The design text
   * (VERIFICATION-ECONOMICS-DESIGN §3.2) words the count as "mode is 'run' and
   * the state is not passed/failed", which would count it. This repo has four
   * `ctx.skip()` call sites that fire on some hosts (tests/commands/plugin-root-chains.test.js,
   * tests/hooks/pre-write-guard.test.js, tests/project-state/runtime-exclude.test.js
   * twice) — counted, they would turn a clean run into an "unfinished" one
   * depending on the machine.
   */
  it('keeps a skip — declared, todo, or taken at run time — out of the unfinished count', async () => {
    const skipTest = (mode) => ({ options: { mode }, result: () => ({ state: 'skipped' }) });
    const skips = {
      moduleId: '/x/tests/skips.test.js',
      errors: () => [],
      children: { allTests: () => [skipTest('skip'), skipTest('todo'), skipTest('run')] },
    };
    const snapshot = await snapshotOf([skips], [], 'passed');

    expect(snapshot).toMatchObject({ totalTests: 3, skipped: 3 });
    expect(snapshot.completion.unfinishedCount).toBe(0);
  });

  it('puts every test in exactly one bucket', async () => {
    const snapshot = await snapshotOf(
      [fakeModule('/x/tests/mixed.test.js', ['passed', 'failed', 'skipped', 'pending'])],
      [],
      'failed',
    );
    const { totalTests, passed, skipped, completion } = snapshot;

    // `failed` is the one bucket that a collection error can also feed, so the
    // single failed TEST is counted by hand here.
    expect(totalTests).toBe(passed + 1 + skipped + completion.unfinishedCount);
    expect(completion.unfinishedCount).toBe(1);
  });

  it('counts a collection error as one failure with nothing unfinished', async () => {
    const snapshot = await snapshotOf(
      [fakeModule('/x/tests/broken.test.js', [], [new Error('import failed')])],
      [],
      'failed',
    );

    expect(snapshot).toMatchObject({ totalTests: 0, failed: 1 });
    expect(snapshot.completion).toEqual({ reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 });
  });
});

/**
 * WRITER TO READER. `lib/verification/deterministic-source.js` cannot import this
 * reporter, and the reporter cannot import it (this file copies the reporter alone
 * into a temp root), so each side holds its own copy of the key names and of the
 * reason vocabulary. Each side's suite feeds it fixtures its own author chose, so a
 * key renamed on one side leaves both green and turns every live record into
 * "unreadable". These cases run the reporter's REAL output through the real reader.
 *
 * The marker is dated well before the run, so freshness cannot explain a verdict.
 */
describe('test-status-reporter — what the Stop gate concludes from what this reporter wrote', () => {
  const clean = () => [fakeModule('/x/tests/a.test.js', ['passed', 'passed'])];

  /**
   * @param {any[]} endArgs
   * @returns {Promise<{ exitCode?: number, reason: string }>}
   */
  async function layerFrom(...endArgs) {
    const { outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd(...endArgs);
    const text = readFileSync(outputPath, 'utf-8');
    const ranAtMs = Date.parse(JSON.parse(text).timestamp);
    return deterministicLayerFrom({ resultJsonText: text, markerMtimeMs: ranAtMs - 5000, nowMs: ranAtMs + 1000 });
  }

  it('passes a run that ended cleanly', async () => {
    expect((await layerFrom(clean(), [], 'passed')).exitCode).toBe(0);
  });

  it('fails a run with an unhandled error although every test passed', async () => {
    expect((await layerFrom(clean(), [new Error('unobserved rejection')], 'passed')).exitCode).toBe(1);
  });

  it("fails a run vitest ended as 'failed' although no test failed (a hook threw inside a describe)", async () => {
    const skippedByHook = [fakeModule('/x/tests/a.test.js', ['skipped', 'skipped', 'skipped'])];

    expect((await layerFrom(skippedByHook, [], 'failed')).exitCode).toBe(1);
  });

  it('fails a run whose worker was killed, whatever vitest called it', async () => {
    const killed = [fakeModule('/x/tests/a.test.js', ['pending', 'pending', 'pending'])];
    const layer = await layerFrom(killed, [new Error('Worker forks emitted error.')], 'passed');

    expect(layer.exitCode).toBe(1);
  });

  it('leaves an interrupted run unmeasured, not passed', async () => {
    expect((await layerFrom(clean(), [], 'interrupted')).exitCode).toBeUndefined();
  });

  it('leaves a run unmeasured when only the modules were handed over', async () => {
    expect((await layerFrom(clean())).exitCode, 'unknown is not a clean run').toBeUndefined();
  });
});

/**
 * THE GIT IDENTITY (v3). A snapshot says which TREE it measured, or a verdict can
 * be read against a tree it never saw: the Stop gate's freshness rule (F1) compares
 * the run against the last edit by time, and the REPORT gate's SHA binding
 * (05_REVISED_DESIGN.md D-04, rule 7) needs the commit itself. `gitSha` is
 * `git rev-parse HEAD` and `gitDirty` is whether `git status --porcelain
 * --untracked-files=no` printed anything, both run in the plugin root.
 *
 * Both keys are OMITTED — never `null`, never `''` — whenever git is missing, fails,
 * times out or answers with something that is not a 40-hex id. A reader treats an
 * absent key as "identity not recorded" (`deterministic-source.js#readSnapshotIdentity`),
 * which is a different claim from "the tree had no commit".
 *
 * The reader is injectable through the constructor so these cases do not depend on
 * the temp root being a repository; the default reader is exercised once against the
 * real checkout this test file lives in, and once against a temp root that is not one.
 */
describe('test-status-reporter — the git identity of the measured tree', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  /**
   * @param {unknown} readGitIdentity
   * @param {any[]} [endArgs]
   * @returns {Promise<{ snapshot: Record<string, any>, text: string }>}
   */
  async function snapshotWith(readGitIdentity, endArgs = [[fakeModule('/x/tests/a.test.js', ['passed'])], [], 'passed']) {
    const { outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter({ readGitIdentity });
    reporter.onTestRunStart();
    reporter.onTestRunEnd(...endArgs);
    const text = readFileSync(outputPath, 'utf-8');
    return { snapshot: JSON.parse(text), text };
  }

  it('records the sha and the dirty flag the reader returned, verbatim', async () => {
    const { snapshot } = await snapshotWith(() => ({ gitSha: SHA, gitDirty: true }));
    expect(snapshot.gitSha).toBe(SHA);
    expect(snapshot.gitDirty).toBe(true);
  });

  it('round-trips a clean tree as gitDirty false, a measured nothing rather than an omission', async () => {
    const { snapshot } = await snapshotWith(() => ({ gitSha: SHA, gitDirty: false }));
    expect(snapshot.gitDirty).toBe(false);
    expect(Object.hasOwn(snapshot, 'gitDirty')).toBe(true);
  });

  it('omits both keys when the reader throws, and still writes the rest of the snapshot', async () => {
    const { snapshot } = await snapshotWith(() => { throw new Error('git: not found (injected)'); });
    expect(Object.hasOwn(snapshot, 'gitSha')).toBe(false);
    expect(Object.hasOwn(snapshot, 'gitDirty')).toBe(false);
    expect(snapshot).toMatchObject({ totalTests: 1, passed: 1, schemaVersion: 3 });
  });

  it('omits a key whose value is not the shape it promises, one key at a time', async () => {
    const garbage = [
      { gitSha: 'HEAD', gitDirty: 'yes' },
      { gitSha: SHA.slice(0, 39), gitDirty: 1 },
      { gitSha: SHA.toUpperCase(), gitDirty: null },
      { gitSha: null, gitDirty: undefined },
      { gitSha: 42, gitDirty: 'false' },
    ];
    for (const value of garbage) {
      const { snapshot } = await snapshotWith(() => value);
      expect(Object.hasOwn(snapshot, 'gitSha'), `gitSha=${JSON.stringify(value.gitSha)}`).toBe(false);
      expect(Object.hasOwn(snapshot, 'gitDirty'), `gitDirty=${JSON.stringify(value.gitDirty)}`).toBe(false);
    }
  });

  it('keeps a well-formed sha when only the dirty flag is garbage, and the other way round', async () => {
    const onlySha = (await snapshotWith(() => ({ gitSha: SHA, gitDirty: 'dirty' }))).snapshot;
    expect(onlySha.gitSha).toBe(SHA);
    expect(Object.hasOwn(onlySha, 'gitDirty')).toBe(false);

    const onlyDirty = (await snapshotWith(() => ({ gitSha: 'garbage', gitDirty: true }))).snapshot;
    expect(Object.hasOwn(onlyDirty, 'gitSha')).toBe(false);
    expect(onlyDirty.gitDirty).toBe(true);
  });

  it('omits both keys when the reader is not a function or returns a non-object', async () => {
    for (const reader of [undefined, null, 'git', () => null, () => 'sha', () => [SHA]]) {
      const { snapshot } = await snapshotWith(reader);
      expect(Object.hasOwn(snapshot, 'gitSha'), `reader=${String(reader)}`).toBe(false);
      expect(Object.hasOwn(snapshot, 'gitDirty'), `reader=${String(reader)}`).toBe(false);
    }
  });

  /**
   * The copy's plugin root is a temp directory. `GIT_CEILING_DIRECTORIES` stops
   * git's upward search at the temp directory's parent for the duration of the
   * call, so a machine whose temp directory happens to sit inside a repository (a
   * home directory under version control) cannot turn this case into a sha.
   */
  it('exposes the default reader, which answers with nothing for a plugin root outside any repository', async () => {
    const { root, mod } = await loadIsolatedReporter();
    expect(typeof mod.defaultReadGitIdentity).toBe('function');

    const previous = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
    try {
      expect(mod.defaultReadGitIdentity()).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previous;
    }
  });

  it('reads this checkout with the default reader: a 40-hex sha and a boolean dirty flag', () => {
    // The real module, not a copy: its PLUGIN_ROOT is this plugin directory, which
    // is tracked by the repository this test file lives in. Importing it writes
    // nothing — only `onTestRunEnd` does.
    const identity = readGitIdentityOfThisCheckout();
    expect(identity.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof identity.gitDirty).toBe('boolean');
  });

  it('is read back by deterministic-source: the identity, and a sha clause in the evidence note', async () => {
    const { snapshot, text } = await snapshotWith(() => ({ gitSha: SHA, gitDirty: false }));

    expect(readSnapshotIdentity(text)).toEqual({
      gitSha: SHA,
      gitDirty: false,
      measuredAtMs: Date.parse(snapshot.timestamp),
    });

    const ranAtMs = Date.parse(snapshot.timestamp);
    const layer = deterministicLayerFrom({ resultJsonText: text, markerMtimeMs: ranAtMs - 5000, nowMs: ranAtMs + 1000 });
    expect(layer.exitCode).toBe(0);
    expect(layer.evidence[0].note).toBe(
      `vitest total=1 passed=1 failed=0 skipped=0 modules=1 completion=passed unhandled=0 unfinished=0 sha=${SHA.slice(0, 12)} dirty=false`,
    );
  });
});
