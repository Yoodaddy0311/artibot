/**
 * Behaviour pins for `scripts/ledger/migrate-ledger-adr011.mjs` — the ADR-011
 * one-shot ledger merge tool.
 *
 * WHY A TEST FOR A TOOL NOBODY IMPORTS. The script is run by hand exactly once,
 * against the only copy of a project's event history that exists. There is no
 * second chance and no runtime that would notice a bad merge, so the three
 * properties the operator is trusting have to be pinned somewhere: lines come
 * out VERBATIM and in the caller's order, an existing `--out` is refused rather
 * than appended to, and a missing input writes nothing at all. Each case below
 * is one of those.
 *
 * The script is exercised as a CHILD PROCESS (`spawnSync`), never imported. It
 * decides everything at module top level and calls `process.exit`, so importing
 * it would run the migration inside the test worker and the exit codes — which
 * are the contract — would not be observable.
 *
 * Every case builds its own `mkdtempSync` tree and its own output path, so no
 * case depends on another one having run (case b does its own first migration
 * before re-running it). Nothing here reads or writes a real ledger, a real
 * project root, or the shared store under the repository's git common dir.
 *
 * WHAT THESE TESTS CANNOT SEE (a green run is not evidence of any of these):
 *   - REAL LEDGER SCALE. The fixtures are 6 lines across 3 files. The live
 *     ledgers are of unknown size as of 2026-09-11, and the script holds every
 *     input in memory and joins them into one string; nothing here says what
 *     that does at tens of MB.
 *   - CRLF / MIXED LINE ENDINGS. Fixtures are written with "\n" only. The
 *     script promises to preserve a trailing CR inside a line as part of that
 *     line's bytes; that promise is NOT exercised here.
 *   - CONCURRENT WRITERS. Every fixture is quiescent. A window still appending
 *     while the merge runs yields a correct-but-stale output, and the script
 *     cannot detect it — which is why the ADR requires every split window
 *     closed first.
 *   - THE INSTALLED COPY. These tests run the file in this worktree. Whether
 *     `~/.claude/plugins/.../scripts/ledger/` holds the same bytes at migration
 *     time is a separate question, and the ADR's step 0-5 gates own it.
 *   - WHETHER `--out` IS THE PATH THE SHIPPED WRITER USES. Case (c) asserts the
 *     NON-git fallback rule only, in a temp directory with no `.git` entry.
 *
 * @module tests/ledger/migrate-ledger-adr011
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ledgerFilePath, readLedgerCensus } from '../../lib/runtime/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'migrate-ledger-adr011.mjs');

/** `ledger.path` from artibot.config.json, as path segments. */
const LEDGER_REL_SEGMENTS = ['.artibot', 'runtime', 'ledger.jsonl'];

/** Every temp tree this file made, removed in `afterAll`. */
const sandboxes = [];

/** @returns {string} a fresh temp directory, cleaned up after the suite */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'adr011-migrate-'));
  sandboxes.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * One ledger line. `marker` rides in `data` so output ORDER can be asserted on
 * content rather than on byte offsets, and `seq`/`ts` are unique per line so the
 * reader's dedupe key cannot collapse two of them (see `ledger.js#dedupeKey`).
 *
 * @param {{marker: string, seq: number, source: string}} spec
 * @returns {string} one JSONL line, no trailing newline
 */
function ledgerLine({ marker, seq, source }) {
  return JSON.stringify({
    event: 'mission.started',
    ts: new Date(Date.UTC(2026, 8, 11, 1, 0, seq)).toISOString(),
    mission_id: 'm-adr011',
    session_id: `s-${source}`,
    source,
    pid: 4242,
    seq,
    data: { marker },
  });
}

/**
 * Write the three-file fixture set: main holds 3 lines with ONE blank line
 * mixed in, the first worktree 2, the second 1. Markers encode the expected
 * merge order.
 *
 * @param {string} dir
 * @returns {{main: string, worktrees: string[], markers: string[], lines: string[]}}
 */
function writeFixture(dir) {
  const mainLines = [
    ledgerLine({ marker: 'main-1', seq: 0, source: 'main' }),
    ledgerLine({ marker: 'main-2', seq: 1, source: 'main' }),
    ledgerLine({ marker: 'main-3', seq: 2, source: 'main' }),
  ];
  const wt1Lines = [
    ledgerLine({ marker: 'wt1-1', seq: 3, source: 'wt1' }),
    ledgerLine({ marker: 'wt1-2', seq: 4, source: 'wt1' }),
  ];
  const wt2Lines = [ledgerLine({ marker: 'wt2-1', seq: 5, source: 'wt2' })];

  const main = path.join(dir, 'main-ledger.jsonl');
  const wt1 = path.join(dir, 'wt1-ledger.jsonl');
  const wt2 = path.join(dir, 'wt2-ledger.jsonl');
  // The blank line sits BETWEEN two real lines, not only at the end: a
  // trailing-newline-only fixture would leave the "drop blank lines" rule
  // exercised by an artefact of how the file was written.
  writeFileSync(main, `${mainLines[0]}\n\n${mainLines[1]}\n${mainLines[2]}\n`, 'utf-8');
  writeFileSync(wt1, `${wt1Lines.join('\n')}\n`, 'utf-8');
  writeFileSync(wt2, `${wt2Lines.join('\n')}\n`, 'utf-8');

  const lines = [...mainLines, ...wt1Lines, ...wt2Lines];
  return {
    main,
    worktrees: [wt1, wt2],
    markers: lines.map((l) => JSON.parse(l).data.marker),
    lines,
  };
}

