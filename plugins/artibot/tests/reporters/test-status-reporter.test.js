import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deterministicLayerFrom } from '../../lib/verification/deterministic-source.js';

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
   * schema: the eight keys that existed before 2026-10-06, plus `schemaVersion`
   * and `completion`. Nothing else — `selection`, `source`, `environment` and
   * `runId` are in VERIFICATION-ECONOMICS-DESIGN §3.2 but were deferred.
   */
  it('keeps the eight pre-existing keys and adds exactly schemaVersion and completion', async () => {
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
    expect((await snapshotOf(onePass(), [], 'passed')).schemaVersion).toBe(2);
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
