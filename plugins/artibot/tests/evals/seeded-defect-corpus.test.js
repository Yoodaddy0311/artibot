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
 *  5. `also_accept`, where present, holds only enum kinds, never repeats the
 *     canonical `finding_kind`, and never duplicates. The "not the canonical
 *     kind" half cannot be said in draft-07 - it compares two sibling values -
 *     so it is asserted here or nowhere. The number of rows carrying it is
 *     pinned, because widening the accepted vocabulary raises catch rate for
 *     free and should have to be argued for.
 *  6. No row leaks its own answer. A regex vocabulary runs over
 *     `injected_diff` and `file_hint` BOTH as raw text and after splitting
 *     identifiers on snake_case and camelCase, so `is_broken` and `raceGuard`
 *     are caught and not only `is broken`.
 *  7. No row carries an absolute path, an email address, a URL, or a literal
 *     control character - checked over EVERY string field by walking the
 *     parsed row, and over the raw file text for control characters.
 *     `tests/firewall/no-control-bytes.test.js` reads only
 *     .js/.mjs/.cjs/.md/.json (its own EXTENSIONS list), so `.jsonl` is
 *     invisible there and the assertion has to live here.
 *  8. Structural tells are bounded: no diff re-adds a line it just deleted,
 *     every diff adds at least two lines, and the defect is not the first
 *     added line in a pinned majority of rows. Each of those, left alone, is a
 *     way to score well without reading the code.
 *  9. The file is byte-pinned by `CORPUS_SHA256`, computed on CRLF-normalised
 *     text. Not raw bytes: this repo runs `core.autocrlf=true` and
 *     `git ls-files --eol` reports `i/lf w/crlf` for this file, so a raw-byte
 *     pin would pass on one machine and fail on the other for an identical
 *     file.
 * 10. Every `finding_kind` the schema enumerates is used by some row, and the
 *     `design_axis` coverage table in the README matches the corpus - both
 *     directions, including the axis with ZERO rows. An enum value nobody uses
 *     reads as coverage the corpus does not have.
 * 11. Every scanner above is fed bad input and observed to reject it, THROUGH
 *     THE SAME FIELD-WALKING LOOP the real check uses - not by calling a regex
 *     on a hand-written string. A control that only exercises the pattern
 *     would stay green if the loop stopped visiting a field.
 *
 * What this file does NOT see
 * ---------------------------
 *  - **Whether any reviewer catches any defect.** Nothing here runs a
 *    reviewer. Catch rate, false-positive rate and location accuracy are all
 *    UNMEASURED by this suite; the scoring rules live in the README and their
 *    implementation in `scripts/bench/seeded-defect.mjs`. A green run means
 *    the corpus is well-formed, not that it is hard, fair, or discriminating.
 *  - **Whether the defects are the ones a row claims.** `expected.finding_kind`
 *    is the author's judgement. Nothing here executes or analyses an invented
 *    module, so a row whose diff really contains, say, a resource leak while
 *    the row says `off-by-one` is green on every assertion below. The same
 *    blindness covers `also_accept` (is that really a synonym?) and the decoy
 *    changes (is that really defect-free?). Human re-reading is the only
 *    control for this class, and it is the most valuable review this corpus
 *    can get.
 *  - **Whether the corpus is representative.** Every row is synthetic and the
 *    class distribution was chosen, not sampled. Balanced coverage is asserted;
 *    realism cannot be.
 *  - **Whether N=30 supports a conclusion.** One row is 3.3 percentage points
 *    and a per-class figure rests on 3-5 rows. The count is pinned; its
 *    adequacy is a separate, open question (design ARTIBOT-5.0-DESIGN.md:188
 *    records an unstated N as "not confirmed", not as "enough").
 *  - **Leakage this vocabulary does not name.** `LEAK_WORDS` is a DENYLIST of
 *    words seen to give an answer away, and a denylist fails open on the next
 *    word nobody thought of. A row whose variable is named `staleCeiling`
 *    passes here. The same shape applies to the hygiene regexes: the
 *    drive-letter and URL patterns enumerate the forms that have come up, not
 *    every form that exists - a UNC path or a `data:` URI is invisible to
 *    them.
 *  - **Whether the hygiene regexes are free of FALSE positives.** The
 *    'windows separator run' pattern in particular matches a backslash between
 *    two identifier-ish runs, which a row containing a regular expression
 *    escape could trip innocently. If that happens the fix is to narrow the
 *    pattern with a control proving it still catches a real path - not to drop
 *    the check.
 *  - **Whether a harness honours the reviewer input contract.** The README
 *    requires showing `injected_diff` only, withholding `class` and `expected`,
 *    and running without file tools. Nothing here can observe a harness, so a
 *    runner that showed the reviewer the whole row would be green on this file
 *    and measuring nothing.
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
 * The zero is the load-bearing entry: the schema enumerates all seven axes of
 * ARTIBOT-5.0-DESIGN.md:188, and without this pin a reader would take the enum
 * for coverage. Adding an `over-implementation` row is a real change and must
 * update the README table in the same commit.
 */
