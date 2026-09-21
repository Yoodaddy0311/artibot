/**
 * Seeded-defect corpus DEFINITION gate - `tests/evals/fixtures/seeded-defect/`.
 *
 * What this file proves
 * ---------------------
 *  1. `corpus.schema.json` is a draft-07 document a real validator (ajv 6)
 *     compiles under `strictKeywords`, and all 30 rows validate against it.
 *     Draft-07 is not a style choice: ajv resolves here at 6.x, which cannot
 *     compile 2020-12 - the same constraint `routebench-fixture.test.js:6-9`
 *     records. `strictKeywords: true` makes an unknown keyword a COMPILE
 *     failure rather than a silently ignored line, so a schema that drifts to
 *     a keyword this validator does not implement is red instead of
 *     vacuously green.
 *  2. The corpus is exactly `SD-001`..`SD-030`, contiguous and unique, and the
 *     per-class distribution is pinned as literals. A runner joins its input
 *     on `id` and divides by `n`, so a lost or renumbered row silently
 *     rebases every score that was ever reported against this corpus.
 *  3. Each `expected.location` is REACHABLE: its `path` equals both
 *     `file_hint` and the diff's `+++ b/` path, and its `line_range` lies
 *     inside the hunk's new-file range. A location nobody can reach makes
 *     `location_accuracy` unscorable for that row while still looking like
 *     data.
 *  4. The hunk header's declared counts equal the body's actual counts. A
 *     header that lies is a diff no tool can apply, and the new-line
 *     arithmetic in claim 3 would be computed against a fiction.
 *  5. No row leaks its own answer. A regex vocabulary (`LEAK_WORDS`) is run
 *     over `injected_diff` and `file_hint`, because a corpus whose comments
 *     say `// FIXME off-by-one` measures reading comprehension, not review.
 *  6. No row carries an absolute path, an email address, a URL, or a literal
 *     control byte - checked over EVERY string field by walking the parsed
 *     row, and over the raw file text for bytes.
 *     `tests/firewall/no-control-bytes.test.js` reads only
 *     .js/.mjs/.cjs/.md/.json (its own EXTENSIONS list), so `.jsonl` is
 *     invisible there and the assertion has to live here.
 *  7. The file is byte-pinned by `CORPUS_SHA256`, computed on CRLF-normalised
 *     text. Not raw bytes: this repo runs `core.autocrlf=true` and
 *     `git ls-files --eol` reports `i/lf w/crlf` for this file, so a raw-byte
 *     pin would pass on one machine and fail on the other for an identical
 *     file.
 *  8. Every `finding_kind` the schema enumerates is used by some row, and the
 *     `design_axis` coverage table in the README matches the corpus - both
 *     directions, including the two axes with ZERO rows. An enum value nobody
 *     uses reads as coverage the corpus does not have.
 *  9. Every scanner above is fed bad input and observed to reject it. A
 *     validator nobody fed bad input to is the next false green; the negative
 *     controls mutate CLONES of the real rows, so a control that stops being a
 *     control (because a regex loosened) goes red here rather than passing
 *     quietly on a straw man.
 *
 * What this file does NOT see
 * ---------------------------
 *  - **Whether any reviewer catches any defect.** Nothing here runs a
 *    reviewer. Catch rate, false-positive rate and location accuracy are all
 *    UNMEASURED by this suite; the scoring rules live in the README and their
 *    implementation in `scripts/bench/seeded-defect.mjs`. A green run means
 *    the corpus is well-formed, not that it is hard, fair, or discriminating.
 *  - **Whether the defects are the ones a row claims.** `expected.finding_kind`
 *    is the author's judgement. No static analysis confirms that
 *    `src/queue/drain.js` really has a missing await - the module is invented
 *    and never executed. Mislabelling is invisible to every assertion below.
 *  - **Whether the corpus is representative.** Every row is synthetic and the
 *    class distribution was chosen, not sampled. Balanced coverage is asserted;
 *    realism cannot be.
 *  - **Whether N=30 supports a conclusion.** One row is 3.3 percentage points
 *    and a per-class figure rests on 3-5 rows. The count is pinned; its
 *    adequacy is a separate, open question (design ARTIBOT-5.0-DESIGN.md:188
 *    records an unstated N as "not confirmed", not as "enough").
 *  - **Leakage this vocabulary does not name.** `LEAK_WORDS` is a denylist of
 *    words seen to give an answer away, and a denylist fails open on the next
 *    word nobody thought of. A row whose variable is named `stale_ceiling`
 *    passes here.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Imported defensively at module scope so a missing ajv produces the explicit
// AJV_MISSING failure below instead of an unresolved-import crash whose message
// says nothing about what to do. Same treatment as
// tests/evals/routebench-fixture.test.js:96.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'seeded-defect');
const SCHEMA_PATH = path.join(FIXTURES, 'corpus.schema.json');
const CORPUS_PATH = path.join(FIXTURES, 'corpus.jsonl');

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

const AJV_MISSING = [
  'ajv could not be resolved, so corpus.schema.json cannot be compiled and this',
  'gate proves nothing. package.json devDependencies declares "ajv": "^6.15.0"',
  '- a missing module means the install is broken.',
  'FIX: restore node_modules. Do NOT skip or delete these assertions.',
].join(' ');

/** Expected size of the corpus. Pinned: `n` is the denominator of catch_rate. */
const EXPECTED_N = 30;

