/**
 * In-process contract for `scripts/ledger/v51-census.mjs`: the parts a real
 * process run cannot steer — a ledger that GROWS while the census runs, readers
 * that misbehave, and the source/registry/doc contracts that keep the census
 * honest as files around it change. `v51-census-cli.test.js` is the real-process
 * half (foreign cwd, missing ledger, read-only, usage errors).
 *
 * SNAPSHOT CONSISTENCY IS MEASURED, NOT ASSUMED. The census's whole claim is that
 * every ledger-derived number comes from ONE copy taken at the start. A run that
 * never sees the ledger change proves nothing about that, so the injected `spawn`
 * appends a row to the LIVE ledger right before the first reader starts (after the
 * snapshot exists). Real readers then run. Each must report the snapshot's byte
 * count, and the census must report the growth separately. The POSITIVE CONTROL is
 * a reader started on the live project afterwards: it reports the grown size, so
 * the two sizes are distinguishable and "all readers saw the snapshot" is a real
 * finding rather than an equality between two identical numbers.
 *
 * THE CHECKS MUST BE ABLE TO GO RED. A consistency block that can only say "fine"
 * is decoration. Fake readers that report a different file, different byte counts
 * or different line counts must turn `consistency.ok` false and the status partial.
 *
 * MISBEHAVING READERS ARE DATA. Seven fake readers — exits 1, prints junk, never
 * returns, reports its own `error`, reports `ok:false`, is missing on disk, and one
 * good one — run in a single census. It must return (never throw), keep the good
 * reader's numbers, and classify each of the others.
 *
 * SOURCE CONTRACT. The script is read-only toward the project by construction:
 * its imports are an ALLOWLIST (a deny list is fail-open for the next import) and
 * it spells neither the ledger's append function nor an append verb. The scanner
 * is itself shown to go red on a fabricated source.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - A TORN APPEND AT COPY TIME. The growth case appends BEFORE a reader starts,
 *    never during the copy itself; a half-written last line would reach the
 *    readers as one `corrupt` line in their own census, which they already handle.
 *  - THE INSTALLED COPY, and a ledger the size of the owner's.
 *  - ELAPSED-TIME LIMITS. The hang case uses a short injected timeout; the
 *    shipped default is not exercised.
 *
 * @module tests/ledger/v51-census-inproc
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import {
  census, FLAGS, main, NOT_RUN, READERS,
} from '../../scripts/ledger/v51-census.mjs';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'v51-census.mjs');
const RUNBOOK = path.join(REPO_ROOT, '.artibot', 'guides', 'v5-design', 'MEASUREMENT-RUNBOOK.md');

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-census-inproc-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

/** A project root with a `.git` directory, so its ledger resolves to the common-dir rule. */
function makeProject(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** One `session.ended` row (a skipped session, no receipt). */
function seedEnded(root, sessionId) {
  const res = appendLedgerEvent(root, {
    event: 'session.ended',
    session_id: sessionId,
    source: 'hook',
    idempotency_key: `session.ended:${sessionId}`,
    data: {
      receipt_status: 'skipped',
      receipts: 0,
      appended: 0,
      rejected: 0,
      deduped: 0,
      coverage: null,
      reason: 'no-transcript',
      unresolved_models: [],
      transcript_present: true,
      session_fallback: false,
    },
  });
  expect(res.ok).toBe(true);
}

/** The metric row for an id and scope. */
function metric(doc, id, scope = 'history') {
  return doc.metrics.find((m) => m.id === id && m.scope === scope);
}

/** The census block of one run, wherever that reader prints it. */
function censusOf(doc, reader) {
  const spec = READERS.find((r) => r.id === reader);
  const res = doc.runs.find((r) => r.reader === reader && r.scope === 'history').result;
  return spec.census(res);
}

describe('v51-census: one snapshot, even while the live ledger grows', () => {
  it('hands every reader the pre-growth bytes and reports the growth separately', () => {
    const root = makeProject('grow');
    seedEnded(root, 'sessGrow00001');
    seedEnded(root, 'sessGrow00002');
    const live = ledgerFilePath(root);
    const startBytes = statSync(live).size;
    let grew = 0;
    // Appends to the LIVE ledger once the snapshot exists and before any reader starts.
    const spawn = (cmd, args, opts) => {
      if (grew === 0) { seedEnded(root, 'sessGrow00003'); grew += 1; }
      return spawnSync(cmd, args, opts);
    };

    const doc = census({ cwd: root, since: null }, { spawn, tmpRoot: tmp });

    expect(grew).toBe(1);
    expect(doc.snapshot.bytes).toBe(startBytes);
    expect(doc.ledger.bytesAtStart).toBe(startBytes);
    expect(doc.ledger.bytesAtEnd).toBeGreaterThan(startBytes);
    expect(doc.ledger.grewDuringRun).toBe(true);
    // The numbers are the snapshot's: two ended sessions, not three.
    expect(metric(doc, 'observe4.receipt-coverage').denominator).toBe(2);
    for (const r of doc.runs.filter((x) => x.input === 'snapshot')) {
      expect(r.status, r.reader).not.toBe('error');
      expect(censusOf(doc, r.reader).file.bytes, r.reader).toBe(startBytes);
    }
    expect(doc.consistency.ok).toBe(true);
  });

  it('POSITIVE CONTROL: a reader run on the live project afterwards sees the growth', () => {
    const root = makeProject('grow-control');
    seedEnded(root, 'sessCtrl00001');
    const startBytes = statSync(ledgerFilePath(root)).size;
    seedEnded(root, 'sessCtrl00002');

    const out = spawnSync(process.execPath, [
      path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'session-coverage.mjs'), '--cwd', root,
    ], { encoding: 'utf-8', windowsHide: true });
    const direct = JSON.parse(out.stdout);

    // A live read is NOT the snapshot's size and count — so the case above discriminates.
    expect(direct.census.file.bytes).toBeGreaterThan(startBytes);
    expect(direct.ended).toBe(2);
  });
});

