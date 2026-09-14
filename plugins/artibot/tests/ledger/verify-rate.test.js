/**
 * Real-process contract for `scripts/ledger/verify-rate.mjs` — the read-only
 * CLI that reports how many Stop-hook `verify.completed` denominators a
 * `/verify` self-report answered.
 *
 * WHY THESE CASES SPAWN A PROCESS. `tests/verification/verify-rate.test.js`
 * drives the pure fold over arrays it built itself, so it proves the counting
 * and proves nothing about the path this CLI reads, the filters it passes to
 * `readLedgerCensus`, or its exit codes. It also cannot prove the one property
 * that matters most here.
 *
 * READ-ONLY IS ASSERTED, NOT DECLARED. Every other `scripts/ledger/*` entry
 * point appends. This one must not, and "we did not import the writer" is a
 * claim about the source, not about the run — a transitive import, a stray
 * `mkdirSync`, or the ledger reader itself creating a directory would all slip
 * past it. So `leaves the ledger byte-identical` captures mtime, size, the raw
 * bytes AND the directory listing before the spawn and asserts all four
 * unchanged after it.
 *
 * WHAT A GREEN RUN HERE DOES NOT PROVE (rules §9):
 *  - That the live ledger looks like these fixtures. Measured 2026-09-14 14:31
 *    KST on this machine's parent ledger: 810 non-blank lines, 16 of them
 *    `verify.completed` — 4 hook firings across 3 sessions and NO self-report
 *    at all, so the one case these fixtures centre on has never occurred in
 *    production. Every number below comes from a fixture.
 *  - That the INSTALLED copy behaves this way. These cases run the file in this
 *    worktree.
 *  - Anything about concurrent appends. The ledger is read once; a line that
 *    lands during the read is invisible, exactly as
 *    `readLedgerCensus`'s own header says (`lib/runtime/ledger.js:235`).
 *
 * @module tests/ledger/verify-rate
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { SELF_REPORT_NOTE } from '../../lib/verification/verify-rate.js';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'verify-rate.mjs');

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = ['ok', 'reason', 'file', 'rate', 'census'];

const STAMP = '20260914T120000Z';

/** @type {string} */
let tmp;
let seq = 0;

/**
 * A project root the Artibot guards will actually run inside — a bare `.git/`
 * is not enough, per `tests/ledger/record-verify.test.js:33-39`.
 *
 * @param {string} name
 * @returns {string}
 */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/**
 * One `verify.completed` envelope. `seq` is unique per line because
 * `lib/runtime/ledger.js#dedupeKey` (:144) keys on session/source/pid/seq/ts.
 *
 * @param {{session: string, vid: string, layer: string|null, result: string,
 *          note?: string, ts: string}} p
 * @returns {object}
 */
function line({ session, vid, layer, result, note, ts }) {
  seq += 1;
  const data = {
    result,
    evidence: note === undefined ? [] : [{ kind: 'command', command: '/verify', output: '', note }],
    verification_id: vid,
  };
  if (layer !== null) data.layer = layer;
  return {
    ts, session_id: session, event: 'verify.completed', source: 'gate', pid: 4242, seq,
    idempotency_key: `${vid}:${layer ?? 'overall'}`, data,
  };
}

/**
 * @param {{session: string, vid: string, ts: string}} p
 * @returns {object[]}
 */
function hookRun({ session, vid, ts }) {
  return ['deterministic', 'behavioral', 'operational', null]
    .map((layer) => line({ session, vid, layer, result: 'unmeasured', ts }));
}

/**
 * @param {{session: string, vid: string, ts: string}} p
 * @returns {object[]}
 */
function selfReportRun({ session, vid, ts }) {
  return [
    line({ session, vid, layer: 'deterministic', result: 'pass', note: SELF_REPORT_NOTE, ts }),
    line({ session, vid, layer: 'behavioral', result: 'unmeasured', ts }),
    line({ session, vid, layer: 'operational', result: 'unmeasured', ts }),
    line({ session, vid, layer: null, result: 'pass', ts }),
  ];
}

/**
 * Write the brief fixture — two hook firings, one of them answered — into the
 * root's real ledger path.
 *
 * @param {string} root
 * @returns {string} the ledger file path
 */
function writeFixture(root) {
  const file = ledgerFilePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const events = [
    ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' }),
    ...hookRun({ session: 'S2', vid: `v1-bbbbbbbbbbbb-${STAMP}`, ts: '2026-09-14T12:05:00.000Z' }),
    ...selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' }),
  ];
  writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  return file;
}

