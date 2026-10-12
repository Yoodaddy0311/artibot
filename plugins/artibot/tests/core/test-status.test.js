import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getLastTestStatus } from '../../lib/core/test-status.js';

/** The real reporter, so the writer-to-reader cases below run its output and not a hand-made fixture. */
const REPORTER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'reporters',
  'test-status-reporter.js',
);

/**
 * Unit tests for the test-status reader.
 *
 * Covers:
 *   - Missing file → no warning
 *   - Corrupt JSON → no warning
 *   - Fresh pass-only run → no warning, exists=true
 *   - Fresh with failures → warning with sample of failed files
 *   - Stale run (>24h) → stale=true, no warning even if failures
 *   - Custom TTL boundary
 *   - Truncation when >3 failed files
 *   - `completion` (schemaVersion 2): a run vitest itself ended badly warns even
 *     with failed === 0, and is appended after the failing-tests text when tests
 *     failed as well; a completion this reader cannot read never does
 *   - A snapshot that is not a record (the JSON text null) → read like a corrupt file
 */
describe('getLastTestStatus', () => {
  /** @type {string} */
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-test-status-'));
    mkdirSync(path.join(tmpRoot, 'runtime'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeStatus(payload) {
    writeFileSync(
      path.join(tmpRoot, 'runtime', 'last-test-result.json'),
      JSON.stringify(payload),
      'utf-8',
    );
  }

  it('returns exists=false and no warning when the file is missing', () => {
    const result = getLastTestStatus(tmpRoot);
    expect(result.exists).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.summary).toBeNull();
  });

  it('returns exists=false when JSON is corrupt', () => {
    writeFileSync(
      path.join(tmpRoot, 'runtime', 'last-test-result.json'),
      '{not-json',
      'utf-8',
    );
    const result = getLastTestStatus(tmpRoot);
    expect(result.exists).toBe(false);
    expect(result.warning).toBeNull();
  });

  it('returns no warning when fresh and all tests pass', () => {
    writeStatus({
      timestamp: new Date().toISOString(),
      totalTests: 100,
      passed: 100,
      failed: 0,
      failedFiles: [],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.exists).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.summary.totalTests).toBe(100);
  });

  it('emits a warning with sample of failed files when fresh + failures present', () => {
    writeStatus({
      timestamp: new Date().toISOString(),
      totalTests: 200,
      passed: 198,
      failed: 2,
      failedFiles: ['tests/cron/auto-cleanup-runner.test.js', 'tests/hooks/runtime-prompt.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.warning).toContain('2 failing test(s)');
    expect(result.warning).toContain('auto-cleanup-runner.test.js');
    expect(result.warning).toContain('runtime-prompt.test.js');
    expect(result.warning).not.toContain('+'); // no truncation suffix
  });

  it('truncates failedFiles to 3 with a "+N more" suffix', () => {
    writeStatus({
      timestamp: new Date().toISOString(),
      totalTests: 200,
      passed: 195,
      failed: 5,
      failedFiles: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.warning).toContain('a.test.js, b.test.js, c.test.js');
    expect(result.warning).toContain('(+2 more)');
    expect(result.warning).not.toContain('d.test.js');
  });

  it('marks the result as stale and suppresses the warning when older than 24h', () => {
    const oldTs = Date.now() - 25 * 3600 * 1000;
    writeStatus({
      timestamp: new Date(oldTs).toISOString(),
      totalTests: 100,
      passed: 95,
      failed: 5,
      failedFiles: ['x.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.stale).toBe(true);
    expect(result.warning).toBeNull();
  });

  it('respects a custom ttlHours', () => {
    const oldTs = Date.now() - 2 * 3600 * 1000; // 2 hours ago
    writeStatus({
      timestamp: new Date(oldTs).toISOString(),
      totalTests: 10,
      passed: 9,
      failed: 1,
      failedFiles: ['only.test.js'],
    });
    // ttl=1h → stale, no warning
    const stale = getLastTestStatus(tmpRoot, { ttlHours: 1 });
    expect(stale.stale).toBe(true);
    expect(stale.warning).toBeNull();
    // ttl=4h → still fresh, warning fires
    const fresh = getLastTestStatus(tmpRoot, { ttlHours: 4 });
    expect(fresh.stale).toBe(false);
    expect(fresh.warning).toContain('1 failing test(s)');
  });

  it('renders age in minutes for runs younger than 1 hour', () => {
    const recentTs = Date.now() - 15 * 60 * 1000; // 15 min ago
    writeStatus({
      timestamp: new Date(recentTs).toISOString(),
      totalTests: 50,
      passed: 49,
      failed: 1,
      failedFiles: ['x.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.warning).toMatch(/\d+m ago/);
  });

  it('treats unparseable timestamp as stale (returns no warning)', () => {
    writeStatus({
      timestamp: 'not-a-date',
      totalTests: 5,
      passed: 4,
      failed: 1,
      failedFiles: ['x.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.stale).toBe(true);
    expect(result.warning).toBeNull();
  });

  /**
   * `completion` — how the RUN ended, beside what the individual tests did.
   *
   * `failed === 0` says no TEST failed, not that vitest ended the run well: an
   * unobserved rejection, a hook that throws inside a `describe`, a killed worker
   * and an interrupted run all leave `failed: 0` while vitest exits 1 (measured on
   * vitest 4.0.18; VERIFICATION-ECONOMICS-DESIGN §3.2). The reporter records that
   * in `completion` and the Stop gate already reads it. These cases pin the
   * SessionStart side: a bad end warns even with no failing test, and a record
   * that cannot say how the run ended stays exactly as quiet as it always was.
   */
  describe('completion (schemaVersion 2)', () => {
    const RUN_AT = '2026-10-06T00:00:00.000Z';
    const CLEAN = { reason: 'passed', unhandledErrorCount: 0, unfinishedCount: 0 };

    /** Options that make the run exactly `minutes` old, so the age text is a fixed string. */
    const ageOf = (minutes) => ({ now: () => Date.parse(RUN_AT) + minutes * 60_000 });

    /** A v2 snapshot in which no TEST failed, so only `completion` can decide the warning. */
    function writeV2(completion, overrides = {}) {
      writeStatus({
        timestamp: RUN_AT,
        modules: 10,
        totalTests: 100,
        passed: 100,
        failed: 0,
        skipped: 0,
        failedFiles: [],
        schemaVersion: 2,
        completion,
        ...overrides,
      });
    }

    it('keeps the failing-tests warning byte for byte when the snapshot has no completion', () => {
      writeStatus({
        timestamp: RUN_AT,
        totalTests: 200,
        passed: 198,
        failed: 2,
        failedFiles: ['a.test.js', 'b.test.js'],
      });
      expect(getLastTestStatus(tmpRoot, ageOf(90)).warning).toBe(
        '[artibot:test-status] 2 failing test(s) recorded 1.5h ago — a.test.js, b.test.js',
      );
    });

    it('stays silent for a snapshot without completion even when it carries the newer counts', () => {
      writeStatus({
        timestamp: RUN_AT,
        modules: 10,
        totalTests: 100,
        passed: 100,
        failed: 0,
        skipped: 0,
        failedFiles: [],
      });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBeNull();
    });

    it('stays silent when the run ended cleanly', () => {
      writeV2(CLEAN);
      const result = getLastTestStatus(tmpRoot, ageOf(15));
      expect(result.exists).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.warning).toBeNull();
    });

    // Each field on its own with every other field clean: any ONE of them is enough.
    it.each([
      {
        what: 'unobserved errors although every test passed',
        completion: { reason: 'passed', unhandledErrorCount: 2, unfinishedCount: 0 },
        expected: '[artibot:test-status] last test run did not end cleanly'
          + ' (vitest reason=passed, unhandled=2, unfinished=0) recorded 15m ago',
      },
      {
        what: "a run vitest ended as 'failed' with no failed test",
        completion: { reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 },
        expected: '[artibot:test-status] last test run did not end cleanly'
          + ' (vitest reason=failed, unhandled=0, unfinished=0) recorded 15m ago',
      },
      {
        what: 'an interrupted run',
        completion: { reason: 'interrupted', unhandledErrorCount: 0, unfinishedCount: 0 },
        expected: '[artibot:test-status] last test run did not end cleanly'
          + ' (vitest reason=interrupted, unhandled=0, unfinished=0) recorded 15m ago',
      },
      {
        what: 'tests that never reached a final state',
        completion: { reason: 'passed', unhandledErrorCount: 0, unfinishedCount: 3 },
        expected: '[artibot:test-status] last test run did not end cleanly'
          + ' (vitest reason=passed, unhandled=0, unfinished=3) recorded 15m ago',
      },
    ])('warns for $what', ({ completion, expected }) => {
      writeV2(completion);
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBe(expected);
    });

    it('renders the age in hours once the run is an hour old', () => {
      writeV2({ reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 });
      expect(getLastTestStatus(tmpRoot, ageOf(90)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=failed, unhandled=0, unfinished=0) recorded 1.5h ago',
      );
    });

    // A failing test leads and its text is the old text byte for byte; how the run ended
    // only follows it, so the failing files are never pushed aside by the end of the run.
    it('keeps the failing-tests text as the prefix and appends how the run ended', () => {
      writeV2(
        { reason: 'failed', unhandledErrorCount: 3, unfinishedCount: 1 },
        { passed: 98, failed: 2, failedFiles: ['a.test.js'] },
      );
      expect(getLastTestStatus(tmpRoot, ageOf(90)).warning).toBe(
        '[artibot:test-status] 2 failing test(s) recorded 1.5h ago — a.test.js'
        + ' — run also did not end cleanly (vitest reason=failed, unhandled=3, unfinished=1)',
      );
    });

    it('appends nothing to the failing-tests text when the run ended cleanly', () => {
      writeV2(CLEAN, { passed: 98, failed: 2, failedFiles: ['a.test.js'] });
      expect(getLastTestStatus(tmpRoot, ageOf(90)).warning).toBe(
        '[artibot:test-status] 2 failing test(s) recorded 1.5h ago — a.test.js',
      );
    });

    it.each([
      { what: 'a string', completion: 'oops' },
      { what: 'null', completion: null },
      { what: 'an empty object', completion: {} },
      {
        what: 'every field mistyped',
        completion: { reason: 7, unhandledErrorCount: '2', unfinishedCount: 1.5 },
      },
    ])('appends nothing to the failing-tests text when completion is $what', ({ completion }) => {
      writeV2(completion, { passed: 98, failed: 2, failedFiles: ['a.test.js'] });
      expect(getLastTestStatus(tmpRoot, ageOf(90)).warning).toBe(
        '[artibot:test-status] 2 failing test(s) recorded 1.5h ago — a.test.js',
      );
    });

    it('appends the end of the run after the "+N more" part, reading each field on its own', () => {
      writeV2(
        { reason: null, unhandledErrorCount: null, unfinishedCount: 2 },
        {
          passed: 95,
          failed: 5,
          failedFiles: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'],
        },
      );
      expect(getLastTestStatus(tmpRoot, ageOf(90)).warning).toBe(
        '[artibot:test-status] 5 failing test(s) recorded 1.5h ago — a.test.js, b.test.js, c.test.js (+2 more)'
        + ' — run also did not end cleanly (vitest reason=unknown, unhandled=unknown, unfinished=2)',
      );
    });

    it('suppresses the warning for an old run whatever the completion says', () => {
      writeV2({ reason: 'failed', unhandledErrorCount: 4, unfinishedCount: 2 });
      const result = getLastTestStatus(tmpRoot, ageOf(25 * 60));
      expect(result.stale).toBe(true);
      expect(result.warning).toBeNull();
    });

    it('applies the same ttlHours to the new warning', () => {
      writeV2({ reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 });
      const stale = getLastTestStatus(tmpRoot, { ...ageOf(120), ttlHours: 1 });
      expect(stale.stale).toBe(true);
      expect(stale.warning).toBeNull();
      const fresh = getLastTestStatus(tmpRoot, { ...ageOf(120), ttlHours: 4 });
      expect(fresh.stale).toBe(false);
      expect(fresh.warning).toContain('did not end cleanly');
    });

    // UNKNOWN IS NOT A BAD END. A completion this reader cannot read says nothing about
    // how the run ended, so it warns about nothing — and is never read as a measured 0.
    it.each([
      { what: 'a string', completion: 'oops' },
      { what: 'null', completion: null },
      { what: 'an array', completion: [] },
      { what: 'an empty object', completion: {} },
      {
        what: 'every field mistyped',
        completion: { reason: 7, unhandledErrorCount: '2', unfinishedCount: 1.5 },
      },
      {
        what: 'values outside the vocabulary and the range',
        completion: { reason: 'exploded', unhandledErrorCount: -1, unfinishedCount: -3 },
      },
      {
        what: 'the unknowns the reporter writes when it was handed only the modules',
        completion: { reason: null, unhandledErrorCount: null, unfinishedCount: 0 },
      },
    ])('stays silent when completion is $what', ({ completion }) => {
      writeV2(completion);
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBeNull();
    });

    it('stays silent when the version says 2 but there is no completion to read', () => {
      writeStatus({
        timestamp: RUN_AT,
        totalTests: 100,
        passed: 100,
        failed: 0,
        failedFiles: [],
        schemaVersion: 2,
      });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBeNull();
    });

    // THE DECISION IS MADE ON `completion`, NOT ON THE VERSION STAMP. The Stop gate's reader
    // (lib/verification/deterministic-source.js#isV2Record) calls a record v2 as soon as it has
    // a `completion` key, whatever `schemaVersion` says, and this reader judges the same records.
    it.each([
      { what: 'no schemaVersion', overrides: { schemaVersion: undefined } }, // JSON drops the key
      { what: 'schemaVersion 1', overrides: { schemaVersion: 1 } },
    ])('judges a present completion although the snapshot carries $what', ({ overrides }) => {
      writeV2({ reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 }, overrides);
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=failed, unhandled=0, unfinished=0) recorded 15m ago',
      );
    });

    // The vocabulary is exact: a reason in the wrong case is not 'failed', it is unknown. On its
    // own it warns about nothing; beside a field that does warn it is shown as unknown.
    it('treats a reason in the wrong case as unknown, so it does not warn on its own', () => {
      writeV2({ reason: 'FAILED', unhandledErrorCount: 0, unfinishedCount: 0 });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBeNull();
    });

    it('shows a reason in the wrong case as unknown beside a field that does warn', () => {
      writeV2({ reason: 'FAILED', unhandledErrorCount: 1, unfinishedCount: 0 });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=unknown, unhandled=1, unfinished=0) recorded 15m ago',
      );
    });

    it('reads each field on its own: a readable bad end warns and an unreadable field shows as unknown', () => {
      writeV2({ reason: 'failed', unhandledErrorCount: 'two' });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=failed, unhandled=unknown, unfinished=unknown) recorded 15m ago',
      );
    });

    it('counts unfinished tests even when vitest left the reason and the error count unknown', () => {
      writeV2({ reason: null, unhandledErrorCount: null, unfinishedCount: 2 });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=unknown, unhandled=unknown, unfinished=2) recorded 15m ago',
      );
    });

    it('never echoes a reason outside the vocabulary the reporter writes', () => {
      writeV2({ reason: 'timeout <injected>', unhandledErrorCount: 1, unfinishedCount: 0 });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=unknown, unhandled=1, unfinished=0) recorded 15m ago',
      );
    });

    it('leaves the summary at its four counts: completion feeds the warning and is not exposed', () => {
      writeV2({ reason: 'failed', unhandledErrorCount: 2, unfinishedCount: 1 });
      expect(getLastTestStatus(tmpRoot, ageOf(15)).summary).toEqual({
        totalTests: 100,
        passed: 100,
        failed: 0,
        failedFiles: [],
      });
    });

    /**
     * WRITER TO READER. This reader keeps its own copy of the key names and of the
     * reason vocabulary (lib/core may not import the reporter or lib/verification),
     * and the reporter's suite never meets this reader, so a key renamed on one
     * side would leave both suites green and turn every live record into
     * "unreadable" — which here reads as a SILENT SessionStart. These cases run the
     * reporter's REAL output through the real reader. The reporter is copied under
     * `tmpRoot` because it finds its output from its own location
     * (`<root>/tests/reporters/` -> `<root>/runtime/`).
     */
    describe('what this reader concludes from what the reporter wrote', () => {
      let imports = 0;

      const fakeModule = (states) => ({
        moduleId: '/x/tests/a.test.js',
        errors: () => [],
        children: { allTests: () => states.map((state) => ({ result: () => ({ state }) })) },
      });
      const allPassed = () => [fakeModule(['passed', 'passed'])];

      async function readAfterReporter(...endArgs) {
        const dir = path.join(tmpRoot, 'tests', 'reporters');
        mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, 'test-status-reporter.js');
        cpSync(REPORTER_SRC, dest);
        imports += 1;
        const { default: Reporter } = await import(`${pathToFileURL(dest).href}?case=${imports}`);
        const reporter = new Reporter();
        reporter.onTestRunStart();
        reporter.onTestRunEnd(...endArgs);
        return getLastTestStatus(tmpRoot);
      }

      it('stays silent for a run that ended cleanly', async () => {
        expect((await readAfterReporter(allPassed(), [], 'passed')).warning).toBeNull();
      });

      it('warns for an unobserved rejection that left every test passed', async () => {
        const { warning } = await readAfterReporter(allPassed(), [new Error('unobserved')], 'passed');
        expect(warning).toContain('(vitest reason=passed, unhandled=1, unfinished=0)');
      });

      it("warns for a run vitest ended as 'failed' with every test skipped by a throwing hook", async () => {
        const skippedByHook = [fakeModule(['skipped', 'skipped', 'skipped'])];
        const { warning } = await readAfterReporter(skippedByHook, [], 'failed');
        expect(warning).toContain('(vitest reason=failed, unhandled=0, unfinished=0)');
      });

      it('warns for a run whose worker was killed', async () => {
        const killed = [fakeModule(['pending', 'pending', 'pending'])];
        const { warning } = await readAfterReporter(killed, [new Error('Worker forks emitted error.')], 'passed');
        expect(warning).toContain('(vitest reason=passed, unhandled=1, unfinished=3)');
      });

      it('warns for an interrupted run', async () => {
        const { warning } = await readAfterReporter(allPassed(), [], 'interrupted');
        expect(warning).toContain('(vitest reason=interrupted, unhandled=0, unfinished=0)');
      });

      it('stays silent when only the modules were handed over: unknown is not a bad end', async () => {
        expect((await readAfterReporter(allPassed())).warning).toBeNull();
      });

      it('appends how the run ended to the failing-tests warning when a test failed as well', async () => {
        const oneFailed = [fakeModule(['passed', 'failed'])];
        const { warning } = await readAfterReporter(oneFailed, [new Error('unobserved')], 'failed');
        expect(warning).toContain('1 failing test(s)');
        expect(warning).toMatch(
          / — run also did not end cleanly \(vitest reason=failed, unhandled=1, unfinished=0\)$/,
        );
      });
    });
  });

  /**
   * The header promises "never throws". The JSON text `null` parses without error and then
   * has no properties to read, so it used to throw out of the reader. It is not a snapshot:
   * it is read like a corrupt file.
   */
  describe('a snapshot file that is not a record', () => {
    function writeRaw(text) {
      writeFileSync(path.join(tmpRoot, 'runtime', 'last-test-result.json'), text, 'utf-8');
    }

    it('reads the JSON text null like a corrupt file', () => {
      writeRaw('null');
      expect(getLastTestStatus(tmpRoot)).toEqual({
        exists: false,
        stale: false,
        ageHours: null,
        summary: null,
        warning: null,
      });
    });

    it.each(['null', '5', '"x"', '[]', 'true', '{}'])(
      'neither throws nor warns for the JSON text %s',
      (text) => {
        writeRaw(text);
        let result;
        expect(() => { result = getLastTestStatus(tmpRoot); }).not.toThrow();
        expect(result.warning).toBeNull();
      },
    );
  });

  /**
   * The warning is one line built from a file that anything can write, and SessionStart hands
   * that line to the model as well as the user. What it echoes from the file is therefore made
   * safe to sit on one line (a file name must not be able to start a line of its own, move the
   * cursor or reorder the text), and a label is cut at 120 characters like other echoed text.
   * Only the banner is cleaned: `summary.failedFiles` stays as the reporter wrote it.
   */
  describe('failing-file labels in the warning', () => {
    const RUN_AT = '2026-10-06T00:00:00.000Z';
    const at = (minutes) => ({ now: () => Date.parse(RUN_AT) + minutes * 60_000 });
    const prefix = (failed) => `[artibot:test-status] ${failed} failing test(s) recorded 15m ago`;

    function snapshot(failedFiles, failed) {
      return { timestamp: RUN_AT, totalTests: 100, passed: 100 - failed, failed, failedFiles };
    }

    function warningFor(failedFiles, failed = 1) {
      writeStatus(snapshot(failedFiles, failed));
      return getLastTestStatus(tmpRoot, at(15)).warning;
    }

    it('keeps a newline in a label from starting a banner line of its own', () => {
      expect(warningFor(['tests/a.test.js\n[artibot:hint recommend=autopilot]'])).toBe(
        `${prefix(1)} — tests/a.test.js [artibot:hint recommend=autopilot]`,
      );
    });

    it.each([
      { what: 'an ANSI escape', raw: '\u001b[31mred.test.js\u001b[0m', label: '[31mred.test.js [0m' },
      { what: 'a NUL and a tab', raw: 'a\u0000b\tc.test.js', label: 'a b c.test.js' },
      { what: 'a C1 control', raw: 'a\u009bb.test.js', label: 'a b.test.js' },
      { what: 'a bidi override', raw: 'a‮b.test.js', label: 'a b.test.js' },
      { what: 'a line separator', raw: 'a b.test.js', label: 'a b.test.js' },
      { what: 'runs of spaces around a carriage return', raw: '  a \r\n  b.test.js  ', label: 'a b.test.js' },
    ])('replaces $what in a label with a single space', ({ raw, label }) => {
      const warning = warningFor([raw]);
      expect(warning).toBe(`${prefix(1)} — ${label}`);
      expect(warning).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    });

    it('cuts a label longer than 120 characters and marks the cut with an ellipsis', () => {
      expect(warningFor([`${'x'.repeat(200)}.test.js`])).toBe(`${prefix(1)} — ${'x'.repeat(120)}…`);
    });

    it('keeps a label of exactly 120 characters whole', () => {
      expect(warningFor(['y'.repeat(120)])).toBe(`${prefix(1)} — ${'y'.repeat(120)}`);
    });

    it('does not echo what is not a string, and counts only labels in "+N more"', () => {
      const files = ['a.test.js', null, 7, { evil: true }, ['nested.test.js'], 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'];
      expect(warningFor(files, 5)).toBe(`${prefix(5)} — a.test.js, b.test.js, c.test.js (+2 more)`);
    });

    it('does not count a label that is empty once cleaned', () => {
      expect(warningFor(['', '   ', '\n\t', 'a.test.js'], 2)).toBe(`${prefix(2)} — a.test.js`);
    });

    it.each([
      { what: 'an empty list', failedFiles: [] },
      { what: 'only things that are not labels', failedFiles: [null, 7, '  '] },
      { what: 'not a list at all', failedFiles: 'a.test.js' },
    ])('ends the sentence without a dangling dash when failedFiles is $what', ({ failedFiles }) => {
      expect(warningFor(failedFiles, 2)).toBe(prefix(2));
    });

    it('leaves summary.failedFiles as the reporter wrote it', () => {
      const raw = ['a\nb.test.js', null];
      writeStatus(snapshot(raw, 2));
      expect(getLastTestStatus(tmpRoot, at(15)).summary.failedFiles).toEqual(raw);
    });
  });

  /**
   * A snapshot dated ahead of this clock (skew, or a file written under a wrong clock) has no
   * age. It used to print a negative one (`-30m ago`). It still warns - hiding a failing run
   * because of a clock would be the worse mistake - but it says what is wrong with the date.
   */
  describe('a snapshot dated ahead of this clock', () => {
    const RUN_AT = '2026-10-06T00:00:00.000Z';
    const at = (minutes) => ({ now: () => Date.parse(RUN_AT) + minutes * 60_000 });

    function writeFailing() {
      writeStatus({ timestamp: RUN_AT, totalTests: 200, passed: 198, failed: 2, failedFiles: ['a.test.js'] });
    }

    it('says how far ahead it is instead of printing a negative age', () => {
      writeFailing();
      const result = getLastTestStatus(tmpRoot, at(-30));
      expect(result.stale).toBe(false);
      expect(result.warning).toBe('[artibot:test-status] 2 failing test(s) recorded 30m in the future — a.test.js');
    });

    it('renders a future date of an hour or more in hours', () => {
      writeFailing();
      expect(getLastTestStatus(tmpRoot, at(-90)).warning).toBe(
        '[artibot:test-status] 2 failing test(s) recorded 1.5h in the future — a.test.js',
      );
    });

    it('words the end-of-run warning the same way', () => {
      writeStatus({
        timestamp: RUN_AT,
        totalTests: 100,
        passed: 100,
        failed: 0,
        failedFiles: [],
        completion: { reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 },
      });
      expect(getLastTestStatus(tmpRoot, at(-30)).warning).toBe(
        '[artibot:test-status] last test run did not end cleanly'
        + ' (vitest reason=failed, unhandled=0, unfinished=0) recorded 30m in the future',
      );
    });

    it('reads a skew of under half a minute as 0m ago, with no sign', () => {
      writeFailing();
      expect(getLastTestStatus(tmpRoot, at(-0.1)).warning).toBe(
        '[artibot:test-status] 2 failing test(s) recorded 0m ago — a.test.js',
      );
    });

    it('never prints a minus sign in front of an age, however far ahead', () => {
      writeFailing();
      for (const minutes of [-0.6, -1, -45, -59.9, -60, -600, -100000]) {
        expect(getLastTestStatus(tmpRoot, at(minutes)).warning).not.toMatch(/-\d/);
      }
    });
  });

  /**
   * `failed` is a count of tests. A number that is not a count (negative, fractional, overflowed)
   * or a value that is not a number says nothing this reader can trust, so the record is not a
   * snapshot: it is never rounded, clamped or defaulted to 0, which would read as a pass, and it
   * is never worded as "-3 failing test(s)".
   */
  describe('a failed count that is not a count', () => {
    const RUN_AT = '2026-10-06T00:00:00.000Z';
    const at = (minutes) => ({ now: () => Date.parse(RUN_AT) + minutes * 60_000 });

    function writeRaw(text) {
      writeFileSync(path.join(tmpRoot, 'runtime', 'last-test-result.json'), text, 'utf-8');
    }

    it.each([
      { what: 'a negative integer', failed: -3 },
      { what: 'a negative fraction', failed: -0.5 },
      { what: 'a fraction above one', failed: 1.5 },
      { what: 'a fraction below one, which rounds to a pass', failed: 0.4 },
      { what: 'a string', failed: '3' },
      { what: 'null', failed: null },
      { what: 'a boolean', failed: true },
      { what: 'a list', failed: [] },
      { what: 'an object', failed: {} },
    ])('reads $what as no snapshot: no warning, no summary', ({ failed }) => {
      writeStatus({ timestamp: RUN_AT, totalTests: 100, passed: 97, failed, failedFiles: ['a.test.js'] });
      const result = getLastTestStatus(tmpRoot, at(15));
      expect(result.warning).toBeNull();
      expect(result.summary).toBeNull();
    });

    it('does not take an overflowing number (1e999 parses as Infinity) for a count', () => {
      writeRaw(`{"timestamp":"${RUN_AT}","totalTests":100,"passed":0,"failed":1e999,"failedFiles":["a.test.js"]}`);
      const result = getLastTestStatus(tmpRoot, at(15));
      expect(result.warning).toBeNull();
      expect(result.summary).toBeNull();
    });

    // The other side: a count the reporter could have written is still measured and still warns.
    it.each([
      { failed: 0, warns: false },
      { failed: 1, warns: true },
      { failed: 25, warns: true },
    ])('still measures failed=$failed', ({ failed, warns }) => {
      writeStatus({ timestamp: RUN_AT, totalTests: 100, passed: 100 - failed, failed, failedFiles: failed ? ['a.test.js'] : [] });
      const result = getLastTestStatus(tmpRoot, at(15));
      expect(result.summary).toMatchObject({ failed });
      expect(result.warning !== null).toBe(warns);
    });
  });
});
