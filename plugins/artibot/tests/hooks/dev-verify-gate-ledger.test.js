import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { buildDevVerifyOutput } from '../../lib/core/dev-verify-output.js';

/**
 * dev-verify-gate.js — the "unmeasured denominator" ledger wiring (OB-07).
 *
 * WHY A SEPARATE FILE FROM `dev-verify-gate.test.js`. That suite mocks
 * `node:child_process` with an `execSync`-only factory, so `spawnSync` is not
 * importable inside it and no child process can be started from it. The cases
 * below need a REAL process (the hook's own stdout bytes and the ledger file it
 * leaves behind are the measurement), so they live here. Per the repo's
 * Stop-gate stem rule, `<stem>-<suffix>.test.js` still counts as coverage of
 * `dev-verify-gate.js`.
 *
 * WHICH CASE IS MEASURED HOW:
 *   - case 1 (ledger contents)      REAL SPAWN
 *   - case 2a (normal stdout)       REAL SPAWN
 *   - case 2b (ledger unwritable)   REAL SPAWN
 *   - case 2c (lib import fails)    NOT HERE — the hook resolves `lib/` relative
 *     to its own file, so no sandbox can remove it. It is unit-tested with
 *     `vi.doMock` in `dev-verify-gate.test.js`.
 *   - case 3 (idempotency)          REAL SPAWN
 *   - case 4 (no session_id)        REAL SPAWN
 *   - case 5 (fresh vitest result)  REAL SPAWN — the deterministic NUMERATOR
 *   - case 6 (fresh, failures)      REAL SPAWN
 *   - case 7 (stale / absent)       REAL SPAWN — must equal the pre-numerator
 *     denominator byte for byte, `verification_id` aside
 *
 * WHAT THESE TESTS CANNOT SEE (rules §9, stated next to the gate): the ledger
 * that PRODUCTION writes (this is a throwaway repo), concurrency with the five
 * sibling Stop hooks, and any line appended after the read below.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '../../scripts/hooks/dev-verify-gate.js');
const SESSION = 'sessVGW00001';

/**
 * PINNED COPY of `dev-verify-gate.js#DEV_VERIFY_REASON` (module-private, so it
 * cannot be imported). If the hook's string changes, this test fails and BOTH
 * must be updated together — that is the point of pinning it.
 */
const DEV_VERIFY_REASON =
  'DEV verify (CLAUDE.md DEV Protocol): report per-item evidence (file:line); ' +
  "flag anything unproven as 'Pending verification'.";

/** The exact bytes the hook must print on the fire path, in every case. */
const EXPECTED_STDOUT = JSON.stringify(
  buildDevVerifyOutput(DEV_VERIFY_REASON, { mode: 'enforce', hookEventName: 'Stop' }),
);

/**
 * THE PRE-NUMERATOR DENOMINATOR, MEASURED BEFORE THIS CHANGE WAS WRITTEN.
 *
 * Captured 2026-09-15 15:49 KST by spawning the then-current hook against the
 * sandbox below, at HEAD 2b10fd31 (`verify({ layers: {} })`, one `data` object
 * per ledger line, in append order). Every path that measures NOTHING must keep
 * producing exactly this, `verification_id` aside — that id is the hash of the
 * verdict INCLUDING each layer's reason, so it legitimately changes when the
 * reason names which branch went unmeasured, while the four ledger `data`
 * objects must not move at all. A reader joining old and new lines therefore
 * needs no special case.
 *
 * For the record, the live constant at capture time was
 * `v1-83866286c2d8-<stamp>`; 112 of 112 `verify.completed` lines in the
 * 2026-09-14 ledger copy carried that hash.
 */
const BASELINE_DENOMINATOR_DATA = Object.freeze([
  { result: 'unmeasured', evidence: [] },
  { layer: 'deterministic', result: 'unmeasured', evidence: [] },
  { layer: 'behavioral', result: 'unmeasured', evidence: [] },
  { layer: 'operational', result: 'unmeasured', evidence: [] },
]);

/**
 * The four `data` objects with `verification_id` stripped, in append order.
 *
 * @param {object[]} lines
 * @returns {object[]}
 */
function denominatorShape(lines) {
  return lines.map((e) => {
    const { verification_id: _id, ...rest } = e.data;
    return rest;
  });
}

/** @type {string[]} */
const created = [];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

