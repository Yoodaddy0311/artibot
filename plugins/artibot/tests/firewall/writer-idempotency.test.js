/**
 * Firewall - a pinned inventory of every `lib/` module that this scanner can
 * see appending a record to a persisted store, each classified `keyed` (it
 * supplies an idempotency key) or `exempt` (it does not, with a stated reason).
 * An appender the scanner discovers but the inventory does not list is RED. A
 * `keyed` entry that loses its key is RED. An `exempt` entry that gains one is
 * RED until it is reclassified.
 *
 * THE FIRST SENTENCE IS DELIBERATELY NOT "every appender". Two earlier versions
 * of this header claimed completeness and were wrong both times, so the claim
 * is now scoped to what the six families below mechanically detect, and the
 * measured holes are listed under "WHAT THIS GATE CANNOT SEE".
 *
 * TWO ROUNDS OF UNDER-DISCOVERY, RECORDED BECAUSE THE FAILURE MODE REPEATS.
 * v1 required three envelope members spelled `key:` and missed a shorthand
 * property (`lib/context/rehydration.js`) and a port callsite whose envelope
 * omits the members the port fills (`lib/checkpoint/checkpoint-service.js`).
 * v2 required the port name to be followed by `(` and missed two modules that
 * import it under an `as` alias and call it through a local (`tel(...)`,
 * `emit(...)`): `lib/autopilot/cost-tracker.js` and `lib/autopilot/preflight.js`
 * (measured 2026-09-21; those two are the only `as`-aliased port imports in
 * `lib/`). Under-discovery is the one direction in which an allowlist gate
 * fails OPEN: an undiscovered appender is not red, it is invisible.
 * Over-discovery costs one `exempt` line. Discovery is therefore wide, and many
 * entries below are not ledger writers at all.
 *
 * WHAT COUNTS - the mechanical definition. A `lib/**\/*.{js,mjs,cjs}` module is
 * DISCOVERED when its comment-stripped source satisfies ANY family:
 *
 *   A - LEDGER ENVELOPE. Carries `event`, `session_id` AND `source` as object
 *       members, as `key:` properties OR shorthand. Those three are the
 *       caller-supplied members of `event-writer.js#REQUIRED_ENVELOPE_KEYS`;
 *       `v`/`ts`/`pid`/`seq` are synthesized and `mission_id` has a fallback,
 *       so none of those four identifies a callsite.
 *   B - KEY PRODUCER. Mentions idempotency in code, any case. Comments do not
 *       count.
 *   C - APPEND PORT NAMED IN CODE. Bare word, NOT requiring a following `(`, so
 *       an `as`-aliased import counts. See `APPEND_PORTS`.
 *   D - DIRECT `fs.appendFile` / `appendFileSync`.
 *   E - DEFINES an `append*`/`record*` function AND persists in the same module
 *       (`writeFile*`, `atomicWrite*`, `writeJsonFile`, `writeText`). This is
 *       what reaches the read-modify-write JSON stores, which never append at
 *       the filesystem level - they read an array, push, and rewrite the file.
 *   F - `<obj>.append(...)`. One module in `lib/` (measured 2026-09-21):
 *       `checkpoint/checkpoint-store.js`, which mints `checkpoint_id` itself
 *       and hands the record to an injected adapter.
 *
 * NEITHER THE STRING NOR THE IMPORT IS THE DEFINITION. A `grep -rn
 * "idempotency" lib` on 2026-09-21 returned ten files; three
 * (`replay/spawn-outcome.js`, `runtime/artifact-lifecycle-gates.js`,
 * `review/independent-reviewer.js`) mention it only in prose, assign no key,
 * and are absent here. On the import side, three modules below statically
 * import from the ledger primitive (`runtime/event-writer.js` or
 * `runtime/ledger.js`): `runtime/ledger.js`, `runtime/middleware/tasks.js` and
 * `runtime/middleware/mission-ledger.js`, the last split out of `tasks.js` on
 * 2026-09-23. A fourth, `runtime/human-asked-record.js`, reaches `ledger.js`
 * through `await import()`, which the earlier "2 of 53" import scan did not
 * count. So 4 of the 55 modules below (re-measured 2026-09-23; the undiscovered
 * `runtime/ledger-tail.js` also imports `ledgerFilePath`, a path helper, and
 * appends nothing). Every other appender takes its port by injection.
 *
 * ALLOWLIST, NOT DENYLIST. The scanner discovers, and the discovered set must
 * equal `INVENTORY` exactly. A denylist fails open for every future writer.
 *
 * MEASUREMENTS, all 2026-09-21. v1: 394 files, 13 discovered. v2: 394, 32.
 * v3 (this one): 395 files under `lib/` (`.mjs` now scanned), 53 discovered, 6
 * keyed, 47 exempt, of which 13 write the run ledger and 7 of those carry no
 * key. Counts are recorded, never asserted - the SET is asserted, because a
 * count goes red on a rename and green on a swap.
 *
 * WHAT THIS GATE CANNOT SEE:
 *
 *   - A KEY UNDER ANOTHER NAME, and this is CURRENT, not hypothetical. AT LEAST
 *     seven stores dedupe today without using the word (a lower bound, not a
 *     census): `supervisor/run-store.js` (`actionId`, returns
 *     `duplicate:true`), `autopilot/memory.js` (`taskHash` + lesson text,
 *     compared against the LAST row only), `learning/ledger/store.js`
 *     (per-session watermark cursor plus a whole-line Set),
 *     `learning/memory/episodic.js` (content `hash`),
 *     `autopilot/failure-memory.js` (`signature` upsert),
 *     `learning/macro-learner.js` (pattern `fingerprint` upsert) and
 *     `learning/skill-injector.js` (`ruleHash` set). All read `exempt`.
 *
 *   - READ-MODIFY-WRITE STORES NOT NAMED `append*`/`record*`. Family E keys on
 *     a NAMING convention, so a store whose function is `save*` or `push*`
 *     escapes. The stores E does reach are a measured LOWER BOUND, not a
 *     census: `learning/knowledge-transfer.js#appendTransferLog`,
 *     `learning/lifelong-learner.js#appendLearningLog`,
 *     `learning/memory/episodic.js#appendEpisode`,
 *     `learning/skill-injector.js#appendInjectionLog`,
 *     `learning/wakeup-scheduler.js#appendRateLimit`,
 *     `core/decision-trail.js#recordDecision`, and a second unkeyed writer
 *     inside an already-listed file, `dream/promote-md.js#registerRejection`.
 *
 *   - A PORT DESTRUCTURED UNDER A DIFFERENT NAME. `const { appendEvent: put } =
 *     deps` escapes Family C. Measured 2026-09-21: zero occurrences in `lib/`
 *     (grep for a renaming destructure of any `append*` binding), so this is a
 *     known hole rather than a live miss. The `as`-aliased IMPORT form, which
 *     IS live at two callsites, is covered since v3.
 *
 *   - DYNAMIC KEY ASSEMBLY AND NULL KEYS. `keyed` means an assignment site
 *     exists in the text, not that the key is well formed, unique or non-null.
 *     TWO keyed modules can emit a null key:
 *     `observability/activation-observed.js` (`promptIdOk ? ... : null`) and
 *     `observability/decision-events.js` (null when `prompt_id` is null).
 *
 *   - KEY UNIQUENESS AND COLLISION, and whether any reader dedupes on the key.
 *     Both need a runtime probe over real lines.
 *
 *   - `scripts/` IS OUT OF SCOPE (the limb scopes this to writer LIBS).
 *     Measured 2026-09-21: eleven files there mention idempotency. A hook that
 *     appends an unkeyed line is invisible. A scope cut, not a measurement.
 *
 *   - A `*IdempotencyKey` FUNCTION DEFINITION counts as a key-assignment site,
 *     so a module that only DEFINES a builder and never calls it would read as
 *     keyed. Zero such modules today; the self-verification below pins the
 *     behavior so the day one appears is a deliberate decision.
 *
 *   - STRIPPER MISPARSES. Two measurements of two different things, both true
 *     (2026-09-21, all 395 files). Line-count preservation: 0 files drift.
 *     Residual-comment-line check (does any stripped line still start with a
 *     JSDoc opener, a ` * ` continuation or a closer): 1 file,
 *     `planning/artifacts.js`, where an escaped backtick inside a nested
 *     template substitution flips string parity and the JSDoc after it reads as
 *     code. That file carries no scanner token, so its classification is
 *     unchanged, and all 53 classifications are stable. This is a scanner, not
 *     a parser: no JSX, no nested template substitutions.
 *
 * OPEN DEFECT CANDIDATES, recorded rather than repaired. Seven run-ledger
 * writers append with no idempotency key; each is marked below. Two of them
 * (`context/rehydration.js`, `checkpoint/checkpoint-service.js`) were invisible
 * to v1. Whether any is wrong is an allowlist question, and
 * `schemas/ledger-events.allowlist.json` declares no machine-readable
 * idempotency requirement for ANY event. It states one in PROSE, once:
 * `session.ended` documents an idempotency key deduped by `readAllEvents`. One
 * prose contract, zero enforceable ones.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LIB_ROOT = path.join(PLUGIN_ROOT, 'lib');

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/** Characters after which a `/` starts a regex literal rather than division. */
const REGEX_PREV_CHAR = /[({[,;:=!&|?+\-*%~^<>]$/;

/** Keywords after which a `/` starts a regex literal. */
const REGEX_PREV_WORD =
  /(^|[^\w$])(return|typeof|case|in|of|do|else|yield|await|void|delete|instanceof|new)$/;

/**
 * True when a `/` at this point opens a regex literal.
 *
 * @param {string} emitted - Code emitted so far.
 * @returns {boolean} Whether a regex literal may start here.
 */
function regexAllowedAfter(emitted) {
  const t = emitted.replace(/\s+$/, '');
  return t === '' || REGEX_PREV_CHAR.test(t) || REGEX_PREV_WORD.test(t);
}

/**
 * Consume a quoted string starting at `i`, preserving it verbatim.
 *
 * @param {string} src - Full source.
 * @param {number} i - Index of the opening quote.
 * @returns {{text: string, next: number}} Emitted text and the next index.
 */
function takeString(src, i) {
  const quote = src[i];
  let out = quote;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { out += src.slice(j, j + 2); j += 2; continue; }
    out += src[j];
    j += 1;
    if (src[j - 1] === quote) break;
  }
  return { text: out, next: j };
}

/**
 * Consume a regex literal starting at `i`, preserving it verbatim. A `/` inside
 * a character class does not close it: `/[/]/` is one token.
 *
 * @param {string} src - Full source.
 * @param {number} i - Index of the opening slash.
 * @returns {{text: string, next: number}} Emitted text and the next index.
 */
function takeRegex(src, i) {
  let out = '/';
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    if (src[j] === '\\') { out += src.slice(j, j + 2); j += 2; continue; }
    if (src[j] === '[') inClass = true;
    else if (src[j] === ']') inClass = false;
    out += src[j];
    j += 1;
    if (src[j - 1] === '/' && !inClass) break;
  }
  return { text: out, next: j };
}

/**
 * Remove line and block comments, preserving newlines, strings and regexes.
 *
 * @param {string} src - JavaScript source.
 * @returns {string} Source with comments removed.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const t = takeString(src, i);
      out += t.text; i = t.next;
    } else if (c === '/' && regexAllowedAfter(out)) {
      const t = takeRegex(src, i);
      out += t.text; i = t.next;
    } else {
      out += c; i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery and classification
// ---------------------------------------------------------------------------

/**
 * An object member named `k`, as a `k:` property OR shorthand (`k,` / `k }`).
 *
 * @param {string} k - Member name.
 * @returns {RegExp} Matcher.
 */
function objectMember(k) {
  return new RegExp(`(^|[{,(]|\\s)${k}\\s*[:,}]`, 'm');
}

/** An object property strictly in `k:` form. Used for key-assignment sites. */
function propertyKey(k) {
  return new RegExp(`(^|[^\\w.'"\`])${k}\\s*:`, 'm');
}

/** The caller-supplied envelope members that identify a ledger callsite. */
const ENVELOPE_MEMBERS = ['event', 'session_id', 'source'];

/**
 * Append-port names. HARVESTED, with a stated limit: every identifier CALLED in
 * `lib/` matching `append*`/`write*`/`record*` and naming a ledger, event,
 * line, run, lesson, episode, transfer or spawn (measured 2026-09-21), minus
 * `recordRiskEvent`, which on inspection mutates autopilot state and reaches no
 * store. The harvest is a snapshot of CALLED names, so a port defined but never
 * called in `lib/` is absent - `appendSpawn` is listed anyway because
 * `learning/ledger/spawn-ledger.js` exports it with zero in-repo callers.
 */
const APPEND_PORTS = [
  'appendEvent', 'appendRunEvent', 'writeEvent', 'appendLedgerEvent',
  'appendLedger', 'appendMissionEvent', 'appendReviewLine', 'recordReviewLine',
  'appendLine', 'appendLesson', 'appendEpisode', 'appendTransferLog',
  'appendSpawn',
];

/** Family C - a port named anywhere in code, `(` NOT required (as-alias). */
const APPEND_PORT_WORD = new RegExp(`\\b(${APPEND_PORTS.join('|')})\\b`);

/** Family D - a hand-rolled append straight to the filesystem. */
const FS_APPEND_CALL = /\b(appendFileSync|appendFile)\s*\(/;

/** Family E, first half - defines a function named like an appender. */
const APPENDER_DEF =
  /(?:^|\s)(?:async\s+)?function\s+(?:append|record)[A-Z]\w*\s*\(|(?:const|let)\s+(?:append|record)[A-Z]\w*\s*=\s*(?:async\s*)?(?:function|\()/;

/** Family E, second half - the module writes a file of its own. */
const PERSISTS =
  /\b(appendFileSync|appendFile|writeFileSync|writeFile|atomicWriteJson\w*|writeJsonFile|writeText|atomicWrite\w*)\s*\(/;

/** Family F - a record handed to an injected store adapter. */
const MEMBER_APPEND = /\b\w+\.append\s*\(/;

/** Family B - any in-code mention of idempotency. */
const IDEMPOTENCY_WORD = /idempotenc/i;

/**
 * Sites that ACTUALLY put a key on a record, as opposed to naming the concept:
 * the snake_case envelope property, a member assignment, the camelCase local
 * used by the artifact store, and a `*IdempotencyKey` builder.
 */
const KEY_ASSIGNMENT_SITES = [
  propertyKey('idempotency_key'),
  /\.idempotency_key\s*=(?!=)/,
  /\bidempotencyKey\s*[:,=]/,
  /\b\w*IdempotencyKey\s*\(/,
];

/**
 * Classify one module's source.
 *
 * @param {string} src - Raw source text.
 * @returns {{discovered: boolean, families: string, keyed: boolean}} Verdict.
 */
function classifySource(src) {
  const code = stripComments(src);
  const families = [
    ENVELOPE_MEMBERS.every((m) => objectMember(m).test(code)) && 'A',
    IDEMPOTENCY_WORD.test(code) && 'B',
    APPEND_PORT_WORD.test(code) && 'C',
    FS_APPEND_CALL.test(code) && 'D',
    APPENDER_DEF.test(code) && PERSISTS.test(code) && 'E',
    MEMBER_APPEND.test(code) && 'F',
  ].filter(Boolean).join('');
  return {
    discovered: families !== '',
    families,
    keyed: KEY_ASSIGNMENT_SITES.some((re) => re.test(code)),
  };
}

/**
 * Every source file under `dir`, recursively. All three module extensions are
 * walked: `lib/` holds one `.mjs` today and a store could arrive in either.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} out - Accumulator.
 * @returns {string[]} Absolute file paths.
 */
function walkSources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walkSources(p, out);
    else if (/\.(js|mjs|cjs)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Scan `lib/` and return every discovered appender with its measured class.
 *
 * @returns {{scanned: number, found: Map<string, {keyed: boolean, families: string}>}} Result.
 */
function scanLib() {
  const files = walkSources(LIB_ROOT).sort();
  const found = new Map();
  for (const file of files) {
    const verdict = classifySource(readFileSync(file, 'utf8'));
    if (!verdict.discovered) continue;
    found.set(path.relative(LIB_ROOT, file).split(path.sep).join('/'), verdict);
  }
  return { scanned: files.length, found };
}

// ---------------------------------------------------------------------------
// The inventory. Every reason below was written after opening the module and
// reading its append site; 53 of 53 were opened on 2026-09-21. Adding an entry
// is the decision - do not add one to turn a red run green without reading it.
// ---------------------------------------------------------------------------

/** @param {string} why - Why this module supplies no idempotency key. */
const x = (why) => ({ cls: 'exempt', why });
/** @param {string} why - Where this module's key comes from. */
const k = (why) => ({ cls: 'keyed', why });

const INVENTORY = {
  // --- keyed ---------------------------------------------------------------
  'economics/receipt-envelope.js': k('run ledger usage.receipt; key from usageReceiptIdempotencyKey.'),
  'observability/activation-observed.js': k('decisions-store payload; key is null when the prompt id is bad.'),
  'observability/decision-events.js': k('decisions store, not the run ledger; key is null when prompt_id is null.'),
  'review/verdict-writer.js': k('run ledger review.completed and review.claim_audit; two key builders.'),
  'runtime/artifact-lifecycle.js': k('mission-artifact store; computeIdempotencyKey plus a seen-key set.'),
  'verification/verify-writer.js': k('run ledger verify.completed; key from verifyCompletedIdempotencyKey.'),

  // --- run-ledger writers with no key: defect candidates --------------------
  'checkpoint/checkpoint-service.js': x('run ledger mission.checkpointed via deps.appendEvent; envelope is event/mission_id/data only. No key. Defect candidate; invisible to v1.'),
  'checkpoint/save-checkpoint.js': x('run ledger announce carrying data.checkpoint_id as its handle. A different module and function from checkpoint-service.js, which has an announce of its own. No key. Defect candidate.'),
  'context/rehydration.js': x('run ledger context.compiled via writer.writeEvent, source spelled as shorthand. No key. Defect candidate; invisible to v1.'),
  'project-state/state-manager.js': x('run ledger state.updated, paired 1:1 with a store write and carrying the monotonic data.state_version. No key. Defect candidate.'),
  'runtime/human-asked-record.js': x('run ledger human.asked and human.resolved, carrying data.question_id. No key. Defect candidate.'),
  'runtime/middleware/mission-ledger.js': x('run ledger mission lifecycle events with a dynamic event name; no per-line handle beyond mission_id. Defect candidate. Moved out of tasks.js 2026-09-23 (800-line split) with the append site unchanged.'),
  'topology/split-state.js': x('run ledger split worker events with a dynamic event name; keyed only by worker. Defect candidate.'),

  // --- primitives, wrappers, readers ----------------------------------------
  'runtime/event-writer.js': x('the run-ledger append primitive. Validates idempotency_key as an optional envelope key and authors no event.'),
  'runtime/ledger.js': x('thin wrapper: appendLedgerEvent forwards to writeEvent and assembles nothing.'),
  'runtime/middleware/tasks.js': x('assembles no envelope since the 2026-09-23 split: binds appendLedgerEvent as the StateStore appendEvent port in openMissionStore (the state.updated line is authored by project-state/state-manager.js) and calls mission-ledger.js#appendMissionEvent. No key.'),
  'replay/replay.js': x('READER. Its event/session_id/source members are projections off ledger lines it reads back.'),
  'handoff/state-version-port.js': x('READ-ONLY state-version port, discovered only because createStateStore requires an appendEvent key and this module passes a REFUSING stub for it. It assembles no envelope and owns no store: a grep of the file for the fs write APIs (writeFile, appendFile, mkdir, createWriteStream, rename, unlink) returns 0 hits over 98 lines, measured 2026-09-22, and the paired test hashes a tree before and after the call and asserts the digest unchanged in 2 places - the store directory and the project root (tests/handoff/state-version-port.test.js, hashDir plus the two expect(hashDir(...)).toBe(before) assertions). No key.'),

  // --- supervisor and observability stores ----------------------------------
  'supervisor/run-store.js': x('supervisor ndjson. Dedupes on actionId and returns duplicate:true on a repeat - a real idempotency key under a different name.'),
  'supervisor/index.js': x('barrel that re-exports run-store appendEvent; owns no store.'),
  'observability/run-events.js': x('defines appendRunEvent, the run-events ndjson primitive. Not the run ledger; no key.'),
  'observability/split-telemetry.js': x('split run-events stream via appendRunEvent; no key.'),
  'observability/exporters/ndjson.js': x('export sink: appends already-formed lines to a per-session ndjson file. Authors no record.'),
  'observability/otel-exporter.js': x('runtime/otel-retry-buffer.jsonl, a retry buffer of FAILED export payloads. Rows are {url, payload, ts} with no row id, and flushRetryBuffer re-appends what fails again.'),
  'observability/session-aggregator.js': x('session rollup and archive JSON, rewritten whole by atomicWriteJson; buckets upsert by key, rows are not appended.'),

  // --- autopilot ------------------------------------------------------------
  'autopilot/telemetry.js': x('defines the autopilot session-event port over appendRunEvent; a separate store from the run ledger, no key.'),
  'autopilot/_engine-helpers.js': x('calls the autopilot telemetry port; session events, no key.'),
  'autopilot/phase-diff.js': x('calls the autopilot telemetry port; session events, no key.'),
  'autopilot/session-store.js': x('session JSON rewritten whole, plus a dynamically imported telemetry append; no key.'),
  'autopilot/cost-tracker.js': x('telemetry port imported under an as-alias and called as tel(...). Guards on receiptId membership in the session usage list, which dedupes usage but not the telemetry row. Invisible to v2.'),
  'autopilot/preflight.js': x('telemetry port imported under an as-alias and called as emit(...); no key. Invisible to v2.'),
  'autopilot/index.js': x('barrel re-exporting appendEvent and appendLesson; owns no store.'),
  'autopilot/engine-state.js': x('calls appendLesson into the autopilot lesson store; no key of its own.'),
  'autopilot/recovery-transition.js': x('calls appendLesson into the autopilot lesson store; no key of its own.'),
  'autopilot/memory.js': x('per-feature lessons jsonl. appendLesson drops a row whose taskHash and lesson text match the LAST row only - a key under another name, and a weaker one than it looks.'),
  'autopilot/failure-memory.js': x('per-repo failure JSON keyed by repoHash; recordFailureMemory upserts a cluster by signature (findIndex on e.signature) - a key under another name.'),
  'autopilot/goal-budget-aggregator.js': x('per-queue budget JSON rewritten whole; no record stream.'),

  // --- core -----------------------------------------------------------------
  'core/decision-trail.js': x('runtime/decision-trail.json; recordDecision reads the array, pushes and rewrites. No per-record key.'),
  'core/user-profile.js': x('user-profile.json, read-modify-write: recordSignal pushes a {type, value, timestamp} row onto profile.signals and caps it at MAX_STORED_SIGNALS. A row stream with no key.'),

  // --- checkpoint stores ----------------------------------------------------
  'checkpoint/checkpoint-store.js': x('mints checkpoint_id itself and hands the record to an injected adapter.append. The author site for checkpoint identity, but that id is a record id, not an idempotency key.'),
  'checkpoint/adapters/file-store.js': x('checkpoints.jsonl, one appended line per record; identity is the caller-supplied checkpoint_id.'),
  'runtime/middleware/checkpoint.js': x('appends checkpoint rows as jsonl lines to runtime/checkpoints.json; no key.'),

  // --- learning stores ------------------------------------------------------
  'learning/ledger/store.js': x('Ambient Conversation Ledger, a per-session jsonl. Dedupes with a per-session watermark cursor plus a whole-line Set - a key under another name.'),
  'learning/ledger/spawn-ledger.js': x('spawns.ndjson, one row per spawn EVENT (start or stop), not per spawn; no key.'),
  'learning/memory/dream/apply.js': x('dream ledger, one appended line per applied proposal; no key.'),
  'learning/memory/dream/promote-md.js': x('dream ledger via a local appendLedger. isRecentlyRejected gates only previously REJECTED signatures, so a passing proposal promoted twice leaves two stage rows for one signatureHash. No line dedupe. Its registerRejection is a second unkeyed writer in the same file.'),
  'learning/memory/episodic.js': x('episodes.json; appendEpisode drops a record whose content hash already exists - a key under another name, invisible to the keyed axis.'),
  'learning/memory/working.js': x('calls episodicStore.appendEpisode on promotion; owns no store.'),
  'learning/knowledge-transfer.js': x('transfer-log.json and system1-patterns.json; appendTransferLog reads, pushes, prunes and rewrites. No per-record key.'),
  'learning/knowledge-demotion.js': x('calls appendTransferLog; owns no store.'),
  'learning/lifelong-learner.js': x('daily-experiences.json and learning-log.json; read-modify-write with pruning, no per-record key.'),
  'learning/skill-injector.js': x('skill-injection-log.json; a ruleHash set keeps a rule from being injected twice - a key under another name for rules, not for log rows.'),
  'learning/wakeup-scheduler.js': x('wakeup request and rate-limit JSON; read-modify-write of an entries array, no per-record key.'),
  'learning/kill-switch.js': x('kill-switch state JSON, read-modify-write: recordFailure pushes an {at, error} row onto a failures array and prunes it to a time window. A row stream with no key.'),
  'learning/macro-learner.js': x('macro-suggestions.json; observations and suggestions upsert by pattern fingerprint, which dedupes suggestions rather than keying rows.'),
};

// ---------------------------------------------------------------------------
// Scanner self-verification. Every fixture is a STRING - no file is created.
// ---------------------------------------------------------------------------

const F = {
  unkeyed: "export const b = (p) => p.appendEvent({ event: 'x.y', session_id: s, source: 'h' });",
  commentOnly: [
    '/** Needs an idempotency_key: someday. */',
    '// TODO idempotency_key: derive it',
    "export const b = (p) => p.send({ event: 'x.y', session_id: s, source: 'h' });",
  ].join('\n'),
  keyed: [
    'export const b = (p) => p.send({',
    "  event: 'x.y', session_id: s, source: 'h', idempotency_key: `x:${s}`,",
    '});',
  ].join('\n'),
  shorthand: "export const b = (w, source) => w.send({ event: 'x.y', session_id: sid, source, data });",
  portPartial: "export const a = (d, m, data) => d.appendEvent({ event: 'm.c', mission_id: m, data });",
  asAlias: [
    "import { appendEvent as defaultAppend } from './telemetry.js';",
    'export const emit = (deps, id, ev) => (deps.telemetry || defaultAppend)(id, ev);',
  ].join('\n'),
  portInComment: '/** Someday this calls appendEvent(sessionId, event). */\nexport const noop = () => null;',
  rmwStore: [
    'export async function appendLearningLog(entry) {',
    '  const all = await readJsonFile(P);',
    '  await writeJsonFile(P, [...all, entry]);',
    '}',
  ].join('\n'),
  adapterAppend: 'export const save = async (a, r) => { await a.append(r); };',
  unrelated: 'export const add = (a, b) => a + b;\n',
};

describe('record-appender idempotency inventory', () => {
  const { scanned, found } = scanLib();

  it('discovers a non-empty appender set (a void scan is a failure, not a pass)', () => {
    expect(scanned).toBeGreaterThan(100);
    expect(found.size).toBeGreaterThan(0);
    expect(Object.keys(INVENTORY).length).toBeGreaterThan(0);
  });

  it('discovered appenders match the pinned inventory exactly', () => {
    const discovered = [...found.keys()].sort();
    const added = discovered.filter((f) => !INVENTORY[f]);
    const removed = Object.keys(INVENTORY).filter((f) => !found.has(f));
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it('every entry carries the class the scanner measures', () => {
    const mismatched = [];
    for (const [rel, entry] of Object.entries(INVENTORY)) {
      const measured = found.get(rel);
      if (!measured) continue;
      const expected = measured.keyed ? 'keyed' : 'exempt';
      if (entry.cls !== expected) mismatched.push({ rel, declared: entry.cls, measured: expected });
    }
    expect(mismatched).toEqual([]);
  });

  it('every entry states a substantive reason and a legal class', () => {
    const bad = Object.entries(INVENTORY).filter(
      ([, e]) => (e.cls !== 'keyed' && e.cls !== 'exempt')
        || typeof e.why !== 'string' || e.why.trim().length < 20,
    ).map(([rel]) => rel);
    expect(bad).toEqual([]);
  });

  it('keeps every module an earlier narrower version missed', () => {
    // Named pins: each absence was fail-open, not red, so the set assertion
    // alone would not say which regression happened.
    for (const rel of [
      'context/rehydration.js', 'checkpoint/checkpoint-service.js',
      'autopilot/cost-tracker.js', 'autopilot/preflight.js',
      'checkpoint/checkpoint-store.js',
    ]) expect({ rel, found: found.has(rel) }).toEqual({ rel, found: true });
  });
});

describe('scanner self-verification', () => {
  const c = (src) => classifySource(src);

  it('flags an envelope assembler that supplies no key', () => {
    expect(c(F.unkeyed).families).toContain('A');
    expect(c(F.unkeyed).keyed).toBe(false);
  });

  it('does not accept a key that exists only in comments', () => {
    expect(c(F.commentOnly).keyed).toBe(false);
    expect(c(F.commentOnly).families).not.toContain('B');
  });

  it('accepts a genuinely keyed writer', () => {
    expect(c(F.keyed).keyed).toBe(true);
  });

  it('discovers an envelope whose members are shorthand', () => {
    expect(c(F.shorthand).families).toContain('A');
  });

  it('discovers a port call whose envelope omits session_id and source', () => {
    expect(c(F.portPartial).families).toBe('C');
  });

  it('discovers a port imported under an as-alias and called through a local', () => {
    expect(c(F.asAlias).families).toBe('C');
  });

  it('does not discover a port named only in a comment', () => {
    expect(c(F.portInComment).discovered).toBe(false);
  });

  it('discovers a read-modify-write store that never appends to a file', () => {
    expect(c(F.rmwStore).families).toBe('E');
  });

  it('discovers a record handed to an injected adapter', () => {
    expect(c(F.adapterAppend).families).toBe('F');
  });

  it('discovers a direct filesystem append', () => {
    expect(c("await fs.appendFile(p, l + '\\n', 'utf-8');").families).toBe('D');
  });

  it('does not discover an unrelated module', () => {
    expect(c(F.unrelated)).toEqual({ discovered: false, families: '', keyed: false });
  });

  it('discovers a key producer that assigns the key onto a member and assembles no envelope', () => {
    // The only string fixture for the member-assignment key site. In real code
    // `observability/decision-events.js` is keyed through that site alone.
    expect(c('export const k = (data) => { data.idempotency_key = 1; };'))
      .toEqual({ discovered: true, families: 'B', keyed: true });
  });

  it('does not read an allowlist array element as a key assignment', () => {
    const v = c("export const KEYS = ['idempotency_key', 'worker'];");
    expect({ b: v.families.includes('B'), keyed: v.keyed }).toEqual({ b: true, keyed: false });
  });

  it('reads a bare *IdempotencyKey DEFINITION as keyed - a known false positive', () => {
    // Pinned, not fixed: zero modules define a builder without calling it
    // today, so tightening now would be untestable against real code.
    expect(c('export function fooIdempotencyKey(a) { return a; }').keyed).toBe(true);
  });
});

describe('comment stripper self-verification', () => {
  it('survives a regex literal containing a quote character', () => {
    // This shape mis-parsed during development on 2026-09-21: the naive
    // stripper read the apostrophe in the character class as a string opener
    // and swallowed the rest of the file.
    expect(classifySource("const R = /['\"]/;\nconst e = { idempotency_key: 1 };\n").keyed).toBe(true);
  });

  it('survives a double slash inside a string literal', () => {
    expect(classifySource("const u = 'https://x.test/a';\nconst e = { idempotency_key: 1 };\n").keyed).toBe(true);
  });

  it('survives an apostrophe inside a line comment', () => {
    expect(classifySource("// don't swallow this\nconst e = { idempotency_key: 1 };\n").keyed).toBe(true);
  });

  it('survives an apostrophe inside a block comment', () => {
    expect(classifySource("/* it isn't a string */\nconst e = { idempotency_key: 1 };\n").keyed).toBe(true);
  });

  it('removes a block comment rather than merely blanking its text', () => {
    expect(stripComments('/* idempotency_key: 1 */\nconst a = 1;\n').trim()).toBe('const a = 1;');
  });

  it('preserves line numbering across a multi-line block comment', () => {
    expect(stripComments('/*\n *\n */\nconst a = 1;\n').split('\n')[3]).toBe('const a = 1;');
  });

  it('keeps a division expression from being read as a regex', () => {
    expect(classifySource('const r = t / c;\nconst e = { idempotency_key: 1 };\n').keyed).toBe(true);
  });
});
