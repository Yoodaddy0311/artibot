/**
 * Real-process contract for `scripts/ledger/session-coverage.mjs` — the CLI that
 * prints Observe axis ④ session coverage.
 *
 * WHY THE CASES SPAWN A PROCESS AND SEED A REAL LEDGER. The arithmetic lives in
 * `lib/replay/session-coverage.js` and has its own pure unit suite, which proves
 * the fold counts a given ARRAY correctly and proves nothing about whether rows
 * of that shape survive the ledger's allowlist, envelope validation and byte
 * cap on the way in. A `data` shape the writer refuses lands as
 * `ledger.rejected` and is excluded from every read — green fold tests and an
 * empty coverage report are perfectly compatible. So every seeded case here
 * writes through the real `appendLedgerEvent` and spawns the real script
 * against it; the FIRST seeded case asserts the file holds ZERO
 * `ledger.rejected` lines, and the later cases reuse the same deterministic
 * seed, so that one assertion covers the shape they all depend on.
 *
 * READ-ONLY IS ASSERTED, NOT ASSUMED. The Observe contract says this script
 * writes nothing, and "it does not import the writer" is a claim about the
 * source rather than about the run. Two cases measure the filesystem instead:
 * an empty root must still have no ledger file after the script has run, and a
 * seeded root's ledger must have the same byte length before and after. A
 * measuring tool that appends to the stream it measures is its own next data
 * point, and that regression is invisible in every other assertion here.
 *
 * `coverage` IS `null`, NEVER `0`, WHEN NOTHING ENDED — asserted with BOTH
 * `toBeNull()` and `not.toBe(0)`. The two are different findings ("no
 * denominator yet" vs "sessions ended and none were covered") and `expect(x)
 * .toBeFalsy()` would pass for either. This is the live case as of
 * 2026-09-14, so it is the assertion most likely to be read as noise and
 * loosened.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *  Every case builds its own `mkdtempSync` root and uses it as BOTH the child
 *  process cwd and `--cwd`, so nothing here can reach the repository's own
 *  ledger. The one case that omits `--cwd` still runs with the child cwd inside
 *  the temp root, which is the defaulting behaviour it measures.
 *  `resolveGitCommonDir` is pure `fs` (no `git` subprocess), so the path this
 *  file computes and the path the child computes come from one function over
 *  one root.
 *
 * ── WHY EVERY TMP ROOT CARRIES `artibot.config.json` ────────────────────────
 *  Inherited from `tests/ledger/record-verify.test.js`: Artibot guards drop out
 *  entirely when the cwd is outside an Artibot repo, and a bare `.git/`
 *  directory is not enough to make a temp directory look like one. Nothing here
 *  depends on a guard firing, so the file keeps these roots the same shape as
 *  the precedent's rather than being load-bearing.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - WHETHER ANY SESSION EVER WRITES A `session.ended` ROW. The rows here are
 *    seeded by the test. Measured 2026-09-14T05:15Z, the parent ledger had 0 of
 *    them, so the live answer is `coverage:null` and this file says nothing
 *    about when that changes.
 *  - WHETHER `receipt_status` IS TRUE. It is a self-report copied by the hook;
 *    the seeds here assert the CLI carries the claim through, not that a claim
 *    matches reality.
 *  - THE FOLD'S CLASSIFICATION RULES. `disagree` is asserted only through its
 *    own internal invariant (count === the two list lengths) plus "at least
 *    one", so this file stays green if the fold refines which bucket a row
 *    lands in. The bucket rules belong to the fold's own suite.
 *  - THE INSTALLED COPY, and any ledger larger than a handful of rows.
 *
 * @module tests/ledger/session-coverage-cli
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath, sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import { toUsageReceiptEnvelopes } from '../../lib/economics/receipt-envelope.js';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'session-coverage.mjs');

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'event', 'measured_at', 'ledger_path', 'since',
  'ended', 'with_receipts', 'coverage', 'fallback_sessions',
  'by_status', 'by_reason', 'disagree',
  'receipt_only_sessions', 'receipt_sessions', 'duplicate_ended_rows',
  'malformed_ended', 'census',
];

/** @type {string} */
let tmp;

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Run the CLI inside a project root. */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, parsed, with the stream discipline checked first. */
function parseOne(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

/** Every well-formed line in a project's ledger, rejections included. */
function ledgerLines(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * The seeded rows, with the rejected count checked FIRST.
 *
 * A rejected line means the seed violated the writer's contract and was
 * silently replaced — every count below would then be measured over a file that
 * does not contain what this test thinks it seeded.
 */
function seededLines(root) {
  const lines = ledgerLines(root);
  expect(lines.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
  return lines;
}

/** One assistant transcript entry in the shape measured 2026-09-02. */
function entry(requestId, timestamp) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp,
    effort: 'high',
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 800,
        output_tokens: 45,
        output_tokens_details: { thinking_tokens: 12 },
      },
    },
  });
}

