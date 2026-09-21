#!/usr/bin/env node
/**
 * Seeded-defect offline scorer - grades a reviewer's output against the corpus.
 *
 * WHY THIS EXISTS
 *
 * `tests/evals/fixtures/seeded-defect/corpus.jsonl` states, per row, exactly
 * one defect that was injected and exactly where it sits. That makes "did the
 * reviewer find it?" a decidable question - but only if something decides it
 * the same way twice. Before this file, any catch rate quoted for a reviewer
 * came from somebody reading a JSON blob and counting. This turns that count
 * into a program with a fixed denominator and a recorded corpus identity.
 *
 * WHAT THIS TOOL CANNOT SEE (read before quoting anything it prints)
 *
 *   1. It NEVER RUNS A REVIEWER. There is no model call, no network import and
 *      no clock read other than the single `measured_at` stamp. The input is a
 *      reviewer's already-written output; producing that file is somebody
 *      else's job, and this file cannot tell a real one from a hand-edited one.
 *   2. KIND IS A STRING COMPARE, over a SET the corpus row names. `caught`
 *      means the reviewer emitted a finding whose `kind` is the row's
 *      `expected.finding_kind` or one of its optional
 *      `expected.also_accept` alternatives - each compared byte for byte.
 *      There is no fuzzy matching, no stemming and no case folding: widening
 *      the set is the CORPUS's decision, made per row and visible in the
 *      fixture, never an inference this runner makes. A reviewer that names
 *      the right defect with a word the row does not list still scores zero,
 *      and that remains a vocabulary problem for an ADAPTER upstream of here.
 *      `also_accept` exists because the alternative was worse: a row whose
 *      defect has two accurate names used to charge a correct reviewer TWICE
 *      - a miss on `catch_rate` and a false positive on the same finding.
 *   3. SPRAYING KINDS BUYS NOTHING. Because a catch requires membership in the
 *      row's accepted set (item 2), a reviewer that emits every kind at every
 *      location catches everything - and every finding OUTSIDE that set is
 *      charged to `false_positive_rate`. That rate is the only penalty term
 *      this runner prints, so quoting `catch_rate` alone is quoting half the
 *      result. Note what "only penalty term" does not mean: it reaches
 *      out-of-set findings only, and item 3b is the hole that leaves.
 *   3b. SPRAYING AN ACCEPTED KIND IS UNPENALIZED, AND THAT IS A REAL GAP. The
 *      penalty in 3 reaches out-of-set findings only. A reviewer that reports
 *      an accepted kind on fifty lines of the file is not charged anything:
 *      those findings are in the set, so none of them is a false positive,
 *      and `location_accuracy` asks only whether ANY of them landed inside
 *      the range - so it scores 1.0. Precision within a kind is therefore
 *      UNMEASURED here, and a `location_accuracy` of 1.0 means "hit the spot
 *      at least once", never "pointed only at the spot". A metric that closes
 *      this (findings-per-row, or a location precision denominator over
 *      matched findings) is a CONTRACT CHANGE and deliberately not made here.
 *   4. NO SEVERITY, NO DESIGN AXIS. `severity` and `design_axis` are carried by
 *      the corpus and read by nothing here. Nothing is weighted.
 *   5. A ZERO DENOMINATOR IS `null`, NOT 0. A reviewer that emits no findings
 *      at all has an UNDEFINED false positive rate, not a perfect one. Every
 *      rate whose denominator is 0 is emitted as null for that reason, and a
 *      consumer that coerces null to 0 reintroduces the flattering wrong
 *      answer this refuses to print.
 *   6. `also_accept` IS NOT A DIFFICULTY SIGNAL. Rows carrying alternatives
 *      are easier to catch than rows that do not, and nothing here records
 *      how many rows carried them. Two corpora with the same 30 defects but
 *      different `also_accept` coverage produce different catch rates, so a
 *      catch rate is comparable only against the same `corpus_sha256`.
 *
 * DENOMINATORS, stated once so no caller has to infer them:
 *   catch_rate           = caught rows / ALL corpus rows. An id the input
 *                          omits is a MISS, never out of scope.
 *   location_accuracy    = located rows / CAUGHT rows.
 *   false_positive_rate  = findings whose kind is OUTSIDE the row's accepted
 *                          set / ALL findings in input.
 *
 * DETERMINISM. Scoring reads no clock and no randomness, and every count is an
 * integer divided once at the end, so input order - of entries, of findings, of
 * corpus rows - cannot change a printed rate. Two runs with the same
 * `--measured-at` are byte-identical; shuffling the corpus changes
 * `corpus_sha256` and nothing else.
 *
 * FAIL-CLOSED. Every input shape is checked against an ALLOWLIST of legal
 * shapes, not a list of known-bad ones, because a deny list is fail-open
 * against the next malformed file somebody writes. Any violation exits 1 with
 * one line on stderr and ZERO bytes on stdout - a partial result is worse than
 * none, since a truncated envelope still parses as JSON.
 *
 * That allowlist is over the TYPES OF THE KEYS SCORING READS, not a closed
 * object schema: UNKNOWN KEYS ARE ACCEPTED on entries and on findings. This is
 * deliberate - a real reviewer emits `message`, `severity`, `rule_id` and more
 * beside `kind`/`path`/`line`, and refusing those would make every caller
 * strip its own output before it could be scored. Full row conformance of the
 * CORPUS is a different question and belongs to
 * `tests/evals/seeded-defect-corpus.test.js` and its ajv schema.
 *
 * USAGE
 *   node scripts/bench/seeded-defect.mjs --input <reviewer.json>
 *                     [--corpus <file.jsonl>] [--measured-at <ISO>] [--help]
 *
 * @module scripts/bench/seeded-defect
 */

