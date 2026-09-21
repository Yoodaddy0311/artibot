/**
 * Contract for `scripts/bench/seeded-defect.mjs` - the seeded-defect scorer.
 *
 * WHY THIS FILE EXISTS
 *
 *   1. `scripts/hooks/stop-review-gate.js#checkMissingTests` flags a changed
 *      source file with no `tests/**\/<stem>.test.*` sibling, so the runner
 *      needs a file at exactly this path or every edit to it trips Stop.
 *   2. The scorer's numbers are the whole product. `catch_rate` reading 1.0
 *      because a denominator quietly became the INPUT size rather than the
 *      corpus size, or `false_positive_rate` reading 0 because its denominator
 *      was 0, are both green runs that report a perfect reviewer. Every
 *      denominator and every null is therefore pinned here by value.
 *
 * WHAT THIS FILE DOES NOT COVER (do not read a green run as more than it is)
 *
 *   - **Reviewer quality.** Nothing here runs a reviewer, a model, or a
 *     network call. Every reviewer output is a literal in this file or derived
 *     from the corpus, so a green says the SCORER is right, never that any
 *     reviewer is.
 *   - **The corpus schema.** Only the fields scoring reads (`id`, `class`,
 *     `expected`) are exercised. Full schema conformance of the shipped
 *     fixture belongs to `tests/evals/seeded-defect-corpus.test.js`.
 *   - **Kind vocabulary.** `kind === expected.finding_kind` is a string
 *     compare. Whether a reviewer's vocabulary maps onto the corpus's is an
 *     adapter's job and is invisible here.
 *   - **Determinism beyond two runs.** Case 3 spawns the runner twice with the
 *     same `--measured-at` and shuffled inputs. Two agreeing runs are not a
 *     proof of purity, only a refutation of the cheapest way to lose it.
 *
 * @module tests/bench/seeded-defect-cli
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORPUS_CLASSES,
  normalizeFindingPath,
  parseArgs,
  parseCorpus,
  scoreFindings,
} from '../../scripts/bench/seeded-defect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** plugins/artibot/tests/bench -> plugins/artibot. No cwd dependency anywhere. */
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const RUNNER = path.join(PLUGIN_ROOT, 'scripts', 'bench', 'seeded-defect.mjs');
const SHIPPED_CORPUS = path.join(
  PLUGIN_ROOT, 'tests', 'evals', 'fixtures', 'seeded-defect', 'corpus.jsonl',
);

/** A fixed stamp, so two runs differ only where the scorer is impure. */
const STAMP = '2026-09-21T00:00:00.000Z';

/** The envelope's key set, in contract order. */
const ENVELOPE_KEYS = [
  'n', 'catch_rate', 'false_positive_rate', 'location_accuracy',
  'per_class', 'corpus_sha256', 'measured_at',
];

/**
 * One corpus row carrying every field the shared row contract names, so the
 * stub is a legal corpus and not just the subset scoring happens to read.
 *
 * `kind` and `language` are spelled from B1's real enums. The RUNNER does not
 * know either vocabulary - it compares `kind` as a string and never reads
 * `language` at all - so this is legibility, not a constraint the scorer
 * enforces. Nothing here may be read as a check on the enums themselves; that
 * is `tests/evals/seeded-defect-corpus.test.js` with its ajv schema.
 *
 * @param {string} id @param {string} cls @param {string} kind
 * @param {string} file @param {[number, number]} range
 * @returns {object}
 */
function row(id, cls, kind, file, range) {
  return {
    id,
    class: cls,
    language: 'javascript',
    file_hint: file,
    injected_diff: `--- a/${file}\n+++ b/${file}\n`,
    expected: { finding_kind: kind, location: { path: file, line_range: range } },
    severity: 'medium',
    source: 'synthetic',
  };
}

/** The three-row stub every case below scores against. */
const STUB_ROWS = [
  row('SD-001', 'logic', 'off-by-one', 'lib/a.js', [10, 20]),
  row('SD-002', 'boundary', 'inclusive-exclusive-mismatch', 'lib/b.js', [5, 5]),
  row('SD-003', 'security', 'command-injection', 'lib/c.js', [1, 3]),
];