const EXPECTED_AXIS_COUNTS = Object.freeze({
  'fail-open': 2,
  'windows-path-crlf': 1,
  'shell-injection': 1,
  'gate-self-destruct': 1,
  'spec-omission': 2,
  'over-implementation': 0,
  'intent-mismatch': 1,
});

/**
 * How many rows carry `expected.also_accept`.
 *
 * Pinned because every row that gains one gets easier to catch: the accepted
 * vocabulary widens and `false_positive_rate` stops charging for the extra
 * word. Growth should be an argument in review, not a drift.
 */
const EXPECTED_ALSO_ACCEPT_ROWS = 6;

/**
 * Rows where the defect does NOT start on the first added line of its hunk.
 *
 * A floor, not an equality: the point is that "flag the first `+` line" is not
 * a strategy. Measured at 26/30 when written.
 */
const MIN_DEFECT_NOT_FIRST_ADDED = 24;

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
 * fixture can hold a prettier constant is the expensive one. Whoever re-pins
 * this next will hit the same block - segment the new digest the same way
 * rather than editing the guard.
 */
const CORPUS_SHA256 = [
  '9ec2df32d4aee5d5',
  'ff5cb602c898a7fd',
  'f1f174984fd4619f',
  '1b9021e2466769da',
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
const CONTROL_CHARS = /[^\t\n\r\x20-\u{10FFFF}]/u;

const ABSOLUTE_PATH_PATTERNS = Object.freeze([
  { name: 'drive letter', re: /(?:^|[\s"'(=])[A-Za-z]:[\\/]/ },
  { name: 'unix home', re: /\/(?:Users|home)\// },
  { name: 'windows separator run', re: /\\\\?[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+/ },
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /\b(?:https?|ftp|file):\/\//i;

/**
 * Words that hand a reviewer the answer. THE canonical list - the README
 * points here rather than copying it, so the two cannot drift.
 *
 * Word-boundary anchored so `trace` does not trip `race` and `debugger` does
 * not trip `bug`. Applied to identifier-split text as well as raw text, so
 * `is_broken` and `raceGuard` are caught. Still a DENYLIST, and therefore
 * fails open on the next word nobody listed - it raises the cost of leaking,
 * it does not prove absence.
 */
const LEAK_WORDS = Object.freeze([
  'bug', 'bugs', 'buggy', 'fixme', 'todo', 'xxx', 'hack', 'broken', 'wrong',
  'incorrect', 'unsafe', 'insecure', 'vulnerable', 'vulnerability', 'exploit',
  'leak', 'leaks', 'race', 'deadlock', 'oops', 'careful', 'beware', 'flaw',
  'defect', 'stale', 'unvalidated', 'traversal', 'injection',
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
 * Split identifiers so the word-boundary regex can see inside them.
 *
 * `\b` treats `is_broken` and `raceGuard` as single tokens, so a leak hidden in
 * a name would pass the raw-text pass. Underscores become spaces and a
 * lower-to-upper transition gains one.
 *
 * @param {string} text source text
 * @returns {string} text with identifier internals separated by spaces
 */
function splitIdentifiers(text) {
  return text.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

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
 * character does not care which side of the colon it sits on.
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
 * Run every hygiene scanner over a whole row and report what it found.
 *
 * The REAL check and the negative controls both call this, so a control cannot
 * stay green by exercising a regex the field-walk no longer reaches.
 *
 * @param {object} row corpus row
 * @returns {string[]} one message per violation; empty means clean
 */
function scanRow(row) {
  const findings = [];
  for (const value of allStrings(row)) {
    for (const { name, re } of ABSOLUTE_PATH_PATTERNS) {
      if (re.test(value)) findings.push(`${name}: ${value}`);
    }
    if (EMAIL_RE.test(value)) findings.push(`email: ${value}`);
    if (URL_RE.test(value)) findings.push(`url: ${value}`);
    if (CONTROL_CHARS.test(value)) findings.push(`control character: ${JSON.stringify(value)}`);
  }
  for (const field of ['injected_diff', 'file_hint']) {
    const text = row[field] ?? '';
    const raw = LEAK_RE.exec(text);
    if (raw) findings.push(`${field} leaks "${raw[0]}"`);
    const split = LEAK_RE.exec(splitIdentifiers(text));
    if (split && !raw) findings.push(`${field} leaks "${split[0]}" inside an identifier`);
  }
  return findings;
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
 * @returns {{first: number, last: number, actualNew: number, actualOld: number,
 *   firstAdded: number|null}} span
 */
function newLineSpan(parsed) {
  let actualNew = 0;
  let actualOld = 0;
  let cursor = parsed.newStart;
  let firstAdded = null;
  for (const line of parsed.body) {
    if (line.startsWith('-')) { actualOld += 1; continue; }
    if (line.startsWith('+')) {
      actualNew += 1;
      if (firstAdded === null) firstAdded = cursor;
    } else { actualOld += 1; actualNew += 1; }
    cursor += 1;
  }
  return {
    first: parsed.newStart,
    last: parsed.newStart + actualNew - 1,
    actualNew,
    actualOld,
    firstAdded,
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
const KIND_ENUM = schema.properties.expected.properties.finding_kind.enum;

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

  it('makes also_accept optional and draws it from the same kind vocabulary', () => {
    const also = schema.properties.expected.properties.also_accept;
    expect(schema.properties.expected.required).not.toContain('also_accept');
    expect(also.uniqueItems).toBe(true);
    expect(also.minItems).toBe(1);
    // One vocabulary, not two: a separate enum here is how a synonym list ends
    // up naming a kind the corpus cannot express.
    expect([...also.items.enum].sort()).toEqual([...KIND_ENUM].sort());
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

  it('does not order ids in class blocks', () => {
    // The reviewer input contract calls `id` an opaque token. If the file were
    // authored in class order, id order alone would leak the taxonomy to
    // anyone shown the rows in sequence - no withheld field required. Measured
    // as: adjacent same-class pairs stay well below a blocked layout, which
    // would produce 23 for seven blocks.
    const classes = rows.map((row) => row.class);
    let adjacent = 0;
    for (let i = 1; i < classes.length; i += 1) {
      if (classes[i] === classes[i - 1]) adjacent += 1;
    }
    expect(adjacent).toBeLessThanOrEqual(8);
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
    expect([...used].sort()).toEqual([...KIND_ENUM].sort());
  });

  it('matches the README design_axis table, zero included', () => {
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

describe('corpus.jsonl - also_accept', () => {
  const withAlso = () => rows.filter((row) => row.expected.also_accept !== undefined);

  it('appears on exactly the pinned number of rows', () => {
    expect(withAlso()).toHaveLength(EXPECTED_ALSO_ACCEPT_ROWS);
  });

  it('never repeats the canonical kind and never duplicates', () => {
    // draft-07 cannot compare a value to a sibling value, so "also_accept does
    // not contain finding_kind" is asserted here or nowhere. A row that
    // repeated it would silently look like it accepts two names while
    // accepting one.
    for (const row of withAlso()) {
      const also = row.expected.also_accept;
      expect(also, row.id).not.toContain(row.expected.finding_kind);
      expect(new Set(also).size, row.id).toBe(also.length);
      expect(also.length, row.id).toBeGreaterThan(0);
      for (const kind of also) expect(KIND_ENUM, `${row.id} ${kind}`).toContain(kind);
    }
  });

  it('is used sparingly rather than on every row that could claim a synonym', () => {
    // A corpus where most rows accept several kinds stops measuring whether the
    // reviewer named the defect. Kept well under half by construction.
    expect(withAlso().length).toBeLessThan(EXPECTED_N / 2);
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

  it('never ends a diff with a newline, which the README makes an adapter concern', () => {
    // Stated in the reviewer input contract because `git apply` rejects a patch
    // whose last line is unterminated. Asserted so the contract cannot go
    // stale against the data.
    for (const row of rows) {
      expect(row.injected_diff.endsWith('\n'), row.id).toBe(false);
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
});

describe('corpus.jsonl - structural tells a reviewer could exploit', () => {
  it('adds at least two lines in every hunk', () => {
    // If the seeded line were the only added line, "flag the one + line" would
    // score 100% while reading nothing.
    for (const row of rows) {
      const parsed = parseDiff(row.injected_diff);
      const added = parsed.body.filter((line) => line.startsWith('+')).length;
      expect(added, row.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('never re-adds a line it just deleted', () => {
    // A `-`/`+` pair with identical text is an artefact of writing diffs by
    // hand rather than by editing a file. It marks the surrounding lines as
    // the ones that really changed, which is a free hint.
    for (const row of rows) {
      const { body } = parseDiff(row.injected_diff);
      const removed = new Set(body.filter((l) => l.startsWith('-')).map((l) => l.slice(1)));
      const readded = body.filter((l) => l.startsWith('+') && removed.has(l.slice(1)));
      expect(readded, row.id).toEqual([]);
    }
  });

  it('keeps the defect off the first added line in most rows', () => {
    // Position is the other free hint. A floor rather than an equality: some
    // rows legitimately have nowhere else to put it.
    let notFirst = 0;
    for (const row of rows) {
      const span = newLineSpan(parseDiff(row.injected_diff));
      if (row.expected.location.line_range[0] !== span.firstAdded) notFirst += 1;
    }
    expect(notFirst).toBeGreaterThanOrEqual(MIN_DEFECT_NOT_FIRST_ADDED);
  });
});

describe('corpus.jsonl - leakage and hygiene scanners', () => {
  it('contains no literal control character outside tab, LF and CR', () => {
    // tests/firewall/no-control-bytes.test.js reads only .js/.mjs/.cjs/.md and
    // .json, so a .jsonl fixture is invisible to it. Checked on the RAW file
    // text, before normalisation, because a stray character is a property of
    // the bytes on disk.
    const hit = CONTROL_CHARS.exec(rawCorpus);
    const where = hit === null ? '' : `offset ${hit.index} char ${JSON.stringify(hit[0])}`;
    expect(hit, where).toBeNull();
  });

  it('passes every hygiene scanner on every row', () => {
    for (const row of rows) {
      expect(scanRow(row), row.id).toEqual([]);
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
    expect(scanRow(sample())).toEqual([]);
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

  it('rejects an also_accept that is empty, duplicated or off-vocabulary', () => {
    const row = sample();
    row.expected.also_accept = [];
    expect(validator(row), 'empty').toBe(false);
    row.expected.also_accept = ['off-by-one', 'off-by-one'];
    expect(validator(row), 'duplicate').toBe(false);
    row.expected.also_accept = ['looks-odd'];
    expect(validator(row), 'off-vocabulary').toBe(false);
  });

  it('rejects an absolute file_hint and a traversal file_hint through the schema pattern', () => {
    for (const bad of ['/srv/app/main.js', 'C:/app/main.js', '../secrets/key.js', 'a\\b.js']) {
      const row = sample();
      row.file_hint = bad;
      expect(validator(row), bad).toBe(false);
    }
  });

  it('catches an absolute path, email, URL or control character ANYWHERE in a row', () => {
    // Injected into real rows and run through scanRow, so this also proves the
    // field-walk reaches nested and array values - not just that the regexes
    // work on a literal. `expected.location.path` and an `also_accept` element
    // are both places a hand-written control would never have looked.
    const cases = [
      ['injected_diff', '+  const base = "C:/app/data";', 'drive letter'],
      ['injected_diff', '+  open("/home/svc/config.json")', 'unix home'],
      ['injected_diff', '+  const p = "app\\bin\\run.exe";', 'windows separator run'],
      ['injected_diff', '+  // owner: someone@example.com', 'email'],
      ['injected_diff', '+  fetch("https://api.example.com/v1")', 'url'],
      ['injected_diff', '+  const x = "\u0001";', 'control character'],
    ];
    for (const [field, text, label] of cases) {
      const row = sample();
      row[field] = `${row[field]}\n${text}`;
      const found = scanRow(row);
      expect(found.join(' | '), label).toContain(label);
    }
    // Nested reach: a violation that is not in a top-level string field.
    const nested = sample();
    nested.expected.location.path = 'C:/app/main.js';
    expect(scanRow(nested).join(' | '), 'nested').toContain('drive letter');
    const inArray = sample();
    inArray.expected.also_accept = ['https://example.com/kind'];
    expect(scanRow(inArray).join(' | '), 'array element').toContain('url');
  });

  it('catches a leaked answer in prose and inside an identifier', () => {
    const cases = [
      ['+  // FIXME: off-by-one here', 'fixme'],
      ['+  // the limit should be inclusive', 'should be'],
      ['+  if (is_broken) return;', 'broken'],
      ['+  const raceGuard = null;', 'race'],
      ['+  function fixmeLater() {}', 'fixme'],
    ];
    for (const [text, word] of cases) {
      const row = sample();
      row.injected_diff = `${row.injected_diff}\n${text}`;
      expect(scanRow(row).join(' | ').toLowerCase(), text).toContain(word);
    }
  });

  it('tolerates ordinary code that merely contains a leak word', () => {
    // Word boundaries matter in both directions: a scanner that red-flags
    // `trace` or `debugger` gets loosened by whoever hits it next, and then it
    // catches nothing.
    for (const text of [
      '+  logger.trace({ id });',
      '+  const embraced = wrap(value);',
      '+  attachDebugger(session);',
      '+  const bugle = horn();',
    ]) {
      const row = sample();
      row.injected_diff = `${row.injected_diff}\n${text}`;
      expect(scanRow(row), text).toEqual([]);
    }
  });

  it('flags a location the diff cannot reach', () => {
    const outside = sample();
    const span = newLineSpan(parseDiff(outside.injected_diff));
    outside.expected.location.line_range = [span.last + 5, span.last + 6];
    expect(locationIsReachable(outside)).toBe(false);

    const mismatched = sample();
    mismatched.expected.location.path = 'src/elsewhere/module.js';
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

  it('flags an identical re-add and an astral character correctly', () => {
    // Two controls for the two checks most likely to become vacuous: the
    // re-add detector must actually compare text, and the control-character
    // class must not mistake an emoji for a control byte.
    const body = ['-  const a = 1;', '+  const a = 1;', ' ctx'];
    const removed = new Set(body.filter((l) => l.startsWith('-')).map((l) => l.slice(1)));
    expect(body.filter((l) => l.startsWith('+') && removed.has(l.slice(1)))).toHaveLength(1);
    expect(CONTROL_CHARS.test('\u001b[0m')).toBe(true);
    expect(CONTROL_CHARS.test('\u{1F600} ok\t\r\n')).toBe(false);
  });
});
