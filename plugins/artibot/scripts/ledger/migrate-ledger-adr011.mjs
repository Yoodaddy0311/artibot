#!/usr/bin/env node
/**
 * ADR-011 one-shot ledger migration: concatenate the main ledger and every
 * linked-worktree ledger into ONE shared file, fail-closed.
 *
 * This is NOT a library and NOT wired into any runtime path. It is the
 * "1회 이관 절차" step 2 of `.artibot/adr/ADR-011-worktree-ledger-store.md`
 * run by hand, once, after the code has shipped AND the installed copy has been
 * refreshed AND every split window is closed. Keeping it untracked and
 * argument-driven is deliberate: the target path must be supplied by the caller,
 * NOT derived from `event-writer.js#ledgerFilePath`, because that resolver is
 * being changed by the same limb and a migration must not depend on which
 * version of the resolver happens to be loaded.
 *
 * PROVENANCE (tracked copy). Promoted from the W5-b dry-run tool that lived in
 * the limb worktree's run-local split folder (untracked; preserved in the
 * leader handoff; sha256
 * 3379aa6fb3d7bc0c668a0955654ccd7885a6335eb524cc7e86e752a7ebecca12);
 * no logic was rewritten. It is the tool named by ADR-011 "1회 이관
 * 절차" step 2. Being tracked does NOT wire it into any runtime path or CI step:
 * the real migration stays a one-time MANUAL run by a human, after ADR-011
 * steps 0-5 and their gates (code shipped, installed copy refreshed, every
 * split window closed). A second run is harmless only because an existing
 * `--out` means write nothing and exit 3 — see FAIL-CLOSED RULES below.
 *
 * Exactly one line of the body differs from that original: the `node:fs` named
 * imports are now sorted, because `scripts/**` is under the `sort-imports` lint
 * gate and the untracked copy never was. Reordering named imports changes no
 * behaviour; an eslint-disable would have bought byte-identity by silencing a
 * gate, which is the worse trade. Behaviour is pinned by
 * `tests/ledger/migrate-ledger-adr011.test.js`.
 *
 * USAGE
 *   node scripts/ledger/migrate-ledger-adr011.mjs --main <mainLedger> \
 *        [--worktree <wtLedger> ...] --out <target> [--report <json>]
 *
 * ORDER IS THE CALLER'S (ADR-011 decision 5): the main ledger first, then the
 * worktree ledgers in `git worktree list --porcelain` order. Lines are copied
 * VERBATIM — no re-serialization, no timestamp sort. The ledger is append-only
 * and the reader dedupes on (session_id, source, pid, seq, ts), so re-ordering
 * by ts would destroy information (per-file append order) to produce a global
 * order nothing reads.
 *
 * WHAT IS TRANSFORMED: blank / whitespace-only lines are dropped and every
 * emitted line is terminated with a single "\n". A trailing CR inside a line is
 * PRESERVED as part of that line's bytes (JSON.parse and
 * `ledger.js#parseLine`'s trim() both tolerate it); stripping it would mean
 * rewriting content this script promises not to rewrite.
 *
 * FAIL-CLOSED RULES
 *   - `--out` already exists        -> write nothing, exit 3.
 *   - an input is missing/unreadable-> write nothing, exit 2.
 *   - sum(input nonBlankLines) !== output lines -> delete the output, exit 4.
 *     The count identity is the only integrity claim this script makes.
 *
 * WHAT THIS SCRIPT CANNOT SEE (do not read more into a clean run):
 *   - Whether the inputs were quiescent. A window still appending while this
 *     runs yields a correct-but-stale merge. Close every window first.
 *   - Semantic duplicates across files. Counts are preserved, not deduped;
 *     `ledger.js#readLedgerCensus` reports `dropped.loss.duplicate`.
 *   - Whether `--out` is the path the shipped resolver actually uses. Verify
 *     with a real writer after migrating.
 *
 * EXIT CODES: 0 ok | 1 usage | 2 input unreadable | 3 output pre-exists |
 *             4 line-count mismatch (output removed)
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const USAGE = [
  'usage: node scripts/ledger/migrate-ledger-adr011.mjs --main <mainLedger> [--worktree <wtLedger> ...]',
  '                               --out <target> [--report <json>]',
].join('\n');

function die(code, message) {
  process.stderr.write(`migrate-ledger: ${message}\n`);
  process.exit(code);
}

/**
 * Parse argv. `process.argv[1]` is never referenced on purpose: scanners flag
 * argv[1] comparisons as a direct-run guard (gotcha #64), and this script has
 * no library entry point to guard.
 *
 * @param {string[]} args
 * @returns {{main: string|null, worktrees: string[], out: string|null, report: string|null}}
 */
