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
 *  - THE LIVE MIX. The exclusion cases seed 7 sessions and the `--since` cases 3.
 *    They prove the flag prints every view and that the identities hold; they do
 *    not prove what the live ledger's numbers are (that is a run against it).
 *  - WHY A LISTED SESSION MADE NO MODEL CALL. The CLI takes the list as given.
 *    What it can show is a listed session that HAS a receipt
 *    (`exclusion.with_receipts`), and that is all these cases pin.
 *  - A RACE BETWEEN THE TWO `--since` READS. Window and history are read one
 *    after the other from a ledger nothing appends to here; whether a row can
 *    land between them on a live ledger is not something this file exercises.
 *  - A WINDOW EDGE THAT SPLITS A SESSION. The `--since` seeds hold skipped
 *    sessions only, on purpose: a receipt row stamped "now" beside an ended row
 *    stamped in the past would build exactly that edge and test the artifact.
 *
 * SPLIT: the refusal, error-branch, spawn-retry and import-safety cases live in
 * `session-coverage-cli-edges.test.js`, moved verbatim to keep this file under the
 * 800-line standard (V5-BACKLOG section 3). The cases that seed a ledger and measure stay here.
 *
 * @module tests/ledger/session-coverage-cli
 */

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
import { spawnSyncRetryDllInit } from '../helpers/spawn-retry.js';

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
  'exclude_sessions', 'views',
];

/** Every view carries these, and only these. */
const VIEW_KEYS = ['coverage', 'ended', 'skipped', 'skipped_by_cause', 'unresolved_models', 'with_receipts'];

/**
 * The six sessions `ledger-exclusions-20260929.md` names. They appear here only
 * as DATA a ledger may contain: the CLI must never know them, so a run without
 * `--exclude-sessions` has to count all of them.
 */
const DOC_EXCLUDED_IDS = [
  '3eb8466c-6df6-4193-b880-a30529776aa0',
  'fd7bc579-aa62-4bc6-a93d-cfc93ef2d2e5',
  'b5369386-eee6-4a70-b486-cdf0876149bf',
  '65a342a1-c4f1-4746-b5b4-f7a57dccbc99',
  '860c8b93-6e48-4b16-8725-6801dfe42355',
  'a5d7a7b8-bc73-4f41-aceb-f0747c13c1a0',
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

/**
 * Run the CLI inside a project root.
 *
 * Through `spawnSyncRetryDllInit`: a child that exits 0xC0000142 with no output
 * died in the Windows loader before the CLI ran, and gets exactly one more
 * attempt (see the helper). Every assertion still reads the attempt it gets.
 * `deps.spawn` exists only for the case that pins this routing.
 */
function runCli(args, root, deps = {}) {
  const res = spawnSyncRetryDllInit(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env },
  }, deps);
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
 * @param {{status: string, reason?: string|null, fallback?: boolean,
 *   unresolved?: string[], now?: () => Date}} o
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
      unresolved_models: o.unresolved ?? [],
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

// ---------------------------------------------------------------------------
// Instrumentation for the ④ census: exclusion, cause columns, full history.
// No threshold moves here; what is pinned is that no number can be quoted
// without its counterpart.
// ---------------------------------------------------------------------------

/** ended = with_receipts + skipped, the causes partition skipped, coverage is the ratio. */
function expectIdentity(view, tag) {
  expect(view.ended, tag).toBe(view.with_receipts + view.skipped);
  const causeTotal = Object.values(view.skipped_by_cause).reduce((a, b) => a + b, 0);
  expect(causeTotal, tag).toBe(view.skipped);
  expect(view.coverage, tag).toBe(view.ended === 0 ? null : view.with_receipts / view.ended);
}

/** Every non-null view a printed report carries, tagged `<scope>.<kind>`. */
function allViews(printed) {
  const out = [];
  for (const scope of ['window', 'history']) {
    for (const kind of ['unexcluded', 'excluded']) {
      const view = printed.views[scope][kind];
      if (view !== null) out.push([`${scope}.${kind}`, view]);
    }
  }
  return out;
}

/** The printed report minus everything that legitimately differs between two runs. */
function rawFields(printed) {
  const copy = { ...printed };
  delete copy.measured_at;
  delete copy.exclude_sessions;
  delete copy.views;
  return copy;
}

