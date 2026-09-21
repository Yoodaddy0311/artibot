/**
 * Firewall - every module under `lib/` that APPENDS A RECORD TO A PERSISTED
 * STORE is inventoried here, and each one is classified `keyed` (it supplies an
 * idempotency key) or `exempt` (it does not, with a stated reason). A record
 * appender that is not in the inventory is RED. A `keyed` entry that loses its
 * key is RED. An `exempt` entry that gains one is RED until it is reclassified.
 *
 * THE FIRST VERSION OF THIS GATE UNDER-DISCOVERED, AND THAT IS THE FAILURE MODE
 * WORTH NAMING. It required three canonical envelope members spelled as
 * `key:` properties, which missed two real ledger writers - a shorthand
 * property and a callsite whose port fills the members. Under-discovery is the
 * one direction in which an allowlist gate fails OPEN: an undiscovered writer
 * is not red, it is invisible. Over-discovery is cheap by comparison, since a
 * false positive costs one `exempt` line and a reason. Discovery below is
 * therefore deliberately wide, and several entries are not ledger writers at
 * all.
 *
 * WHAT COUNTS - the mechanical definition, stated so nobody has to guess. A
 * `lib/**\/*.js` module is DISCOVERED when its comment-stripped source
 * satisfies ANY of four families:
 *
 *   FAMILY A - ledger-envelope assembler. Carries `event`, `session_id` AND
 *     `source` as object members, EITHER as `key:` properties OR as shorthand
 *     (`source,` / `source }`). Those three are the caller-supplied members of
 *     `lib/runtime/event-writer.js#REQUIRED_ENVELOPE_KEYS` (symbol, measured
 *     2026-09-21); `v`, `ts`, `pid` and `seq` are synthesized by the primitive
 *     and `mission_id` has a documented fallback, so none of those four can
 *     identify a callsite. Shorthand support is what finds
 *     `lib/context/rehydration.js`, whose envelope spells `source,`.
 *
 *   FAMILY B - key producer. Mentions idempotency IN CODE, any case. Comment-
 *     only mentions do not count.
 *
 *   FAMILY C - named append port called in code. The port names are harvested
 *     rather than guessed: see `APPEND_PORTS`. This is what finds
 *     `lib/checkpoint/checkpoint-service.js`, whose envelope carries only
 *     `event`, `mission_id` and `data` because the port supplies the rest.
 *
 *   FAMILY D - direct `fs.appendFile` / `appendFileSync`. Measured 2026-09-21:
 *     13 modules under `lib/` append to a file by hand. Included because a
 *     store that bypasses every port is exactly the store a port-name scan
 *     cannot see.
 *
 * THE STRING "idempotency" IS NOT THE DEFINITION, and this is the point of the
 * limb. A `grep -rn "idempotency" lib` on 2026-09-21 returned ten files; three
 * of them (`lib/replay/spawn-outcome.js`,
 * `lib/runtime/artifact-lifecycle-gates.js`, `lib/review/independent-reviewer.js`)
 * mention the concept only in prose. They assign no key and are NOT in this
 * inventory. Conversely most modules below never say the word.
 *
 * IMPORT REACH IS NOT THE DEFINITION EITHER. Measured 2026-09-21: only
 * `lib/runtime/ledger.js` imports `writeEvent` from the primitive, and
 * `lib/runtime/middleware/tasks.js` imports `sessionFallbackMissionId`. Every
 * other writer receives its append port by INJECTION (`ports.appendEvent`,
 * `deps.appendEvent`, `ctx.appendEvent`, `writer.writeEvent`) and names the
 * primitive nowhere. An import scan would have found 2 of the 32 modules below.
 *
 * ALLOWLIST, NOT DENYLIST. The scanner DISCOVERS appenders and the discovered
 * set must equal `INVENTORY` exactly. A new one is red because it is absent
 * from the inventory, not because it matched a list of bad patterns - a
 * denylist fails open for every future writer.
 *
 * MEASUREMENTS. 2026-09-21 first run: 394 files scanned, 13 discovered (the
 * narrow definition). 2026-09-21 after widening: 394 scanned, 32 discovered, 6
 * keyed, 26 exempt. Counts are recorded here but NOT asserted; the SET is. A
 * count assertion goes red on an unrelated rename and green on a swap.
 *
 * WHAT THIS GATE CANNOT SEE - do not read a green run as more than it is:
 *
 *   - DYNAMIC KEY ASSEMBLY. `keyed` means an assignment site exists in the
 *     source text. Not that the key is well formed, unique, or non-null.
 *     `lib/observability/activation-observed.js` assigns
 *     `idempotency_key: promptIdOk ? ... : null` (symbol
 *     `buildActivationObservedData`) - keyed here, still able to emit null.
 *
 *   - A KEY UNDER ANOTHER NAME. `lib/supervisor/run-store.js#appendEvent`
 *     dedupes on `actionId` and returns `{appended:false, duplicate:true}` on a
 *     repeat. That IS idempotency; it reads as `exempt` here because the
 *     scanner keys on the word. Any future store that invents a third name is
 *     equally invisible to the `keyed` axis.
 *
 *   - A PORT DESTRUCTURED UNDER A DIFFERENT NAME. `const { appendEvent: put }
 *     = deps` then `put({...})` escapes Family C, and escapes Family A too
 *     unless the envelope happens to carry all three members. This is the
 *     nearest remaining hole and it is not measured.
 *
 *   - KEY UNIQUENESS AND COLLISION, and whether any reader dedupes on the key.
 *     Both need a runtime probe over real lines, not a text scan.
 *
 *   - `scripts/` IS OUT OF SCOPE. The brief scopes this to writer LIBS.
 *     Measured 2026-09-21, eleven files under `scripts/` mention idempotency
 *     (eight hook recorders, `scripts/ledger/record-verify.mjs`, the routebench
 *     pair). A hook that appends an unkeyed line is invisible here. That is a
 *     deliberate scope cut, not a measurement.
 *
 *   - THE COMMENT STRIPPER IS A SCANNER, NOT A PARSER. Self-verified below on
 *     the shapes that have actually broken scanners in this repo - a regex
 *     literal containing a quote, a `//` inside a string, an apostrophe in a
 *     comment - but it does not understand JSX or nested template
 *     substitutions.
 *
 * OPEN DEFECT CANDIDATES, recorded rather than repaired. Two ledger writers
 * append with no idempotency key and were invisible to the first version of
 * this gate: `lib/context/rehydration.js#reportContextReceipt`
 * (`context.compiled`) and `lib/checkpoint/checkpoint-service.js#announce`
 * (`mission.checkpointed`). Five more unkeyed ledger writers are marked
 * "Defect candidate" below. Whether any of them is wrong is an allowlist
 * question, and `schemas/ledger-events.allowlist.json` declares no idempotency
 * requirement for ANY event (measured 2026-09-21), so there is no
 * machine-readable contract to check them against.
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
 * Consume a regex literal starting at `i`, preserving it verbatim.
 *
 * A `/` inside a character class does not close the literal, which is why the
 * class flag exists: `/[/]/` is one token, not two.
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
 * Remove line and block comments, preserving newlines, string literals and
 * regex literals.
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
 * An object member named `k`, as a `k:` property OR as shorthand (`k,` /
 * `k }`). The leading guard keeps a member expression and a quoted array
 * element out, so `'idempotency_key',` inside an allowlist array is not a
 * member.
 *
 * @param {string} k - Member name.
 * @returns {RegExp} Matcher for that member.
 */
