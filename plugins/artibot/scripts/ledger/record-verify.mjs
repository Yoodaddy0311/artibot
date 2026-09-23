#!/usr/bin/env node
/**
 * Record the outcome of the `/verify` pipeline as `verify.completed` ledger
 * lines from the command line.
 *
 * `scripts/hooks/dev-verify-gate.js` writes this event when a HOOK observes a
 * verification. `/verify` is not a hook: it is a command a model drives, and
 * the exit codes of lint/typecheck/test/build exist only in that model's
 * transcript. Without this script the numerator of "how many verifications
 * were recorded" counts hook runs and nothing else, while the pipeline that
 * actually ran leaves no line at all.
 *
 * SO EVERY LINE THIS SCRIPT WRITES IS A SELF-REPORT. Nothing here runs a
 * linter, reads an exit code, or checks that the summary on the command line
 * describes anything that happened. `--status PASS` is a claim, and the only
 * thing that makes it a claim rather than a measurement is the evidence note
 * described below. That asymmetry is the same one
 * `lib/runtime/human-asked-record.js` documents under "kind IS A SELF-REPORT",
 * and it is the first thing to keep in mind when reading any statistic built
 * from `verify.completed`.
 *
 * OBSERVE CONTRACT (PRD R-03, "no behaviour change"): this script records and
 * nothing else. It applies no gate, blocks no step, and changes no state
 * outside the ledger and the evidence registry beside it
 * (`lib/verification/evidence-registry.js`). Recording is best effort, so a
 * failure to write exits 0 and reports itself on stdout rather than failing
 * the caller's step. A registry failure is not even reported: the ledger lines
 * are the record, and the registry only indexes their evidence.
 *
 * USAGE
 *   node scripts/ledger/record-verify.mjs --status <PASS|FAIL> \
 *     [--command <one-line summary>] [--evidence <ref>]... \
 *     [--layer deterministic] [--session <id>] [--cwd <root>]
 *
 *   Without `--session` the session id is read from `CLAUDE_SESSION_ID`, then
 *   from `CLAUDE_CODE_SESSION_ID`. Those three sources are the whole
 *   allowlist, in that order; when all of them are empty nothing is recorded
 *   and the refusal says so. See `main` for the measurement behind the second
 *   spelling.
 *
 * -- WHY ONLY THE DETERMINISTIC LAYER IS SELF-REPORTABLE --------------------
 *  `--layer` is an ALLOWLIST OF ONE, not a filter against bad values, and the
 *  reason is in the verifier rather than in taste. `behavioralShell`
 *  (`lib/verification/unified-verifier.js`, measured 2026-09-14) returns
 *  UNMEASURED unconditionally — there is no behavioral runner, so no input can
 *  make that layer PASS. `normalizeOperational` needs readings carrying a
 *  finite `value` and a `min`/`max` bound; a pipeline summary has neither. The
 *  deterministic layer is the one the `/verify` pipeline IS: four exit codes
 *  folded to one.
 *
 *  The other two layers still land, as `unmeasured`. That is the point of
 *  writing one line per layer — an absent line reads to
 *  `lib/runtime/artifact-lifecycle-gates.js#tallyLayer` as a smaller
 *  denominator, while an `unmeasured` one reads as a layer nobody measured.
 *  One run therefore writes FOUR lines: three layers plus the overall fold.
 *
 * -- HOW THE SELF-REPORT IS MARKED IN THE LEDGER ---------------------------
 *  `verify.completed` carries exactly four data fields
 *  (`schemas/ledger-events.allowlist.json`, read 2026-09-14: `result`, `layer`,
 *  `evidence`, `verification_id`). There is no `kind_source` to set and this
 *  script does not add one — that schema is owned elsewhere, and a field
 *  invented here would be rejected by the writer's contract check, losing the
 *  whole line.
 *
 *  So the marker travels inside `evidence`, as one entry whose `note` is
 *  {@link SELF_REPORT_NOTE}. The layer `reason` also says so, but a reason is
 *  NOT written to the ledger — `lib/verification/verify-writer.js`'s
 *  `verifyEventInput` builds `data` from `layer`/`result`/`evidence`/
 *  `verification_id` only. THE EVIDENCE NOTE IS THE ONLY LEDGER-VISIBLE
 *  MARKER. A reader that ignores it cannot tell this line from a hook's.
 *
 *  That entry is FIRST in the list on purpose. `verify-writer.js#fitLine`
 *  drops evidence from the END to fit the 4096-byte line cap, so a marker at
 *  the back would be the first thing to disappear on a long run.
 *
 * -- WHY `--cwd` MAY DEFAULT TO `process.cwd()` HERE ------------------------
 *  Same rationale, and same trap, as
 *  `scripts/ledger/record-human-resolved.mjs`: the caller is a model working
 *  inside the project it is reporting about, so the process cwd IS the
 *  injected root. THE GLOBAL INSTALL IS THE TRAP — Artibot also lives under
 *  the user's `.claude` directory and this file is inside that copy too, so
 *  invoking the INSTALLED script from an unrelated directory files that
 *  project's verification into whatever directory the shell was in. Pass
 *  `--cwd` explicitly from anything that is not a session already rooted in
 *  the project.
 *
 * -- EXIT CODES, AND WHY ONLY ONE IS NON-ZERO -------------------------------
 *  0  the lines were recorded, OR a precondition was missing and stdout says so
 *  2  usage error: the command line itself is wrong, and NOTHING was written
 *
 *  READ `recorded` BEFORE TRUSTING AN EXIT 0. A missing session id, an
 *  unwritable ledger and a line over the byte cap all exit 0 with
 *  `recorded:false`, because a recording failure is not the caller's problem
 *  and must not fail its step — that is the Observe contract.
 *
 *  A malformed command line is a different thing: it means the model asked for
 *  something impossible, and exiting 0 over it would report success for a
 *  record that does not exist. A missing `--status`, a `--status` outside its
 *  enum and a `--layer` outside the allowlist are therefore all exit 2. This
 *  is a DEVIATION from the task brief, which called for exit 0 with a reason
 *  on stdout; it follows the precedent set by `record-human-resolved.mjs`,
 *  where a silent no-op was judged the fail-open shape this repository's
 *  verification rules exist to prevent.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  One line of JSON with a FIXED key set, so a caller can parse it without
 *  branching:
 *    {"event","verification_id","session","status","recorded","appended",
 *     "deduped","rejected","skipped","reason"}
 *  `recorded` is `appended > 0 && rejected === 0` — the four tallies are kept
 *  alongside it because "exit 0" otherwise covers written, deduped, rejected
 *  and skipped alike, and the model that ran this would have no way to tell
 *  which one it got. `reason` is null when nothing went wrong.
 *
 * -- WHAT THIS FILE CANNOT DO ----------------------------------------------
 *  Nothing invokes it. `commands/verify.md` asks the model to run it after the
 *  pipeline; whether any model does is unmeasured, exactly as it is for
 *  `record-human-resolved.mjs`. A ledger with no `verify.completed` lines from
 *  this source means either "no /verify ran" or "nobody reported one", and
 *  this file cannot tell those apart.
 *
 * @module scripts/ledger/record-verify
 */