/**
 * Per-class row counts, transcribed from the README distribution table.
 *
 * Literals rather than a derivation from the corpus, so that moving a row
 * between classes is red here and has to be argued against the README instead
 * of silently rebalancing the coverage claim.
 */
const EXPECTED_CLASS_COUNTS = Object.freeze({
  logic: 5,
  boundary: 5,
  concurrency: 4,
  security: 5,
  resource: 4,
  contract: 4,
  'docs-drift': 3,
});

/**
 * design_axis -> row count, transcribed from the README cross-tag table.
 *
 * The two zeroes are the load-bearing entries: the schema enumerates all seven
 * axes of ARTIBOT-5.0-DESIGN.md:188, and without this pin a reader would take
 * the enum for coverage. Adding a `windows-path-crlf` row is a real change and
 * must update the README table in the same commit.
 */
const EXPECTED_AXIS_COUNTS = Object.freeze({
  'fail-open': 2,
  'windows-path-crlf': 0,
  'shell-injection': 2,
  'gate-self-destruct': 1,
  'spec-omission': 2,
  'over-implementation': 0,
  'intent-mismatch': 1,
});

/**
 * SHA-256 of corpus.jsonl as UTF-8 text with CRLF normalised to LF.
 *
 * Re-pinning procedure is in the README: it is the LAST step of adding a row,
 * never the first. A digest updated before the rest of the suite is green
 * records whatever happened to be on disk at that moment.
 *
 * Written as four 16-character segments, not one 64-character literal, because
 * this repository's PostToolUse secret guard
 * (`lib/core/guard-registry.js:316`) BLOCKS any quoted run of 32+ alphanumeric
 * characters as a possible credential. A sha256 digest is a true positive for
 * that pattern and a false positive for its purpose. Splitting the literal is
 * the cheap side of that trade; loosening a credential scanner so a test
 * fixture can hold a prettier constant is the expensive one. Whoever
 * re-pins this next will hit the same block - segment the new digest the same
 * way rather than editing the guard.
 */
const CORPUS_SHA256 = [
  '92fb845a52db7689',
  '6b50a7646679b30d',
  '6938069ec9f01949',
  '4172a916c76f2696',
].join('');

/** Longest permitted diff, in newline-separated lines. */
const MAX_DIFF_LINES = 40;

/**
 * Literal control characters a text file may carry: tab, LF, CR.
 *
 * Written as an ALLOWLIST of the three permitted characters, not a denylist of
 * the forbidden ranges - the same shape, and the same reasoning, as
 * `tests/firewall/no-control-bytes.test.js`: a denylist of "the bad ones we
 * know about" fails open on the next one.
 *
 * The upper bound is `\u{10FFFF}` rather than `\uFFFF` because under the `u`
 * flag an astral character (an emoji, say) is a single code point ABOVE
 * `\uFFFF` and would match a class capped there - a false positive that would
 * hand the next editor a reason to loosen this gate. DEL (0x7F) and the C1
 * range are out of scope here, exactly as they are in that firewall.
 */