/**
 * Append a schema-valid `usage.receipt` for one session.
 *
 * Built through the real writer with injected ports rather than hand-typed:
 * `event-writer.js` validates this event's whole `data` object against
 * `schemas/attempt-receipt.schema.json`, so an invented shape lands as
 * `ledger.rejected` and the row this test needs is never in the file.
 *
 * THE MISSION ID IS SYNTHESIZED BY THE PRODUCTION HELPER, not spelled by hand.
 * `event-writer.js#MISSION_ID_RE` accepts only `M-<YYYYMMDD>-<seq|Ssid8>`, and
 * `toUsageReceiptEnvelopes` lifts the receipt's id onto the envelope — a
 * readable id like `mission-runA` is rejected as `invalid-envelope:mission_id`
 * and the whole receipt is lost. Caught by the rejection check below on the
 * first run of this file, which is why that check runs before every count.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {string} stem transcript stem — becomes the receipt's `run_id`
 * @returns {Promise<void>}
 */
async function seedReceipt(root, sessionId, stem) {
  const transcriptPath = `/fixture/projects/slug/${stem}.jsonl`;
  const body = [
    entry(`${stem}-a`, '2026-09-13T06:29:36.000Z'),
    entry(`${stem}-b`, '2026-09-13T06:29:41.250Z'),
  ].join('\n');
  const { receipts } = await buildUsageReceipts({
    transcriptPath,
    missionId: sessionFallbackMissionId(sessionId, '2026-09-13T00:00:00.000Z'),
    readTranscript: (p) => {
      if (p !== transcriptPath) throw new Error(`ENOENT ${p}`);
      return body;
    },
    listSubagentTranscripts: () => [],
  });
  const envelopes = toUsageReceiptEnvelopes(receipts, { sessionId });
  expect(envelopes.length).toBeGreaterThanOrEqual(1);
  for (const envelope of envelopes) appendLedgerEvent(root, envelope);
}

/**
 * Append one `session.ended` row in the shape
 * `scripts/hooks/session-end.js#appendSessionEndedEvent` writes.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {{status: string, reason?: string|null, fallback?: boolean, now?: () => Date}} o
 * @returns {void}
 */
function seedEnded(root, sessionId, o) {
  const res = appendLedgerEvent(root, {
    event: 'session.ended',
    session_id: sessionId,
    source: 'hook',
    idempotency_key: `session.ended:${sessionId}`,
    data: {
      receipt_status: o.status,
      receipts: 0,
      appended: 0,
      rejected: 0,
      deduped: 0,
      coverage: null,
      reason: o.reason ?? null,
      unresolved_models: [],
      transcript_present: true,
      session_fallback: o.fallback === true,
    },
  }, o.now === undefined ? {} : { now: o.now });
  // The seed is the premise of every count below; a silent write failure would
  // read as "the CLI counted wrong".
  expect(res.ok).toBe(true);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-scov-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('session-coverage: a project with no ledger', () => {
  it('reports coverage null — not 0 — and creates no file', () => {
    const root = makeRoot('A');
    const file = ledgerFilePath(root);
    expect(existsSync(file)).toBe(false);

    const printed = parseOne(runCli(['--cwd', root], root));

    expect(printed.event).toBe('session.ended');
    expect(printed.ended).toBe(0);
    // "No denominator yet" and "nothing was covered" are different findings.
    expect(printed.coverage).toBeNull();
    expect(printed.coverage).not.toBe(0);
    expect(printed.with_receipts).toBe(0);
    expect(printed.census.file.present).toBe(false);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.ledger_path).toBe(file);
    expect(printed.since).toBeNull();
    // READ-ONLY: reading a coverage number must not create the thing it reads.
    expect(existsSync(file)).toBe(false);
  });
});