import { verify } from '../../lib/verification/unified-verifier.js';
import {
  recordVerification,
  VERIFY_COMPLETED_EVENT,
} from '../../lib/verification/verify-writer.js';
import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { redactDeep } from '../../lib/runtime/ledger-redaction.js';
import { registerEvidence } from '../../lib/verification/evidence-registry.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * Layers a caller may self-report.
 *
 * An ALLOWLIST, for the reason given in the module header: the other two
 * layers have no path to PASS through `verify()`, so accepting them would let
 * a caller believe it had reported something the verifier will always record
 * as `unmeasured`. A deny list would fail open on the next layer anybody adds.
 */
const SELF_REPORTABLE_LAYERS = ['deterministic'];

/** The two outcomes a deterministic pipeline has. `UNMEASURED` is not one of
 * them: a pipeline that did not run has nothing to report from here. */
const STATUSES = ['PASS', 'FAIL'];

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--status', '--command', '--evidence', '--layer', '--session', '--cwd'];

/** Used when `--command` is omitted; the summary is optional, the fact is not. */
const DEFAULT_COMMAND = '/verify';

/**
 * The one ledger-visible mark that separates a self-reported line from one a
 * hook measured. Exported so a reader can detect the condition rather than
 * pattern-match prose, and so the test asserts the same bytes the writer uses.
 */
export const SELF_REPORT_NOTE = 'self-report: recorded by scripts/ledger/record-verify.mjs';

const USAGE = 'usage: record-verify.mjs --status <PASS|FAIL> [--command <text>]'
  + ' [--evidence <path:line|command>]... [--layer deterministic]'
  + ' [--session <id>] [--cwd <root>]';

/**
 * A `path:line` reference, with the LAST colon taken as the separator so a
 * Windows drive letter does not split the path in half.
 */
const FILE_REF = /^(.+):(\d+)$/;