/** Source of a fake reader: prints what a real reader prints for the snapshot root it is given. */
function fakeReaderSource(body) {
  return [
    "import { statSync } from 'node:fs';",
    "import path from 'node:path';",
    "const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };",
    "const root = arg('--cwd');",
    "const file = root === null ? null : path.join(root, '.artibot', 'runtime', 'ledger.jsonl');",
    'const bytes = file === null ? null : statSync(file).size;',
    body,
  ].join('\n');
}

/** Write a fake reader script and return its absolute path. */
function writeFake(name, body) {
  const file = path.join(tmp, `${name}.mjs`);
  writeFileSync(file, fakeReaderSource(body), 'utf-8');
  return file;
}

/** A registry entry for a fake reader. `over` replaces any field. */
function fakeSpec(id, script, over = {}) {
  return {
    id,
    axis: 'test',
    script,
    feed: 'cwd',
    windowed: false,
    inputPath: (r) => r.ledger_path ?? null,
    census: (r) => r.census ?? null,
    measuredAt: (r) => r.measured_at ?? null,
    extract: (r) => [{
      id: `${id}.metric`, label: id, unit: 'rows', numerator: r.n ?? 0, denominator: r.d ?? 0,
    }],
    ...over,
  };
}

/** The JSON an honest fake prints, with overrides for the lies the checks must catch. */
const HONEST = [
  'const lines = { raw: 4, blank: 1, nonblank: 3 };',
  "process.stdout.write(JSON.stringify({ ledger_path: file, measured_at: '2026-09-30T00:00:00.000Z', n: 1, d: 2,",
  '  census: { file: { present: true, readable: true, bytes, path: file }, lines,',
  '    dropped_total: { loss: 0, selection: 0 }, survivors: 3 } }));',
].join('\n');