describe('session-coverage: a seeded ledger', () => {
  /**
   * Three ended sessions and four receipt sessions, arranged so every field on
   * stdout has a value that is not zero by accident:
   *   A  ended `appended`, has a receipt          -> agrees
   *   B  ended `skipped`,  has a receipt          -> a receipt the status denies
   *   C  ended `failed`,   no receipt, fallback   -> the fallback denominator row
   *   D  never ended,      has a receipt          -> receipt-only
   */
  async function seedThree(root) {
    seedEnded(root, 'sessCovA0001', { status: 'appended' });
    seedEnded(root, 'sessCovB0002', { status: 'skipped', reason: 'no-transcript' });
    seedEnded(root, 'sessCovC0003', { status: 'failed', reason: 'write-failed', fallback: true });
    await seedReceipt(root, 'sessCovA0001', 'runA');
    await seedReceipt(root, 'sessCovB0002', 'runB');
    await seedReceipt(root, 'sessCovD0004', 'runD');
  }

  it('divides receipts by ended sessions and names both sides', async () => {
    const root = makeRoot('B');
    await seedThree(root);
    expect(seededLines(root).filter((e) => e.event === 'session.ended')).toHaveLength(3);

    const printed = parseOne(runCli(['--cwd', root], root));

    expect(printed.ended).toBe(3);
    expect(printed.with_receipts).toBe(2);
    expect(printed.coverage).toBeCloseTo(2 / 3, 10);
    // A session with no id is still a session that ended. Excluding it would
    // shrink the denominator and INFLATE coverage — the one error the fallback
    // row exists to prevent.
    expect(printed.fallback_sessions).toBe(1);
    expect(printed.receipt_sessions).toBe(3);
    expect(printed.receipt_only_sessions).toEqual(['sessCovD0004']);
    expect(printed.duplicate_ended_rows).toBe(0);
    // A dropped ended row shrinks the denominator and leaves the numerator
    // alone, so a non-zero value here means `coverage` above reads too HIGH.
    expect(printed.malformed_ended).toBe(0);
    expect(printed.by_status).toEqual({ appended: 1, skipped: 1, failed: 1 });
    expect(printed.by_reason['no-transcript']).toBe(1);
    expect(printed.by_reason['write-failed']).toBe(1);
    expect(printed.census.file.present).toBe(true);
    expect(printed.census.survivors).toBe(6);
  });

  it('reports the two sides disagreeing rather than averaging them away', async () => {
    const root = makeRoot('C');
    await seedThree(root);

    const { disagree } = parseOne(runCli(['--cwd', root], root));

    // The bucket rules belong to the fold's own suite; what this file pins is
    // that the count is the lists (a count that drifts from its own evidence is
    // the failure that would be quoted to a human) and that the seeded
    // contradiction is not silently reconciled.
    expect(disagree.count).toBe(
      disagree.status_appended_no_receipt.length
      + disagree.receipt_but_status_not_appended.length,
    );
    expect(disagree.count).toBeGreaterThanOrEqual(1);
  });

  it('leaves the ledger byte-for-byte the same length', async () => {
    const root = makeRoot('D');
    await seedThree(root);
    const file = ledgerFilePath(root);
    const before = statSync(file).size;

    runCli(['--cwd', root], root);

    // The Observe contract, measured on the filesystem rather than inferred
    // from which modules the script imports.
    expect(statSync(file).size).toBe(before);
  });

  it('prints one line of JSON with the fixed key set', async () => {
    const root = makeRoot('E');
    await seedThree(root);

    const out = runCli(['--cwd', root], root);

    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    // Not pretty-printed: a newline inside the object would make the "one line"
    // promise false for every downstream parser.
    expect(out.stdout.trimEnd()).not.toContain('\n');
    const printed = JSON.parse(out.stdout);
    expect(Object.keys(printed).sort()).toEqual([...STDOUT_KEYS].sort());
    expect(Number.isFinite(Date.parse(printed.measured_at))).toBe(true);
  });

  it('defaults --cwd to the process cwd', async () => {
    const root = makeRoot('F');
    await seedThree(root);

    // No --cwd: the child's own cwd is the root. This is the global-install
    // trap from the module header, exercised in its intended direction.
    const printed = parseOne(runCli([], root));

    expect(printed.ended).toBe(3);
    expect(printed.ledger_path).toBe(ledgerFilePath(root));
  });
});