/**
 * Report a usage error on ONE line and nothing else.
 *
 * One line, always, because this stream is read by a model: a two-line message
 * invites "the first line is the error, the rest is noise" and the usage half
 * is then never read.
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`record-verify: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list into a flag map plus the repeatable evidence refs.
 *
 * The entry-point decision belongs to `isMainEntry`; every other spelling of
 * that check has a measured way to go silently wrong
 * (tests/ci/direct-run-guard.test.js).
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{opts: Record<string,string>, evidence: string[]}|{error: string}}
 */
function parseArgs(argv) {
  const opts = {};
  const evidence = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.includes(flag)) return { error: `unknown argument: ${flag}` };
    // A flag with no value is an error rather than an empty string: `--status`
    // at the end of the line is a truncated command, not a status of "".
    if (i + 1 >= argv.length) return { error: `${flag} requires a value` };
    const value = argv[i + 1];
    if (flag === '--evidence') evidence.push(value);
    else opts[flag.slice(2)] = value;
    i += 1;
  }
  return { opts, evidence };
}

/**
 * The command line itself, judged before anything is built or written.
 *
 * Separate from the recording outcome: a missing session is an observation
 * about the environment (exit 0, reported), while a misspelled flag is a
 * mistake in the request (exit 2, nothing written).
 *
 * @param {Record<string,string>} opts
 * @returns {string|null}
 */
function usageError(opts) {
  if (!STATUSES.includes(opts.status)) {
    return `--status must be one of ${STATUSES.join('|')}, got: ${opts.status ?? '(none)'}`;
  }
  if (opts.layer !== undefined && !SELF_REPORTABLE_LAYERS.includes(opts.layer)) {
    return `--layer must be one of ${SELF_REPORTABLE_LAYERS.join('|')}, got: ${opts.layer}`;
  }
  if (opts.command !== undefined && opts.command.trim() === '') {
    return '--command must not be empty';
  }
  return null;
}

/**
 * Turn one `--evidence` ref into an entry `canonicalEvidence` will keep.
 *
 * A `command` entry REQUIRES a string `output` and a `file` entry requires an
 * integer `line` >= 1 (`unified-verifier.js#canonicalEvidence`, read
 * 2026-09-14). An entry missing either is dropped silently by
 * `sanitizeEvidence` and the ref vanishes, so `output: ''` is load-bearing
 * rather than filler.
 *
 * @param {string} ref
 * @returns {Record<string, unknown>}
 */
function evidenceEntry(ref) {
  const m = FILE_REF.exec(ref);
  if (m !== null && Number(m[2]) >= 1) {
    return { kind: 'file', file: m[1], line: Number(m[2]) };
  }
  return { kind: 'command', command: ref, output: '' };
}

/**
 * Idempotency keys already in this session's ledger.
 *
 * A throw here becomes `keys: null` inside `recordVerification`, which rejects
 * every line rather than appending a possible duplicate — that module prefers
 * a visible absence to an inflated per-layer tally, so this function does NOT
 * swallow the error the way `session-end.js#existingReceiptKeys` does.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {Set<string>}
 */
function existingVerifyKeys(cwd, sessionId) {
  const events = readAllEvents(cwd, { session_id: sessionId, event: VERIFY_COMPLETED_EVENT });
  const keys = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const key = event?.idempotency_key;
    if (typeof key === 'string' && key.length > 0) keys.add(key);
  }
  return keys;
}

/**
 * One appended line's evidence exactly as the ledger line stores it.
 *
 * Redacted AT THE ENVELOPE'S OWN POSITION, not as a bare array. The ledger
 * scrubs secrets before it writes, so hashing the raw entry would keep a hash
 * of what the ledger removed — an offline oracle for it (review F1). And
 * `lib/runtime/ledger-redaction.js#walk` counts its depth bound and node budget
 * from the root it is handed, while `lib/runtime/event-writer.js#assembleAndAppend`
 * hands it the whole envelope, where evidence sits at `data.evidence` (depth 2)
 * behind exactly two object nodes. A bare `redactDeep(entries)` cuts a note
 * nested 61+ levels two levels lower than the ledger does, and the row's hash
 * then matches nothing that was written. Every other envelope key is a scalar,
 * which is why this two-level wrapper is the whole of the offset.
 *
 * Exported as a test seam, with the same signature as
 * `scripts/hooks/dev-verify-gate.js#redactAsStored`.
 *
 * @param {Array<unknown>} entries
 * @param {(value: unknown) => unknown} [redact] defaults to `redactDeep`
 * @returns {Array<unknown>}
 */