let sandbox;
/** A mkdtemp cwd for every spawn: no repository sits above it. */
let sandboxCwd;
let stubCorpus;

/**
 * Monotonic suffix for scratch filenames.
 *
 * A counter rather than `Math.random()`: the sandbox is a fresh mkdtemp per
 * run, so uniqueness needs no entropy, and a random name makes a failing run
 * name a file that no rerun can produce. Nothing about ordering is implied -
 * it only has to differ.
 */
let scratchSeq = 0;

/** @param {string} stem @returns {string} an unused path inside the sandbox */
function scratchPath(stem) {
  scratchSeq += 1;
  return path.join(sandbox, `${String(scratchSeq).padStart(3, '0')}-${stem}`);
}

/**
 * Write a corpus file and return its path.
 *
 * @param {object[]} rows @param {{eol?: string, name?: string}} [opts]
 * @returns {string} absolute path
 */
function writeCorpus(rows, { eol = '\n', name = `corpus-${rows.length}.jsonl` } = {}) {
  const file = scratchPath(name);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join(eol) + eol, 'utf-8');
  return file;
}

/**
 * Write a reviewer output file and return its path.
 *
 * @param {unknown} value - serialized as-is, so malformed inputs are writable
 * @returns {string} absolute path
 */
function writeInput(value) {
  const file = scratchPath('input.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
  return file;
}

/**
 * Spawn the runner as a real child process.
 *
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER, ...args], {
      cwd: sandboxCwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (typeof err?.status !== 'number') throw err;
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * Spawn the runner and parse its single stdout line.
 *
 * @param {string[]} args
 * @returns {object}
 */
function runOk(args) {
  const res = run([...args, '--measured-at', STAMP]);
  expect(res.status, `stderr: ${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout);
}

/** A reviewer output that finds every defect at a legal line. @returns {object[]} */
function perfectOutput(rows) {
  return rows.map((r) => ({
    id: r.id,
    findings: [{
      kind: r.expected.finding_kind,
      path: r.expected.location.path,
      line: r.expected.location.line_range[0],
    }],
  }));
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'artibot-seeded-defect-'));
  sandboxCwd = mkdtempSync(path.join(os.tmpdir(), 'artibot-seeded-defect-cwd-'));
  stubCorpus = writeCorpus(STUB_ROWS);
});

afterAll(() => {
  for (const dir of [sandbox, sandboxCwd]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('seeded-defect scorer: rates', () => {
  it('reports 1 / 0 / 1 for a reviewer that catches every defect in place', () => {
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(perfectOutput(STUB_ROWS))]);
    expect(out.n).toBe(3);
    expect(out.catch_rate).toBe(1);
    expect(out.false_positive_rate).toBe(0);
    expect(out.location_accuracy).toBe(1);
  });

  it('nulls both ratios whose denominator is zero, never reporting them as 0', () => {
    const empty = STUB_ROWS.map((r) => ({ id: r.id, findings: [] }));
    for (const input of [empty, []]) {
      const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
      expect(out.n).toBe(3);
      expect(out.catch_rate).toBe(0);
      expect(out.false_positive_rate).toBeNull();
      expect(out.location_accuracy).toBeNull();
    }
  });

  it('counts a corpus id absent from the input as a miss, not as out of scope', () => {
    const out = runOk([
      '--corpus', stubCorpus,
      '--input', writeInput(perfectOutput([STUB_ROWS[0]])),
    ]);
    // Denominator is the CORPUS, so one of three, not one of one.
    expect(out.n).toBe(3);
    expect(out.catch_rate).toBeCloseTo(1 / 3, 12);
    expect(out.location_accuracy).toBe(1);
  });

  it('counts a right-kind finding at the wrong place as caught but not located', () => {
    const input = [
      { id: 'SD-001', findings: [{ kind: 'off-by-one', path: 'lib/a.js', line: 10 }] },
      { id: 'SD-002', findings: [{ kind: 'inclusive-exclusive-mismatch', path: 'lib/WRONG.js', line: 5 }] },
    ];
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
    expect(out.catch_rate).toBeCloseTo(2 / 3, 12);
    expect(out.location_accuracy).toBe(0.5);
    expect(out.false_positive_rate).toBe(0);
  });

  it('charges every kind-mismatched finding to the false positive rate', () => {
    // The false positives below are REAL corpus kinds (`stale-comment`), just
    // the wrong kind for these rows. That is the stronger fixture: it pins that
    // a mismatch is judged against THIS ROW's expected kind, and not by whether
    // the word appears in the corpus vocabulary anywhere.
    const input = [
      {
        id: 'SD-001',
        findings: [
          { kind: 'off-by-one', path: 'lib/a.js', line: 12 },
          { kind: 'stale-comment', path: 'lib/a.js', line: 12 },
        ],
      },
      { id: 'SD-002', findings: [{ kind: 'stale-comment', path: 'lib/b.js', line: 5 }] },
      { id: 'SD-003', findings: [] },
    ];
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
    expect(out.false_positive_rate).toBeCloseTo(2 / 3, 12);
    // Spraying kinds buys nothing on catch_rate - it is only charged as FP.
    expect(out.catch_rate).toBeCloseTo(1 / 3, 12);
  });
});

describe('seeded-defect scorer: location boundaries', () => {
  const at = (line) => [{
    id: 'SD-002', findings: [{ kind: 'inclusive-exclusive-mismatch', path: 'lib/b.js', line }],
  }];

  it('includes both ends of line_range and excludes the lines either side', () => {
    const wide = writeCorpus([row('SD-002', 'boundary', 'inclusive-exclusive-mismatch', 'lib/b.js', [5, 9])]);
    for (const [line, located] of [[5, 1], [9, 1], [4, 0], [10, 0]]) {
      const out = runOk(['--corpus', wide, '--input', writeInput(at(line))]);
      expect(out.location_accuracy, `line ${line}`).toBe(located);
      expect(out.catch_rate, `line ${line}`).toBe(1);
    }
  });

  it('applies that normalization ON THE SCORING PATH, not just in the helper', () => {
    // The helper being correct says nothing about `gradeRow` calling it.
    // Measured with a mutant 2026-09-21: deleting the `normalizeFindingPath`
    // call from gradeRow left every other test in this file green, because
    // every other fixture already spells its path the corpus way.
    const input = [{
      id: 'SD-002',
      findings: [{ kind: 'inclusive-exclusive-mismatch', path: '.\\lib\\b.js', line: 5 }],
    }];
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
    expect(out.location_accuracy).toBe(1);
    expect(out.false_positive_rate).toBe(0);
  });

  it('counts a row with several right-kind findings once, and locates it if ANY hits', () => {
    // Both halves are unpinned without this: `caught` must not become 2, and
    // the out-of-range twin must not be charged as a false positive, because
    // its kind matches. Measured with a mutant 2026-09-21: making `matched`
    // a 0/1 flag rather than a count turns false_positive_rate into 0.5 here
    // while leaving every other test in this file green.
    const input = [{
      id: 'SD-002',
      findings: [
        { kind: 'inclusive-exclusive-mismatch', path: 'lib/b.js', line: 99 },
        { kind: 'inclusive-exclusive-mismatch', path: 'lib/b.js', line: 5 },
      ],
    }];
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
    expect(out.catch_rate).toBeCloseTo(1 / 3, 12);
    expect(out.location_accuracy).toBe(1);
    expect(out.false_positive_rate).toBe(0);
    expect(out.per_class.boundary).toEqual({
      n: 1, caught: 1, catch_rate: 1, location_accuracy: 1,
    });
  });

  it('normalizes backslashes and a leading ./ in the reviewer path, and nothing else', () => {
    expect(normalizeFindingPath('lib\\b.js')).toBe('lib/b.js');
    expect(normalizeFindingPath('./lib/b.js')).toBe('lib/b.js');
    // No fuzzy matching: a basename or a parent-relative spelling stays itself.
    expect(normalizeFindingPath('b.js')).toBe('b.js');
    expect(normalizeFindingPath('../lib/b.js')).toBe('../lib/b.js');
  });
});

describe('seeded-defect scorer: per_class', () => {
  it('emits all seven classes in a fixed order, nulling the ratios of empty ones', () => {
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(perfectOutput(STUB_ROWS))]);
    expect(Object.keys(out.per_class)).toEqual([...CORPUS_CLASSES]);
    expect(out.per_class.logic).toEqual({ n: 1, caught: 1, catch_rate: 1, location_accuracy: 1 });
    // A class the corpus does not exercise reports no rate at all.
    expect(out.per_class.concurrency)
      .toEqual({ n: 0, caught: 0, catch_rate: null, location_accuracy: null });
  });

  it('nulls location_accuracy for a class with rows but no catch', () => {
    const input = [{ id: 'SD-001', findings: [] }];
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
    expect(out.per_class.logic)
      .toEqual({ n: 1, caught: 0, catch_rate: 0, location_accuracy: null });
  });
});

describe('seeded-defect scorer: expected.also_accept', () => {
  /**
   * Two near-synonyms a reviewer might legitimately use for the row's defect.
   * The canonical kind (`off-by-one`) is NOT a member - the corpus contract
   * refuses `also_accept` that repeats it, and `acceptedKinds` adds it.
   */
  const ALSO = ['inclusive-exclusive-mismatch', 'wrong-operator'];

  /** A one-row corpus whose single row carries `also_accept`. @returns {string} */
  function corpusWithAlso(also = ALSO) {
    const base = row('SD-001', 'logic', 'off-by-one', 'lib/a.js', [10, 20]);
    return writeCorpus([{
      ...base,
      expected: { ...base.expected, also_accept: also },
    }]);
  }

  /** @param {string} kind @param {number} [line] @returns {object[]} */
  const reportOnly = (kind, line = 10) => [{
    id: 'SD-001', findings: [{ kind, path: 'lib/a.js', line }],
  }];

  it('accepts an also_accept kind as a catch, and does not charge it as a false positive', () => {
    // The defect M1 names: a reviewer that saw the defect and named it with the
    // corpus's OWN alternative spelling used to score a miss AND a false
    // positive off one finding - penalised twice for being right.
    for (const kind of ALSO) {
      const out = runOk(['--corpus', corpusWithAlso(), '--input', writeInput(reportOnly(kind))]);
      expect(out.catch_rate, kind).toBe(1);
      expect(out.false_positive_rate, kind).toBe(0);
      expect(out.location_accuracy, kind).toBe(1);
    }
  });

  it('charges nothing when the canonical and an alternative kind are both reported', () => {
    const input = [{
      id: 'SD-001',
      findings: [
        { kind: 'off-by-one', path: 'lib/a.js', line: 10 },
        { kind: 'wrong-operator', path: 'lib/a.js', line: 11 },
      ],
    }];
    const out = runOk(['--corpus', corpusWithAlso(), '--input', writeInput(input)]);
    // Both are in the accepted set, so both count as matched: the row is caught
    // ONCE and neither finding reaches the false positive numerator.
    expect(out.catch_rate).toBe(1);
    expect(out.false_positive_rate).toBe(0);
    expect(out.per_class.logic).toEqual({ n: 1, caught: 1, catch_rate: 1, location_accuracy: 1 });
  });

  it('still charges a kind outside the accepted set', () => {
    const out = runOk([
      '--corpus', corpusWithAlso(),
      '--input', writeInput(reportOnly('stale-comment')),
    ]);
    expect(out.catch_rate).toBe(0);
    expect(out.false_positive_rate).toBe(1);
    expect(out.location_accuracy).toBeNull();
  });

  it('locates a row through an also_accept finding, and only inside the range', () => {
    // `located` must widen with the kind set, or an alternative-kind catch
    // would report caught with location_accuracy 0 - the half-penalty M1 is
    // about, moved rather than removed.
    const inside = runOk([
      '--corpus', corpusWithAlso(), '--input', writeInput(reportOnly('wrong-operator', 20)),
    ]);
    expect(inside.location_accuracy).toBe(1);
    const outside = runOk([
      '--corpus', corpusWithAlso(), '--input', writeInput(reportOnly('wrong-operator', 21)),
    ]);
    expect(outside.catch_rate).toBe(1);
    expect(outside.location_accuracy).toBe(0);
  });

  it('leaves a row with no also_accept scoring exactly as before', () => {
    // The field is optional, so its absence must not change one number.
    const out = runOk([
      '--corpus', stubCorpus,
      '--input', writeInput(reportOnly('inclusive-exclusive-mismatch')),
    ]);
    // SD-001 in the shared stub has NO also_accept: this is a plain FP.
    expect(out.catch_rate).toBe(0);
    expect(out.false_positive_rate).toBe(1);
  });

  it('refuses a malformed also_accept', () => {
    const input = writeInput([]);
    const bad = [
      'inclusive-exclusive-mismatch',          // not an array
      ['off-by-one'],                          // the canonical kind itself
      ['wrong-operator', 'wrong-operator'],    // duplicated
      ['wrong-operator', ''],                  // empty string member
      ['wrong-operator', 7],                   // non-string member
      [],                                      // present but empty
    ];
    for (const also of bad) {
      const res = run(['--corpus', corpusWithAlso(also), '--input', input]);
      expect(res.status, `accepted also_accept ${JSON.stringify(also)}`).toBe(1);
      expect(res.stdout).toBe('');
    }
  });
});

describe('seeded-defect scorer: output shape and determinism', () => {
  it('writes exactly one line whose keys match the contract in order', () => {
    const res = run([
      '--corpus', stubCorpus,
      '--input', writeInput(perfectOutput(STUB_ROWS)),
      '--measured-at', STAMP,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout.endsWith('\n')).toBe(true);
    expect(res.stdout.trimEnd().includes('\n')).toBe(false);
    const parsed = JSON.parse(res.stdout);
    expect(Object.keys(parsed)).toEqual(ENVELOPE_KEYS);
    expect(parsed.measured_at).toBe(STAMP);
  });

  it('is byte-identical across two child processes with shuffled inputs', () => {
    const forward = perfectOutput(STUB_ROWS).map((e) => ({
      ...e,
      findings: [...e.findings, { kind: 'stale-comment', path: 'lib/z.js', line: 1 }],
    }));
    const shuffled = [...forward].reverse().map((e) => ({
      ...e, findings: [...e.findings].reverse(),
    }));
    const args = (input) => ['--corpus', stubCorpus, '--input', writeInput(input),
      '--measured-at', STAMP];

    const a = run(args(forward));
    const b = run(args(shuffled));
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe(a.stdout);
  });

  it('reports the same corpus_sha256 for a CRLF and an LF corpus', () => {
    const lf = writeCorpus(STUB_ROWS, { eol: '\n' });
    const crlf = writeCorpus(STUB_ROWS, { eol: '\r\n' });
    const input = writeInput(perfectOutput(STUB_ROWS));
    const a = runOk(['--corpus', lf, '--input', input]);
    const b = runOk(['--corpus', crlf, '--input', input]);
    // Same text, two checkouts: autocrlf must not change the recorded identity.
    expect(b.corpus_sha256).toBe(a.corpus_sha256);
    expect(a.corpus_sha256).toMatch(/^[0-9a-f]{64}$/);
    // And it is the sha of the LF-normalized TEXT, not of the raw bytes.
    const expectedSha = createHash('sha256')
      .update(readFileSync(lf, 'utf-8').replace(/\r\n/g, '\n'), 'utf-8')
      .digest('hex');
    expect(a.corpus_sha256).toBe(expectedSha);
  });

  it('shuffling the corpus rows changes only the sha, never a rate', () => {
    const reversed = writeCorpus([...STUB_ROWS].reverse());
    const input = writeInput(perfectOutput(STUB_ROWS));
    const a = runOk(['--corpus', stubCorpus, '--input', input]);
    const b = runOk(['--corpus', reversed, '--input', input]);
    expect({ ...b, corpus_sha256: null }).toEqual({ ...a, corpus_sha256: null });
    expect(b.corpus_sha256).not.toBe(a.corpus_sha256);
  });
});

describe('seeded-defect scorer: fail-closed inputs', () => {
  /** Every refusal writes nothing to stdout and one line to stderr. */
  function expectRefusal(args) {
    const res = run(args);
    expect(res.status, `stdout: ${res.stdout}`).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    return res.stderr;
  }

  it('refuses a missing, unparseable or non-array input file', () => {
    expectRefusal(['--corpus', stubCorpus, '--input', path.join(sandbox, 'nope.json')]);
    expectRefusal(['--corpus', stubCorpus, '--input', writeInput('{ not json')]);
    expectRefusal(['--corpus', stubCorpus, '--input', writeInput({ id: 'SD-001' })]);
  });

  it('refuses a malformed entry rather than scoring around it', () => {
    const bad = [
      [{ id: 7, findings: [] }],
      [{ id: 'SD-001' }],
      [{ id: 'SD-001', findings: {} }],
      [{ id: 'SD-001', findings: [{ kind: 1, path: 'lib/a.js', line: 10 }] }],
      [{ id: 'SD-001', findings: [{ kind: 'off-by-one', path: 7, line: 10 }] }],
      [{ id: 'SD-001', findings: [{ kind: 'off-by-one', path: 'lib/a.js', line: '10' }] }],
      [{ id: 'SD-001', findings: [{ kind: 'off-by-one', path: 'lib/a.js', line: 1.5 }] }],
      [{ id: 'SD-001', findings: [{ kind: 'off-by-one', path: 'lib/a.js' }] }],
      [null],
    ];
    for (const input of bad) {
      expectRefusal(['--corpus', stubCorpus, '--input', writeInput(input)]);
    }
  });

  it('refuses an id the corpus does not contain, and a duplicated id', () => {
    expectRefusal(['--corpus', stubCorpus,
      '--input', writeInput([{ id: 'SD-999', findings: [] }])]);
    expectRefusal(['--corpus', stubCorpus, '--input', writeInput([
      { id: 'SD-001', findings: [] }, { id: 'SD-001', findings: [] },
    ])]);
  });

  it('refuses a corpus that is missing, empty, malformed or duplicated', () => {
    const input = writeInput([]);
    const emptyCorpus = path.join(sandbox, 'empty.jsonl');
    writeFileSync(emptyCorpus, '\n\n', 'utf-8');
    const notJson = path.join(sandbox, 'bad.jsonl');
    writeFileSync(notJson, '{ nope\n', 'utf-8');

    // Symmetric with the input-side pin below: the CORPUS read must keep the
    // absolute path out of stderr too. Measured with a mutant 2026-09-21 -
    // reverting `readCorpus` to quote `err.message` left all 37 tests green,
    // because only the input path was pinned.
    const missingStderr = expectRefusal([
      '--corpus', path.join(sandbox, 'absent.jsonl'), '--input', input,
    ]);
    expect(missingStderr).not.toContain(sandbox);
    expect(missingStderr).toContain('ENOENT');
    expectRefusal(['--corpus', emptyCorpus, '--input', input]);
    expectRefusal(['--corpus', notJson, '--input', input]);
    expectRefusal(['--corpus', writeCorpus([STUB_ROWS[0], STUB_ROWS[0]]), '--input', input]);
    expectRefusal(['--corpus', writeCorpus([{ ...STUB_ROWS[0], id: 'SD-1' }]), '--input', input]);
    expectRefusal(['--corpus', writeCorpus([{ ...STUB_ROWS[0], class: 'typo' }]), '--input', input]);
    expectRefusal(['--corpus', writeCorpus([
      { ...STUB_ROWS[0], expected: { finding_kind: 'x', location: { path: 'a', line_range: [9, 2] } } },
    ]), '--input', input]);
  });

  it('refuses an unknown argument, a missing --input and a non-ISO --measured-at', () => {
    const input = writeInput([]);
    expectRefusal(['--corpus', stubCorpus, '--input', input, '--verbose']);
    expectRefusal(['--corpus', stubCorpus]);
    expectRefusal(['--corpus', stubCorpus, '--input', input, '--measured-at', 'yesterday']);
    expectRefusal(['--corpus', stubCorpus, '--input', input, '--measured-at', '2026-13-01T00:00:00Z']);
  });

  it('refuses a zone-less or date-only --measured-at that Date.parse accepts', () => {
    // These are the cases the ISO_INSTANT regex exists for, and the ONLY ones
    // that reach it: measured 2026-09-21, `Date.parse` returns a number for
    // both, so the earlier refusals ('yesterday', '2026-13-01T00:00:00Z') were
    // both caught by the NaN clause and the regex was unpinned. A zone-less
    // stamp is the dangerous one - it is silently read as LOCAL time, so the
    // same corpus scored in two timezones would carry two different instants.
    const input = writeInput([]);
    for (const stamp of ['2026-09-21T00:00:00', '2026-09-21', '2026-09-21T00:00Z']) {
      const res = run(['--corpus', stubCorpus, '--input', input, '--measured-at', stamp]);
      expect(res.status, `accepted ${stamp}`).toBe(1);
      expect(res.stdout).toBe('');
    }
  });

  it('refuses a finding line below 1 instead of scoring it as a miss', () => {
    // Fail-open direction: a 0 or negative line cannot be inside any 1-based
    // line_range, so it used to pass validation and then silently reduce
    // location_accuracy, reporting a reviewer as inaccurate rather than
    // reporting its output as malformed.
    for (const line of [0, -1]) {
      const input = [{ id: 'SD-001', findings: [{ kind: 'off-by-one', path: 'lib/a.js', line }] }];
      expectRefusal(['--corpus', stubCorpus, '--input', writeInput(input)]);
    }
  });

  it('refuses the same flag twice rather than silently taking the last value', () => {
    // `--input good --input bad` scoring `bad` is a wrong number with no
    // symptom. Two spellings of one option is always a mistake worth naming.
    const input = writeInput([]);
    expectRefusal(['--corpus', stubCorpus, '--input', input, '--input', input]);
    expectRefusal(['--corpus', stubCorpus, '--corpus', stubCorpus, '--input', input]);
    expectRefusal(['--corpus', stubCorpus, '--input', input,
      '--measured-at', STAMP, '--measured-at', STAMP]);
  });

  it('keeps an absolute path out of the refusal line', () => {
    // Node's ENOENT message embeds the full path it tried to open. A stderr
    // line is quoted into tickets and CI logs, and a user-profile absolute
    // path is both noise and an identifier there - it carries the account
    // name. Measured 2026-09-21: the message did carry one before this pin.
    //
    // Asserted against the sandbox path this run actually created, rather than
    // against a spelled-out path pattern: the literal form is what the land
    // citation gate refuses, and a runtime value is the stronger check anyway.
    const absent = scratchPath('absent.json');
    const stderr = expectRefusal(['--corpus', stubCorpus, '--input', absent]);
    expect(stderr).not.toContain(sandbox);
    expect(stderr).toContain('ENOENT');
    expect(stderr).toContain(path.basename(absent));
  });

  it('writes exactly one stderr line for a multi-line malformed input', () => {
    // Measured 2026-09-21: V8's JSON error quotes the offending SOURCE, so a
    // broken input spanning four lines produced a four-line refusal. One
    // refusal is one line, or a log reader cannot tell one failure from four.
    //
    // WHAT THIS CANNOT SEE: it bites only on a runtime whose JSON error embeds
    // a source snippet (measured on node v24.15.0). On a runtime with a
    // one-line message format this passes vacuously - it would then assert
    // nothing about the clamp in `refusalLine`, which is the thing under test.
    expectRefusal(['--corpus', stubCorpus,
      '--input', writeInput('[\n  { "id": "SD-001",\n    "findings": [ }\n  ]\n]\n')]);
  });

  it('accepts unknown keys on entries and findings', () => {
    // Deliberate, and the reason the shape check is a check on the THREE keys
    // scoring reads rather than a closed object schema: a real reviewer emits
    // `message`, `severity`, `rule_id` and more alongside them. Refusing those
    // would force every caller to strip its own output before scoring it.
    const input = [{
      id: 'SD-001',
      severity: 'high',
      findings: [{
        kind: 'off-by-one', path: 'lib/a.js', line: 10, message: 'x', rule_id: 'R1',
      }],
    }];
    const out = runOk(['--corpus', stubCorpus, '--input', writeInput(input)]);
    expect(out.catch_rate).toBeCloseTo(1 / 3, 12);
    expect(out.location_accuracy).toBe(1);
  });

  it('refuses a corpus location.path that no normalized finding could ever equal', () => {
    // The comparison normalizes the FINDING side only, so a corpus path
    // spelled `./lib/a.js` or `lib\a.js` can never be located - the row would
    // sit in the corpus scoring a permanent 0 with no error anywhere. Zero of
    // the shipped 30 rows are spelled that way, so this refuses a shape that
    // does not exist yet rather than changing any current result.
    const input = writeInput([]);
    for (const p of ['./lib/a.js', 'lib\\a.js']) {
      const bad = {
        ...STUB_ROWS[0],
        expected: { finding_kind: 'off-by-one', location: { path: p, line_range: [1, 2] } },
      };
      expectRefusal(['--corpus', writeCorpus([bad]), '--input', input]);
    }
  });

  it('parses the arguments it does accept (unit)', () => {
    expect(parseArgs(['--input', 'a.json']).input).toBe('a.json');
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--input', 'a.json', '--measured-at', STAMP]).measuredAt).toBe(STAMP);
    expect(() => parseArgs(['--nope'])).toThrow(/unrecognized/);
    expect(() => parseArgs([])).toThrow(/--input/);
  });

  it('scores without a child process, and throws on the same refusals (unit)', () => {
    const corpus = parseCorpus(STUB_ROWS.map((r) => JSON.stringify(r)).join('\r\n'));
    expect(corpus).toHaveLength(3);
    const scored = scoreFindings(corpus, perfectOutput(STUB_ROWS));
    expect(scored.catch_rate).toBe(1);
    expect(() => scoreFindings(corpus, [{ id: 'SD-404', findings: [] }])).toThrow(/SD-404/);
    expect(() => parseCorpus('')).toThrow(/empty/i);
  });

  it('prints usage for --help without emitting a result line', () => {
    const res = run(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--corpus');
    expect(() => JSON.parse(res.stdout.trim())).toThrow();
  });
});

describe('seeded-defect scorer: the shipped corpus', () => {
  it('scores the shipped 30-row corpus at 1 / 0 / 1 for a perfect reviewer', () => {
    // Deliberately NOT skipped when the fixture is absent. This pair of files
    // ships together; a skip here would let the runner land with nothing ever
    // having scored the corpus it defaults to.
    expect(existsSync(SHIPPED_CORPUS), `missing fixture (owned by B1): ${SHIPPED_CORPUS}`)
      .toBe(true);

    const rows = parseCorpus(readFileSync(SHIPPED_CORPUS, 'utf-8'));
    expect(rows, 'shipped corpus is SD-001..030 by the B1 row contract')
      .toHaveLength(30);

    // No --corpus: this also pins that the DEFAULT path is the shipped fixture.
    const out = runOk(['--input', writeInput(perfectOutput(rows))]);
    expect(out.n).toBe(30);
    // Recomputed here rather than trusted: this is the number that makes two
    // results files comparable, and B1's pin test must agree with it byte for
    // byte on both a CRLF and an LF checkout.
    expect(out.corpus_sha256).toBe(
      createHash('sha256')
        .update(readFileSync(SHIPPED_CORPUS, 'utf-8').split('\r\n').join('\n'), 'utf-8')
        .digest('hex'),
    );
    expect(out.catch_rate).toBe(1);
    expect(out.false_positive_rate).toBe(0);
    expect(out.location_accuracy).toBe(1);
    // Deliberately NOT pinned to the planned per-class distribution (logic 5,
    // boundary 5, ...): B1 owns those counts and may rebalance them. What must
    // hold is that every class is actually exercised - a corpus that dropped a
    // class would otherwise report `null` rates for it and still look green -
    // and that the buckets sum back to n.
    let total = 0;
    for (const cls of CORPUS_CLASSES) {
      const bucket = out.per_class[cls];
      expect(bucket.n, `class ${cls} is unexercised`).toBeGreaterThanOrEqual(3);
      expect(bucket.caught, `class ${cls}`).toBe(bucket.n);
      total += bucket.n;
    }
    expect(total).toBe(out.n);
  });
});
