/**
 * The round trip: the real writer `scripts/ledger/record-verify.mjs` spawned as
 * a process, the real file it produced, and the real reader
 * `lib/verification/verify-rate.js#computeVerifyRate` folding those bytes back.
 *
 * ── WHY THIS FILE EXISTS NEXT TO THE TWO THAT ALREADY PASS ──────────────────
 * `tests/ledger/record-verify.test.js` proves the writer lands four lines.
 * `tests/verification/verify-rate.test.js` proves the reader classifies lines
 * it was HANDED. Both are green while the numerator is zero, because neither
 * one crosses the seam: the reader's fixtures are written by the test, not by
 * the writer. A marker the writer stops emitting, an evidence entry
 * `sanitizeEvidence` drops, an envelope field the reader keys on — each of
 * those breaks the join and leaves both files green. This file is the only
 * place where the bytes the writer actually produced are the bytes the reader
 * actually counts.
 *
 * ── WHY THE NEGATIVE CONTROL IS NOT OPTIONAL ────────────────────────────────
 * `ids.self_report === 1` over a one-run ledger is also what a reader that
 * counted EVERYTHING as a self-report would print. So the same real rows are
 * replayed with `data.evidence[0].note` stripped, and the count must fall to
 * zero. Without that, the positive case measures nothing.
 *
 * Stripping the note does not make the run vanish — it becomes `measured`,
 * because a self-report's deterministic line carries `result: 'pass'`
 * (`record-verify.mjs:315`) and `bucketOf` falls through to the next bucket.
 * That is asserted too: it is the difference between "the reader discriminates"
 * and "the reader dropped the run".
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Following `tests/ledger/record-verify.test.js`: every case builds its own
 * `mkdtempSync` root carrying `.git/` and `artibot.config.json`, and passes it
 * as BOTH the child cwd and `--cwd`. Nothing here can reach the repository's
 * own ledger store, and nothing here reads it.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - WHETHER ANY MODEL RUNS THE STEP. `commands/verify.md` Step 5 asks for it.
 *    Nothing executes it. A green round trip says the machinery works when
 *    called, and says nothing about the live numerator.
 *  - THE INSTALLED COPY. The script under test is the one in this worktree.
 *    The copy under `$HOME/.claude/artibot/` can lag by releases.
 *  - THE CLI WRAPPER. `scripts/ledger/verify-rate.mjs` reads a real ledger and
 *    prints the census; this file calls `computeVerifyRate` directly, so a
 *    wrapper that dropped or mis-globbed lines is invisible here.
 *  - THE LIVE LEDGER. Only temp roots are read. The rate on this machine, and
 *    whether any of these lines ever appear there, is unmeasured here.
 *  - WHETHER `--status PASS` IS TRUE. Nothing behind the flag ran a linter.
 *
 * @module tests/ledger/verify-self-report-roundtrip
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { computeVerifyRate } from '../../lib/verification/verify-rate.js';
import { SELF_REPORT_NOTE } from '../../scripts/ledger/record-verify.mjs';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'record-verify.mjs');

const SID = 'sessRT000001';

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

/** Run the real writer inside a project root. */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** Every well-formed line the writer left in this project's ledger. */
function ledgerEvents(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Write one self-report into `root` and hand back the rows the reader will see.
 * Exit 0 is checked but is NOT the evidence — the rows are.
 */
function selfReportInto(root, { status = 'PASS', command = '/verify: all pass', session = SID } = {}) {
  const out = runCli([
    '--status', status, '--command', command, '--session', session, '--cwd', root,
  ], root);
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(JSON.parse(out.stdout).recorded).toBe(true);

  const events = ledgerEvents(root);
  // A rejected line means the record was silently lost, which would make every
  // reader assertion below a measurement of an empty ledger.
  expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
  const completed = events.filter((e) => e.event === 'verify.completed');
  expect(completed).toHaveLength(4);
  return completed;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-rtverify-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('verify self-report round trip: writer -> file -> reader', () => {
  it('counts one real PASS self-report as exactly one self-reported run', () => {
    const root = makeRoot('A');

    const rows = selfReportInto(root);
    const rate = computeVerifyRate(rows);

    expect(rate.ids.self_report).toBe(1);
    // The other buckets are asserted individually rather than by comparing the
    // whole object: a sibling limb may add keys to this shape.
    expect(rate.ids.hook).toBe(0);
    expect(rate.ids.measured).toBe(0);
    expect(rate.ids.other).toBe(0);
    expect(rate.sessions.self_report).toBe(1);
  });

  it('counts a real FAIL self-report the same way — the marker, not the verdict', () => {
    const root = makeRoot('B');

    const rows = selfReportInto(root, { status: 'FAIL', command: '/verify: test FAIL' });
    const rate = computeVerifyRate(rows);

    expect(rate.ids.self_report).toBe(1);
    expect(rate.ids.hook).toBe(0);
    expect(rate.ids.measured).toBe(0);
    expect(rate.ids.other).toBe(0);
    expect(rate.sessions.self_report).toBe(1);
  });

  it('NEGATIVE CONTROL: the same rows without the marker are not self-reports', () => {
    const root = makeRoot('C');

    const rows = selfReportInto(root);
    // Anchor: exactly TWO of the four real lines carry the marker — the overall
    // fold and the deterministic layer — and those are the bytes this control
    // removes. Measured against the real writer 2026-09-21; the header of
    // `lib/verification/verify-rate.js` says "only the DETERMINISTIC line",
    // which is one line short of what the writer emits. Nothing downstream
    // depends on the difference (the reader ORs over a run's lines), but the
    // number is anchored here so a writer that stopped emitting either copy
    // fails loudly instead of letting this control pass vacuously.
    const marked = rows.filter((e) => e.data?.evidence?.[0]?.note === SELF_REPORT_NOTE);
    expect(marked).toHaveLength(2);
    expect(marked.map((e) => e.data.layer ?? null).sort()).toEqual(['deterministic', null].sort());

    const stripped = rows.map((e) => {
      const evidence = (e.data.evidence ?? []).map((entry, i) => {
        if (i !== 0) return entry;
        const { note: _note, ...rest } = entry;
        return rest;
      });
      return { ...e, data: { ...e.data, evidence } };
    });
    expect(stripped.filter((e) => e.data?.evidence?.[0]?.note === SELF_REPORT_NOTE)).toHaveLength(0);

    const rate = computeVerifyRate(stripped);

    expect(rate.ids.self_report).toBe(0);
    // It did not vanish — it fell through to the next bucket, because the
    // deterministic line still says `pass`. "Zero self-reports" from a reader
    // that lost the run would be the wrong kind of zero.
    expect(rate.ids.measured).toBe(1);
    expect(rate.ids.hook).toBe(0);
    expect(rate.ids.other).toBe(0);
    expect(rate.sessions.self_report).toBe(0);
  });

  it('counts two self-reports from two sessions as two', () => {
    const rootA = makeRoot('D1');
    const rootB = makeRoot('D2');

    // Separate roots AND separate sessions AND separate command text: the
    // grouping key is `(session_id, verification_id)`, and `verification_id`
    // embeds a SECOND-resolution stamp, so two runs inside one second with
    // identical content would share an id. The ids differ by construction here,
    // not by how fast the machine is.
    const rows = [
      ...selfReportInto(rootA, { session: `${SID}-1`, command: '/verify: run one' }),
      ...selfReportInto(rootB, { session: `${SID}-2`, command: '/verify: run two' }),
    ];
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((e) => e.data.verification_id)).size).toBe(2);

    const rate = computeVerifyRate(rows);

    expect(rate.ids.self_report).toBe(2);
    expect(rate.ids.hook).toBe(0);
    expect(rate.ids.measured).toBe(0);
    expect(rate.ids.other).toBe(0);
    expect(rate.sessions.self_report).toBe(2);
  });
});