import { createHash } from 'node:crypto';
import { isMainEntry } from '../hooks/_main-entry.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CORPUS = path.join(
  PLUGIN_ROOT, 'tests', 'evals', 'fixtures', 'seeded-defect', 'corpus.jsonl',
);

/**
 * The defect classes, in the order `per_class` emits them. Fixed rather than
 * derived from the corpus so that two results files always carry the same
 * seven keys in the same order and stay byte-comparable - a corpus that
 * happens to contain no `concurrency` row must still report that as `n: 0`,
 * not omit the bucket and let a reader infer whatever they like.
 *
 * @type {readonly string[]}
 */
export const CORPUS_CLASSES = Object.freeze([
  'logic', 'boundary', 'concurrency', 'security', 'resource', 'contract', 'docs-drift',
]);

/**
 * ISO-8601 instants this accepts for `--measured-at`: a date, `T`, a time, and
 * an explicit zone. An allowlist, so `Date.parse` leniency (which happily
 * accepts `"yesterday"`-adjacent spellings on some runtimes, and silently
 * reinterprets zone-less strings as LOCAL time) cannot put an ambiguous stamp
 * in a results envelope.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Corpus ids, as the shared row contract spells them. */
const ROW_ID = /^SD-\d{3}$/;

/**
 * The errno of a failed read, never its message.
 *
 * Node's ENOENT message embeds the FULL path it tried to open, so quoting
 * `err.message` puts a user-profile absolute path on stderr - noise in a CI
 * log, an identifier in a ticket (it carries the account name), and
 * machine-specific in a place people compare across machines. The basename is
 * already in the caller's message; the code is the part that says what went
 * wrong.
 *
 * @param {unknown} err
 * @returns {string}
 */
function readErrorCode(err) {
  const code = err?.code;
  return typeof code === 'string' && code !== '' ? code : 'unreadable';
}

/** @param {unknown} v @returns {boolean} a non-empty string */
function isText(v) {
  return typeof v === 'string' && v !== '';
}

