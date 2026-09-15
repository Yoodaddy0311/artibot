/**
 * Existence Audit — the DENOMINATOR for "does this thing ever fire?"
 *
 * CLAUDE.md:84-90 makes a rule: hooks, commands, skills and `lib/` modules get
 * their CONSUMER count and their FIRING count measured every release, and two
 * consecutive releases at zero/zero make something a removal CANDIDATE — a
 * candidate only, removed by a human, never automatically. That section closes
 * by naming its own hole: "발화 카운트의 분모는 현재 미측정" (CLAUDE.md:90).
 *
 * This module is that denominator. Since Wave 11 it answers for ONE of the four
 * kinds — `skills`, through `tool.used.skill` — and still answers `unmeasured`
 * for the other three.
 *
 * WHAT CHANGED (2026-09-15, Wave 11 / SH-29)
 * ---------------------------------------------------------------------------
 * A PostToolUse writer, `scripts/hooks/tool-used-record.js`, now records the
 * skill name in `tool.used.data.skill`, and the allowlist registers that field
 * (`schemas/ledger-events.allowlist.json:280-295`, event `tool.used`, measured
 * 2026-09-15). `CARRIERS.skills` below is therefore no longer null, and a
 * per-skill firing count is a real measurement rather than a declared gap.
 *
 * The key is OMITTED, never null, when the name is unavailable: `matchesType`
 * (`lib/runtime/ledger-schema.js:56-66`) rejects `null` against a declared
 * `string`, so writing null would produce a REJECTED line instead of an honest
 * blank. Rows without the key land in the fold's `absent` bucket, so "a tool
 * fired without naming a skill" stays distinct from a skill that never fired.
 *
 * `skill` is deliberately NOT in `required`. `tool.used` covers every tool and
 * most of them have no skill to name, so requiring it would reject the majority
 * of the event's own rows.
 *
 * `hooks`, `commands` and `modules` stay null, for the reasons unchanged from
 * the 2026-09-02 survey below. Those reasons were RE-MEASURED 2026-09-15 across
 * all 39 registered events (39 = `Object.keys(allowlist.events).length`; it was
 * 36 at the 2026-09-02 pass, and the events added since were read too): no
 * `data` field names a hook, a command, or a `lib/` module. The closest
 * candidates are still category labels one level off — `review.requested
 * .reviewer` and `review.claim_audit.subject_agent_type` name an AGENT, and
 * `memory.promoted.path` names a memory file, not a module.
 *
 * WHAT WAS MEASURED (2026-09-02, `schemas/ledger-events.allowlist.json`, all 36
 * events registered at that time, read end to end) — HISTORICAL, KEPT
 * ---------------------------------------------------------------------------
 * Kept verbatim in substance because it records why three carriers are still
 * null, and why the fourth needed a writer before it could exist at all. The
 * question was: which registered event carries, in a named field, the IDENTITY
 * of a hook, a command, a skill, or a module? The answer, on that date, was
 * none. The near misses are worth writing down, because each looks like a
 * carrier until you read the field:
 *
 *   - `tool.used.tool` (allowlist:280-295 today, :232-242 when this paragraph
 *     was written) carries the TOOL name — the firewall fixture writes
 *     `{tool: 'Bash'}` (tests/firewall/ledger-vocab-allowlist.test.js:215). A
 *     skill reaches the runtime through the `Skill` tool, so THAT field can at
 *     best say "a skill fired" and never WHICH skill. An aggregate that loses
 *     the identity is not a per-skill count. This is the near miss Wave 11
 *     closed — not by rereading `tool`, but by adding a sibling field beside it.
 *   - The envelope `source` enum (ledger-envelope.schema.json:45-58) has the
 *     value `hook`, and six events list `sources: ["hook"]`. That is a CATEGORY
 *     of emitter, one of eight, not a hook name. Counting it yields "hooks
 *     fired N times", which is not the per-hook number the rule asks for.
 *   - `intent.detected.type` (allowlist:104-113) carries an intent type, not a
 *     command name. `phase.started.segment` carries a phase segment. Neither is
 *     an artifact identity.
 *   - `worker.claimed.agent_type` names an agent type, not a hook/command/skill.
 *
 * So `CARRIERS` below was all-null on 2026-09-02, and every entry this module
 * returned was `unmeasured`. That was the finding, not a stub: the rule in
 * CLAUDE.md cannot be evaluated until a writer records an artifact name, and
 * saying so with a null is the whole point. A `fired: 0` in that state cannot
 * be told apart from a measured silence, and would let something be deleted for
 * a silence nobody was ever listening for. Three kinds are still in exactly
 * that state; `skills` left it on 2026-09-15 and nothing else did.
 *
 * WHY THE EXEMPT LIST IS A CONSTANT AND NOT A PARSE
 * ---------------------------------------------------------------------------
 * `EXEMPT_CONTRACTS` restates CLAUDE.md:88 verbatim. Parsing that markdown at
 * runtime would let a prose edit silently change a safety list, and would put a
 * file read inside a module that is forbidden one. A copy nobody compares is a
 * copy that drifts, so the copy is compared: the test parses CLAUDE.md:88 and
 * asserts the same 14 items in the same order — the tactic
 * `tests/replay/no-second-source.test.js` already uses for the restated
 * envelope key list.
 *
 * Exemption is an ALLOWLIST, not a boolean. A caller declares one by naming the
 * contract it falls under (`exemptAs`), and a name outside `EXEMPT_CONTRACTS`
 * THROWS. A free `exempt: true` would let any caller exempt anything, which is
 * the fail-open shape repo rules §8 keeps warning about.
 *
 * ── WHAT THIS MODULE CANNOT SEE ─────────────────────────────────────────────
 *   - A LIVE LEDGER EXISTS AND HOLDS NO `tool.used` ROW. The 2026-09-02 note
 *     here said no live ledger existed at all; it had looked at
 *     `.artibot/runtime/ledger.jsonl` under the project root, which is NOT
 *     where the file lands. `ledgerFilePath` (`lib/runtime/event-writer.js`
 *     :261-273) puts it at `<git-common-dir>/artibot/ledger.jsonl`, shared by
 *     every linked worktree. Measured there 2026-09-15: 1,167 non-blank lines,
 *     0 corrupt, 10 distinct events, and `tool.used` rows = 0.
 *     So the `skills` carrier has a real FIELD, a real WRITER, and still zero
 *     real ROWS — which is exactly the state `CARRIER_ABSENT_REASON` exists to
 *     report, and exactly the state in which a `fired: 0` would be a lie.
 *     Every number obtainable from the tests comes from an injected fixture, so
 *     nothing here has been exercised against that live traffic and no live
 *     firing rate is claimed.
 *   - LOSS ABOVE THE READER IS INVISIBLE UNLESS THE CALLER PASSES `census`.
 *     `summary.eventsReceived` counts the lines this module was HANDED. By
 *     then `ledger.js#readAllEvents` has already dropped the corrupt, the
 *     rejected, the filtered and the duplicate, so a firing rate taken against
 *     it is measured on survivors and reads HIGH. The reader now counts those
 *     drops (`readLedgerCensus`, F-30); a caller that reads through it can
 *     hand the census in as `opts.census` and it is echoed at
 *     `summary.census`. Absent, `summary.census` is `null` — not counted,
 *     never "counted and found zero". Nothing here opens the file.
 *   - CONSUMERS ARE NOT COUNTED, AT ALL. "소비처 수" is a static fact about who
 *     imports or references a thing; it is not in the ledger and cannot be
 *     folded out of one. Every entry reports the literal string `'unmeasured'`
 *     rather than a plausible zero.
 *   - NO RELEASE HISTORY. "2릴리스 연속" needs release-scoped history that one
 *     fold over one ledger cannot express, so `candidate` is hard `false` on
 *     every entry. This module never proposes a removal.
 *   - THE INVENTORY IS THE CALLER'S WORD. Nothing here enumerates the
 *     filesystem — a caller passing an incomplete inventory gets a complete
 *     looking audit of the wrong set, and this module cannot tell.
 *   - THE CARRIER TABLE READS SCHEMAS, NOT WRITERS. It was measured from the
 *     allowlist. A writer smuggling a hook name into `data` under a key the
 *     allowlist does not register is invisible here — and would be unreadable
 *     by anything else too, which is the actual defect in that case.
 *   - A REGISTERED FIELD IS NOT A FIRING WRITER. `CARRIERS.skills` says the
 *     field exists and is readable, not that the hook is installed, reached, or
 *     succeeding. If `scripts/hooks/tool-used-record.js` stops running, this
 *     module reports `unmeasured:carrier-event-absent-from-ledger` for an empty
 *     ledger — but for a ledger holding tool.used rows written by anything
 *     else, it reports `fired: 0, measured: true` for every skill. Whether the
 *     writer runs is that file's own gate, not this one's.
 *
 * @module lib/replay/existence-audit
 */