/**
 * Run the script as a child process.
 *
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runMigrate(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** @param {string} file @returns {string[]} non-blank lines of `file` */
function nonBlankLines(file) {
  return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
}

/** @param {string} file @returns {string} sha256 of the file's bytes */
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

describe('migrate-ledger-adr011 merge', () => {
  it('concatenates main then worktrees verbatim, dropping blank lines', () => {
    const dir = sandbox();
    const fx = writeFixture(dir);
    const out = path.join(dir, 'merged', 'ledger.jsonl');
    const reportPath = path.join(dir, 'report.json');

    const res = runMigrate([
      '--main', fx.main,
      '--worktree', fx.worktrees[0],
      '--worktree', fx.worktrees[1],
      '--out', out,
      '--report', reportPath,
    ]);

    expect(res.status, res.stderr).toBe(0);

    const merged = nonBlankLines(out);
    // 3 + 2 + 1 inputs, and the blank line in `main` is not one of them.
    expect(merged).toHaveLength(6);
    // VERBATIM: the output lines are the input lines, byte for byte.
    expect(merged).toEqual(fx.lines);
    // ORDER: main's lines first, in file order, then each worktree in argv order.
    expect(merged.map((l) => JSON.parse(l).data.marker)).toEqual([
      'main-1', 'main-2', 'main-3', 'wt1-1', 'wt1-2', 'wt2-1',
    ]);

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.lineCountMatch).toBe(true);
    expect(report.expectedLines).toBe(6);
    expect(report.output.lines).toBe(6);
    expect(report.output.sha256).toMatch(HEX64);
    expect(report.output.sha256).toBe(sha256File(out));
    expect(report.inputs).toHaveLength(3);
    for (const input of report.inputs) expect(input.sha256).toMatch(HEX64);
    expect(report.inputs.map((i) => i.role)).toEqual(['main', 'worktree', 'worktree']);
    expect(report.inputs.map((i) => i.nonBlankLines)).toEqual([3, 2, 1]);
  });

  it('refuses a second run into the same --out and leaves it byte-identical', () => {
    const dir = sandbox();
    const fx = writeFixture(dir);
    const out = path.join(dir, 'merged', 'ledger.jsonl');
    const args = [
      '--main', fx.main,
      '--worktree', fx.worktrees[0],
      '--worktree', fx.worktrees[1],
      '--out', out,
    ];

    const first = runMigrate(args);
    expect(first.status, first.stderr).toBe(0);
    const shaAfterFirst = sha256File(out);

    const second = runMigrate(args);
    expect(second.status).toBe(3);
    expect(second.stderr).toMatch(/already exists/);
    // The whole point of exit 3: nothing was appended, so every line is still
    // there exactly once.
    expect(sha256File(out)).toBe(shaAfterFirst);
    expect(nonBlankLines(out)).toHaveLength(6);
  });

  it('produces a merge the ledger reader accepts with zero duplicate loss', () => {
    // A temp directory has no `.git` entry, so `ledgerFilePath` takes its
    // NON-git fallback: <projectRoot>/<ledger.path from artibot.config.json>.
    // Asserted rather than assumed — if the rule or the config key changes, this
    // must go red here instead of silently testing a path nothing resolves to.
    const projectRoot = sandbox();
    const expectedLedger = path.join(projectRoot, ...LEDGER_REL_SEGMENTS);
    expect(
      ledgerFilePath(projectRoot),
      'precondition: a non-git project root must resolve to the in-project fallback path',
    ).toBe(expectedLedger);

    const fx = writeFixture(projectRoot);
    const res = runMigrate([
      '--main', fx.main,
      '--worktree', fx.worktrees[0],
      '--worktree', fx.worktrees[1],
      '--out', expectedLedger,
    ]);
    expect(res.status, res.stderr).toBe(0);

    const { events, census } = readLedgerCensus(projectRoot);
    expect(census.file.present).toBe(true);
    expect(census.lines.nonblank).toBe(6);
    // Counts are preserved by the merge, not deduped — so if the merge had
    // doubled anything, the reader would report it here.
    expect(census.dropped.loss.duplicate).toBe(0);
    expect(census.dropped.loss.corrupt).toBe(0);
    expect(census.dropped.loss.malformed_envelope).toBe(0);
    expect(census.survivors).toBe(6);
    expect(events.map((e) => e.data.marker)).toEqual([
      'main-1', 'main-2', 'main-3', 'wt1-1', 'wt1-2', 'wt2-1',
    ]);
  });

  it('writes nothing when an input is missing', () => {
    const dir = sandbox();
    const fx = writeFixture(dir);
    const out = path.join(dir, 'merged', 'ledger.jsonl');

    const res = runMigrate([
      '--main', path.join(dir, 'does-not-exist.jsonl'),
      '--worktree', fx.worktrees[0],
      '--out', out,
    ]);

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/does not exist/);
    // Fail-closed means the target is not created at all, not created-and-empty:
    // an empty file would make the NEXT run exit 3 and block the real migration.
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.dirname(out))).toBe(false);
  });
});