describe('v51-census: the consistency checks can go red', () => {
  it('flags a reader that reports a different ledger file and different bytes', () => {
    const root = makeProject('liar');
    seedEnded(root, 'sessLiar00001');
    const liar = writeFake('liar', [
      'const lines = { raw: 4, blank: 1, nonblank: 3 };',
      "process.stdout.write(JSON.stringify({ ledger_path: '/somewhere/else/ledger.jsonl', n: 1, d: 2,",
      "  census: { file: { present: true, readable: true, bytes: 999999, path: '/somewhere/else/ledger.jsonl' }, lines,",
      '    dropped_total: { loss: 0, selection: 0 }, survivors: 3 } }));',
    ].join('\n'));
    const honest = writeFake('honest', HONEST);

    const doc = census(
      { cwd: root, since: null },
      { readers: [fakeSpec('liar', liar), fakeSpec('honest', honest)], tmpRoot: tmp },
    );

    expect(doc.consistency.ok).toBe(false);
    expect(doc.status).toBe('partial');
    const liarRun = doc.runs.find((r) => r.reader === 'liar');
    expect(liarRun.inputIsSnapshot).toBe(false);
    const red = doc.consistency.checks.filter((c) => c.holds === false);
    expect(red.map((c) => `${c.id}:${c.reader}`)).toEqual(expect.arrayContaining([
      'reader-input-is-snapshot:liar', 'reader-bytes-equal-snapshot:liar',
    ]));
    // The honest reader is not dragged into the finding.
    expect(doc.runs.find((r) => r.reader === 'honest').inputIsSnapshot).toBe(true);
    expect(red.some((c) => c.reader === 'honest' && c.id !== 'lines-raw-same-across-readers')).toBe(false);
  });

  it('flags two readers that disagree about how many lines the same file has', () => {
    const root = makeProject('lines');
    seedEnded(root, 'sessLines0001');
    const a = writeFake('lines-a', HONEST);
    const b = writeFake('lines-b', HONEST.replace('raw: 4, blank: 1, nonblank: 3', 'raw: 9, blank: 1, nonblank: 8').replace('survivors: 3', 'survivors: 8'));

    const doc = census(
      { cwd: root, since: null },
      { readers: [fakeSpec('a', a), fakeSpec('b', b)], tmpRoot: tmp },
    );

    const cross = doc.consistency.checks.find((c) => c.id === 'lines-raw-same-across-readers');
    expect(cross.holds).toBe(false);
    expect(doc.consistency.ok).toBe(false);
  });

  it('flags a reader whose own line census does not add up', () => {
    const root = makeProject('arith');
    seedEnded(root, 'sessArith0001');
    const broken = writeFake('broken', HONEST.replace('survivors: 3', 'survivors: 1'));

    const doc = census({ cwd: root, since: null }, { readers: [fakeSpec('broken', broken)], tmpRoot: tmp });

    const check = doc.consistency.checks.find((c) => c.id === 'census-lines-add-up' && c.reader === 'broken');
    expect(check.holds).toBe(false);
  });
});