import { countBy } from './replay.js';

/** The four artifact kinds CLAUDE.md:86 puts under the rule. */
export const AUDITED_KINDS = Object.freeze(['hooks', 'commands', 'skills', 'modules']);

/** Kind key to the singular noun used in `unmeasured:no-event-carries-<kind>`. */
export const KIND_SINGULAR = Object.freeze({
  hooks: 'hook',
  commands: 'command',
  skills: 'skill',
  modules: 'module',
});

/**
 * CLAUDE.md:88 verbatim, in document order, backticks stripped.
 *
 * Safety contracts kept regardless of what the counts say. The canonical list
 * is design §3.7 "유지(REJECT)"; CLAUDE.md:88 is its restatement and is what the
 * drift test compares against, because that is the copy a reader of this
 * repository actually meets.
 */
export const EXEMPT_CONTRACTS = Object.freeze([
  '보고·중계 계약',
  '{sid}',
  'Phase 0 VALIDATE',
  'Phase 4.5',
  'fast 하드캡',
  'Operator-Waits',
  'FABLE_DENYLIST',
  'task-budget 하한',
  'PreToolUse 보안 훅',
  'dispatch-table',
  'vitest-only',
  '격리',
  'ambiguity-guard',
  'verification-discipline 전문',
]);

/**
 * Which registered event field carries each kind's artifact NAME.
 *
 * `null` means no registered event carries it — see the header for the near
 * misses that were checked and rejected. When a writer starts recording one,
 * the change here is a single `{ event: 'x.y', field: 'z' }` and the fold below
 * starts producing numbers with no other edit. `skills` is the worked example:
 * Wave 11 added the writer and the allowlist field, and this one line is the
 * entire reader-side change.
 */