/** @param {unknown} v @returns {boolean} a plain object, not an array or null */
function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The reviewer's spelling of a path, reduced to the corpus's spelling.
 *
 * Exactly two rewrites: Windows separators to forward slashes, and a single
 * leading `./`. Both are the SAME path written differently, so neither can
 * make two different files compare equal. Nothing else is attempted - no
 * basename match, no suffix match, no case folding - because every one of
 * those turns "found the defect" into "mentioned a file with a similar name",
 * which is the measurement this runner exists to avoid.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeFindingPath(p) {
  return String(p).split('\\').join('/').replace(/^\.\//, '');
}

/**
 * Validate the optional `expected.also_accept` list.
 *
 * Present-but-empty is REFUSED along with the malformed shapes: an empty list
 * is indistinguishable in effect from omitting the field, so allowing both
 * spellings of "no alternatives" would let two corpora differ in bytes while
 * scoring identically - and a reader would reasonably wonder which one meant
 * something. Duplicates and the canonical kind are refused for the same
 * reason: neither changes the accepted SET, so their only effect is to make
 * the row look like it says more than it does.
 *
 * @param {unknown} also @param {string} canonical @param {string} where
 * @returns {void} throws on violation
 */
function validateAlsoAccept(also, canonical, where) {
  if (also === undefined) return;
  if (!Array.isArray(also) || also.length === 0) {
    throw new Error(`${where}: expected.also_accept must be a non-empty array when present`);
  }
  if (!also.every(isText)) {
    throw new Error(`${where}: expected.also_accept members must be non-empty strings`);
  }
  if (new Set(also).size !== also.length) {
    throw new Error(`${where}: expected.also_accept has a duplicate member`);
  }
  if (also.includes(canonical)) {
    throw new Error(
      `${where}: expected.also_accept must not repeat finding_kind ${JSON.stringify(canonical)}`,
    );
  }
}

/**
 * Every kind that counts as naming this row's defect: the canonical
 * `finding_kind` plus any `also_accept` alternatives.
 *
 * This widens a SET MEMBERSHIP test; it is not fuzzy matching. Each member is
 * still compared to `f.kind` by string equality, and a kind the corpus row
 * does not list is a false positive exactly as before.
 *
 * @param {object} row
 * @returns {Set<string>}
 */
function acceptedKinds(row) {
  return new Set([row.expected.finding_kind, ...(row.expected.also_accept ?? [])]);
}

/**
 * Validate one corpus row's scoring-relevant fields.
 *
 * Only `id`, `class` and `expected` are checked, because those are the only
 * fields scoring reads. The rest of the row contract (`language`, `severity`,
 * `injected_diff`, ...) is pinned by `tests/evals/seeded-defect-corpus.test.js`
 * against the shipped fixture; duplicating it here would put the schema in two
 * places and let them drift.
 *
 * @param {unknown} parsed @param {number} lineNo
 * @returns {object} the row
 */
function validateRow(parsed, lineNo) {
  const where = `corpus line ${lineNo}`;
  if (!isRecord(parsed)) throw new Error(`${where}: not a JSON object`);
  if (!isText(parsed.id) || !ROW_ID.test(parsed.id)) {
    throw new Error(`${where}: id must match SD-NNN, got ${JSON.stringify(parsed.id)}`);
  }
  if (!CORPUS_CLASSES.includes(parsed.class)) {
    throw new Error(`${where}: unknown class ${JSON.stringify(parsed.class)}`);
  }
  const expected = parsed.expected;
  const location = isRecord(expected) ? expected.location : undefined;
  if (!isRecord(expected) || !isText(expected.finding_kind) || !isRecord(location)) {
    throw new Error(`${where}: expected.finding_kind and expected.location are required`);
  }
  const range = location.line_range;
  const legalRange = Array.isArray(range) && range.length === 2
    && range.every(Number.isInteger) && range[0] >= 1 && range[0] <= range[1];
  if (!isText(location.path) || !legalRange) {
    throw new Error(`${where}: location.path and an ascending 1-based line_range are required`);
  }
  // The path comparison normalizes the FINDING side only, so a corpus path
  // spelled `./lib/a.js` or `lib\a.js` could never be matched by any reviewer
  // output: the row would score a permanent location miss with nothing
  // anywhere reporting why. Refused at load instead. Zero of the 30 shipped
  // rows are spelled that way (measured 2026-09-21), so this changes no
  // current result - it closes the shape before it can be written.
  if (location.path !== normalizeFindingPath(location.path)) {
    throw new Error(
      `${where}: location.path must be POSIX with no leading "./", got `
      + `${JSON.stringify(location.path)}`,
    );
  }
  validateAlsoAccept(expected.also_accept, expected.finding_kind, where);
  return parsed;
}

/**
 * Parse corpus JSONL text into validated rows.
 *
 * A malformed line aborts the whole run rather than being skipped: skipping
 * one would shrink the denominator of every rate printed, which raises the
 * reported catch rate. Blank lines are ignored and `\r` is stripped so a CRLF
 * checkout parses identically to an LF one.
 *
 * @param {string} text
 * @returns {object[]} rows, in file order
 */
export function parseCorpus(text) {
  const lines = String(text ?? '').split('\n');
  const rows = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '').trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`corpus line ${index + 1}: invalid JSON (${err.message})`, { cause: err });
    }
    const row = validateRow(parsed, index + 1);
    if (seen.has(row.id)) throw new Error(`corpus line ${index + 1}: duplicate id ${row.id}`);
    seen.add(row.id);
    rows.push(row);
  }
  if (rows.length === 0) throw new Error('corpus is empty: no rows to score against');
  return rows;
}