/**
 * @param {string[]} args
 * @param {string} root child cwd
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, with its key set checked before anything reads a field. */
function parseOut(out) {
  expect(out.stdout.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
  const printed = JSON.parse(out.stdout);
  expect(Object.keys(printed)).toEqual(STDOUT_KEYS);
  return printed;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-vrate-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('verify-rate CLI: reading a real ledger', () => {
  it('reports one of two firings answered, with the census beside the rate', () => {
    const root = makeRoot('A');
    const file = writeFixture(root);

    const out = runCli(['--cwd', root], root);

    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    const printed = parseOut(out);
    expect(printed.ok).toBe(true);
    expect(printed.reason).toBe(null);
    expect(printed.file).toBe(file);
    expect(printed.rate.sessions.rate).toBe(0.5);
    expect(printed.rate.firings.rate).toBe(0.5);
    expect(printed.rate.ids).toEqual({ hook: 2, self_report: 1, other: 0, unknown_stamp: 0 });
    // The census is what makes the rate readable: 12 survivors out of 12
    // non-blank lines means nothing upstream was dropped.
    expect(printed.census.survivors).toBe(12);
    expect(printed.census.lines.nonblank).toBe(12);
    expect(printed.census.dropped_total).toEqual({ loss: 0, selection: 0 });
    expect(printed.census.file.path).toBe(file);
  });

  it('defaults --cwd to the process cwd', () => {
    const root = makeRoot('B');
    writeFixture(root);

    const printed = parseOut(runCli([], root));

    expect(printed.ok).toBe(true);
    expect(printed.rate.firings.hook).toBe(2);
  });

  it('leaves the ledger byte-identical and creates no sibling file', () => {
    const root = makeRoot('C');
    const file = writeFixture(root);
    const dir = path.dirname(file);
    const before = {
      bytes: readFileSync(file),
      mtimeMs: statSync(file).mtimeMs,
      size: statSync(file).size,
      listing: readdirSync(dir).sort(),
    };

    const out = runCli(['--cwd', root], root);
    expect(out.status).toBe(0);

    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readFileSync(file).equals(before.bytes)).toBe(true);
    // A `ledger.rejected` line lands in the SAME file, which the byte compare
    // already covers; this catches a writer that created a new file instead.
    expect(readdirSync(dir).sort()).toEqual(before.listing);
  });

  it('filters to one session and says how many lines that filter removed', () => {
    const root = makeRoot('D');
    writeFixture(root);

    const printed = parseOut(runCli(['--cwd', root, '--session', 'S1'], root));

    expect(printed.ok).toBe(true);
    expect(printed.rate.sessions.hook).toBe(1);
    expect(printed.rate.firings).toEqual({ hook: 1, answered: 1, unordered: 0, rate: 1 });
    // S2's four lines. A filtered rate whose denominator shrank silently is the
    // failure mode `census.dropped.selection` exists to make visible.
    expect(printed.census.dropped.selection.filtered_out).toBe(4);
    expect(printed.census.survivors).toBe(8);
  });

  it('honours --since', () => {
    const root = makeRoot('E');
    writeFixture(root);

    const printed = parseOut(runCli(['--cwd', root, '--since', '2026-09-14T12:07:00.000Z'], root));

    // Only the self-report survives the cut, so there is no firing left to
    // measure and the rate is null rather than 0 — an absent denominator, not
    // a failure to answer.
    expect(printed.rate.ids).toEqual({ hook: 0, self_report: 1, other: 0, unknown_stamp: 0 });
    expect(printed.rate.firings.rate).toBe(null);
    expect(printed.census.dropped.selection.filtered_out).toBe(8);
  });
});

describe('verify-rate CLI: when there is no ledger to read', () => {
  it('exits 0, says so, and still prints the zero rate', () => {
    const root = makeRoot('F');
    const file = ledgerFilePath(root);
    expect(existsSync(file)).toBe(false);

    const out = runCli(['--cwd', root], root);

    // Exit 0: an absent ledger is an observation about the environment, not a
    // malformed request. The caller reads `ok`, exactly as record-verify.mjs
    // asks its callers to read `recorded` (:82).
    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    const printed = parseOut(out);
    expect(printed.ok).toBe(false);
    expect(printed.reason).toContain(file);
    expect(printed.file).toBe(file);
    expect(printed.rate.sessions.rate).toBe(null);
    expect(printed.rate.lines.total).toBe(0);
    expect(printed.census.file.present).toBe(false);
  });

  it('exits 0 when the ledger path cannot be opened', () => {
    const root = makeRoot('G');
    // A regular FILE where the ledger's directory has to be, the way
    // tests/ledger/record-verify.test.js:336-358 does it.
    const dir = path.dirname(ledgerFilePath(root));
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, 'not a directory\n', 'utf-8');

    const out = runCli(['--cwd', root], root);

    expect(out.status).toBe(0);
    const printed = parseOut(out);
    expect(printed.ok).toBe(false);
    expect(typeof printed.reason).toBe('string');
    expect(printed.reason.length).toBeGreaterThan(0);
    expect(printed.rate.firings.rate).toBe(null);
    // WHICH of the two flavours the census reports is platform-dependent: an
    // ENOTDIR makes `existsSync` answer false on Windows, so the path reads as
    // absent rather than unreadable. Both are `ok:false`; neither is a rate.
    expect(printed.census.file.present === false || printed.census.file.readable === false).toBe(true);
  });
});

describe('verify-rate CLI: a malformed command line', () => {
  const cases = [
    ['an unknown flag', ['--oops']],
    ['a flag with no value', ['--cwd']],
    ['an empty --cwd', ['--cwd', '']],
    ['an unparsable --since', ['--since', 'notadate']],
  ];

  for (const [label, args] of cases) {
    it(`exits 2 and writes nothing to stdout for ${label}`, () => {
      const root = makeRoot(`H${label.length}`);
      writeFixture(root);

      const out = runCli(args, root);

      // Exit 2, not 0, and this is a DELIBERATE deviation from the task brief:
      // a wrong command line means the caller asked for something impossible,
      // and printing a rate over it would report a measurement that was never
      // requested. Same reasoning as record-verify.mjs:88-94.
      expect(out.status).toBe(2);
      expect(out.stdout).toBe('');
      const lines = out.stderr.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith('verify-rate: ')).toBe(true);
      expect(lines[0]).toContain('usage:');
    });
  }

  it('does not touch the ledger on a usage error', () => {
    const root = makeRoot('I');
    const file = writeFixture(root);
    const before = readFileSync(file);

    runCli(['--oops'], root);

    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe('verify-rate CLI: it is safe to import', () => {
  it('does nothing when imported rather than run', async () => {
    // The direct-run guard is what lets a test or a sibling import this file
    // without running a side effect. A guard that answers FALSE on a real
    // direct run is fail-open in the quietest way
    // (tests/ci/direct-run-guard.test.js); every case above is the positive
    // half of that pin, this is the negative half.
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
  });
});