/**
 * Seven ended sessions, arranged so every column has a value that is not zero
 * by accident and the excluded view differs from the raw one:
 *   sessCov0001..3          appended, receipt present               -> covered
 *   sessEmptyA01, B02       skipped, bare no-receipts               -> the empty `claude -p` shape
 *   sessDrift0001           skipped, bare, unresolved opus-5-5      -> catalog drift
 *   sessUnread001           skipped, no-receipts:unreadable         -> a suffixed cause
 * raw: ended 7 / with_receipts 3 / skipped 4. Without the two empties: 5 / 3 / 2.
 */
async function seedMix(root) {
  for (const [i, sid] of ['sessCov0001', 'sessCov0002', 'sessCov0003'].entries()) {
    seedEnded(root, sid, { status: 'appended' });
    await seedReceipt(root, sid, `runMix${i}`);
  }
  seedEnded(root, 'sessEmptyA01', { status: 'skipped', reason: 'no-receipts' });
  seedEnded(root, 'sessEmptyB02', { status: 'skipped', reason: 'no-receipts' });
  seedEnded(root, 'sessDrift0001', {
    status: 'skipped', reason: 'no-receipts', unresolved: ['claude-opus-5-5'],
  });
  seedEnded(root, 'sessUnread001', { status: 'skipped', reason: 'no-receipts:unreadable' });
}

const EMPTIES_LIST = [
  '# Empty claude -p runs (no model call)',
  '',
  'These carry no receipts because nothing ran.',
  '',
  '- sessEmptyA01',
  '- `sessEmptyB02`',
  '',
].join('\n');