/**
 * Read a corpus file and return its rows plus the identity hash.
 *
 * The hash is taken over the file's text with CRLF normalized to LF, NOT over
 * its raw bytes. This repository checks out with `core.autocrlf=true`
 * (`git ls-files --eol` reports `i/lf w/crlf`), so a raw-byte hash of the same
 * committed corpus differs between a Windows and a Linux checkout and two
 * honest results files would look incomparable.
 *
 * @param {string} file
 * @returns {{rows: object[], sha256: string}}
 */
export function readCorpus(file) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`cannot read corpus ${path.basename(file)}: ${readErrorCode(err)}`,
      { cause: err });
  }
  const normalized = text.split('\r\n').join('\n');
  return {
    rows: parseCorpus(normalized),
    sha256: createHash('sha256').update(normalized, 'utf-8').digest('hex'),
  };
}

/**
 * Validate one reviewer finding.
 *
 * @param {unknown} finding @param {string} id @param {number} index
 * @returns {{kind: string, path: string, line: number}}
 */
function validateFinding(finding, id, index) {
  const where = `entry ${id} finding ${index}`;
  if (!isRecord(finding)) throw new Error(`${where}: not a JSON object`);
  if (!isText(finding.kind)) throw new Error(`${where}: kind must be a non-empty string`);
  if (!isText(finding.path)) throw new Error(`${where}: path must be a non-empty string`);
  // `>= 1`, not merely an integer. Line numbers are 1-based, so 0 and negatives
  // cannot be inside ANY line_range: they used to validate and then quietly
  // lower location_accuracy, reporting a malformed input as an inaccurate
  // reviewer. Unknown keys alongside these three are accepted on purpose - see
  // the FAIL-CLOSED note in the module header.
  if (!Number.isInteger(finding.line) || finding.line < 1) {
    throw new Error(`${where}: line must be an integer >= 1`);
  }
  return finding;
}

/**
 * Index a reviewer output array by corpus id, validating every shape.
 *
 * An id the corpus does not contain is REFUSED rather than ignored: it means
 * the input was produced against a different corpus than the one being scored,
 * and silently dropping it would print rates for a comparison nobody made.
 *
 * @param {unknown} reviewerOutput @param {Map<string, object>} byId
 * @returns {Map<string, object[]>} id -> validated findings
 */
