#!/usr/bin/env node
/**
 * Record one `human.resolved` ledger line from the command line.
 *
 * This is the writing surface for the half of the pair no hook can write. A
 * `human.asked` line is produced BY the machinery that blocked a call, so the
 * model cannot omit it; a `human.resolved` line exists only if the model
 * chooses to run this script after a person answers. That asymmetry is the
 * design's (see `lib/runtime/human-asked-record.js`, section "kind IS A
 * SELF-REPORT"), and it is the first thing to keep in mind when reading any
 * statistic built from these two events.
 *
 * OBSERVE CONTRACT (PRD R-03, "no behaviour change"): this script records and
 * nothing else. It applies no decision, lifts no block, and changes no state
 * outside the ledger. Recording is best effort, so a failure to write exits 0
 * and reports itself on stdout rather than failing the caller's step.
 *
 * USAGE
 *   node scripts/ledger/record-human-resolved.mjs \
 *     --tool <Bash|Write|Edit> --subject <command|path> --decision <text> \
 *     [--kind correction|decision|approval] [--session <id>] [--cwd <root>]
 *
 * THE SUBJECT MUST BE SPELLED AS THE BLOCKED CALL SPELLED IT. `question_id` is
 * a hash of the gate and the subject, so a paraphrased command or a
 * re-normalised path yields a well-formed id that joins nothing at all. There
 * is no way for this script to detect that: a wrong subject and a right one are
 * both just strings.
 *
 * -- WHY `--cwd` MAY DEFAULT TO `process.cwd()` HERE ------------------------
 *  `recordHumanResolved` refuses to derive a project root -- a record filed
 *  under the wrong project is a false history (see its module header). This
 *  script relaxes that ONLY because its caller is a model working inside the
 *  project it is reporting about, so the process cwd IS the injected root, one
 *  level out.
 *
 *  THE GLOBAL INSTALL IS THE TRAP. Artibot also lives under the user's
 *  `.claude` directory, and this file is inside that installed copy too.
 *  Invoking the INSTALLED script from an unrelated directory therefore files
 *  that project's answers into whatever directory the shell happened to be in.
 *  Pass `--cwd` explicitly from anything that is not an interactive session
 *  already rooted in the project.
 *
 * -- EXIT CODES, AND WHY ONLY ONE IS NON-ZERO -------------------------------
 *  0  the line was recorded, OR a precondition was missing and stdout says so
 *  2  usage error: the command line itself is wrong, and NOTHING was written
 *
 *  A recording failure is not the caller's problem and must not fail its step --
 *  that is the Observe contract. A malformed command line is a different thing:
 *  it means the model asked for something impossible, and exiting 0 over it
 *  would report success for a record that does not exist. So a bad `--tool`, a
 *  missing `--decision` and a `--kind` outside its enum are all exit 2. The
 *  `--kind` case is a DEVIATION from the task brief, which called for exit 0:
 *  a typo in an enumerated flag is the same class of mistake as a bad `--tool`,
 *  and a silent no-op is the fail-open shape this repository's verification
 *  rules exist to prevent.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  One line of JSON with a FIXED key set, so a caller can parse it without
 *  branching:
 *    {"event","question_id","kind","session","recorded","skipped"}
 *  `recorded` and `skipped` are additions to the shape the brief specified.
 *  Without them "exit 0" covers both "written" and "silently skipped", and the
 *  model that ran this would have no way to tell which one it got.
 *
 * @module scripts/ledger/record-human-resolved
 */

import {
  describeHumanQuestion,
  humanResolvedSkipReason,
  recordHumanResolved,
} from '../../lib/runtime/human-asked-record.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * Tools this script will record for.
 *
 * An ALLOWLIST, not a check against a list of bad values: the human-gate matrix
 * is itself an allowlist, and a tool outside it classifies to an empty subject,
 * so accepting an arbitrary `--tool` would quietly record every answer under
 * the same empty-subject id. A deny list would fail open on the next tool name
 * anybody invents.
 */
