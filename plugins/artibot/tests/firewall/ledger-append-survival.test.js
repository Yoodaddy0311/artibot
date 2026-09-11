/**
 * Firewall gate — the central run ledger survives concurrent append.
 *
 * WHY THIS GATE EXISTS. `lib/core/decision-trail.js` reads the whole file,
 * mutates it, and writes it back. Measured 2026-08-28 across processes, that
 * loses 21 of 60 records (decision-trail.js:213-216). The v5 ledger's answer is
 * structural, not a lock: one line is one `appendFileSync` with the `'a'` flag,
 * and nothing ever reads before it writes. This suite runs the SAME experiment
 * against the new writer — real processes, 20 lines each — and requires every
 * line back. Anything less means the design claim is false, not that the test
 * is flaky.
 *
 * WHY EIGHT PROCESSES, NOT THREE. The original experiment's shape was 3 × 20 =
 * 60, and that case is still here unchanged. ADR-011 then made ONE physical
 * ledger serve every linked worktree, so the file's write frequency now grows
 * linearly with the number of open `/split` windows where it used to be split
 * across N files. The observed `/split` maximum is 12 windows
 * (`.artibot/guides/NEXT-SESSION.md`), which 3 does not reach. The gate is
 * therefore EXTENDED to 8 × 20 = 160 — a strictly harder shape added beside the
 * old one, not a replacement for it and not a relaxation of anything.
 *
 * WHY BOTH STORE LOCATIONS. `ledgerFilePath` answers with the git common dir
 * when the root has a `.git` and falls back to `<root>/.artibot/runtime/`
 * otherwise, so "which file do 8 processes contend for" has two answers and
 * each child resolves it independently. A case runs on each: the non-git
 * fallback (every other tmpdir fixture in this repo lives there) and a root
 * with a `.git` directory, which is the post-ADR-011 shared location and the
 * only one a real repository uses. Measuring only the fallback would leave the
 * path that the co-location change actually introduced untested under
 * contention.
 *
 * It also pins the three refusals the writer must make, because a ledger that
 * accepts anything is not a ledger: over-cap lines, unregistered vocabulary,
 * and unmasked secrets.
 *
 * REAL PROCESSES, NOT WORKERS. `child_process.spawn` with `process.execPath`.
 * Threads inside one process share a file descriptor and a V8 heap, so they
 * would test a weaker thing than the hook processes this writer is built for.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ────────────────────────────────────
 *   - CONCURRENCY BEYOND N=8. The widest case here is 8 processes. The observed
 *     `/split` maximum is 12 windows and nothing bounds it at 12, so the
 *     interval between 8 and whatever a user opens is UNMEASURED. 160/160 at 8
 *     is not a proof about 12.
 *   - WINDOWS `'a'` ATOMICITY IN GENERAL. This measures 220 lines of roughly
 *     200 bytes on ONE machine's filesystem. It fixes the claim for that shape
 *     and that platform; it does not prove `FILE_APPEND_DATA` is atomic for a
 *     line near the 4 KB cap, on a network share, or under a filesystem this
 *     machine does not have. The 4 KB cap is what keeps real lines inside the
 *     shape actually measured here.
 *   - ACCEPTANCE-JUDGMENT CORRECTNESS. Whether `mission.completed{accepted}`
 *     carries the right verdict is §2.6's deferred rule, decided by evidence
 *     this gate never sees.
 *   - LIVE HOOK PAYLOAD KEYS. Phase 0 has zero callers, so every field written
 *     below was invented by this file. That a real hook will pass the right
 *     `session_id`, `source`, and `data` is UNMEASURED.
 *   - WHETHER N PROCESSES ARE N WORKTREES. Every child below is given the SAME
 *     root string. That N linked worktrees each resolve their own root to that
 *     one file is `tests/firewall/ledger-store-colocation.test.js`'s question
 *     (ADR-011 G1, G4); this file only measures what happens once they do.
 *   - THE 128 KB TAIL. `scripts/hooks/subagent-handler.js` reads the ledger's
 *     last 128 KB. 220 lines of ~200 bytes stays well inside that window, so
 *     how a shared file's growth dilutes that reader is not measured here.
 *   - LOSS THAT LEAVES NO TRACE. 160/160 proves nothing was lost in THIS run at
 *     THIS concurrency. It cannot prove a rarer interleaving does not exist.
 *
 * @module tests/firewall/ledger-append-survival
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendLedgerEvent,
  dedupeKey,
  ledgerFilePath,
  readAllEvents,
  readLedgerCensus,
} from '../../lib/runtime/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_MODULE = pathToFileURL(path.join(HERE, '..', '..', 'lib', 'runtime', 'ledger.js')).href;

/** Records each child appends — the decision-trail experiment's depth. */
const LINES_PER_PROCESS = 20;