function objectMember(k) {
  return new RegExp(`(^|[{,(]|\\s)${k}\\s*[:,}]`, 'm');
}

/** An object property strictly in `k:` form. Used for key-assignment sites. */
function propertyKey(k) {
  return new RegExp(`(^|[^\\w.'"\`])${k}\\s*:`, 'm');
}

/** The three caller-supplied envelope members that identify a ledger callsite. */
const ENVELOPE_MEMBERS = ['event', 'session_id', 'source'];

/**
 * Append-port names, HARVESTED not guessed: every identifier called in `lib/`
 * matching `append*`/`write*`/`record*` and naming a ledger, event, line or run
 * (measured 2026-09-21). `recordRiskEvent` is excluded on inspection - it
 * mutates autopilot state and reaches no store.
 */
const APPEND_PORTS = [
  'appendEvent', 'appendRunEvent', 'writeEvent', 'appendLedgerEvent',
  'appendLedger', 'appendMissionEvent', 'appendReviewLine', 'recordReviewLine',
  'appendLine',
];

/** Family C - a named append port invoked in code. */
const APPEND_PORT_CALL = new RegExp(`\\b(${APPEND_PORTS.join('|')})\\s*\\(`);

/** Family D - a hand-rolled append straight to the filesystem. */
const FS_APPEND_CALL = /\b(appendFileSync|appendFile)\s*\(/;

/** Family B - any in-code mention of idempotency, in any case. */
const IDEMPOTENCY_WORD = /idempotenc/i;

/**
 * Sites that ACTUALLY put a key on a record, as opposed to naming the concept.
 * Four spellings, all measured in this repository on 2026-09-21: the snake_case
 * envelope property, a member assignment onto a `data` object, the camelCase
 * local used by the artifact store, and a call to a `*IdempotencyKey` builder.
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
  const a = ENVELOPE_MEMBERS.every((m) => objectMember(m).test(code));
  const b = IDEMPOTENCY_WORD.test(code);
  const c = APPEND_PORT_CALL.test(code);
  const d = FS_APPEND_CALL.test(code);
  const families = (a ? 'A' : '') + (b ? 'B' : '') + (c ? 'C' : '') + (d ? 'D' : '');
  return {
    discovered: families !== '',
    families,
    keyed: KEY_ASSIGNMENT_SITES.some((re) => re.test(code)),
  };
}

/**
 * Every `.js` file under `dir`, recursively, as absolute paths.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} out - Accumulator.
 * @returns {string[]} Absolute file paths.
 */
function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Scan `lib/` and return every discovered appender with its measured class.
 *
 * @returns {{scanned: number, found: Map<string, {keyed: boolean, families: string}>}} Scan result.
 */
function scanLib() {
  const files = walkJs(LIB_ROOT).sort();
  const found = new Map();
  for (const file of files) {
    const verdict = classifySource(readFileSync(file, 'utf8'));
    if (!verdict.discovered) continue;
    const rel = path.relative(LIB_ROOT, file).split(path.sep).join('/');
    found.set(rel, { keyed: verdict.keyed, families: verdict.families });
  }
  return { scanned: files.length, found };
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

/** Shorthand for an exempt entry. */
function exempt(why) {
  return { cls: 'exempt', why };
}

/** Shorthand for a keyed entry. */
function keyed(why) {
  return { cls: 'keyed', why };
}

/**
 * Pinned inventory, keyed by path relative to `lib/`. `why` is mandatory and is
 * the decision record: for an exempt entry it says WHICH store the module
 * appends to and what, if anything, stands in for an idempotency key.
 *
 * Adding an entry is the decision. Do not add one to make a red run green
 * without reading the module.
 */
const INVENTORY = {
  // --- keyed -------------------------------------------------------------
  'economics/receipt-envelope.js': keyed(
    'run ledger, usage.receipt; key from usageReceiptIdempotencyKey.',
  ),
  'observability/activation-observed.js': keyed(
    'decisions store payload; key can be null when the prompt id is bad.',
  ),
  'observability/decision-events.js': keyed(
    'decisions store, not the run ledger; key assigned onto data.',
  ),
  'review/verdict-writer.js': keyed(
    'run ledger, review.completed and review.claim_audit; two key builders.',
  ),
  'runtime/artifact-lifecycle.js': keyed(
    'mission-artifact store; computeIdempotencyKey plus a seen-key set.',
  ),
  'verification/verify-writer.js': keyed(
    'run ledger, verify.completed; key from verifyCompletedIdempotencyKey.',
  ),

  // --- run-ledger writers with no key: defect candidates ------------------
  'checkpoint/checkpoint-service.js': exempt(
    'run ledger, mission.checkpointed via deps.appendEvent. Envelope carries '
    + 'only event/mission_id/data; no idempotency key. Defect candidate, found '
    + 'only after Family C was added.',
  ),
  'checkpoint/save-checkpoint.js': exempt(
    'run ledger, announce-only line carrying data.checkpoint_id as its handle; '
    + 'no idempotency key. Separate module from checkpoint-service.js, which '
    + 'has an announce of its own. Defect candidate.',
  ),
  'context/rehydration.js': exempt(
    'run ledger, context.compiled via writer.writeEvent. No idempotency key. '
    + 'Defect candidate, found only after shorthand members were accepted.',
  ),
  'project-state/state-manager.js': exempt(
    'run ledger, state.updated paired 1:1 with a store write and carrying the '
    + 'monotonic data.state_version; no idempotency key. Defect candidate.',
  ),
  'runtime/human-asked-record.js': exempt(
    'run ledger, human.asked / human.resolved carrying data.question_id as '
    + 'their handle; no idempotency key. Defect candidate.',
  ),
  'runtime/middleware/tasks.js': exempt(
    'run ledger, mission lifecycle events with a dynamic event name; no '
    + 'per-line handle beyond mission_id. Defect candidate.',
  ),
  'topology/split-state.js': exempt(
    'run ledger, split worker events with a dynamic event name; keyed only by '
    + 'worker. Defect candidate.',
  ),

  // --- primitives, wrappers and readers -----------------------------------
  'runtime/event-writer.js': exempt(
    'the run-ledger append primitive itself. Validates idempotency_key as an '
    + 'optional envelope key and authors no event of its own.',
  ),
  'runtime/ledger.js': exempt(
    'thin wrapper: appendLedgerEvent forwards to the primitive writeEvent and '
    + 'assembles nothing.',
  ),
  'replay/replay.js': exempt(
    'READER, not a writer. Its event/session_id/source members are projections '
    + 'off ledger lines it reads back.',
  ),

  // --- other stores --------------------------------------------------------
  'supervisor/run-store.js': exempt(
    'supervisor ndjson store. Dedupes on actionId and returns duplicate:true '
    + 'on a repeat - a real idempotency key under a different name, which is '
    + 'why this gate reads it as exempt. See "A KEY UNDER ANOTHER NAME".',
  ),
  'observability/run-events.js': exempt(
    'defines appendRunEvent, the run-events ndjson primitive. Not the run '
    + 'ledger and carries no key.',
  ),
  'observability/split-telemetry.js': exempt(
    'split run-events stream via appendRunEvent; no key.',
  ),
  'observability/exporters/ndjson.js': exempt(
    'export sink: appends already-formed lines to an ndjson file. Authors no '
    + 'record of its own.',
  ),
  'observability/otel-exporter.js': exempt(
    'OTel span buffer file; spans carry their own ids, not a ledger key.',
  ),
  'autopilot/telemetry.js': exempt(
    'defines the autopilot session-event append port over appendRunEvent; '
    + 'separate store from the run ledger, no key.',
  ),
  'autopilot/_engine-helpers.js': exempt(
    'calls the autopilot telemetry port; autopilot session events, no key.',
  ),
  'autopilot/phase-diff.js': exempt(
    'calls the autopilot telemetry port; autopilot session events, no key.',
  ),
  'autopilot/session-store.js': exempt(
    'calls the autopilot telemetry port; autopilot session events, no key.',
  ),
  'autopilot/memory.js': exempt(
    'appends JSONL rows to the autopilot memory store; not an event record.',
  ),
  'checkpoint/adapters/file-store.js': exempt(
    'appends checkpoint records one line per write; identity is the checkpoint '
    + 'id supplied by the caller, not an idempotency key.',
  ),
  'runtime/middleware/checkpoint.js': exempt(
    'appends checkpoint journal lines directly; no key.',
  ),
  'learning/ledger/spawn-ledger.js': exempt(
    'spawn ledger: appends one canonical record per spawn; no key.',
  ),
  'learning/ledger/store.js': exempt(
    'learning session store; appends kept lines, no per-record key.',
  ),
  'learning/memory/dream/apply.js': exempt(
    'dream ledger: appends one line per applied proposal; no key.',
  ),
  'learning/memory/dream/promote-md.js': exempt(
    'dream ledger via a local appendLedger; repeats are suppressed by a '
    + 'signatureHash rejection window rather than a per-line key.',
  ),
};

// ---------------------------------------------------------------------------
// Scanner self-verification. Every fixture is a STRING - no file is created.
// ---------------------------------------------------------------------------

/** A fake writer that assembles an envelope and supplies no key. */
const FAKE_UNKEYED = [
  'export function build(ports) {',
  "  return ports.appendEvent({ event: 'x.y', session_id: s, source: 'hook' });",
  '}',
].join('\n');

/** The same fake, with the key named ONLY in prose. Must NOT read as keyed. */
const FAKE_COMMENT_ONLY = [
  '/**',
  ' * This one needs an idempotency_key: someday.',
  ' */',
  'export function build(ports) {',
  '  // TODO idempotency_key: derive from the session',
  "  return ports.appendEvent({ event: 'x.y', session_id: s, source: 'hook' });",
  '}',
].join('\n');

/** A properly keyed fake. */
const FAKE_KEYED = [
  'export function build(ports) {',
  '  return ports.appendEvent({',
  "    event: 'x.y', session_id: s, source: 'hook',",
  '    idempotency_key: `x:${s}`,',
  '  });',
  '}',
].join('\n');

/** Shorthand members only - the shape that hid `context/rehydration.js`. */
const FAKE_SHORTHAND = [
  'export function build(writer, source) {',
  "  return writer.somePort({ event: 'x.y', session_id: sid, source, data });",
  '}',
].join('\n');

/** Port call with a partial envelope - the shape that hid `checkpoint-service.js`. */
const FAKE_PORT_PARTIAL = [
  'export async function announce(deps, missionId, data) {',
  "  await deps.appendEvent({ event: 'mission.checkpointed', mission_id: missionId, data });",
  '}',
].join('\n');

/** A port named only in prose. Must NOT be discovered. */
const FAKE_PORT_IN_COMMENT = [
  '/**',
  ' * Someday this will call appendEvent(sessionId, event) for real.',
  ' */',
  'export const noop = () => null;',
].join('\n');

/** Neither family. Must not be discovered at all. */
const FAKE_UNRELATED = 'export const add = (a, b) => a + b;\n';

describe('record-appender idempotency inventory', () => {
  const { scanned, found } = scanLib();

  it('discovers a non-empty appender set (a void scan is a failure, not a pass)', () => {
    expect(scanned).toBeGreaterThan(100);
    expect(found.size).toBeGreaterThan(0);
    expect(Object.keys(INVENTORY).length).toBeGreaterThan(0);
  });

  it('discovered appenders match the pinned inventory exactly', () => {
    const discovered = [...found.keys()].sort();
    const pinned = Object.keys(INVENTORY).sort();
    const added = discovered.filter((f) => !INVENTORY[f]);
    const removed = pinned.filter((f) => !found.has(f));
    expect({ added, removed }).toEqual({ added: [], removed: [] });
    expect(discovered).toEqual(pinned);
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
    const thin = Object.entries(INVENTORY)
      .filter(([, e]) => typeof e.why !== 'string' || e.why.trim().length < 20)
      .map(([rel]) => rel);
    expect(thin).toEqual([]);
    const badClass = Object.entries(INVENTORY)
      .filter(([, e]) => e.cls !== 'keyed' && e.cls !== 'exempt')
      .map(([rel]) => rel);
    expect(badClass).toEqual([]);
  });

  it('keeps the two writers that the narrow first version missed', () => {
    // Regression pins, named because their absence was fail-open, not red.
    expect(found.has('context/rehydration.js')).toBe(true);
    expect(found.has('checkpoint/checkpoint-service.js')).toBe(true);
  });
});

describe('scanner self-verification', () => {
  it('flags an envelope assembler that supplies no key', () => {
    const v = classifySource(FAKE_UNKEYED);
    expect(v.discovered).toBe(true);
    expect(v.families).toContain('A');
    expect(v.keyed).toBe(false);
  });

  it('does not accept a key that exists only in comments', () => {
    const v = classifySource(FAKE_COMMENT_ONLY);
    expect(v.discovered).toBe(true);
    expect(v.keyed).toBe(false);
    expect(v.families).not.toContain('B');
  });

  it('accepts a genuinely keyed writer', () => {
    expect(classifySource(FAKE_KEYED).keyed).toBe(true);
  });

  it('discovers an envelope whose members are shorthand', () => {
    const v = classifySource(FAKE_SHORTHAND);
    expect(v.families).toContain('A');
    expect(v.keyed).toBe(false);
  });

  it('discovers a port call whose envelope omits session_id and source', () => {
    const v = classifySource(FAKE_PORT_PARTIAL);
    expect(v.discovered).toBe(true);
    expect(v.families).toBe('C');
    expect(v.keyed).toBe(false);
  });

  it('does not discover a port named only in a comment', () => {
    expect(classifySource(FAKE_PORT_IN_COMMENT).discovered).toBe(false);
  });

  it('does not discover an unrelated module', () => {
    expect(classifySource(FAKE_UNRELATED)).toEqual({
      discovered: false, families: '', keyed: false,
    });
  });

  it('discovers a direct filesystem append', () => {
    const v = classifySource("await fs.appendFile(p, line + '\\n', 'utf-8');");
    expect(v.families).toBe('D');
  });

  it('discovers a key producer that assembles no envelope', () => {
    const v = classifySource('export const k = () => { data.idempotency_key = 1; };');
    expect(v.families).toBe('B');
    expect(v.keyed).toBe(true);
  });

  it('does not read an allowlist array element as a key assignment', () => {
    const v = classifySource("export const KEYS = ['idempotency_key', 'worker'];");
    expect(v.families).toContain('B');
    expect(v.keyed).toBe(false);
  });
});

describe('comment stripper self-verification', () => {
  it('survives a regex literal containing a quote character', () => {
    // This exact shape mis-parsed during development on 2026-09-21: the naive
    // stripper read the apostrophe inside the character class as a string
    // opener and swallowed the rest of the file, which made a keyed module
    // look unkeyed and a comment-only module look keyed.
    const src = "const RE = /['\"]/;\nconst e = { idempotency_key: 1 };\n";
    expect(classifySource(src).keyed).toBe(true);
  });

  it('survives a double slash inside a string literal', () => {
    const src = "const u = 'https://example.test/a';\nconst e = { idempotency_key: 1 };\n";
    expect(classifySource(src).keyed).toBe(true);
  });

  it('survives an apostrophe inside a line comment', () => {
    const src = "// don't let this swallow the next line\nconst e = { idempotency_key: 1 };\n";
    expect(classifySource(src).keyed).toBe(true);
  });

  it('survives an apostrophe inside a block comment', () => {
    const src = "/* it isn't a string */\nconst e = { idempotency_key: 1 };\n";
    expect(classifySource(src).keyed).toBe(true);
  });

  it('removes a block comment rather than merely blanking its text', () => {
    expect(stripComments('/* idempotency_key: 1 */\nconst a = 1;\n').trim()).toBe('const a = 1;');
  });

  it('preserves line numbering across a multi-line block comment', () => {
    const src = '/*\n *\n */\nconst a = 1;\n';
    expect(stripComments(src).split('\n')[3]).toBe('const a = 1;');
  });

  it('keeps a division expression from being read as a regex', () => {
    const src = 'const r = total / count;\nconst e = { idempotency_key: 1 };\n';
    expect(classifySource(src).keyed).toBe(true);
  });
});