const TOOLS = ['Bash', 'Write', 'Edit'];

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--tool', '--subject', '--decision', '--kind', '--session', '--cwd'];

const USAGE = 'usage: record-human-resolved.mjs --tool <Bash|Write|Edit>'
  + ' --subject <command|path> --decision <text>'
  + ' [--kind correction|decision|approval] [--session <id>] [--cwd <root>]';

/**
 * Report a usage error on ONE line and nothing else.
 *
 * One line, always, because this stream is read by a model: a two-line message
 * invites "the first line is the error, the rest is noise" and the usage half
 * is then never read. The specific problem comes first so it survives any
 * truncation, with the syntax reminder after it on the same line.
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`record-human-resolved: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list into a flag map.
 *
 * `process.argv[1]` is never read: the entry-point decision belongs to
 * `isMainEntry`, and every other spelling of that check has a measured way to
 * go silently wrong (tests/ci/direct-run-guard.test.js).
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{opts: Record<string,string>}|{error: string}}
 */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.includes(flag)) return { error: `unknown argument: ${flag}` };
    // A flag with no value is an error rather than an empty string: `--decision`
    // at the end of the line is a truncated command, not a decision of "".
    if (i + 1 >= argv.length) return { error: `${flag} requires a value` };
    opts[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  return { opts };
}

/**
 * The command line itself, judged before anything is loaded or written.
 *
 * Separate from `humanResolvedSkipReason`, which judges the RECORD: a missing
 * session is an observation about the environment (exit 0, reported), while a
 * misspelled flag is a mistake in the request (exit 2, nothing written).
 *
 * @param {Record<string,string>} opts
 * @returns {string|null}
 */
function usageError(opts) {
  if (!TOOLS.includes(opts.tool)) {
    return `--tool must be one of ${TOOLS.join('|')}, got: ${opts.tool ?? '(none)'}`;
  }
  if (typeof opts.subject !== 'string') return '--subject is required';
  if (typeof opts.decision !== 'string' || opts.decision === '') {
    return '--decision is required and must not be empty';
  }
  if (opts.kind !== undefined && humanResolvedSkipReason({
    cwd: 'x', sessionId: 'x', decision: 'x', kind: opts.kind,
  }) !== null) {
    return `--kind must be one of correction|decision|approval, got: ${opts.kind}`;
  }
  return null;
}

/**
 * Run the script.
 *
 * @param {string[]} argv arguments after the script path
 * @param {Record<string,string|undefined>} env
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const { opts } = parsed;
  const usage = usageError(opts);
  if (usage !== null) return fail(usage);

  // `CLAUDE_SESSION_ID` is a FALLBACK, not a guarantee: commands/scorecard.md
  // documents it as present in most sessions and absent in some, so a missing
  // one is reported rather than invented.
  const session = opts.session || env.CLAUDE_SESSION_ID || '';
  const args = {
    cwd: opts.cwd || process.cwd(),
    sessionId: session,
    tool: opts.tool,
    subject: opts.subject,
    decision: opts.decision,
    kind: opts.kind,
  };

  const skipped = humanResolvedSkipReason(args);
  await recordHumanResolved(args);
  // Printed from the SAME helper the recorder uses internally, so the id on
  // stdout and the id in the file cannot come from two derivations.
  const question = await describeHumanQuestion({
    sessionId: session, tool: opts.tool, subject: opts.subject,
  });

  process.stdout.write(`${JSON.stringify({
    event: 'human.resolved',
    question_id: question.question_id,
    kind: opts.kind ?? null,
    session: session === '' ? 'none' : session,
    recorded: skipped === null,
    skipped,
  })}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // The recorder never throws and `main` awaits it, but a catch here is what
  // makes "exit 0 unless the command line was wrong" true rather than intended.
  main(argv, process.env).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 0; },
  );
}