export const CARRIERS = Object.freeze({
  hooks: null,
  commands: null,
  skills: Object.freeze({ event: 'tool.used', field: 'skill' }),
  modules: null,
});

/**
 * What each kind's carrier is, or why it is still null, naming what was
 * examined. A note is present for every kind, carried or not — a kind that
 * reports numbers still has to say WHERE they come from.
 */
export const CARRIER_NOTES = Object.freeze({
  hooks:
    'envelope source enum has "hook" (ledger-envelope.schema.json:45-57) but that is '
    + '1 of 8 emitter categories, not a hook name; no event data field names a hook.',
  commands:
    'intent.detected.type is an intent vocabulary and phase.*.segment is a phase name; '
    + 'no registered event data field names a command.',
  skills:
    'tool.used.skill (written by scripts/hooks/tool-used-record.js since Wave 11, '
    + '2026-09-15) carries the skill name for tool=Skill; rows without the key count as '
    + '`absent`. The sibling field tool.used.tool carries only the TOOL name ("Bash", '
    + '"Skill") and loses the skill identity, which is why a second field was needed.',
  modules:
    'no registered event references a lib/ module path or module name in data.',
});

/** Constant reported for consumers, which the ledger structurally cannot answer. */
export const CONSUMERS_UNMEASURED = 'unmeasured';

/** Why `candidate` is false on every entry regardless of the counts. */
export const CANDIDATE_BLOCKED_REASON = 'unmeasured:no-release-history';

/** Reason used when a carrier exists but the ledger holds none of its event. */
export const CARRIER_ABSENT_REASON = 'unmeasured:carrier-event-absent-from-ledger';

/**
 * Reason string for a kind no registered event can carry.
 *
 * @param {string} kind - one of `AUDITED_KINDS`.
 * @returns {string} `unmeasured:no-event-carries-<singular kind>`.
 */
export function noCarrierReason(kind) {
  return `unmeasured:no-event-carries-${KIND_SINGULAR[kind] ?? kind}`;
}

/**
 * Fold firing counts for one carrier.
 *
 * Kept exported and carrier-parameterised on purpose: `CARRIERS` is a MEASURED
 * FACT, not a knob. Three of its four entries are still null (2026-09-15), so a
 * test that produced numbers for those by overriding the constant would be
 * testing a fiction. Passing a hypothetical carrier here exercises the
 * arithmetic without touching the finding. `skills` no longer needs the
 * hypothetical — it has a real carrier and is folded from real rows.
 *
 * A value that is absent, null, or non-scalar lands in `absent` rather than in
 * a bucket of its own (`countBy`, replay.js:445-465), so a writer that omits
 * `skill` cannot be mistaken for a skill named "null" or "undefined".
 *
 * @param {object[]} events - ledger lines, already ordered and deduped by the caller.
 * @param {?{event: string, field: string}} carrier - carrier declaration, or null.
 * @returns {?{counts: Record<string, number>, absent: number, denominator: number}}
 *   null when there is no carrier — an explicit "not measurable", never a zero.
 *   `denominator` is rows OF THE CARRIER EVENT, not all events handed in.
 */