describe('v51-census: readers that misbehave are data, never a crash', () => {
  it('classifies each failure mode and keeps the good reader', () => {
    const root = makeProject('zoo');
    seedEnded(root, 'sessZoo000001');
    const specs = [
      fakeSpec('zoo-exit', writeFake('zoo-exit', "process.stderr.write('boom: cannot read\\n'); process.exit(1);")),
      fakeSpec('zoo-junk', writeFake('zoo-junk', "process.stdout.write('this is not json');")),
      fakeSpec('zoo-hang', writeFake('zoo-hang', 'setInterval(() => {}, 1000);')),
      fakeSpec('zoo-reported', writeFake('zoo-reported', "process.stdout.write(JSON.stringify({ error: 'fold threw', ledger_path: file, n: 0, d: 0 }));")),
      fakeSpec('zoo-unmeasured', writeFake('zoo-unmeasured', "process.stdout.write(JSON.stringify({ ok: false, reason: 'no store at /x', ledger_path: file }));")),
      fakeSpec('zoo-missing', path.join(tmp, 'never-written.mjs')),
      fakeSpec('zoo-good', writeFake('zoo-good', HONEST)),
    ];

    const doc = census({ cwd: root, since: null }, { readers: specs, tmpRoot: tmp, timeoutMs: 2500 });
    const byId = Object.fromEntries(doc.runs.map((r) => [r.reader, r]));

    expect(byId['zoo-exit'].status).toBe('error');
    expect(byId['zoo-exit'].error).toMatchObject({ kind: 'exit', exitCode: 1 });
    expect(byId['zoo-exit'].error.stderr).toContain('boom: cannot read');
    expect(byId['zoo-junk'].error.kind).toBe('unparsable-output');
    expect(byId['zoo-hang'].error.kind).toBe('timeout');
    expect(byId['zoo-reported'].status).toBe('error');
    expect(byId['zoo-reported'].error).toMatchObject({ kind: 'reader-reported', message: 'fold threw' });
    // A reader that threw prints empty folds: they stay in `result` but are not measurements.
    expect(byId['zoo-reported'].result.error).toBe('fold threw');
    expect(metric(doc, 'zoo-reported.metric').status).toBe('error');
    expect(metric(doc, 'zoo-reported.metric').numerator).toBeNull();
    expect(byId['zoo-unmeasured'].status).toBe('unmeasured');
    expect(byId['zoo-unmeasured'].reason).toBe('no store at /x');
    expect(byId['zoo-missing']).toMatchObject({ status: 'skipped', reason: 'reader-missing' });
    expect(byId['zoo-good'].status).toBe('ok');
    expect(metric(doc, 'zoo-good.metric')).toMatchObject({ status: 'measured', numerator: 1, denominator: 2, ratio: 0.5 });

    expect(doc.status).toBe('partial');
    expect(doc.errors.map((e) => e.reader).sort()).toEqual(['zoo-exit', 'zoo-hang', 'zoo-junk', 'zoo-reported']);
    expect(existsSync(doc.snapshot.path)).toBe(false);
  });

  it('never leaves the snapshot behind, even when every reader fails', () => {
    const root = makeProject('allfail');
    seedEnded(root, 'sessAllFail001');
    const doc = census(
      { cwd: root, since: null },
      { readers: [fakeSpec('x', writeFake('x', 'process.exit(3);'))], tmpRoot: tmp },
    );
    expect(doc.runs[0].error.exitCode).toBe(3);
    expect(doc.snapshot.removed).toBe(true);
    expect(existsSync(doc.snapshot.path)).toBe(false);
  });

  it('stamps a run with the census clock when the reader prints no time of its own', () => {
    const root = makeProject('clock');
    seedEnded(root, 'sessClock00001');
    const noClock = writeFake('noclock', HONEST.replace("measured_at: '2026-09-30T00:00:00.000Z', ", ''));
    const doc = census({ cwd: root, since: null }, { readers: [fakeSpec('noclock', noClock)], tmpRoot: tmp });
    const row = metric(doc, 'noclock.metric');
    expect(row.measuredAtSource).toBe('census-run-start');
    expect(Date.parse(row.measuredAt)).toBeGreaterThanOrEqual(Date.parse(doc.measuredAt));
    const withClock = census({ cwd: root, since: null }, { readers: [fakeSpec('honest', writeFake('honest2', HONEST))], tmpRoot: tmp });
    expect(metric(withClock, 'honest.metric').measuredAtSource).toBe('reader');
    expect(metric(withClock, 'honest.metric').measuredAt).toBe('2026-09-30T00:00:00.000Z');
  });
});

