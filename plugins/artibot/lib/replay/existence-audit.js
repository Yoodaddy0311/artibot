/**
 * Existence Audit — the DENOMINATOR for "does this thing ever fire?"
 *
 * CLAUDE.md:84-90 makes a rule: hooks, commands, skills and `lib/` modules get
 * their CONSUMER count and their FIRING count measured every release, and two
 * consecutive releases at zero/zero make something a removal CANDIDATE — a
 * candidate only, removed by a human, never automatically. That section closes
 * by naming its own hole: "발화 카운트의 분모는 현재 미측정" (CLAUDE.md:90).
 *
 * This module is that denominator. Since Wave 12 it answers for THREE of the
 * four kinds — `skills`, through `tool.used.skill`, `hooks`, through
 * `hook.fired.hooks`, and `commands`, through `intent.detected.command` — and
 * still answers `unmeasured` for `modules` alone.
 *
 * WHAT CHANGED (2026-09-29, R1 / OB-24) -- three changes to what `fired: 0` means
 * ---------------------------------------------------------------------------
 * (1) `hook.fired` has a SECOND WRITER, in a DIFFERENT UNIT: the 21 scripts behind
 * the 24 commands `hooks/hooks.json` registers directly write one row per
 * SESSION-DAY (the first firing per UTC day, session, slot, hook;
 * `_main-entry.js#tapDirectFiring` skips loading the recorder once a marker file
 * exists). One row per firing was withdrawn on architect review: it put the
 * ledger writer on every tool call and broke "1 dispatch = 1 row" (owner
 * decision O8=a1). The row SHAPE is the dispatchers'; the UNIT is not.
 * (2) `CARRIERS.skills` is SCOPED to `tool.used` rows with `data.tool` `Skill`
 * (`where`): AskUserQuestion rows (SH-09) name no skill, and counting them made a
 * questions-only ledger read `measured: true, fired: 0` for every skill.
 * (3) An inventory item can carry `requires`, a gate on the CARRIER (see
 * `buildExistenceAudit`): a ledger from before the tap's release holds no row
 * for a direct-only hook, and `fired: 0` would read "unused" for a silence
 * nobody was listening to.
 *
 * WHAT CHANGED (2026-09-17, Wave 12 / SH-29 part B)
 * ---------------------------------------------------------------------------
 * A third writer, `scripts/hooks/runtime-prompt.js#recordSlashCommandInvoked`,
 * records ONE `intent.detected` row per USER-TYPED slash command, naming it in
 * `data.command` beside `type: 'slash-command'` and `confidence: 1`. So
 * `CARRIERS.commands` is no longer null. It is SINGLE-valued, not multi: one
 * prompt types at most one command. The rows a future intent CLASSIFIER writes
 * under this same event will carry no `command` key and land in the fold's
 * `absent` bucket, so that "a command fired" and "an intent was classified and
 * named no command" stay two different readings.
 *
 * WHAT CHANGED (2026-09-17, Wave 12 / SH-29 part A)
 * ---------------------------------------------------------------------------
 * A second writer, `scripts/hooks/_hook-fired-record.js`, records ONE
 * `hook.fired` row per dispatcher invocation, naming in `data.hooks` the
 * handler names that slot dispatched, in dispatch order. That makes `hooks` the
 * first MULTI-VALUED carrier: one row names several artifacts at once, so the
 * fold counts per element rather than per row, and the denominator stays the
 * number of DISPATCH ROWS, not the number of names. `CARRIERS.hooks` below is
 * therefore no longer null. The event is registered in the allowlist beside the
 * other 39, so the survey below re-reads as 40 registered events (2026-09-17).
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
 * `modules` stays null, for the reasons unchanged from the 2026-09-02 survey
 * below. Those reasons were RE-MEASURED 2026-09-15 across all 39 registered
 * events then present (39 = `Object.keys(allowlist.events).length`; it was 36
 * at the 2026-09-02 pass and 40 once Wave 12 added `hook.fired`, and the events
 * added at each step were read too): no `data` field names a `lib/` module. The
 * closest candidates are still category labels one level off —
 * `review.requested.reviewer` and `review.claim_audit.subject_agent_type` name
 * an AGENT, and `memory.promoted.path` names a memory file, not a module.
 * `hooks` and `commands` were in that list until Wave 12; both left by the same
 * route `skills` did, a new writer, not a rereading of an existing field.
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
 *     fired N times", which is not the per-hook number the rule asks for. This
 *     is the near miss Wave 12 closed, again by adding a field rather than
 *     rereading one: `hook.fired.hooks` names the handlers, and `source` still
 *     only says the emitter was a hook.
 *   - `intent.detected.type` (allowlist:104-113) carries an intent type, not a
 *     command name. `phase.started.segment` carries a phase segment. Neither is
 *     an artifact identity. This is the near miss Wave 12 part B closed, for
 *     the third time by adding a field rather than rereading one: the sibling
 *     `intent.detected.command` names the command, and `type` still only says
 *     which intent vocabulary term applied.
 *   - `worker.claimed.agent_type` names an agent type, not a hook/command/skill.
 *
 * So `CARRIERS` below was all-null on 2026-09-02, and every entry this module
 * returned was `unmeasured`. That was the finding, not a stub: the rule in
 * CLAUDE.md cannot be evaluated until a writer records an artifact name, and
 * saying so with a null is the whole point. A `fired: 0` in that state cannot
 * be told apart from a measured silence, and would let something be deleted for
 * a silence nobody was ever listening for. One kind is still in exactly that
 * state; `skills` left it on 2026-09-15, `hooks` and `commands` on 2026-09-17.
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
 *     looking audit of the wrong set, and this module cannot tell. The one
 *     production caller that enumerates is `scripts/ledger/existence-audit.mjs`
 *     (OB-24, 2026-09-23); its header states the enumeration rule per kind and
 *     what that enumeration cannot see, and it prints the carrier names no
 *     inventory entry spells (`unmatched`) beside this module's output.
 *   - THE CARRIER TABLE READS SCHEMAS, NOT WRITERS. It was measured from the
 *     allowlist. A writer smuggling a hook name into `data` under a key the
 *     allowlist does not register is invisible here — and would be unreadable
 *     by anything else too, which is the actual defect in that case.
 *   - THE HOOKS CARRIER IS TWO WRITERS, AND THE SECOND IS ONLY AS OLD AS ITS
 *     RELEASE. `hook.fired` is written by the six dispatchers, which cover the
 *     44 handler entries of `hooks/dispatch-table.json` (42 distinct names —
 *     `memory-tracker` and `session-ledger` each sit in two slots; measured
 *     2026-09-17), and, since R1 / OB-24 (2026-09-29), by the 21 scripts behind
 *     the 24 commands that `hooks/hooks.json` registers directly: PreToolUse 9,
 *     PostToolUseFailure 3, SubagentStart 2, TeammateIdle 2, TaskCompleted 2,
 *     Notification 2, PermissionRequest 1, InstructionsLoaded 1, PreCompact 1,
 *     PostCompact 1 (measured 2026-09-15 from hooks.json, re-measured
 *     2026-09-17 and 2026-09-29). What that does NOT undo:
 *       (i) NOTHING BEFORE THE RELEASE THAT SHIPPED IT. `requires` covers a
 *           ledger with NO direct-slot row, not a `--since` window that starts
 *           before the release on a ledger holding later direct rows.
 *       (ii) NO ROW outside a git work tree (no `git rev-parse` is spawned), with
 *           a `hook_event_name` outside the ten direct events, with no
 *           `session_id` (the unit is keyed by it), when an `exit(0)` tail cut the
 *           append off (the marker is claimed only AFTER a successful append, so
 *           the next firing retries), or with `ARTIBOT_HOOK_FIRED_DIRECT=off`.
 *       (iii) TWO UNITS. A direct-only hook's `fired` counts session-days (400
 *           runs in one read 1), the five names both paths run add the two
 *           units in one number, and `denominator` MIXES them: `fired /
 *           denominator` is a share of ROWS, not a firing rate. Two parallel
 *           FIRST firings of one unit can both write it (accepted).
 *       (iv) THE CLI INVENTORY = dispatch-table handlers PLUS the `hooks.json`
 *           commands on the ten direct events. It does not open the scripts: one
 *           that never calls the tap reads as a measured zero once any
 *           direct-slot row exists (`tests/hooks/hook-fired-direct.test.js` pins
 *           this repository's wiring; an installed copy is taken on trust).
 *     The row also says nothing about how long a handler ran or what it did.
 *   - THE COMMANDS CARRIER SEES ONLY WHAT THE USER TYPED, AND ONLY BARE NAMES.
 *     `intent.detected.command` is written from `detectSlashCommand`
 *     (`lib/mission/mission-id.js:139-144`), which matches a bare `/name` at
 *     the start of the prompt and returns it LOWERCASED. Three consequences,
 *     each a false `fired: 0` waiting for an unwary reader: a NAMESPACED slash
 *     (`/artibot:split`) is not detected at all and writes no row (known gap,
 *     pinned at `tests/hooks/runtime-prompt-activation-wiring.test.js:283`); a
 *     command reached any way OTHER than the user typing it — a hint, a
 *     command invoked by another command, a subagent — is invisible; and the
 *     inventory must be spelled as the bare `commands/*.md` stem, because that
 *     is the only spelling the rows can contain. Normalising the inventory to
 *     that stem is the CALLER's job (leader decision sh29-3); this module
 *     matches names literally and cannot tell a renamed command from a silent
 *     one. The row also says nothing about whether the command then succeeded.
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
 *
 * `multi: true` marks a field whose value is an ARRAY of names rather than one
 * name. `hooks` is the only such carrier (2026-09-17): one `hook.fired` row is
 * one dispatch and names every handler that dispatch fanned out to. The flag is
 * on the carrier and not inferred from the data on purpose — inferring it would
 * let a single malformed row silently switch counting modes.
 *
 * `where` scopes a carrier to the rows that can NAME its artifact (R1 / OB-24): a
 * `{ dataField: scalar }` map, strict `===` on `row.data`. A row that fails it is
 * not a row OF THIS CARRIER -- neither counted, nor `absent`, nor in the
 * denominator. `skills` is the only user (AskUserQuestion rows name no skill).
 * It reads the row's own `data.tool`, so past rows are corrected retroactively.
 */