describe('session-coverage: --exclude-sessions', () => {
  it('prints the raw view and the excluded view side by side', async () => {
    const root = makeRoot('X1');
    await seedMix(root);
    const list = path.join(root, 'empties.md');
    writeFileSync(list, EMPTIES_LIST, 'utf-8');
    expect(seededLines(root).filter((e) => e.event === 'session.ended')).toHaveLength(7);

    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', list], root));

    // The request is echoed, with what it could not read: one prose line.
    expect(printed.exclude_sessions).toEqual({ source: 'file', path: list, requested: 2, ignored: 1 });

    const { unexcluded, excluded, exclusion } = printed.views.window;
    expect(unexcluded).toMatchObject({ ended: 7, with_receipts: 3, skipped: 4 });
    expect(unexcluded.coverage).toBe(3 / 7);
    expect(excluded).toMatchObject({ ended: 5, with_receipts: 3, skipped: 2 });
    expect(excluded.coverage).toBe(3 / 5);
    expect(exclusion).toEqual({ requested: 2, matched_ended: 2, unmatched: [], with_receipts: [] });

    // The top-level fields are the RAW view. They never turn into the excluded one.
    expect(printed.ended).toBe(7);
    expect(printed.with_receipts).toBe(3);
    expect(printed.coverage).toBe(3 / 7);
    expect(printed.ended).toBe(unexcluded.ended);
  });

  it('holds ended = with_receipts + skipped in every view it prints', async () => {
    const root = makeRoot('X2');
    await seedMix(root);

    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'sessEmptyA01,sessEmptyB02'], root));

    const views = allViews(printed);
    expect(views.map(([tag]) => tag)).toEqual([
      'window.unexcluded', 'window.excluded', 'history.unexcluded', 'history.excluded',
    ]);
    for (const [tag, view] of views) {
      expect(Object.keys(view).sort(), tag).toEqual(VIEW_KEYS);
      expectIdentity(view, tag);
    }
  });

  it('CONTROL: the identity helper is able to fail', () => {
    const good = { ended: 5, with_receipts: 3, skipped: 2, coverage: 3 / 5, skipped_by_cause: { a: 2 } };
    expect(() => expectIdentity(good, 'good')).not.toThrow();
    expect(() => expectIdentity({ ...good, skipped: 3 }, 'tampered skipped')).toThrow();
    expect(() => expectIdentity({ ...good, skipped_by_cause: { a: 1 } }, 'tampered causes')).toThrow();
    expect(() => expectIdentity({ ...good, coverage: 1 }, 'tampered ratio')).toThrow();
  });

  it('splits the skipped sessions by cause and keeps catalog drift in its own column', async () => {
    const root = makeRoot('X3');
    await seedMix(root);

    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'sessEmptyA01,sessEmptyB02'], root));

    const { unexcluded, excluded } = printed.views.window;
    expect(unexcluded.skipped_by_cause).toEqual({ 'no-receipts': 3, 'no-receipts:unreadable': 1 });
    expect(excluded.skipped_by_cause).toEqual({ 'no-receipts': 1, 'no-receipts:unreadable': 1 });
    // Excluding two empty runs must not touch the drift evidence.
    for (const view of [unexcluded, excluded]) {
      expect(view.unresolved_models).toEqual({
        sessions: 1, skipped_sessions: 1, by_model: { 'claude-opus-5-5': 1 },
      });
    }
  });

  it('gives the same views for a comma-separated list as for a list file', async () => {
    const root = makeRoot('X4');
    await seedMix(root);
    const list = path.join(root, 'empties.md');
    writeFileSync(list, EMPTIES_LIST, 'utf-8');

    const fromFile = parseOne(runCli(['--cwd', root, '--exclude-sessions', list], root));
    const fromCsv = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'sessEmptyA01, sessEmptyB02'], root));

    expect(fromCsv.views).toEqual(fromFile.views);
    expect(fromCsv.exclude_sessions).toEqual({ source: 'list', path: null, requested: 2, ignored: 0 });
  });

  it('resolves a relative list path against the process cwd', async () => {
    const root = makeRoot('X5');
    await seedMix(root);
    writeFileSync(path.join(root, 'empties.md'), EMPTIES_LIST, 'utf-8');

    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'empties.md'], root));

    expect(printed.exclude_sessions.source).toBe('file');
    expect(printed.exclude_sessions.path).toBe(path.join(root, 'empties.md'));
    expect(printed.views.window.excluded.ended).toBe(5);
  });

  it('leaves every raw number exactly as a run without the flag prints it', async () => {
    const root = makeRoot('X6');
    await seedMix(root);

    const plain = parseOne(runCli(['--cwd', root], root));
    const flagged = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'sessEmptyA01,sessEmptyB02'], root));

    expect(rawFields(flagged)).toEqual(rawFields(plain));
    expect(flagged.views.window.unexcluded).toEqual(plain.views.window.unexcluded);
    expect(flagged.views.history.unexcluded).toEqual(plain.views.history.unexcluded);
    // ...and the flag is what made the difference, not chance:
    expect(flagged.views.window.excluded).not.toEqual(flagged.views.window.unexcluded);
  });

  it('NEGATIVE CONTROL: knows no ids of its own — without the flag it counts the documented six', () => {
    const root = makeRoot('X7');
    for (const sid of DOC_EXCLUDED_IDS) seedEnded(root, sid, { status: 'skipped', reason: 'no-receipts' });
    seedEnded(root, 'sessReal00001', { status: 'skipped', reason: 'no-receipts' });

    const plain = parseOne(runCli(['--cwd', root], root));

    expect(plain.ended).toBe(7);
    expect(plain.exclude_sessions).toBeNull();
    for (const scope of ['window', 'history']) {
      expect(plain.views[scope].unexcluded.ended).toBe(7);
      expect(plain.views[scope].excluded).toBeNull();
      expect(plain.views[scope].exclusion).toBeNull();
    }

    // POSITIVE CONTROL: the same ledger, told to exclude them, does.
    const flagged = parseOne(runCli(['--cwd', root, '--exclude-sessions', DOC_EXCLUDED_IDS.join(',')], root));
    expect(flagged.views.window.excluded.ended).toBe(1);
    expect(flagged.views.window.exclusion.matched_ended).toBe(6);
  });

  it('FLAGS an excluded session that has a receipt instead of quietly dropping it', async () => {
    const root = makeRoot('X8');
    await seedMix(root);

    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'sessCov0001,sessEmptyA01'], root));

    // A covered session on the list lowers numerator and denominator together;
    // the report has to make that visible.
    expect(printed.views.window.exclusion.with_receipts).toEqual(['sessCov0001']);
    expect(printed.views.window.excluded).toMatchObject({ ended: 5, with_receipts: 2, skipped: 3 });
  });

  it('names an id the ledger has no session.ended row for, and changes nothing for it', async () => {
    const root = makeRoot('X9');
    await seedMix(root);

    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'ghost-1'], root));

    expect(printed.exclude_sessions).toEqual({ source: 'list', path: null, requested: 1, ignored: 0 });
    expect(printed.views.window.exclusion).toEqual({
      requested: 1, matched_ended: 0, unmatched: ['ghost-1'], with_receipts: [],
    });
    expect(printed.views.window.excluded).toEqual(printed.views.window.unexcluded);
  });

  it('leaves the ledger byte-for-byte the same length', async () => {
    const root = makeRoot('X10');
    await seedMix(root);
    const file = ledgerFilePath(root);
    const before = statSync(file).size;

    // parseOne first: a run that exits 2 before reading anything also leaves the
    // file untouched, and would make this assertion pass for the wrong reason.
    const printed = parseOne(runCli([
      '--cwd', root, '--since', '2026-01-01T00:00:00Z', '--exclude-sessions', 'sessEmptyA01',
    ], root));

    expect(printed.views.window.excluded.ended).toBe(6);
    expect(statSync(file).size).toBe(before);
  });
});