/**
 * The shapes this gate measures, widest last.
 *
 * `processes` is the contention; `store` picks which location the children
 * resolve to, because `ledgerFilePath` answers differently with and without a
 * `.git` marker and both answers take concurrent appends in production. The
 * 3-process fallback row is the original 2026-08-28 experiment, kept verbatim.
 *
 * @type {ReadonlyArray<{processes: number, store: 'fallback'|'git-common-dir'}>}
 */
const CONCURRENCY_CASES = [
  { processes: 3, store: 'fallback' },
  { processes: 8, store: 'fallback' },
  { processes: 8, store: 'git-common-dir' },
];

/** @type {string} */
let root;

/**
 * The child program. Appends `LINES_PER_PROCESS` events as fast as it can, so
 * the three copies overlap rather than politely taking turns.
 * @type {string}
 */
const CHILD_SOURCE = `
import { appendLedgerEvent } from ${JSON.stringify(LEDGER_MODULE)};

const [root, label] = process.argv.slice(2);
let written = 0;
for (let i = 0; i < ${LINES_PER_PROCESS}; i += 1) {
  const res = appendLedgerEvent(root, {
    event: 'tool.used',
    session_id: 'sess-survival-' + label,
    source: 'hook',
    mission_id: 'M-20260902-001',
    data: { tool: 'Bash', ok: true, duration_ms: i, marker: label + ':' + i },
  });
  if (res.ok) written += 1;
}
process.stdout.write(String(written));
`;

/**
 * Run one child to completion.
 * @param {string} script absolute path to the child program
 * @param {string} label child identity, embedded in every line it writes
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runChild(script, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, root, label], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Every raw line currently in the ledger.
 * @returns {string[]}
 */