export const CARRIERS = Object.freeze({
  hooks: Object.freeze({ event: 'hook.fired', field: 'hooks', multi: true }),
  commands: Object.freeze({ event: 'intent.detected', field: 'command' }),
  skills: Object.freeze({
    event: 'tool.used',
    field: 'skill',
    where: Object.freeze({ tool: 'Skill' }),
  }),
  modules: null,
});

/**
 * What each kind's carrier is, or why it is still null, naming what was
 * examined. A note is present for every kind, carried or not — a kind that
 * reports numbers still has to say WHERE they come from.
 */
export const CARRIER_NOTES = Object.freeze({
  hooks:
    'hook.fired.hooks carries handler NAMES as an ARRAY, so the fold is MULTI-VALUED: the '
    + "denominator is hook.fired rows and a name's `fired` is the number of rows whose array "
    + 'contains it. Rows whose field is not an array count as `absent`. TWO WRITERS, ONE ROW '
    + 'SHAPE, TWO UNITS (scripts/hooks/_hook-fired-record.js): the 6 dispatchers write one row '
    + 'per dispatch (recordHookFired, since Wave 12, 2026-09-17); the 24 commands registered '
    + 'directly in hooks/hooks.json write one row per session-day unit, the first firing per '
    + 'UTC day, session, slot and hook (recordDirectHookFired, since R1 / OB-24, 2026-09-29). '
    + "So a direct-only hook's `fired` counts session-days (400 runs in one read 1), a name "
    + 'both paths run adds the two units in one number, and the denominator MIXES the two '
    + 'units: `fired / denominator` is a share of rows, not a firing rate. CANNOT SEE: a '
    + 'firing of a direct hook before the release that shipped R1 (no row exists; `requires` '
    + 'keeps an item unmeasured while the ledger holds no direct-slot row, but a window that '
    + 'starts before the release on a ledger with later direct rows still reads a false '
    + '`fired: 0`); a direct hook run outside a git work tree or without a session_id; a row '
    + 'cut off by an exit(0) tail (the marker is claimed only after the append, so the next '
    + 'firing retries); ARTIBOT_HOOK_FIRED_DIRECT=off; handler duration; what the handler '
    + 'did. The envelope source enum still only says "hook" '
    + '(ledger-envelope.schema.json:45-57), 1 of 8 emitter categories.',
  commands:
    'intent.detected.command (written by scripts/hooks/runtime-prompt.js'
    + '#recordSlashCommandInvoked since Wave 12, 2026-09-17) carries the command NAME for a '
    + 'row with type="slash-command" and confidence=1, one row per user-typed slash prompt. '
    + 'SINGLE-valued, not multi. Rows WITHOUT the key -- the intent-classifier rows this '
    + 'event was registered for, which have a type but no command -- count as `absent`, so '
    + '"an intent was classified" and "a command fired" stay distinct. CANNOT SEE: a '
    + 'NAMESPACED slash (/artibot:split), which detectSlashCommand (lib/mission/mission-id'
    + '.js:139-144) does not match, so it writes no row at all; and any command not typed by '
    + 'the user. The inventory must therefore be spelled as the bare commands/*.md stem, '
    + 'lowercased, which is the only spelling these rows can contain -- normalising it to '
    + 'that stem is the caller\'s job (leader decision sh29-3), and a mismatch reads as a '
    + 'false fired: 0. The sibling field intent.detected.type is an intent vocabulary term '
    + 'and phase.*.segment is a phase name; neither is a command identity.',
  skills:
    'tool.used.skill (written by scripts/hooks/tool-used-record.js since Wave 11, '
    + '2026-09-15) carries the skill name for tool=Skill. The carrier is SCOPED with '
    + "`where: { tool: 'Skill' }` (R1 / OB-24, 2026-09-29): tool.used also carries "
    + 'AskUserQuestion (SH-09) and those rows can name no skill, so they are neither '
    + 'counted, nor `absent`, nor in the denominator -- a ledger holding only question rows '
    + 'is unmeasured for skills, not a measured zero. A Skill row without the key counts as '
    + '`absent`. The sibling field tool.used.tool carries only the TOOL name ("Skill") and '
    + 'loses the skill identity, which is why a second field was needed.',
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
 * FACT, not a knob. One of its four entries is still null (2026-09-17), so a
 * test that produced numbers for that one by overriding the constant would be
 * testing a fiction. Passing a hypothetical carrier here exercises the
 * arithmetic without touching the finding. `skills`, `hooks` and `commands` no
 * longer need the hypothetical — all three have real carriers and are folded
 * from real rows.
 *
 * SINGLE mode (`multi` unset). A value that is absent, null, or non-scalar
 * lands in `absent` rather than in a bucket of its own (`countBy`,
 * replay.js:445-465), so a writer that omits `skill` cannot be mistaken for a
 * skill named "null" or "undefined".
 *
 * MULTI mode (`carrier.multi === true`). The field holds an ARRAY of names and
 * one row can name many artifacts, so:
 *   - a row whose field is not an array (missing, null, a bare string) counts
 *     as `absent` and STILL counts toward `denominator`;
 *   - non-string and empty-string elements inside an array are SKIPPED — they
 *     do not become a bucket and they do not make the row absent, because the
 *     row did name other handlers and dropping it would lose those;
 *   - an element repeated within ONE row counts TWICE. Chosen over per-row
 *     dedupe because a dispatch table never lists a handler twice in one slot
 *     (measured 2026-09-17: 44 entries, 42 distinct names, and every repeat is
 *     across slots, not within one), so a duplicate inside a row is a writer
 *     defect that should be visible in the count rather than smoothed away.
 *   - `denominator` stays the number of CARRIER ROWS. It is dispatches, not
 *     names, so `fired / denominator` reads as "share of dispatches that
 *     reached this handler" and can never exceed 1.
 *
 * `counts` is built through a `Map` and materialised with `defineProperty`, so
 * an artifact named `constructor`, `__proto__` or `toString` is ordinary data
 * and not a prototype member or a setter. `auditEntry` reads it with
 * `Object.hasOwn` for the same reason.
 *
 * @param {object[]} events - ledger lines, already ordered and deduped by the caller.
 * @param {?{event: string, field: string, multi?: boolean,
 *   where?: Record<string, string|number|boolean>}} carrier - carrier
 *   declaration, or null. `multi: true` selects the array-valued fold above;
 *   `where` scopes the carrier to the rows whose `data` matches (see `CARRIERS`).
 * @returns {?{counts: Record<string, number>, absent: number, denominator: number}}
 *   null when there is no carrier -- never a zero. `denominator` is the rows OF
 *   THE CARRIER EVENT that satisfy its `where`, and in multi mode rows, not names.
 * @throws {TypeError} when `where` is present and not a non-empty scalar map.
 */
export function foldFiredCounts(events, carrier) {
  assertEvents(events);
  if (carrier === null || carrier === undefined) return null;
  if (!isNonEmptyString(carrier.event) || !isNonEmptyString(carrier.field)) {
    throw new TypeError('foldFiredCounts: carrier needs non-empty { event, field }');
  }
  assertWhere(carrier.where);
  const rows = events.filter((e) => e && e.event === carrier.event && matchesWhere(e, carrier.where));
  if (carrier.multi !== true) {
    const { counts, absent, total } = countBy(rows, (e) => e?.data?.[carrier.field]);
    return { counts, absent, denominator: total };
  }
  const tally = new Map();
  let absent = 0;
  for (const row of rows) {
    const value = row?.data?.[carrier.field];
    if (!Array.isArray(value)) {
      absent += 1;
      continue;
    }
    for (const element of value) {
      if (!isNonEmptyString(element)) continue;
      tally.set(element, (tally.get(element) ?? 0) + 1);
    }
  }
  return { counts: sortedCounts(tally), absent, denominator: rows.length };
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
 * @param {{inventory: Record<string, Array<string|{name: string, exemptAs?: string,
 *            requires?: {field: string, anyOf: string[], reason: string}}>>,
 *          census?: object|null}} opts
 *   `inventory` keys are `AUDITED_KINDS`. An ABSENT key and an EMPTY array are
 *   different answers and stay different in the output, via `enumerated`.
 *   An item may carry `requires` (R1 / OB-24): a gate on the CARRIER, for a name
 *   whose writer may not have shipped for this ledger. While no carrier row
 *   (inside its `where`) has `data[field]` in `anyOf`, the item is `measured:
 *   false, fired: null` with `reason` (must start `unmeasured:`); after that it
 *   reads like any other. Per carrier, not per name. A malformed `requires`
 *   THROWS. An empty carrier keeps `CARRIER_ABSENT_REASON`, a kind with no
 *   carrier its own reason: the gate is only asked of a kind that has rows.
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
  // One scan per distinct gate, and only for a kind that has rows to be gated at all.
  const scans = new Map();
  const gateOf = ({ requires }) => {
    if (requires === undefined || fold === null || fold.denominator === 0) return null;
    const key = JSON.stringify([requires.field, requires.anyOf]);
    if (!scans.has(key)) scans.set(key, gateIsOpen(events, carrier, requires));
    return { open: scans.get(key), reason: requires.reason };
  };
  const entries = items.map((item) => auditEntry({ ...item, kind, fold, gate: gateOf(item) })).sort(byName);
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
 * @param {{name: string, exemptAs: string|undefined, kind: string, fold: ?object,
 *   gate?: ?{open: boolean, reason: string}}} args
 *   `fold` is the kind's folded counts, or null when the kind has no carrier;
 *   `gate` the item's `requires` evaluated against the ledger, or null.
 * @returns {object} entry record.
 */
function auditEntry({ name, exemptAs, kind, fold, gate = null }) {
  const exemptContract = resolveExemption(name, exemptAs);
  const carried = fold !== null && fold.denominator > 0;
  const gated = carried && gate !== null && gate.open === false;
  const measured = carried && !gated;
  let reason = null;
  if (fold === null) reason = noCarrierReason(kind);
  else if (!carried) reason = CARRIER_ABSENT_REASON;
  else if (gated) reason = gate.reason;
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
    //
    // PROTOTYPE-KEY DEFENCE (hygiene (c) of the Wave 11 bundle brief, absorbed
    // here 2026-09-17). `fold.counts` is a plain object, so `counts[name]` for
    // an inventory entry named `constructor`, `toString` or `hasOwnProperty`
    // reaches Object.prototype and returns a FUNCTION — `?? 0` would keep it,
    // and the entry would report a function where a number belongs. `hasOwn`
    // asks whether this histogram actually counted that name, which is the
    // question being asked; anything else reports 0.
    fired: measured ? (Object.hasOwn(fold.counts, name) ? fold.counts[name] : 0) : null,
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
 * @returns {Array<{name: string, exemptAs?: string, requires?: object}>} normalized items.
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
    return {
      name,
      exemptAs: typeof item === 'string' ? undefined : item?.exemptAs,
      requires: typeof item === 'string' ? undefined : normalizeRequires(item?.requires, kind, name),
    };
  });
}

/**
 * Validate one item's `requires`: absent is fine; otherwise `{ field, anyOf,
 * reason }` of non-empty strings with a non-empty `anyOf` and a `reason` in the
 * `unmeasured:` namespace (a gated entry is never mistaken for a measured one).
 *
 * @param {unknown} requires - the item's `requires`, or undefined.
 * @param {string} kind - kind key, for the error message.
 * @param {string} name - item name, for the error message.
 * @returns {{field: string, anyOf: string[], reason: string}|undefined} a copy.
 * @throws {TypeError} when present and malformed.
 */
function normalizeRequires(requires, kind, name) {
  if (requires === undefined) return undefined;
  const { field, anyOf, reason } = requires ?? {};
  const ok = typeof requires === 'object' && !Array.isArray(requires)
    && isNonEmptyString(field) && isNonEmptyString(reason) && reason.startsWith('unmeasured:')
    && Array.isArray(anyOf) && anyOf.length > 0 && anyOf.every(isNonEmptyString);
  if (!ok) {
    throw new TypeError(
      `existence-audit: inventory.${kind} item ${JSON.stringify(name)} has a malformed requires; `
      + "it needs { field: string, anyOf: non-empty string[], reason: 'unmeasured:...' }",
    );
  }
  return { field, anyOf: [...anyOf], reason };
}

/**
 * Has the carrier (non-null here) any row, inside its `where`, whose own
 * `data[field]` is in `anyOf`? Own properties, strict equality, like `where`.
 *
 * @param {object[]} events - ledger lines.
 * @param {{event: string, where?: object}} carrier - the kind's carrier.
 * @param {{field: string, anyOf: string[]}} gate - a validated `requires`.
 * @returns {boolean}
 */
function gateIsOpen(events, carrier, { field, anyOf }) {
  return events.some((row) => {
    const data = row?.data;
    return row?.event === carrier.event && matchesWhere(row, carrier.where)
      && data !== null && typeof data === 'object'
      && Object.hasOwn(data, field) && anyOf.includes(data[field]);
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
 * Refuse a malformed carrier `where`. Absent is fine (no scope); anything else
 * must be a non-empty plain object of scalars. A scope that silently matched
 * nothing — or everything — would move every count without a sound.
 *
 * @param {unknown} where - the carrier's `where`, or undefined.
 * @throws {TypeError} when present and not a non-empty `{ field: scalar }` map.
 */
function assertWhere(where) {
  if (where === undefined) return;
  const ok = where !== null
    && typeof where === 'object'
    && !Array.isArray(where)
    && Object.keys(where).length > 0
    && Object.values(where).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
  if (!ok) {
    throw new TypeError('foldFiredCounts: carrier.where must be a non-empty { dataField: scalar } map');
  }
}

/**
 * Does `row` satisfy a carrier's `where` scope? Strict, case-sensitive `===`
 * on OWN `data` fields; a row without `data`, or without the field, does not.
 * No `where` means every row of the carrier's event belongs.
 *
 * @param {object} row - ledger line of the carrier's event.
 * @param {Record<string, string|number|boolean>|undefined} where - validated scope.
 * @returns {boolean}
 */
function matchesWhere(row, where) {
  if (where === undefined) return true;
  const data = row.data;
  if (data === null || typeof data !== 'object') return false;
  return Object.entries(where).every(([field, value]) => Object.hasOwn(data, field) && data[field] === value);
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

/**
 * Materialise a tally as a key-sorted plain object, same shape `countBy` emits.
 *
 * Sorted so the same input serialises identically. `defineProperty` rather than
 * `counts[label] = n` because a plain assignment to `__proto__` runs the
 * inherited SETTER and stores nothing: the key would silently vanish from the
 * histogram of an artifact that really is named `__proto__`. Every key here is
 * an own, enumerable, ordinary data property.
 *
 * @param {Map<string, number>} tally - label to count.
 * @returns {Record<string, number>} key-sorted counts.
 */
function sortedCounts(tally) {
  const counts = {};
  for (const label of [...tally.keys()].sort()) {
    Object.defineProperty(counts, label, {
      value: tally.get(label), enumerable: true, writable: true, configurable: true,
    });
  }
  return counts;
}