export function foldFiredCounts(events, carrier) {
  assertEvents(events);
  if (carrier === null || carrier === undefined) return null;
  if (!isNonEmptyString(carrier.event) || !isNonEmptyString(carrier.field)) {
    throw new TypeError('foldFiredCounts: carrier needs non-empty { event, field }');
  }
  const rows = events.filter((e) => e && e.event === carrier.event);
  const { counts, absent, total } = countBy(rows, (e) => e?.data?.[carrier.field]);
  return { counts, absent, denominator: total };
}

/**
 * Resolve an entry's exemption against the allowlist.
 *
 * @param {string} name - artifact name.
 * @param {string|undefined} declared - caller-declared contract; must be one of
 *   `EXEMPT_CONTRACTS`.
 * @returns {?string} the matched contract, or null when not exempt.
 * @throws {Error} when `declared` is outside the allowlist.
 */
export function resolveExemption(name, declared) {
  if (declared !== undefined) {
    if (!EXEMPT_CONTRACTS.includes(declared)) {
      throw new Error(
        `existence-audit: exemptAs ${JSON.stringify(declared)} is not one of the `
        + `${EXEMPT_CONTRACTS.length} contracts in CLAUDE.md:88. Exemption is an `
        + 'allowlist; widening it is a documentation change, not a call argument.',
      );
    }
    return declared;
  }
  return EXEMPT_CONTRACTS.includes(name) ? name : null;
}

/**
 * Build the audit.
 *
 * PURE: no clock, no filesystem, no randomness. The inventory is supplied by
 * the caller — this module never enumerates anything itself.
 *
 * @param {object[]} events - ledger lines.
 * @param {{inventory: Record<string, Array<string|{name: string, exemptAs?: string}>>,
 *          census?: object|null}} opts
 *   `inventory` keys are `AUDITED_KINDS`. An ABSENT key and an EMPTY array are
 *   different answers and stay different in the output, via `enumerated`.
 *   `census` is the reader's line census (`readLedgerCensus().census`, F-30),
 *   optional; it is echoed, never recomputed, and never used as a denominator
 *   here — which denominator to adopt is a separate decision.
 * @returns {{kinds: object, summary: object}} audit result; entries sorted by name.
 */
export function buildExistenceAudit(events, opts) {
  assertEvents(events);
  const inventory = opts?.inventory;
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new TypeError(
      'buildExistenceAudit: { inventory } is required. Defaulting to {} would report a '
      + 'clean audit of nothing, which reads exactly like a clean audit of everything.',
    );
  }
  const kinds = {};
  for (const kind of AUDITED_KINDS) kinds[kind] = auditKind(events, inventory, kind);
  return { kinds, summary: summarize(kinds, events.length, opts?.census ?? null) };
}

/**
 * Audit one kind.
 *
 * @param {object[]} events - ledger lines.
 * @param {object} inventory - caller-supplied inventory.
 * @param {string} kind - one of `AUDITED_KINDS`.
 * @returns {object} kind block with its entries.
 */
function auditKind(events, inventory, kind) {
  const enumerated = Object.hasOwn(inventory, kind);
  const carrier = CARRIERS[kind] ?? null;
  const fold = foldFiredCounts(events, carrier);
  const items = normalizeInventory(inventory[kind], kind, enumerated);
  const entries = items
    .map(({ name, exemptAs }) => auditEntry({ name, exemptAs, kind, fold }))
    .sort(byName);
  return {
    carrier,
    carrierNote: CARRIER_NOTES[kind] ?? null,
    enumerated,
    denominator: fold ? fold.denominator : 0,
    entries,
  };
}

/**
 * One inventory item's verdict.
 *
 * @param {{name: string, exemptAs: string|undefined, kind: string, fold: ?object}} args
 *   `fold` is the kind's folded counts, or null when the kind has no carrier.
 * @returns {object} entry record.
 */