function parseArgs(args) {
  const parsed = { main: null, worktrees: [], out: null, report: null };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    const needsValue = flag === '--main' || flag === '--worktree'
      || flag === '--out' || flag === '--report';
    if (needsValue && (value === undefined || value.startsWith('--'))) {
      die(1, `${flag} needs a value\n${USAGE}`);
    }
    if (flag === '--main') {
      if (parsed.main !== null) die(1, '--main given more than once');
      parsed.main = value;
      i += 1;
    } else if (flag === '--worktree') {
      parsed.worktrees.push(value);
      i += 1;
    } else if (flag === '--out') {
      if (parsed.out !== null) die(1, '--out given more than once');
      parsed.out = value;
      i += 1;
    } else if (flag === '--report') {
      parsed.report = value;
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      die(1, `unknown argument: ${flag}\n${USAGE}`);
    }
  }
  if (!parsed.main) die(1, `--main is required\n${USAGE}`);
  if (!parsed.out) die(1, `--out is required\n${USAGE}`);
  return parsed;
}

/** @param {string|Buffer} data @returns {string} */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Read one input and split it into the lines that will be emitted.
 *
 * @param {string} file
 * @param {'main'|'worktree'} role
 * @returns {{path: string, role: string, bytes: number, mtime: string,
 *            rawLines: number, blankLines: number, nonBlankLines: number,
 *            sha256: string, lines: string[]}}
 */
function readInput(file, role) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) die(2, `input does not exist: ${abs}`);
  let buf;
  let stat;
  try {
    stat = statSync(abs);
    buf = readFileSync(abs);
  } catch (err) {
    die(2, `input unreadable: ${abs} (${err && err.message})`);
  }
  if (!stat.isFile()) die(2, `input is not a regular file: ${abs}`);
  const text = buf.toString('utf-8');
  const all = text.split('\n');
  const lines = [];
  let blank = 0;
  for (const line of all) {
    if (line.trim().length === 0) { blank += 1; continue; }
    lines.push(line);
  }
  return {
    path: abs,
    role,
    bytes: buf.length,
    mtime: stat.mtime.toISOString(),
    rawLines: all.length,
    blankLines: blank,
    nonBlankLines: lines.length,
    sha256: sha256(buf),
    lines,
  };
}

const [, , ...args] = process.argv;
const opts = parseArgs(args);

const outAbs = path.resolve(opts.out);
// Fail-closed BEFORE any read: an existing target means a migration already
// ran (or the shipped writer has started using the new path). Appending blindly
// would double every line; the operator must inspect and decide.
if (existsSync(outAbs)) {
  die(3, `output already exists, refusing to write: ${outAbs}`);
}

const inputs = [readInput(opts.main, 'main')];
for (const wt of opts.worktrees) inputs.push(readInput(wt, 'worktree'));

const expectedLines = inputs.reduce((n, i) => n + i.nonBlankLines, 0);
const merged = inputs.flatMap((i) => i.lines);
const payload = merged.length === 0 ? '' : `${merged.join('\n')}\n`;

mkdirSync(path.dirname(outAbs), { recursive: true });
writeFileSync(outAbs, payload, 'utf-8');

const outBuf = readFileSync(outAbs);
const outText = outBuf.toString('utf-8');
const outLines = outText.length === 0
  ? 0
  : outText.split('\n').filter((l) => l.trim().length > 0).length;

const report = {
  tool: 'migrate-ledger.mjs',
  adr: 'ADR-011',
  ranAt: new Date().toISOString(),
  argv: args,
  inputs: inputs.map((i) => ({
    path: i.path,
    role: i.role,
    bytes: i.bytes,
    mtime: i.mtime,
    rawLines: i.rawLines,
    blankLines: i.blankLines,
    nonBlankLines: i.nonBlankLines,
    sha256: i.sha256,
  })),
  expectedLines,
  output: { path: outAbs, bytes: outBuf.length, lines: outLines, sha256: sha256(outBuf) },
  lineCountMatch: outLines === expectedLines,
};

if (opts.report) {
  const reportAbs = path.resolve(opts.report);
  mkdirSync(path.dirname(reportAbs), { recursive: true });
  writeFileSync(reportAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  report.reportPath = reportAbs;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!report.lineCountMatch) {
  rmSync(outAbs, { force: true });
  die(4, `line count mismatch: expected ${expectedLines}, wrote ${outLines}; removed ${outAbs}`);
}
