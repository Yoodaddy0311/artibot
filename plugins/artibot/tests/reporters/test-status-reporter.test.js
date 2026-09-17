import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * tests/reporters/test-status-reporter.js — the vitest reporter that writes
 * `runtime/last-test-result.json`, the single input of the deterministic
 * verification layer (`lib/verification/deterministic-source.js`).
 *
 * ── HOW THE REAL STORE IS KEPT OUT OF THIS ──────────────────────────────────
 * The reporter has NO output-path injection point: `OUTPUT_PATH` is a
 * module-level constant derived from `import.meta.url` (:28-30), so calling the
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
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTER_SRC = path.join(HERE, 'test-status-reporter.js');

/** Every temp root made here, removed in `afterAll`. @type {string[]} */
const roots = [];

let importCounter = 0;

/**
 * A module that reports the plugin root exactly as the reporter computes it
 * (`test-status-reporter.js:28-29`). It is written beside the reporter copy and
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
 * `path.relative(PLUGIN_ROOT, moduleId)` (:41) sees only the loader's form, so
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
 * A fake `TestModule` in the shape the reporter reads (:70-87).
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
   * The count is ADDITIVE. `deterministic-source.js#parseResult` (:108) rejects
   * a payload missing any of the four counts, so dropping or renaming an
   * existing key here would make every snapshot read as `corrupt`.
   */
  it('keeps the seven pre-existing keys and adds exactly one', async () => {
    const { loadedRoot, outputPath, Reporter } = await loadIsolatedReporter();
    const reporter = new Reporter();
    reporter.onTestRunStart();
    reporter.onTestRunEnd([fakeModule(path.join(loadedRoot, 'tests', 'a.test.js'), ['passed'])]);

    expect(Object.keys(readSnapshot(outputPath)).sort()).toEqual([
      'durationMs',
      'failed',
      'failedFiles',
      'modules',
      'passed',
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
   * The reporter swallows everything (:101-104) so a reporter bug can never
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