function auditEntry({ name, exemptAs, kind, fold }) {
  const exemptContract = resolveExemption(name, exemptAs);
  const measured = fold !== null && fold.denominator > 0;
  const reason = fold === null
    ? noCarrierReason(kind)
    : (measured ? null : CARRIER_ABSENT_REASON);
  return {
    name,
    kind,
    // null, never 0: an unmeasured silence and a measured silence are different
    // facts, and only one of them is evidence for removal.
    //
    // The lookup is by EXACT inventory name. Now that `skills` is carried, that
    // matters: the writer copies whatever string the host handed it, and which
    // spelling that is (bare `split`, namespaced `artibot:split`, a path) is
    // NOT verified here — the writer's own header marks it inferred. An
    // inventory spelled differently from the rows yields `fired: 0,
    // measured: true`, a false zero that reads as removal evidence. Matching
    // the two spellings is the caller's job; this module cannot tell a renamed
    // skill from a silent one.
    fired: measured ? (fold.counts[name] ?? 0) : null,
    denominator: fold ? fold.denominator : 0,
    measured,
    reason,
    consumers: CONSUMERS_UNMEASURED,
    exempt: exemptContract !== null,
    exemptContract,
    // Hard false. See CANDIDATE_BLOCKED_REASON — Observe records, it does not judge.
    candidate: false,
    candidateReason: CANDIDATE_BLOCKED_REASON,
  };
}

/**
 * Validate and normalize one kind's inventory list.
 *
 * @param {unknown} list - raw inventory value.
 * @param {string} kind - kind key, used in error messages.
 * @param {boolean} enumerated - whether the key was present at all.
 * @returns {Array<{name: string, exemptAs: string|undefined}>} normalized items.
 */
function normalizeInventory(list, kind, enumerated) {
  if (!enumerated || list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new TypeError(`existence-audit: inventory.${kind} must be an array`);
  }
  const seen = new Set();
  return list.map((item) => {
    const name = typeof item === 'string' ? item : item?.name;
    if (!isNonEmptyString(name)) {
      throw new TypeError(`existence-audit: inventory.${kind} item needs a non-empty name`);
    }
    if (seen.has(name)) {
      throw new Error(
        `existence-audit: inventory.${kind} lists ${JSON.stringify(name)} twice. A `
        + 'duplicate silently doubles a denominator, so it is refused, not merged.',
      );
    }
    seen.add(name);
    return { name, exemptAs: typeof item === 'string' ? undefined : item?.exemptAs };
  });
}

/**
 * Roll the entries up.
 *
 * `measured + unmeasured === entries` is a partition. `exempt` is NOT part of
 * it — an exempt entry is also counted as measured or unmeasured, because being
 * a safety contract says nothing about whether its firing was observable.
 *
 * @param {object} kinds - per-kind blocks.
 * @param {number} eventsReceived - how many lines this function was HANDED.
 *   SURVIVORS, after the reader has already discarded the corrupt, the
 *   rejected, the filtered-out and the duplicated. It is NOT the ledger's line
 *   count, and this module never opens the file to find out what that is.
 *   Naming it `ledgerLines` made it read like the audit's true denominator,
 *   which would overstate every firing rate computed against it. Same meaning
 *   as T-41's `totals.received` in `replay.js`, and named to match it. The
 *   reader's own count of what it dropped travels separately, as `census`.
 * @param {object|null} census - the reader's line census (F-30) or `null`.
 * @returns {{entries: number, measured: number, unmeasured: number, exempt: number,
 *   eventsReceived: number, census: object|null}} totals.
 */
function summarize(kinds, eventsReceived, census) {
  const all = AUDITED_KINDS.flatMap((kind) => kinds[kind].entries);
  return {
    entries: all.length,
    measured: all.filter((e) => e.measured).length,
    unmeasured: all.filter((e) => !e.measured).length,
    exempt: all.filter((e) => e.exempt).length,
    // Kept beside the zeros above so "the ledger was empty" and "nothing carries
    // this kind" cannot collapse into the same reading. Survivors, not lines —
    // see the param note; upstream loss is invisible from here unless the
    // caller passed the reader's census, echoed next.
    eventsReceived,
    census,
  };
}

/**
 * Deterministic name ordering, independent of inventory order.
 *
 * @param {{name: string}} a - left entry.
 * @param {{name: string}} b - right entry.
 * @returns {number} comparator result.
 */
function byName(a, b) {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/**
 * Fail loudly on a non-array event list.
 *
 * @param {unknown} events - candidate.
 * @throws {TypeError} when not an array.
 */
function assertEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('existence-audit: events must be an array of ledger lines');
  }
}

/**
 * @param {unknown} value - candidate.
 * @returns {boolean} true when a non-empty string.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