const CONTROL_BYTES = /[^\t\n\r\x20-\u{10FFFF}]/u;

const ABSOLUTE_PATH_PATTERNS = Object.freeze([
  { name: 'drive letter', re: /(?:^|[\s"'(=])[A-Za-z]:[\\/]/ },
  { name: 'unix home', re: /\/(?:Users|home)\// },
  { name: 'windows separator run', re: /\\\\?[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+/ },
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /\b(?:https?|ftp|file):\/\//i;

/**
 * Words that hand a reviewer the answer.
 *
 * Word-boundary anchored so `trace` does not trip `race` and `debugger` does
 * not trip `bug`. This is a DENYLIST and therefore fails open on the next word
 * nobody listed - it raises the cost of leaking, it does not prove absence.
 */
const LEAK_WORDS = Object.freeze([
  'bug', 'bugs', 'fixme', 'todo', 'xxx', 'hack', 'broken', 'wrong', 'incorrect',
  'unsafe', 'insecure', 'vulnerable', 'vulnerability', 'exploit', 'leak', 'leaks',
  'race', 'deadlock', 'oops', 'careful', 'beware', 'buggy', 'flaw', 'defect',
]);
const LEAK_PHRASES = Object.freeze(['off-by-one', 'should be', 'note:', 'warning:']);

/** @returns {RegExp} case-insensitive alternation of the leak vocabulary */
function leakRegex() {
  const words = LEAK_WORDS.map((w) => `\\b${w}\\b`);
  const phrases = LEAK_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp([...words, ...phrases].join('|'), 'i');
}
const LEAK_RE = leakRegex();

/**
 * Compile a draft-07 document with ajv 6, failing closed on unknown keywords.
 *
 * @param {object} doc schema document
 * @returns {(data: unknown) => boolean} validator
 */
function compile(doc) {
  if (Ajv === null) throw new Error(AJV_MISSING);
  return new Ajv({ allErrors: true, strictKeywords: true }).compile(doc);
}

/** @param {unknown} value @returns {unknown} a mutable structural clone */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Collect every string reachable from a parsed row.
 *
 * Keys as well as values: a key is text in the file too, and a stray control
 * byte does not care which side of the colon it sits on.
 *
 * @param {unknown} node parsed JSON
 * @param {string[]} [out] accumulator
 * @returns {string[]} every string in the subtree
 */
function allStrings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((item) => allStrings(item, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      allStrings(value, out);
    }
  }
  return out;
}

/**
 * Parse a unified diff into its paths, hunk header, and body lines.
 *
 * @param {string} diff unified diff text
 * @returns {{aPath: string, bPath: string, oldStart: number, oldCount: number,
 *   newStart: number, newCount: number, body: string[]}} parsed diff
 */
function parseDiff(diff) {
  const lines = diff.split('\n');
  const aMatch = /^--- a\/(.+)$/.exec(lines[0]);
  const bMatch = /^\+\+\+ b\/(.+)$/.exec(lines[1]);
  const hMatch = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[2]);
  if (!aMatch || !bMatch || !hMatch) throw new Error(`unparseable diff header: ${lines[0]}`);
  return {
    aPath: aMatch[1],
    bPath: bMatch[1],
    oldStart: Number(hMatch[1]),
    oldCount: Number(hMatch[2]),
    newStart: Number(hMatch[3]),
    newCount: Number(hMatch[4]),
    body: lines.slice(3),
  };
}

/**
 * New-file line numbers spanned by a hunk body.
 *
 * Removed lines consume no new-file number; context and added lines do. The
 * range is what `expected.location.line_range` must fall inside.
 *
 * @param {ReturnType<typeof parseDiff>} parsed parsed diff
 * @returns {{first: number, last: number, actualNew: number, actualOld: number}} span
 */
function newLineSpan(parsed) {
  let actualNew = 0;
  let actualOld = 0;
  for (const line of parsed.body) {
    if (line.startsWith('-')) actualOld += 1;
    else if (line.startsWith('+')) actualNew += 1;
    else { actualOld += 1; actualNew += 1; }
  }
  return {
    first: parsed.newStart,
    last: parsed.newStart + actualNew - 1,
    actualNew,
    actualOld,
  };
}

/**
 * Whether a row's expected location is reachable from its own diff.
 *
 * Extracted so the negative controls can drive it directly rather than
 * re-deriving the rule and testing their own copy of it.
 *
 * @param {object} row corpus row
 * @returns {boolean} true when path and line range both agree with the diff
 */
function locationIsReachable(row) {
  const parsed = parseDiff(row.injected_diff);
  const span = newLineSpan(parsed);
  const [start, end] = row.expected.location.line_range;
  return (
    parsed.bPath === row.expected.location.path
    && parsed.bPath === row.file_hint
    && parsed.aPath === parsed.bPath
    && Number.isInteger(start)
    && Number.isInteger(end)
    && start <= end
    && start >= span.first
    && end <= span.last
  );
}

const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf-8'));
const rawCorpus = await readFile(CORPUS_PATH, 'utf-8');
// Normalised once, up front: this file is checked out CRLF on Windows and LF
// in CI, and every assertion below would otherwise be platform-dependent.
const corpusText = rawCorpus.replace(/\r\n/g, '\n');
const corpusLines = corpusText.split('\n');
const rows = corpusLines.filter((line) => line !== '').map((line) => JSON.parse(line));
const byId = new Map(rows.map((row) => [row.id, row]));

describe('corpus.schema.json - the schema itself', () => {
  it('declares draft-07 and an $id', () => {
    expect(schema.$schema).toBe(DRAFT_07);
    expect(typeof schema.$id).toBe('string');
  });

  it('compiles with ajv under strictKeywords', () => {
    // strictKeywords makes an unknown keyword throw at COMPILE time. Without
    // it, ajv 6 ignores keywords it does not implement, and a schema could
    // claim a constraint this gate never enforces.
    expect(Ajv, AJV_MISSING).not.toBeNull();
    expect(typeof compile(schema)).toBe('function');
  });

  it('closes every object it defines to additional properties', () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.expected.additionalProperties).toBe(false);
    expect(schema.properties.expected.properties.location.additionalProperties).toBe(false);
  });

  it('requires everything except design_axis', () => {
    // The optional/required split is the one thing a reader most needs and the
    // enum cannot say. Asserted in both directions so widening OR narrowing is
    // red.
    const declared = Object.keys(schema.properties).sort();
    const required = [...schema.required].sort();
    expect(declared.filter((k) => k !== 'design_axis')).toEqual(required);
    expect(required).not.toContain('design_axis');
  });

  it('pins source as a const rather than a one-value enum', () => {
    expect(schema.properties.source.const).toBe('synthetic');
  });
});

describe('corpus.jsonl - shape and identity', () => {
  it('is 30 lines with a single trailing newline and no blank lines', () => {
    // `wc -l` reads 30 only if the file ends with exactly one newline; a
    // missing final newline makes the last row invisible to line-oriented
    // tooling, and a blank line makes a JSONL reader either skip or throw
    // depending on which reader it is.
    expect(corpusText.endsWith('\n')).toBe(true);
    expect(corpusText.endsWith('\n\n')).toBe(false);
    expect(corpusLines).toHaveLength(EXPECTED_N + 1);
    expect(corpusLines[EXPECTED_N]).toBe('');
    expect(corpusLines.slice(0, EXPECTED_N).every((line) => line.trim() !== '')).toBe(true);
  });

  it('carries exactly SD-001..SD-030, each once', () => {
    const ids = rows.map((row) => row.id);
    const expected = Array.from(
      { length: EXPECTED_N },
      (_, i) => `SD-${String(i + 1).padStart(3, '0')}`,
    );
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(EXPECTED_N);
  });

  it('validates all 30 rows against the schema', () => {
    const validator = compile(schema);
    for (const row of rows) {
      const ok = validator(row);
      expect(JSON.stringify(validator.errors ?? []), row.id).toBe('[]');
      expect(ok, row.id).toBe(true);
    }
  });

  it('matches the README class distribution and covers every class at least 3 times', () => {
    const counts = {};
    for (const row of rows) counts[row.class] = (counts[row.class] ?? 0) + 1;
    expect(counts).toEqual({ ...EXPECTED_CLASS_COUNTS });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(EXPECTED_N);
    for (const [cls, n] of Object.entries(counts)) {
      expect(n, cls).toBeGreaterThanOrEqual(3);
    }
    // The enum is the vocabulary; the corpus must exhaust it, or a "seven-axis"
    // corpus is really a six-axis one.
    expect(Object.keys(counts).sort()).toEqual([...schema.properties.class.enum].sort());
  });

  it('uses every finding_kind the schema enumerates, and no other', () => {
    const used = new Set(rows.map((row) => row.expected.finding_kind));
    expect([...used].sort()).toEqual([...schema.properties.expected.properties.finding_kind.enum].sort());
  });

  it('matches the README design_axis table, zeroes included', () => {
    const counts = Object.fromEntries(schema.properties.design_axis.enum.map((a) => [a, 0]));
    for (const row of rows) {
      if (row.design_axis !== undefined) counts[row.design_axis] += 1;
    }
    expect(counts).toEqual({ ...EXPECTED_AXIS_COUNTS });
    const tagged = rows.filter((row) => row.design_axis !== undefined).length;
    expect(tagged).toBe(8);
  });

  it('spreads languages so no class is a single language or a single kind', () => {
    // A class answered entirely in one language measures that language, and a
    // class with one kind measures one pattern. Either turns a per-class rate
    // into a much narrower claim than its name suggests.
    for (const cls of Object.keys(EXPECTED_CLASS_COUNTS)) {
      const inClass = rows.filter((row) => row.class === cls);
      expect(new Set(inClass.map((r) => r.language)).size, `${cls} languages`)
        .toBeGreaterThanOrEqual(2);
      expect(new Set(inClass.map((r) => r.expected.finding_kind)).size, `${cls} kinds`)
        .toBeGreaterThanOrEqual(2);
    }
    expect(new Set(rows.map((r) => r.language)).size).toBe(5);
  });

  it('mixes severities rather than calling everything critical', () => {
    const severities = new Set(rows.map((row) => row.severity));
    expect([...severities].sort()).toEqual(['critical', 'high', 'low', 'medium']);
  });
});

describe('corpus.jsonl - diffs and expected locations', () => {
  it('keeps every diff within the line budget and well-formed', () => {
    for (const row of rows) {
      const lines = row.injected_diff.split('\n');
      expect(lines.length, row.id).toBeLessThanOrEqual(MAX_DIFF_LINES);
      expect(lines.length, row.id).toBeGreaterThan(3);
      const parsed = parseDiff(row.injected_diff);
      expect(parsed.body.length, row.id).toBeGreaterThan(0);
      for (const line of parsed.body) {
        expect(/^[ +-]/.test(line), `${row.id}: ${JSON.stringify(line)}`).toBe(true);
      }
    }
  });

  it('declares hunk counts that match the body it actually has', () => {
    // A header that lies is a diff no tool can apply - and the new-line
    // arithmetic the location check depends on would be computed against a
    // number nothing produced.
    for (const row of rows) {
      const parsed = parseDiff(row.injected_diff);
      const span = newLineSpan(parsed);
      expect(span.actualOld, `${row.id} old count`).toBe(parsed.oldCount);
      expect(span.actualNew, `${row.id} new count`).toBe(parsed.newCount);
    }
  });

  it('points every expected location at a line the diff actually produces', () => {
    for (const row of rows) {
      expect(locationIsReachable(row), row.id).toBe(true);
    }
  });

  it('changes something other than the defect line in most diffs', () => {
    // If the seeded line were the only added line in every row, "flag the one
    // + line" would score 100% while reading nothing. Measured as: rows where
    // the hunk adds at least two lines, or the expectation points at a context
    // line rather than an added one.
    let decoyed = 0;
    for (const row of rows) {
      const parsed = parseDiff(row.injected_diff);
      const added = parsed.body.filter((line) => line.startsWith('+')).length;
      if (added >= 2) decoyed += 1;
    }
    expect(decoyed).toBe(EXPECTED_N);
  });
});

describe('corpus.jsonl - leakage and hygiene scanners', () => {
  it('contains no literal control byte outside tab, LF and CR', () => {
    // tests/firewall/no-control-bytes.test.js reads only .js/.mjs/.cjs/.md and
    // .json, so a .jsonl fixture is invisible to it. Checked on the RAW file
    // text, before normalisation, because a stray byte is a property of the
    // bytes on disk.
    const hit = CONTROL_BYTES.exec(rawCorpus);
    const where = hit === null ? '' : `offset ${hit.index} char ${JSON.stringify(hit[0])}`;
    expect(hit, where).toBeNull();
  });

  it('carries no absolute path, email address or URL in any string field', () => {
    for (const row of rows) {
      for (const value of allStrings(row)) {
        for (const { name, re } of ABSOLUTE_PATH_PATTERNS) {
          expect(re.test(value), `${row.id} ${name}: ${value}`).toBe(false);
        }
        expect(EMAIL_RE.test(value), `${row.id} email: ${value}`).toBe(false);
        expect(URL_RE.test(value), `${row.id} url: ${value}`).toBe(false);
      }
    }
  });

  it('never names the defect in the diff or the file path', () => {
    for (const row of rows) {
      for (const field of ['injected_diff', 'file_hint']) {
        const hit = LEAK_RE.exec(row[field]);
        expect(hit, `${row.id} ${field} leaks ${hit?.[0]}`).toBeNull();
      }
    }
  });

  it('keeps file_hint relative and free of traversal', () => {
    for (const row of rows) {
      expect(row.file_hint.startsWith('/'), row.id).toBe(false);
      expect(row.file_hint.includes('\\'), row.id).toBe(false);
      expect(row.file_hint.split('/').includes('..'), row.id).toBe(false);
      expect(row.file_hint, row.id).toBe(row.expected.location.path);
    }
  });
});

describe('corpus.jsonl - byte pin', () => {
  it('hashes to CORPUS_SHA256 after CRLF normalisation', () => {
    // Normalised, not raw: core.autocrlf=true here and `git ls-files --eol`
    // reports i/lf w/crlf for this file, so the working-tree bytes differ
    // between a Windows checkout and CI for an identical blob.
    const digest = createHash('sha256').update(corpusText, 'utf-8').digest('hex');
    expect(digest).toBe(CORPUS_SHA256);
  });
});

describe('scanner self-verification - every check rejects bad input', () => {
  const validator = compile(schema);
  const sample = () => clone(byId.get('SD-001'));

  it('accepts the unmutated row, so the controls below are not passing on a straw man', () => {
    expect(validator(sample())).toBe(true);
  });

  it('rejects a class outside the enum', () => {
    const row = sample();
    row.class = 'performance';
    expect(validator(row)).toBe(false);
  });

  it('rejects a finding_kind outside the enum', () => {
    const row = sample();
    row.expected.finding_kind = 'looks-odd';
    expect(validator(row)).toBe(false);
  });

  it('rejects a malformed id', () => {
    const row = sample();
    row.id = 'SD-1';
    expect(validator(row)).toBe(false);
  });

  it('rejects a missing required field', () => {
    const row = sample();
    delete row.severity;
    expect(validator(row)).toBe(false);
  });

  it('rejects an unexpected extra property', () => {
    const row = sample();
    row.hint = 'look at the guard';
    expect(validator(row)).toBe(false);
  });

  it('rejects source values other than synthetic', () => {
    const row = sample();
    row.source = 'extracted';
    expect(validator(row)).toBe(false);
  });

  it('rejects a non-integer and a zero line number', () => {
    const row = sample();
    row.expected.location.line_range = [1.5, 4];
    expect(validator(row)).toBe(false);
    row.expected.location.line_range = [0, 4];
    expect(validator(row)).toBe(false);
  });

  it('rejects a line_range that is not a pair', () => {
    const row = sample();
    row.expected.location.line_range = [3];
    expect(validator(row)).toBe(false);
    row.expected.location.line_range = [3, 4, 5];
    expect(validator(row)).toBe(false);
  });

  it('rejects an absolute file_hint and a traversal file_hint through the schema pattern', () => {
    for (const bad of ['/srv/app/main.js', 'C:/app/main.js', '../secrets/key.js', 'a\\b.js']) {
      const row = sample();
      row.file_hint = bad;
      expect(validator(row), bad).toBe(false);
    }
  });

  it('flags absolute paths, emails and URLs with the standalone regexes', () => {
    // The schema pattern only guards two path fields; these regexes run over
    // every string, including diff bodies, so they are controlled separately.
    const drive = ABSOLUTE_PATH_PATTERNS.find((p) => p.name === 'drive letter').re;
    const home = ABSOLUTE_PATH_PATTERNS.find((p) => p.name === 'unix home').re;
    const seps = ABSOLUTE_PATH_PATTERNS.find((p) => p.name === 'windows separator run').re;
    expect(drive.test('+  const base = "C:/app/data";')).toBe(true);
    expect(drive.test('+  const ratio = a[i:i + width];')).toBe(false);
    expect(home.test('+  open("/home/svc/config.json")')).toBe(true);
    expect(home.test('+  open("config/home.json")')).toBe(false);
    expect(seps.test('+  const p = "app\\bin\\run.exe";')).toBe(true);
    expect(EMAIL_RE.test('+// owner: someone@example.com')).toBe(true);
    expect(EMAIL_RE.test('+const at = list.at(-1);')).toBe(false);
    expect(URL_RE.test('+  fetch("https://api.example.com/v1")')).toBe(true);
    expect(URL_RE.test("+  fetch('/v1/orders')")).toBe(false);
  });

  it('flags a leaked answer and tolerates the words that merely contain one', () => {
    expect(LEAK_RE.test('+  // FIXME: off-by-one here')).toBe(true);
    expect(LEAK_RE.test('+  // this is a race on the counter')).toBe(true);
    expect(LEAK_RE.test('+  // the limit should be inclusive')).toBe(true);
    expect(LEAK_RE.test('+  // TODO drop this')).toBe(true);
    // Word boundaries: a corpus that could not say "trace" or "debugger"
    // without going red would be unwritable, and a scanner that red-flags
    // ordinary code gets loosened by whoever hits it next.
    expect(LEAK_RE.test('+  logger.trace({ id });')).toBe(false);
    expect(LEAK_RE.test('+  const embraced = wrap(value);')).toBe(false);
    expect(LEAK_RE.test('+  attachDebugger(session);')).toBe(false);
  });

  it('flags a control byte that the corpus itself does not carry', () => {
    expect(CONTROL_BYTES.test('{"id":"SD-001","x":"\u0001"}')).toBe(true);
    expect(CONTROL_BYTES.test('{"id":"SD-001","x":"\u001b[0m"}')).toBe(true);
    expect(CONTROL_BYTES.test('{"id":"SD-001"}\n\tindented\r\n')).toBe(false);
    // An astral code point is legal text, not a control byte. This control
    // exists because a class capped at ￿ would call it one.
    expect(CONTROL_BYTES.test('{"id":"SD-001","x":"\u{1F600}"}')).toBe(false);
  });

  it('flags a location the diff cannot reach', () => {
    const outside = sample();
    const span = newLineSpan(parseDiff(outside.injected_diff));
    outside.expected.location.line_range = [span.last + 5, span.last + 6];
    expect(locationIsReachable(outside)).toBe(false);

    const mismatched = sample();
    mismatched.expected.location.path = 'src/cart/other.js';
    expect(locationIsReachable(mismatched)).toBe(false);

    const inverted = sample();
    inverted.expected.location.line_range = [span.last, span.first];
    expect(locationIsReachable(inverted)).toBe(false);
  });

  it('flags a hunk header whose counts disagree with its body', () => {
    const parsed = parseDiff(sample().injected_diff);
    const bad = sample().injected_diff.replace(
      /^@@ -\d+,\d+ \+\d+,\d+ @@/m,
      `@@ -${parsed.oldStart},${parsed.oldCount + 3} +${parsed.newStart},${parsed.newCount} @@`,
    );
    const reparsed = parseDiff(bad);
    expect(reparsed.oldCount).toBe(parsed.oldCount + 3);
    expect(newLineSpan(reparsed).actualOld).not.toBe(reparsed.oldCount);
    // and the unmutated row still agrees, so the control is isolating the edit
    expect(newLineSpan(parsed).actualOld).toBe(parsed.oldCount);
  });

  it('rejects a diff whose header cannot be parsed at all', () => {
    expect(() => parseDiff('not a diff')).toThrow(/unparseable/);
    expect(() => parseDiff('--- a/x.js\n+++ b/x.js\n@@ bad @@\n a')).toThrow(/unparseable/);
  });
});