function indexReviewerOutput(reviewerOutput, byId) {
  if (!Array.isArray(reviewerOutput)) throw new Error('reviewer output must be a JSON array');
  const found = new Map();
  for (const entry of reviewerOutput) {
    if (!isRecord(entry)) throw new Error('reviewer entry: not a JSON object');
    if (!isText(entry.id)) throw new Error('reviewer entry: id must be a non-empty string');
    if (!byId.has(entry.id)) throw new Error(`reviewer entry ${entry.id}: not a corpus id`);
    if (found.has(entry.id)) throw new Error(`reviewer entry ${entry.id}: duplicate id`);
    if (!Array.isArray(entry.findings)) {
      throw new Error(`reviewer entry ${entry.id}: findings must be an array`);
    }
    found.set(entry.id, entry.findings.map((f, i) => validateFinding(f, entry.id, i)));
  }
  return found;
}

/**
 * Grade one corpus row against the findings reported for it.
 *
 * @param {object} row @param {object[]} findings
 * @returns {{caught: boolean, located: boolean, matched: number}} `matched` is
 *   the count of kind-matching findings, used to derive the false positive
 *   numerator by subtraction.
 */
function gradeRow(row, findings) {
  const { location } = row.expected;
  // Membership in the ACCEPTED SET, not equality with one string - see
  // `acceptedKinds`. `caught`, `located` and the false-positive numerator all
  // read the same set, so a row's alternatives cannot widen one of the three
  // without widening the other two.
  const accepted = acceptedKinds(row);
  const matched = findings.filter((f) => accepted.has(f.kind));
  const [start, end] = location.line_range;
  const located = matched.some((f) => normalizeFindingPath(f.path) === location.path
    && f.line >= start && f.line <= end);
  return { caught: matched.length > 0, located, matched: matched.length };
}

/** @returns {number|null} a/b, or null when b is 0 */
function ratio(a, b) {
  return b === 0 ? null : a / b;
}

/**
 * Score a reviewer output against a corpus. Pure: no clock, no filesystem.
 *
 * @param {object[]} corpus - validated rows from {@link parseCorpus}
 * @param {unknown} reviewerOutput - the parsed `--input` array
 * @returns {{n: number, catch_rate: number|null, false_positive_rate: number|null,
 *   location_accuracy: number|null, per_class: Record<string, object>}}
 */
export function scoreFindings(corpus, reviewerOutput) {
  const byId = new Map(corpus.map((row) => [row.id, row]));
  const reported = indexReviewerOutput(reviewerOutput, byId);

  const tally = new Map(CORPUS_CLASSES.map((cls) => [cls, { n: 0, caught: 0, located: 0 }]));
  let caught = 0;
  let located = 0;
  let findings = 0;
  let matched = 0;

  for (const row of corpus) {
    const rowFindings = reported.get(row.id) ?? [];
    const graded = gradeRow(row, rowFindings);
    findings += rowFindings.length;
    matched += graded.matched;
    caught += graded.caught ? 1 : 0;
    located += graded.located ? 1 : 0;
    const bucket = tally.get(row.class);
    bucket.n += 1;
    bucket.caught += graded.caught ? 1 : 0;
    bucket.located += graded.located ? 1 : 0;
  }

  const perClass = {};
  for (const cls of CORPUS_CLASSES) {
    const bucket = tally.get(cls);
    perClass[cls] = {
      n: bucket.n,
      caught: bucket.caught,
      catch_rate: ratio(bucket.caught, bucket.n),
      location_accuracy: ratio(bucket.located, bucket.caught),
    };
  }

  return {
    n: corpus.length,
    catch_rate: ratio(caught, corpus.length),
    false_positive_rate: ratio(findings - matched, findings),
    location_accuracy: ratio(located, caught),
    per_class: perClass,
  };
}

/**
 * Read and parse the reviewer output file.
 *
 * @param {string} file
 * @returns {unknown} parsed JSON, shape-checked later by {@link scoreFindings}
 */
function readReviewerOutput(file) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`cannot read input ${path.basename(file)}: ${readErrorCode(err)}`,
      { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`input ${path.basename(file)} is not valid JSON: ${err.message}`,
      { cause: err });
  }
}

/**
 * Build the result envelope. Key insertion order IS the output contract.
 *
 * @param {object} opts - { input, corpus, measuredAt }
 * @returns {object}
 */