/** Run `main` with stdout and stderr captured, restoring both even if it throws. */
function runMain(argv, deps) {
  const out = [];
  const err = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
  try {
    const code = main(argv, deps);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

describe('v51-census: main never lets a throw or a bad --out fail the measurement', () => {
  it('prints an error document and exits 0 when something nobody foresaw throws, leaving no snapshot', () => {
    const root = makeProject('crash');
    seedEnded(root, 'sessCrash00001');
    // A null registry entry makes the planner throw AFTER the snapshot exists.
    const res = runMain(['--cwd', root, '--json'], { readers: [null], tmpRoot: tmp });

    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
    const doc = JSON.parse(res.stdout);
    expect(doc.status).toBe('error');
    expect(doc.message).toContain('census failed');
    expect(doc.errors[0]).toMatchObject({ kind: 'census-crashed' });
    expect(readdirSync(tmp).filter((n) => n.startsWith('artibot-census-'))).toEqual([]);
  });

  it('exits 1 with one stderr line when --out cannot be written, and still prints the document', () => {
    const root = makeProject('badout');
    seedEnded(root, 'sessBadOut0001');
    const blocker = path.join(tmp, 'a-file');
    writeFileSync(blocker, 'not a directory\n', 'utf-8');

    const res = runMain(['--cwd', root, '--json', '--out', path.join(blocker, 'evidence.md')], { readers: [], tmpRoot: tmp });

    expect(res.code).toBe(1);
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr.startsWith('v51-census: could not write')).toBe(true);
    expect(JSON.parse(res.stdout).schema).toBe('v51-census/1');
  });

  it('reads an all-digit --since as epoch MILLISECONDS and hands every reader the same ISO instant', () => {
    const root = makeProject('since-ms');
    seedEnded(root, 'sessSinceMs001');
    const epochMs = Date.UTC(2026, 8, 25, 0, 0, 0);

    const res = runMain(['--cwd', root, '--json', '--since', String(epochMs)], { readers: [], tmpRoot: tmp });

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).project.since).toBe('2026-09-25T00:00:00.000Z');
    // The readers' own trap, kept: a bare year is 2026 ms after 1970, not the year 2026.
    const year = runMain(['--cwd', root, '--json', '--since', '2026'], { readers: [], tmpRoot: tmp });
    expect(JSON.parse(year.stdout).project.since).toBe('1970-01-01T00:00:02.026Z');
  });

  it('gives every windowed reader the SAME normalized --since, and the history run none', () => {
    const root = makeProject('since-args');
    seedEnded(root, 'sessSinceArg001');
    const spec = {
      id: 'echo', axis: 'test', script: writeFake('echo-args', "process.stdout.write(JSON.stringify({ ledger_path: file, args: process.argv.slice(2) }));"),
      feed: 'cwd', windowed: true,
      inputPath: (r) => r.ledger_path, census: () => null, measuredAt: () => null, extract: () => [],
    };

    const doc = census({ cwd: root, since: '2026-09-25T00:00:00.000Z' }, { readers: [spec], tmpRoot: tmp });

    const byScope = Object.fromEntries(doc.runs.map((r) => [r.scope, r.result.args]));
    expect(byScope.history).not.toContain('--since');
    expect(byScope.window).toContain('--since');
    expect(byScope.window[byScope.window.indexOf('--since') + 1]).toBe('2026-09-25T00:00:00.000Z');
  });

  it('prints the markdown, not JSON, when --json is absent', () => {
    const root = makeProject('mdmode');
    seedEnded(root, 'sessMdMode0001');
    const res = runMain(['--cwd', root], { readers: [], tmpRoot: tmp });
    expect(res.code).toBe(0);
    expect(res.stdout.startsWith('# v5.1 census')).toBe(true);
    expect(res.stdout).toContain('## 6. ');
  });
});

// ── the source contract ──────────────────────────────────────────────────────

/** The ONLY specifiers this script may import. An allowlist, not a deny list. */
const ALLOWED_SPECIFIERS = [
  'node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:url',
  '../../lib/runtime/ledger.js', '../hooks/_main-entry.js', './v51-census-readers.mjs',
];

/** The registry module imports NOTHING: it is pure, so it can neither spawn nor write. */
const REGISTRY = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'v51-census-readers.mjs');

/** Spellings that would let this script write the ledger it measures. */
const WRITER_TOKENS = /appendLedgerEvent|writeEvent|appendFileSync|createWriteStream/;

/**
 * Every static import specifier in a source, in order of appearance — both quote
 * styles and the bare side-effect form, because a scanner that understood only
 * single quotes would pass a double-quoted writer import silently.
 *
 * @param {string} source
 * @returns {string[]}
 */