function rawLines() {
  return readFileSync(ledgerFilePath(root), 'utf-8').split('\n').filter((l) => l.length > 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-survival-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('concurrent append across real processes', () => {
  for (const { processes, store } of CONCURRENCY_CASES) {
    const expected = processes * LINES_PER_PROCESS;

    it(`keeps ${expected} of ${expected} lines written by ${processes} processes `
      + `into the ${store} location`, async () => {
      if (store === 'git-common-dir') {
        // A bare `.git` DIRECTORY is all `resolveGitCommonDir` needs, and it is
        // what every non-worktree checkout has. The children are never told the
        // resolved path — each one resolves `root` on its own, so this also
        // measures that 8 independent processes agree on one file.
        mkdirSync(path.join(root, '.git'), { recursive: true });
      }
      // Self-check: the case is measuring the location it claims to. Without it
      // a resolver change could quietly move both rows onto one path and the
      // titles would lie.
      const target = ledgerFilePath(root);
      expect(target).toBe(store === 'git-common-dir'
        ? path.join(root, '.git', 'artibot', 'ledger.jsonl')
        : path.join(root, '.artibot', 'runtime', 'ledger.jsonl'));

      const script = path.join(root, 'append-child.mjs');
      writeFileSync(script, CHILD_SOURCE, 'utf-8');

      const results = await Promise.all(
        Array.from({ length: processes }, (unused, i) => runChild(script, `p${i}`)),
      );
      for (const r of results) {
        expect(r.stderr).toBe('');
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(String(LINES_PER_PROCESS));
      }

      // (1) Nothing was lost.
      expect(rawLines()).toHaveLength(expected);

      // (2) Nothing was torn: every line is still parseable JSON on its own.
      const parsed = rawLines().map((l) => JSON.parse(l));
      expect(parsed).toHaveLength(expected);

      // (3) Every line has a distinct dedupe key — no duplicate survived, and
      //     the reader's key actually discriminates. Computed with the writer's
      //     own `dedupeKey` rather than a second spelling of it, so this cannot
      //     keep passing after the key definition changes underneath it.
      const keys = new Set(parsed.map((e) => dedupeKey(e)));
      expect(keys.size).toBe(expected);

      // (4) Each process contributed a complete, gapless 0..19 run.
      const byPid = new Map();
      for (const e of parsed) {
        if (!byPid.has(e.pid)) byPid.set(e.pid, []);
        byPid.get(e.pid).push(e.seq);
      }
      expect(byPid.size).toBe(processes);
      for (const seqs of byPid.values()) {
        expect([...seqs].sort((a, b) => a - b))
          .toEqual(Array.from({ length: LINES_PER_PROCESS }, (unused, i) => i));
      }

      // (5) Every marker the children intended to write is present exactly once.
      const markers = parsed.map((e) => e.data.marker);
      expect(new Set(markers).size).toBe(expected);

      // (6) The reader agrees with the raw file.
      expect(readAllEvents(root)).toHaveLength(expected);

      // (7) The reader's own census says "loss 0" DIRECTLY (F-30). Steps 1-6
      //     proved it indirectly (survivors == expected); this is the reader
      //     counting its drops and reporting none, on the same file — and it
      //     reports the path it counted, so a census taken over some OTHER file
      //     cannot satisfy this.
      const { events, census } = readLedgerCensus(root);
      expect(events).toHaveLength(expected);
      expect(census.file.path).toBe(target);
      expect(census.lines.nonblank).toBe(expected);
      expect(census.dropped_total.loss).toBe(0);
      expect(census.dropped.loss).toEqual({ corrupt: 0, malformed_envelope: 0, duplicate: 0 });
      expect(census.survivors).toBe(expected);
    });
  }
});

describe('refusals that keep the ledger a ledger', () => {
  it('refuses a line over the 4 KB cap and records the refusal', () => {
    const res = appendLedgerEvent(root, {
      event: 'mission.created',
      session_id: 'sess-cap',
      source: 'hook',
      mission_id: 'M-20260902-001',
      data: { title: 'x'.repeat(9000), intent_revision: 1 },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^line-too-large:/);
    // Nothing over the cap reached the file, and the refusal is on the record.
    for (const line of rawLines()) {
      expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThanOrEqual(4096);
    }
    expect(readAllEvents(root, { includeRejected: true }).map((e) => e.event))
      .toEqual(['ledger.rejected']);
  });

  it('is fail-closed on vocabulary: an unregistered event is never appended', () => {
    const res = appendLedgerEvent(root, {
      event: 'invented.event',
      session_id: 'sess-vocab',
      source: 'hook',
      mission_id: 'M-20260902-001',
      data: { anything: true },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unregistered-event');
    const written = readAllEvents(root, { includeRejected: true });
    expect(written.map((e) => e.event)).toEqual(['ledger.rejected']);
    expect(written[0].data.raw_event).toBe('invented.event');
  });

  it('masks a secret before it can reach the file', () => {
    // Assembled at run time: a literal credential shape in this file would trip
    // the repo's own content-secret guard on write.
    const fake = ['sk', 'ant', 'A'.repeat(30)].join('-');
    const res = appendLedgerEvent(root, {
      event: 'tool.used',
      session_id: 'sess-secret',
      source: 'hook',
      mission_id: 'M-20260902-001',
      data: { tool: 'Bash', ok: true, duration_ms: 1, note: fake },
    });
    expect(res.ok).toBe(true);
    const raw = readFileSync(ledgerFilePath(root), 'utf-8');
    expect(raw).not.toContain(fake);
    // And the masking did not break the JSONL framing.
    expect(() => JSON.parse(raw.trim())).not.toThrow();
  });
});