export function runSeededDefect(opts) {
  const { rows, sha256 } = readCorpus(opts.corpus ?? DEFAULT_CORPUS);
  const scored = scoreFindings(rows, readReviewerOutput(opts.input));
  return {
    n: scored.n,
    catch_rate: scored.catch_rate,
    false_positive_rate: scored.false_positive_rate,
    location_accuracy: scored.location_accuracy,
    per_class: scored.per_class,
    corpus_sha256: sha256,
    measured_at: opts.measuredAt ?? new Date().toISOString(),
  };
}

/**
 * Parse CLI arguments. An unrecognized argument aborts rather than being
 * ignored, so a typo cannot quietly score the default corpus instead.
 *
 * @param {string[]} argv - arguments after the script path
 * @returns {{input: string|null, corpus: string, measuredAt: string|null, help: boolean}}
 */
export function parseArgs(argv) {
  const opts = { input: null, corpus: DEFAULT_CORPUS, measuredAt: null, help: false };
  // Repeating a flag is refused rather than resolved last-wins: `--input good
  // --input bad` scoring `bad` is a wrong number with no symptom anywhere.
  const seen = new Set();
  const once = (flag) => {
    if (seen.has(flag)) throw new Error(`argument "${flag}" given more than once`);
    seen.add(flag);
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input') { once(arg); opts.input = next; index += 2; continue; }
    if (arg === '--corpus') { once(arg); opts.corpus = next; index += 2; continue; }
    if (arg === '--measured-at') { once(arg); opts.measuredAt = next; index += 2; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; index += 1; continue; }
    throw new Error(`unrecognized argument "${arg}" (try --help)`);
  }
  if (opts.help) return opts;
  if (!isText(opts.input)) throw new Error('--input <reviewer.json> is required');
  if (!isText(opts.corpus)) throw new Error('--corpus needs a file path');
  if (opts.measuredAt !== null
    && (!isText(opts.measuredAt) || !ISO_INSTANT.test(opts.measuredAt)
      || Number.isNaN(Date.parse(opts.measuredAt)))) {
    throw new Error(`--measured-at must be an ISO-8601 instant, got "${opts.measuredAt}"`);
  }
  return opts;
}

/** Print usage. @returns {void} */
function printUsage() {
  console.log([
    'Usage: node scripts/bench/seeded-defect.mjs --input <reviewer.json> [options]',
    '',
    'Scores a reviewer output against the seeded-defect corpus. Offline: no',
    'reviewer is run and no model is called.',
    '',
    'Options:',
    '  --input <f>        REQUIRED. JSON array of {id, findings:[{kind,path,line}]}.',
    '  --corpus <f>       corpus JSONL (default: the shipped fixture).',
    '  --measured-at <t>  ISO-8601 instant for the envelope (default: now).',
    '  --help             this text.',
    '',
    'Prints one line of JSON on stdout: n, catch_rate, false_positive_rate,',
    'location_accuracy, per_class, corpus_sha256, measured_at. A rate whose',
    'denominator is 0 is null, never 0.',
    '',
    'Exit codes: 0 scored, 1 any unreadable or malformed input (stdout stays',
    'empty - a partial envelope would still parse as JSON).',
  ].join('\n'));
}

/** Entry point. @returns {number} process exit code */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  // Built in full BEFORE anything reaches stdout, so a refusal writes 0 bytes.
  console.log(JSON.stringify(runSeededDefect(opts)));
  return 0;
}

/**
 * One refusal is ONE line on stderr.
 *
 * Not cosmetic. V8's `JSON.parse` error quotes the offending SOURCE, so a
 * malformed input spanning four lines produced a four-line refusal (measured
 * 2026-09-21), and a log reader counting refusals by line would have read one
 * failure as four. Clamped at the single exit point rather than at each throw
 * site, so a message added later cannot reintroduce it.
 *
 * @param {unknown} err
 * @returns {string} the first line of the message
 */
function refusalLine(err) {
  const message = typeof err?.message === 'string' ? err.message : String(err);
  return message.split('\n')[0].trim();
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`[seeded-defect] ${refusalLine(err)}`);
    process.exitCode = 1;
  }
}