/**
 * A throwaway repo `isArtibotRepo()` accepts, with a dirty tracked file, plus a
 * throwaway plugin root carrying ONLY the main-agent-edit marker (no
 * `runtime/last-dev-verify-sha.txt`), so the gate fires on the first run.
 *
 * TWO ROOTS ON PURPOSE. `testResult` is written under the REPO root, where
 * `tests/reporters/test-status-reporter.js` puts it, while the marker stays
 * under the plugin root, where the PostToolUse hook puts it. That split IS the
 * thing under test (owner decision R1): a fixture that put both in one place
 * would pass while production reads two.
 *
 * `markerAgeMs` shifts the marker's mtime rather than sleeping. A positive
 * value ages it into the past (so a result dated "now" is fresh); a negative
 * value pushes it into the future (so the same result is stale). Comparing
 * against wall-clock sleeps would make the case flaky on a loaded machine and
 * slow on every machine.
 *
 * @param {{ testResult?: object|null, markerAgeMs?: number }} [opts]
 * @returns {{ repo: string, pluginRoot: string, ledger: string, cache: string }}
 */
function buildSandbox(opts = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'dvg-it-repo-'));
  created.push(repo);
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  mkdirSync(path.join(repo, 'plugins', 'artibot'), { recursive: true });
  writeFileSync(path.join(repo, 'plugins', 'artibot', 'CLAUDE.md'), '# stub\n');
  writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  git(['add', 'plugins/artibot/CLAUDE.md', 'tracked.txt'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  writeFileSync(path.join(repo, 'tracked.txt'), `dirty ${Date.now()}\n`);

  const pluginRoot = mkdtempSync(path.join(os.tmpdir(), 'dvg-it-plugin-'));
  created.push(pluginRoot);
  mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
  const marker = path.join(pluginRoot, 'runtime', 'last-main-agent-edit.timestamp');
  writeFileSync(marker, 'x');

  if (opts.testResult) {
    const runtimeDir = path.join(repo, 'plugins', 'artibot', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      path.join(runtimeDir, 'last-test-result.json'),
      JSON.stringify(opts.testResult),
    );
  }
  if (typeof opts.markerAgeMs === 'number') {
    const shifted = new Date(statSync(marker).mtimeMs - opts.markerAgeMs);
    utimesSync(marker, shifted, shifted);
  }

  return {
    repo,
    pluginRoot,
    ledger: ledgerFilePath(repo),
    cache: path.join(pluginRoot, 'runtime', 'last-dev-verify-sha.txt'),
  };
}

/**
 * Spawn the hook exactly the way the Stop dispatcher does.
 *
 * @param {{repo: string, pluginRoot: string}} box
 * @param {object} [payload] stdin JSON; `null` sends a payload with no session_id
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runHook(box, payload) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: box.pluginRoot };
  delete env.ARTIBOT_DEV_VERIFY_MODE;
  const stdin = JSON.stringify(
    payload ?? { session_id: SESSION, hook_event_name: 'Stop', stop_hook_active: false },
  );
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: box.repo,
    input: stdin,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Every non-blank line of the sandbox ledger, parsed. Read RAW (not through
 * `readAllEvents`) because the reader hides `ledger.rejected` by default and
 * those lines are part of what case 1 asserts.
 *
 * @param {string} ledger
 * @returns {object[]}
 */
function readLedgerLines(ledger) {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('dev-verify-gate — unmeasured denominator (real spawn)', () => {
  it('writes 3 layer lines + 1 overall line, all unmeasured, and nothing rejected', () => {
    const box = buildSandbox();
    const run = runHook(box);
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    const where = `sandbox ledger: ${box.ledger}`;
    expect(lines.length, `${where} — stderr: ${run.stderr}`).toBe(4);

    const verifyLines = lines.filter((e) => e.event === 'verify.completed');
    expect(verifyLines.length, where).toBe(4);
    expect(lines.filter((e) => e.event === 'ledger.rejected').length, where).toBe(0);

    for (const e of verifyLines) {
      expect(e.session_id, where).toBe(SESSION);
      expect(e.source, where).toBe('gate');
      expect(e.data.result, where).toBe('unmeasured');
      expect(typeof e.data.verification_id, where).toBe('string');
    }

    const layered = verifyLines.filter((e) => 'layer' in e.data);
    expect(layered.map((e) => e.data.layer).sort(), where)
      .toEqual(['behavioral', 'deterministic', 'operational']);

    const overall = verifyLines.filter((e) => !('layer' in e.data));
    expect(overall.length, `${where} — the overall line must carry NO layer`).toBe(1);

    // One verdict, so one join key across all four lines.
    const ids = new Set(verifyLines.map((e) => e.data.verification_id));
    expect(ids.size, where).toBe(1);
  }, 60_000);

  it('prints byte-identical stdout when the ledger cannot be written (case 2b)', () => {
    const normal = runHook(buildSandbox());
    expect(normal.stdout).toBe(EXPECTED_STDOUT);

    const box = buildSandbox();
    // Occupy the ledger DIRECTORY path with a regular file, so the writer's
    // mkdir fails. `appendLedgerEvent` never throws, so the hook must be
    // unaffected; the ledger simply stays absent.
    const ledgerDir = path.dirname(box.ledger);
    rmSync(ledgerDir, { recursive: true, force: true });
    writeFileSync(ledgerDir, 'not a directory\n');

    const blocked = runHook(box);
    expect(
      Buffer.from(blocked.stdout, 'utf-8').equals(Buffer.from(normal.stdout, 'utf-8')),
      `normal=${JSON.stringify(normal.stdout)} blocked=${JSON.stringify(blocked.stdout)} `
      + `stderr=${blocked.stderr}`,
    ).toBe(true);
    expect(readLedgerLines(box.ledger)).toEqual([]);
  }, 60_000);

  it('records nothing and prints the same stdout when stdin carries no session_id', () => {
    const box = buildSandbox();
    const run = runHook(box, { hook_event_name: 'Stop', stop_hook_active: false });
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);
    expect(readLedgerLines(box.ledger), `sandbox ledger: ${box.ledger}`).toEqual([]);
  }, 60_000);

  /**
   * IDEMPOTENCY, STATED PRECISELY: the fingerprint cache
   * (`runtime/last-dev-verify-sha.txt`) is the EFFECTIVE dedupe — a second Stop
   * over the same working-tree state returns before any ledger work. The
   * writer's idempotency key only dedupes SAME-SECOND retries, because
   * `verification_id` embeds `measured_at` at second resolution
   * (`unified-verifier.js#buildVerificationId`, stamp `YYYYMMDDTHHMMSSZ`). This
   * test forces a >= 1100ms gap so the second fire is provably in a different
   * second and must append four MORE lines.
   */
  it('does not re-append while the fingerprint is cached, and appends a fresh verdict once it is cleared', async () => {
    const box = buildSandbox();
    expect(runHook(box).stdout).toBe(EXPECTED_STDOUT);
    expect(readLedgerLines(box.ledger).length, `sandbox ledger: ${box.ledger}`).toBe(4);
    expect(existsSync(box.cache)).toBe(true);

    // Same state again: the fingerprint cache short-circuits before the ledger.
    const second = runHook(box);
    expect(second.stdout, 'a cached fingerprint must produce NO stdout').toBe('');
    expect(readLedgerLines(box.ledger).length).toBe(4);

    await new Promise((resolve) => { setTimeout(resolve, 1100); });
    rmSync(box.cache, { force: true });
    expect(runHook(box).stdout).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    expect(lines.length, `sandbox ledger: ${box.ledger}`).toBe(8);
    const ids = new Set(lines.map((e) => e.data.verification_id));
    expect(ids.size, 'two fires a second apart are two verdicts, not one').toBe(2);
  }, 60_000);
});

/**
 * THE DETERMINISTIC NUMERATOR (owner decisions F1 + R1).
 *
 * A vitest result that is at least as new as the last main-agent edit turns the
 * deterministic line into a real verdict. Everything else about the fire is
 * unchanged, and the cases below assert that explicitly rather than by
 * omission — stdout to the byte, the other two layers still `unmeasured`, and
 * the unmeasured fallback still equal to the pre-numerator denominator.
 *
 * WHAT THESE CANNOT SEE: how often a live Stop actually finds a fresh file.
 * These fixtures MAKE it fresh. The live ratio of measured to stale to absent
 * is only answerable from the production ledger after landing (rules §9), and
 * a green run here is not evidence about it.
 */
describe('dev-verify-gate — deterministic numerator from the vitest reporter', () => {
  /** @param {object} [over] */
  function reporterPayload(over = {}) {
    return {
      timestamp: new Date().toISOString(),
      durationMs: 132138,
      totalTests: 17377,
      passed: 17365,
      failed: 0,
      skipped: 12,
      failedFiles: [],
      ...over,
    };
  }

  /**
   * @param {object[]} lines
   * @param {string} layer
   * @returns {object}
   */
  function layerData(lines, layer) {
    const hit = lines.filter((e) => e.data.layer === layer);
    expect(hit, `exactly one ${layer} line`).toHaveLength(1);
    return hit[0].data;
  }

  it('records deterministic pass and overall pass when the result is newer than the marker', () => {
    // Marker aged 10s into the past, result dated now → fresh by F1.
    const box = buildSandbox({ testResult: reporterPayload(), markerAgeMs: 10_000 });
    const run = runHook(box);
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    const where = `sandbox ledger: ${box.ledger}`;
    expect(lines.length, `${where} — stderr: ${run.stderr}`).toBe(4);

    const deterministic = layerData(lines, 'deterministic');
    expect(deterministic.result, where).toBe('pass');
    expect(layerData(lines, 'behavioral').result, 'no behavioral runner exists').toBe('unmeasured');
    expect(layerData(lines, 'operational').result, 'no operational readings exist').toBe('unmeasured');

    const overall = lines.filter((e) => !('layer' in e.data));
    expect(overall, 'the overall line must carry NO layer').toHaveLength(1);
    expect(overall[0].data.result, 'deterministic is the only REQUIRED layer').toBe('pass');

    // The counts are the only way a reader can tell a full suite from a
    // targeted run — `reason` never reaches the ledger.
    expect(deterministic.evidence, where).toHaveLength(1);
    expect(deterministic.evidence[0].kind).toBe('file');
    expect(deterministic.evidence[0].file).toBe('plugins/artibot/runtime/last-test-result.json');
    expect(deterministic.evidence[0].note).toContain('vitest total=17377');
    expect(deterministic.evidence[0].note).toContain('failed=0');

    expect(new Set(lines.map((e) => e.data.verification_id)).size, 'one verdict').toBe(1);
  }, 60_000);

  it('records deterministic fail and overall fail when that fresh result reports failures', () => {
    const box = buildSandbox({
      testResult: reporterPayload({ failed: 3, passed: 17362, failedFiles: ['tests/a.test.js'] }),
      markerAgeMs: 10_000,
    });
    const run = runHook(box);
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    expect(lines.length, `sandbox ledger: ${box.ledger} — stderr: ${run.stderr}`).toBe(4);
    expect(layerData(lines, 'deterministic').result).toBe('fail');
    expect(lines.filter((e) => !('layer' in e.data))[0].data.result).toBe('fail');
    expect(layerData(lines, 'deterministic').evidence[0].note).toContain('failed=3');
  }, 60_000);

  it('falls back to the pre-numerator denominator when the result predates the marker', () => {
    // Marker pushed 10 minutes into the FUTURE, so a result dated now is stale.
    const box = buildSandbox({ testResult: reporterPayload(), markerAgeMs: -600_000 });
    const run = runHook(box);
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    expect(lines.length, `sandbox ledger: ${box.ledger} — stderr: ${run.stderr}`).toBe(4);
    expect(
      denominatorShape(lines),
      'a stale result must leave the four lines byte-identical to the 2026-09-15 baseline',
    ).toEqual(BASELINE_DENOMINATOR_DATA);
  }, 60_000);

  it('falls back to the pre-numerator denominator when no result file exists at all', () => {
    const box = buildSandbox({ markerAgeMs: 10_000 });
    const run = runHook(box);
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    expect(lines.length, `sandbox ledger: ${box.ledger} — stderr: ${run.stderr}`).toBe(4);
    expect(denominatorShape(lines)).toEqual(BASELINE_DENOMINATOR_DATA);
  }, 60_000);

  it('gives the stale and absent fallbacks different verification ids, so a reader can tell them apart', () => {
    const stale = buildSandbox({ testResult: reporterPayload(), markerAgeMs: -600_000 });
    const staleRun = runHook(stale);
    const absent = buildSandbox({ markerAgeMs: 10_000 });
    const absentRun = runHook(absent);

    const hash = (box) => {
      const lines = readLedgerLines(box.ledger);
      expect(lines.length, `sandbox ledger: ${box.ledger}`).toBe(4);
      return lines[0].data.verification_id.split('-')[1];
    };
    expect(
      hash(stale),
      `reason feeds the id hash, and that is the ONLY branch signal in the ledger `
      + `(stale stderr: ${staleRun.stderr} / absent stderr: ${absentRun.stderr})`,
    ).not.toBe(hash(absent));
  }, 60_000);

  it('does not write a result file into the repo it reads (the hook only reads)', () => {
    const box = buildSandbox({ markerAgeMs: 10_000 });
    runHook(box);
    expect(existsSync(path.join(box.repo, 'plugins', 'artibot', 'runtime', 'last-test-result.json')))
      .toBe(false);
  }, 60_000);
});