describe('session-coverage: the window and the full history', () => {
  /** Two sessions inside the window, one before it. */
  function seedAcrossCutoff(root) {
    seedEnded(root, 'sessOldEmpty01', {
      status: 'skipped', reason: 'no-receipts', now: () => new Date('2026-09-01T00:00:00Z'),
    });
    seedEnded(root, 'sessNewEmpty02', {
      status: 'skipped', reason: 'no-receipts', now: () => new Date('2026-09-13T00:00:00Z'),
    });
    seedEnded(root, 'sessNewDrift03', {
      status: 'skipped', reason: 'no-receipts', unresolved: ['claude-opus-5-5'],
      now: () => new Date('2026-09-13T00:00:00Z'),
    });
  }

  it('prints the full-history views next to the window', () => {
    const root = makeRoot('H1');
    seedAcrossCutoff(root);

    const printed = parseOne(runCli([
      '--cwd', root, '--since', '2026-09-10T00:00:00Z',
      '--exclude-sessions', 'sessOldEmpty01,sessNewEmpty02',
    ], root));

    expect(printed.since).toBe('2026-09-10T00:00:00.000Z');
    // Top level is still the RAW WINDOW, as before this flag existed.
    expect(printed.ended).toBe(2);
    expect(printed.census.dropped.selection.filtered_out).toBe(1);

    const { window: win, history } = printed.views;
    expect(win.unexcluded.ended).toBe(2);
    expect(history.unexcluded.ended).toBe(3);
    expect(win.excluded.ended).toBe(1);
    expect(history.excluded.ended).toBe(1);
    // The old empty session is outside the window, so the window cannot match
    // it; the history can. Each scope reports its own account.
    expect(win.exclusion).toEqual({
      requested: 2, matched_ended: 1, unmatched: ['sessOldEmpty01'], with_receipts: [],
    });
    expect(history.exclusion).toEqual({
      requested: 2, matched_ended: 2, unmatched: [], with_receipts: [],
    });
    for (const [tag, view] of allViews(printed)) expectIdentity(view, tag);
  });

  it('never reports a history smaller than its window', () => {
    const root = makeRoot('H2');
    seedAcrossCutoff(root);

    const printed = parseOne(runCli(['--cwd', root, '--since', '2026-09-10T00:00:00Z'], root));

    expect(printed.views.history.unexcluded.ended).toBeGreaterThanOrEqual(printed.views.window.unexcluded.ended);
    expect(printed.views.history.unexcluded.skipped).toBeGreaterThanOrEqual(printed.views.window.unexcluded.skipped);
    expect(printed.views.window.excluded).toBeNull();
    expect(printed.views.history.excluded).toBeNull();
  });

  it('prints an identical history when there is no --since', () => {
    const root = makeRoot('H3');
    seedAcrossCutoff(root);

    const printed = parseOne(runCli(['--cwd', root], root));

    expect(printed.since).toBeNull();
    expect(printed.views.history).toEqual(printed.views.window);
    expect(printed.views.history.unexcluded.ended).toBe(3);
  });
});