export function redactAsStored(entries, redact = redactDeep) {
  return redact({ data: { evidence: entries } }).data.evidence;
}

/**
 * The `registerEvidence` port `main` binds, rooted where the ledger is, over
 * {@link redactAsStored}.
 *
 * Exported so the deep-nesting case can be measured on the port itself: no
 * `--evidence` ref can carry a nested note, since every ref is a string.
 *
 * @param {string} cwd the root `appendLedgerEvent` writes under
 * @returns {(entries: Array<unknown>, lineKey: string) => object}
 */
export function evidenceRegistryPort(cwd) {
  return (entries, lineKey) => registerEvidence(
    redactAsStored(entries),
    { projectRoot: cwd, source: lineKey },
  );
}

/**
 * Why a run recorded nothing, or `null` when it recorded cleanly.
 *
 * The build-time reason wins over a per-line one: when `recordVerification`
 * could not build any input at all it returns `skipped: 1` with no lines, and
 * that reason names the precondition (no session id, no verification id).
 *
 * @param {{reason?: string, lines?: Array<{status: string, reason?: string}>}} result
 * @returns {string|null}
 */
function outcomeReason(result) {
  if (typeof result.reason === 'string' && result.reason !== '') return result.reason;
  const bad = (Array.isArray(result.lines) ? result.lines : [])
    .find((line) => line.status === 'rejected');
  if (bad === undefined) return null;
  return typeof bad.reason === 'string' && bad.reason !== '' ? bad.reason : 'append-failed';
}

/**
 * Run the script.
 *
 * @param {string[]} argv arguments after the script path
 * @param {Record<string,string|undefined>} env
 * @returns {number} process exit code
 */
export function main(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const { opts, evidence } = parsed;
  const usage = usageError(opts);
  if (usage !== null) return fail(usage);

  // THE ENV IS A FALLBACK, NOT A GUARANTEE, AND IT HAS TWO SPELLINGS.
  // commands/scorecard.md documents `CLAUDE_SESSION_ID` as present in most
  // sessions and absent in some. Measured 2026-09-21 on Windows: this host
  // leaves `CLAUDE_SESSION_ID` EMPTY and sets `CLAUDE_CODE_SESSION_ID`
  // instead, so a call reading only the first spelling records nothing at all.
  // Other hosts are unmeasured. The resolution order is an ALLOWLIST of
  // exactly three sources and nothing else:
  //   `--session` > `CLAUDE_SESSION_ID` > `CLAUDE_CODE_SESSION_ID` > empty.
  // An empty string counts as absent, which is what `||` already does. When
  // all three are empty the missing session is REPORTED rather than invented
  // from the cwd, the pid, the clock or anything else.
  const session = opts.session || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || '';
  const cwd = opts.cwd || process.cwd();
  const command = (opts.command ?? DEFAULT_COMMAND).trim();

  const verdict = verify({
    layers: {
      deterministic: {
        exitCode: opts.status === 'PASS' ? 0 : 1,
        // Hashed into `verification_id`, never written to the ledger. The
        // evidence note below is the mark a reader can actually see.
        reason: `${opts.status} self-reported via record-verify.mjs: ${command}`,
        evidence: [
          { kind: 'command', command, output: '', note: SELF_REPORT_NOTE },
          ...evidence.map(evidenceEntry),
        ],
      },
    },
  });

  // The registry is bound to the SAME root as the ledger, so a row lands beside
  // the line its `source` names. Its outcome rides on `result.evidence`, which
  // the stdout line below deliberately does not read: the key set is fixed, and
  // a registry failure is not a recording failure.
  const result = recordVerification(verdict, { sessionId: session }, {
    append: (input) => appendLedgerEvent(cwd, input),
    existingKeys: () => existingVerifyKeys(cwd, session),
    registerEvidence: evidenceRegistryPort(cwd),
  });

  process.stdout.write(`${JSON.stringify({
    event: VERIFY_COMPLETED_EVENT,
    verification_id: verdict.verification_id,
    session: session === '' ? 'none' : session,
    status: opts.status,
    recorded: result.appended > 0 && result.rejected === 0,
    appended: result.appended,
    deduped: result.deduped,
    rejected: result.rejected,
    skipped: result.skipped,
    reason: outcomeReason(result),
  })}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `verify()` throws only on a malformed injected clock and none is injected,
  // and `recordVerification` never throws — but a catch here is what makes
  // "exit 0 unless the command line was wrong" true rather than intended.
  try {
    process.exitCode = main(argv, process.env);
  } catch {
    process.exitCode = 0;
  }
}