function importSpecifiers(source) {
  const pattern = /(?:^|\n)\s*import\s*(?:[^;'"]*?from\s*)?['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

/**
 * The read-only property as one function so the self-test can aim at it.
 *
 * @param {string} source
 * @returns {string[]} findings; empty means clean
 */
function readOnlyFindings(source) {
  const findings = importSpecifiers(source)
    .filter((spec) => !ALLOWED_SPECIFIERS.includes(spec))
    .map((spec) => `unlisted import: ${spec}`);
  const writer = WRITER_TOKENS.exec(source);
  if (writer !== null) findings.push(`writer token: ${writer[0]}`);
  return findings;
}

describe('v51-census: the source is read-only toward the project', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('imports only allowlisted specifiers and spells no append verb', () => {
    expect(readOnlyFindings(source)).toEqual([]);
  });

  it('takes only ledgerFilePath from the ledger module — the resolver the readers use', () => {
    const named = /import\s+\{([^}]*)\}\s+from\s+'\.\.\/\.\.\/lib\/runtime\/ledger\.js'/.exec(source);
    expect(named).not.toBe(null);
    expect(named[1].split(',').map((n) => n.trim()).filter((n) => n !== '')).toEqual(['ledgerFilePath']);
  });

  it('does not spell the autopilot store path (a second assembly site is a firewall failure)', () => {
    for (const text of [source, readFileSync(REGISTRY, 'utf-8')]) {
      expect(text).not.toMatch(/runtime[/\\]+autopilot/);
      expect(text).not.toMatch(/['"`]runtime['"`]\s*,\s*['"`]autopilot['"`]/);
    }
  });

  it('keeps the registry module pure: it imports nothing and spells no fs or process verb', () => {
    const registry = readFileSync(REGISTRY, 'utf-8');
    expect(importSpecifiers(registry)).toEqual([]);
    expect(registry).not.toMatch(/readFileSync|writeFileSync|spawnSync|execSync|Date\.now|new Date\(/);
    expect(readOnlyFindings(registry)).toEqual([]);
  });

  it('SELF-TEST: the same scanner reds on a fabricated source that writes', () => {
    const fake = "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n"
      + "import { x } from '../../lib/runtime/event-writer.js';\n";
    expect(readOnlyFindings(fake)).toContain('unlisted import: ../../lib/runtime/event-writer.js');
    expect(readOnlyFindings(fake)).toContain('writer token: appendLedgerEvent');
  });

  it('SELF-TEST: it reds on a double-quoted and on a side-effect import too', () => {
    const doubleQuoted = 'import { writeEvent } from "../../lib/runtime/event-writer.js";\n';
    const sideEffect = "import '../../lib/runtime/event-writer.js';\n";
    expect(readOnlyFindings(doubleQuoted)).toContain('unlisted import: ../../lib/runtime/event-writer.js');
    expect(readOnlyFindings(sideEffect)).toContain('unlisted import: ../../lib/runtime/event-writer.js');
    expect(readOnlyFindings(doubleQuoted)).toContain('writer token: writeEvent');
  });
});

describe('v51-census: the registries cannot rot', () => {
  it('every reader it runs exists in this plugin root', () => {
    expect(READERS.length).toBeGreaterThanOrEqual(8);
    for (const spec of READERS) {
      expect(existsSync(path.join(PLUGIN_ROOT, spec.script)), spec.id).toBe(true);
    }
  });

  it('every reader it reports as not run still exists, so the pointer is live', () => {
    expect(NOT_RUN.length).toBeGreaterThanOrEqual(5);
    for (const n of NOT_RUN) {
      expect(existsSync(path.join(PLUGIN_ROOT, n.script)), n.id).toBe(true);
    }
  });

  it('keeps the two lists disjoint: a reader is run or reported, never both', () => {
    const run = new Set(READERS.map((r) => r.script));
    expect(NOT_RUN.filter((n) => run.has(n.script))).toEqual([]);
  });

  it('gives each run reader a distinct id and a known feed', () => {
    expect(new Set(READERS.map((r) => r.id)).size).toBe(READERS.length);
    for (const spec of READERS) expect(['cwd', 'ledger', 'store']).toContain(spec.feed);
  });
});

describe('v51-census: the runbook documents the flags the script accepts', () => {
  it('names the script and every flag inside its own runbook section', () => {
    const md = readFileSync(RUNBOOK, 'utf-8');
    const start = md.indexOf('### 3.6');
    expect(start).toBeGreaterThan(-1);
    const rest = md.slice(start + 1);
    const next = rest.search(/\n#{2,3} /);
    const section = next === -1 ? rest : rest.slice(0, next);
    expect(section).toContain('v51-census.mjs');
    for (const flag of [...FLAGS.value, ...FLAGS.boolean]) expect(section, flag).toContain(flag);
  });
});