describe('session-coverage: --since', () => {
  it('excludes rows written before the cutoff and says so in the census', () => {
    const root = makeRoot('G');
    seedEnded(root, 'sessOld00001', { status: 'appended', now: () => new Date('2026-09-01T00:00:00Z') });
    seedEnded(root, 'sessNew00002', { status: 'appended', now: () => new Date('2026-09-13T00:00:00Z') });

    const all = parseOne(runCli(['--cwd', root], root));
    const recent = parseOne(runCli(['--cwd', root, '--since', '2026-09-10T00:00:00Z'], root));

    expect(all.ended).toBe(2);
    expect(all.since).toBeNull();
    expect(recent.ended).toBe(1);
    // The cutoff is echoed as the RESOLVED instant, so a reader never has to
    // re-parse the argument to know what was actually cut at.
    expect(recent.since).toBe('2026-09-10T00:00:00.000Z');
    // A filtered row is SELECTION, not loss: a coverage denominator built from
    // survivors alone cannot tell the two apart.
    expect(recent.census.dropped.selection.filtered_out).toBe(1);
    expect(recent.census.dropped_total.loss).toBe(0);
  });

  it('accepts epoch milliseconds and resolves them to the same instant', () => {
    const root = makeRoot('H');
    seedEnded(root, 'sessNew00002', { status: 'appended', now: () => new Date('2026-09-13T00:00:00Z') });

    const printed = parseOne(runCli([
      '--cwd', root, '--since', String(Date.parse('2026-09-10T00:00:00Z')),
    ], root));

    // Date.parse reads an all-digit string as something other than a stamp, so
    // this case is the one that catches a regression to a bare Date.parse.
    expect(printed.since).toBe('2026-09-10T00:00:00.000Z');
    expect(printed.ended).toBe(1);
  });
});

describe('session-coverage: what it refuses to answer', () => {
  it.each([
    ['an unknown flag is passed', ['--oops']],
    ['a flag has no value', ['--cwd']],
    ['--since has no value', ['--since']],
    ['--since does not parse to a time', ['--since', 'nonsense']],
    ['--since is empty', ['--since', '   ']],
  ])('exits 2 with an empty stdout when %s', (_label, args) => {
    const root = makeRoot('I');

    const out = runCli(args, root);

    // A malformed request is not an observation. Exiting 0 here would report a
    // measurement that was never taken, so a typo could read as success.
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('session-coverage:')).toBe(true);
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('still exits 0 when the ledger path is not a readable file', () => {
    const root = makeRoot('J');
    // A DIRECTORY where the ledger file belongs: present, not readable as text.
    mkdirSync(ledgerFilePath(root), { recursive: true });

    const printed = parseOne(runCli(['--cwd', root], root));

    // "The ledger cannot be read" is a finding about the project, not a failure
    // of this script — and the JSON is what says which of the two it was.
    expect(printed.census.file.present).toBe(true);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.ended).toBe(0);
    expect(printed.coverage).toBeNull();
  });
});

describe('session-coverage: it is safe to import', () => {
  it('exposes main and writes nothing when imported rather than run', async () => {
    const root = makeRoot('K');
    const file = ledgerFilePath(root);

    // The direct-run guard is what lets a test import this file without running
    // it. A guard that answers TRUE under import would make this import parse
    // the importer's own argv and print a line; a guard that answers FALSE on a
    // real direct run is fail-open in the quietest way (tests/ci/direct-run-guard).
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
    expect(existsSync(file)).toBe(false);
  });
});
