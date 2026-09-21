/**
 * NL-activation measurement instrument — READ-ONLY (design §3.7).
 *
 * WHAT THIS IS. §3.7's exit criterion for NL activation is ">=90% agreement
 * between the predicted `command_activation` and the user's REAL slash/hint
 * choice". This file is the instrument that would MEASURE that number. It is
 * not the number, and it does not produce one today.
 *
 * WHY THE ANSWER IS `null`. Measured 2026-09-12 (parent repo) and re-checked
 * 2026-09-14: no writer records either side of that comparison.
 *   - `lib/runtime/middleware/tasks.js#buildMissionLedgerData` writes `title` +
 *     `intent_revision` for `mission.created`, and `reason` + `signals`
 *     (+ `title`) for `mission.candidate_deferred`. Neither carries
 *     `command_activation`.
 *   - `lib/mission/compiler.js#compileMission` computes `command_activation`
 *     and `meta.activation_suppressed_by` in memory and never persists them.
 *   - `scripts/hooks/runtime-prompt.js` emits `[artibot:hint recommend=X]` to
 *     stdout; nothing observes whether the user took the hint.
 * So the denominator of both activation axes is 0, and `ratio` is `null` —
 * UNMEASURED. It is deliberately NOT `0`: a measured `0/5` is the claim "the
 * classifier agreed with nobody", while `0/0` is the claim "nobody looked".
 * Rendering the second as the first is the specific corruption this file
 * refuses (`ratioOf`, pinned by `tests/evals/nl-activation-report.test.js`).
 * Denominator 0 is the RESULT here, not a defect: adding the writer is a
 * separate, owned change.
 *
 * WHAT IT CANNOT SEE
 *  - Anything not already on disk. It reads; it never writes, and it never
 *    re-runs the classifier.
 *  - Which of the two candidate destinations (ledger vs decisions store) a
 *    future writer will pick — so it folds BOTH with one pass and reports
 *    `by_store` alongside the total.
 *  - The n=10 fixture's agreement number as evidence for the >=90% bar. See
 *    `FIXTURE_WARNING`; the fixture block is a side-by-side of what the cases
 *    EXPECT, not a score.
 *
 * Usage: `node scripts/evals/nl-activation-report.mjs [--project-root <dir>]
 * [--fixture <path>]` — one JSON document on stdout, exit 0.
 *
 * Live recount: update the INSTALLED plugin and restart the session first (a
 * running session keeps the old hook), then run the line above and read the
 * `activation.hint-followed` denominator — it is 0 until the restarted hook has
 * written activation records carrying a hint.
 *
 * @module scripts/evals/nl-activation-report
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectRoot } from '../../lib/git/project-root.js';
import {
  ACTIVATION_OBSERVED,
  getDecisionStoreDir,
  HINT_SLASH_MAP,
  readDecisionEvents,
} from '../../lib/observability/decision-events.js';
import { parseRunEventsText, RUN_EVENTS_SUFFIX } from '../../lib/observability/run-events.js';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { isMainEntry } from '../hooks/_main-entry.js';

export const SCHEMA = 'nl-activation-report/v1';

/**
 * The two `data` keys the §3.7 comparison needs. Exported so the future writer
 * limb spells them the same way this reader does — a writer that invents
 * `activation_actual` would leave this instrument reading `null` forever while
 * looking like it works.
 */
export const ACTIVATION_FIELDS = Object.freeze({
  predicted: 'command_activation',
  observed: 'activation_observed',
});

export const AXES = Object.freeze({
  SLASH_AGREEMENT: 'activation.slash-agreement',
  HINT_ACCEPTANCE: 'activation.hint-acceptance',
  DEFERRAL_RATE: 'mission.deferral-rate',
  HINT_FOLLOWED: 'activation.hint-followed',
});

export const FIXTURE_WARNING =
  'n=10 fixture agreement is 10 percentage points per case and is NOT evidence for the §3.7 ≥90% bar';

/** Relative ledger path that predates ADR-011's git-common-dir rule. */
const FALLBACK_LEDGER_REL = '.artibot/runtime/ledger.jsonl';

/** What each activation axis actually counts — true whether or not a writer exists. */
const SLASH_COUNTS =
  `Denominator = records whose ${ACTIVATION_FIELDS.predicted} map has ≥1 true key; ` +
  `numerator = those where ${ACTIVATION_FIELDS.observed}.slash equals one of those keys.`;

const HINT_COUNTS =
  `Denominator = records with a non-empty ${ACTIVATION_FIELDS.observed}.hint_recommend; ` +
  'numerator = those with hint_accepted === true.';

const HINT_NO_PROXY =
  "The decisions store's workflow-planned.data.recommendation and topology-recommended counts " +
  'are a DIFFERENT concept (what the planner proposed, not what a user was shown and took) and ' +
  'must not be used as a proxy denominator.';

/**
 * What `activation.hint-followed` counts. The key difference from
 * `activation.hint-acceptance` is WHERE it reads: the writer puts the shown
 * hint at the top level of `data`, and no writer records an acceptance verdict
 * anywhere, so the only acceptance signal on disk is what the user typed next.
 */
const HINT_FOLLOWED_COUNTS =
  'Denominator = activation records with a non-empty top-level data.hint_recommend; numerator = ' +
  'those whose NEXT activation record in the same run carries an activation_observed.slash equal ' +
  'to the slash map value for that hint. "Next" means append order, not prompt_id order. A ' +
  'CONSECUTIVE re-record of the same prompt_id (consecutive among activation rows) is collapsed ' +
  'onto the first of them rather than counted as the following turn; a non-adjacent reappearance ' +
  'of that prompt_id counts as its own row, and rows with no prompt_id are never collapsed.';

/**
 * The sentence that keeps this axis from being read as an acceptance rate. It
 * is not one, and the gap is not small: `recommend=watch` runs with no
 * confirmation at all, so its acceptances are invisible here by construction.
 */
const HINT_FOLLOWED_BOUND =
  'This is a LOWER BOUND on hint acceptance, NOT an acceptance rate: the surfacing rule is a ' +
  'natural-language confirmation, and recommend=watch executes immediately without one, so a ' +
  'genuine acceptance that was never typed as a slash command counts as 0 here — read by_hint to ' +
  'separate watch from the rest. `unmapped` counts denominator rows whose hint has no own key in ' +
  'the slash map (there is no /workflow to accept), which can never enter the numerator; ' +
  '`no_next` counts denominator rows that are the last activation row of their run, and it cannot ' +
  'tell a finished session from one still in progress at read time (censored). The two overlap. ' +
  'resolvable_denominator = denominator - no_next, and ratio_resolvable = ' +
  'numerator / resolvable_denominator, are the CENSORING-EXCLUDED reading — the same count with ' +
  'the rows that have no following turn dropped. It is NOT an upper bound: a censored row whose ' +
  'user follows the hint later lands in both halves of the fraction, so the eventual ratio can ' +
  'exceed it (1/4 with one censored row reads 1/3 here, but resolves to 2/4 if that row follows).';

/** What this axis cannot see even when its denominator is large. */
const HINT_FOLLOWED_LIMITS =
  'Known limit: if the N+1 record fails to write, row N is paired with N+2 and the verdict is ' +
  'silently wrong — a recorder-stats record with failed > 0 in the same run is the detection ' +
  'signal (not implemented here). Ledger stores carry no run id, so their rows are grouped by ' +
  'session_id, which is coarser than a run. And the ACCEPTING turn can re-enter the denominator: ' +
  'if the prompt that types /X still carries the trigger that produced the hint (a YouTube URL ' +
  'typed again after /watch), the hook shows the hint a second time and that row is counted too — ' +
  'measured 2026-09-21, one accepted watch hint read denominator 2, numerator 1, no_next 1, raw ' +
  'ratio 0.5 and ratio_resolvable 1. Do not read the raw ratio alone; read no_next, ' +
  'ratio_resolvable and ' +
  'by_hint with it.';

/** The one summing rule every axis in this report obeys. */
const TOTALS_RULE =
  'Top-level counts sum the canonical ledger and the decisions store only — never the fallback, ' +
  'which is pre-ADR-011 residue that may overlap the canonical file; read by_store for each ' +
  'store separately.';

const MISSION_CREATED = 'mission.created';
const MISSION_DEFERRED = 'mission.candidate_deferred';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `numerator / denominator`, or `null` when nothing was measured.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null} rounded to 4 decimals; `null` iff `denominator === 0`
 */
export function ratioOf(numerator, denominator) {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** @returns {string} the fixture shipped with the plugin */
export function defaultFixturePath() {
  return path.join(PLUGIN_ROOT, 'tests', 'evals', 'fixtures', 'nl-activation.cases.jsonl');
}

/**
 * A record's event name, whichever envelope it came in: ledger lines key it as
 * `event`, run/decision events as `type`.
 *
 * @param {object} e
 * @returns {string|null}
 */
function eventName(e) {
  if (typeof e?.event === 'string') return e.event;
  if (typeof e?.type === 'string') return e.type;
  return null;
}

/**
 * @param {object[]} events
 * @returns {Record<string, number>}
 */
function countByType(events) {
  const out = {};
  for (const e of events) {
    const name = eventName(e) ?? '(unnamed)';
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

/**
 * @param {object[]} events
 * @returns {number} distinct non-empty session ids
 */
function countSessions(events) {
  const ids = new Set();
  for (const e of events) {
    const id = e?.session_id ?? e?.sessionId;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids.size;
}

/**
 * Both activation axes in ONE pass over one store's records, so either
 * destination a future writer picks is already covered.
 *
 * @param {object[]} events
 * @returns {{slash: {numerator: number, denominator: number},
 *            hint: {numerator: number, denominator: number}}}
 */
export function foldActivation(events) {
  const slash = { numerator: 0, denominator: 0 };
  const hint = { numerator: 0, denominator: 0 };
  for (const e of events) {
    const data = e?.data;
    if (!data || typeof data !== 'object') continue;
    const predicted = data[ACTIVATION_FIELDS.predicted];
    const observed = data[ACTIVATION_FIELDS.observed];
    const trueKeys =
      predicted && typeof predicted === 'object'
        ? Object.keys(predicted).filter((k) => predicted[k] === true)
        : [];
    if (trueKeys.length > 0) {
      slash.denominator += 1;
      if (typeof observed?.slash === 'string' && trueKeys.includes(observed.slash)) {
        slash.numerator += 1;
      }
    }
    if (typeof observed?.hint_recommend === 'string' && observed.hint_recommend.length > 0) {
      hint.denominator += 1;
      if (observed.hint_accepted === true) hint.numerator += 1;
    }
  }
  return { slash, hint };
}

/**
 * The activation rows of ONE run, in append order, with a re-record of a prompt
 * id collapsed onto the row it repeats.
 *
 * Two filters, both load-bearing. Rows of other types (topology-recommended,
 * recorder-stats, …) are skipped rather than ending a pairing: they interleave
 * freely, and treating one as "the next turn" would read every hint as refused.
 * A repeat of the same prompt_id is a RE-RECORD of one turn, not the next one,
 * so it neither doubles the denominator nor stands in as the following row.
 *
 * @param {object[]} events
 * @returns {Array<{promptId: string|null, data: object}>}
 */
function activationRows(events) {
  const rows = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (eventName(e) !== ACTIVATION_OBSERVED) continue;
    const data = e?.data;
    if (!data || typeof data !== 'object') continue;
    const id = typeof data.prompt_id === 'string' && data.prompt_id.length > 0 ? data.prompt_id : null;
    const prev = rows[rows.length - 1];
    if (id !== null && prev && prev.promptId === id) continue;
    rows.push({ promptId: id, data });
  }
  return rows;
}

/**
 * Did the user type the slash command a hint recommended, on the next turn?
 *
 * RUN BOUNDED, by argument type: this takes runs, not events, because the
 * pairing is only meaningful inside one run. A flattened event list would pair
 * the last row of one run with the first row of the next and report an
 * agreement that no user ever made.
 *
 * `Object.hasOwn`, not `in` — `'constructor' in HINT_SLASH_MAP` is true and
 * passes the writer's charset, so `in` would resolve a prototype member as a
 * mapped hint. `by_hint` is built on a null-prototype object for the same
 * reason: its keys come from disk.
 *
 * The writer also puts its own verdict on disk as `hint_resolved_by`, and this
 * fold DELIBERATELY IGNORES it, re-deriving the mapping from `HINT_SLASH_MAP`.
 * A stored verdict was computed by whatever version of the hook was installed
 * when the row was written; recomputing means one vocabulary decides the axis
 * for old and new rows alike, instead of the measurement inheriting a mapping
 * that has since changed.
 *
 * @param {Array<{runId: string, events: object[]}>} runs
 * @returns {{numerator: number, denominator: number, unmapped: number,
 *            no_next: number, by_hint: Record<string, object>}}
 */
export function foldHintFollowed(runs) {
  const byHint = Object.create(null);
  const out = { numerator: 0, denominator: 0, unmapped: 0, no_next: 0 };
  for (const run of Array.isArray(runs) ? runs : []) {
    const rows = activationRows(run?.events);
    for (let i = 0; i < rows.length; i += 1) {
      const hint = rows[i].data.hint_recommend;
      if (typeof hint !== 'string' || hint.length === 0) continue;
      out.denominator += 1;
      if (!Object.hasOwn(byHint, hint)) byHint[hint] = { numerator: 0, denominator: 0 };
      const bucket = byHint[hint];
      bucket.denominator += 1;
      const next = rows[i + 1];
      if (next === undefined) out.no_next += 1;
      if (!Object.hasOwn(HINT_SLASH_MAP, hint)) { out.unmapped += 1; continue; }
      if (next !== undefined && next.data?.activation_observed?.slash === HINT_SLASH_MAP[hint]) {
        out.numerator += 1;
        bucket.numerator += 1;
      }
    }
  }
  return { ...out, by_hint: { ...byHint } };
}

/**
 * Best-available run boundary for a store that has none. The decisions store
 * keeps one file per run; a ledger keeps one flat file, so its rows are grouped
 * by session id — coarser than a run, and declared as such in the axis note.
 *
 * @param {object[]} events
 * @returns {Array<{runId: string, events: object[]}>}
 */
export function runsFromEvents(events) {
  const groups = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const raw = e?.session_id ?? e?.sessionId;
    const id = typeof raw === 'string' && raw.length > 0 ? raw : '(no-run-id)';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(e);
  }
  return [...groups].map(([runId, runEvents]) => ({ runId, events: runEvents }));
}

/**
 * @param {object[]} events
 * @returns {{numerator: number, denominator: number}}
 */
export function foldDeferral(events) {
  let created = 0;
  let deferred = 0;
  for (const e of events) {
    const name = eventName(e);
    if (name === MISSION_CREATED) created += 1;
    else if (name === MISSION_DEFERRED) deferred += 1;
  }
  return { numerator: deferred, denominator: created + deferred };
}

/**
 * Read both ledger locations and the decisions store. All file CONTENT goes
 * through the owning modules' readers; only the decisions directory listing is
 * done here, because no exported API enumerates run ids.
 *
 * @param {string} projectRoot
 * @returns {{projectRoot: string, ledgers: object, decisions: object}}
 */
export function collectStores(projectRoot) {
  const canonical = readLedgerCensus(projectRoot);
  const fallback = readLedgerCensus(projectRoot, { ledgerPath: FALLBACK_LEDGER_REL });
  const sameAsCanonical = fallback.census.file.path === canonical.census.file.path;
  return {
    projectRoot,
    ledgers: {
      canonical,
      fallback: { ...fallback, same_as_canonical: sameAsCanonical },
    },
    decisions: collectDecisions(projectRoot),
  };
}

/**
 * `byRun` is ADDITIVE, not a replacement for `events`. The flattened list is
 * what every axis but `activation.hint-followed` folds, and other readers take
 * it; that axis needs the run boundary the flattening destroys, so both shapes
 * are returned from the one read.
 *
 * @param {string} projectRoot
 * @returns {{dir: string, runIds: string[], events: object[],
 *            byRun: Array<{runId: string, events: object[]}>}}
 */
function collectDecisions(projectRoot) {
  const dir = getDecisionStoreDir({ projectRoot });
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, runIds: [], events: [], byRun: [] };
  }
  const runIds = entries
    .filter((name) => name.endsWith(RUN_EVENTS_SUFFIX))
    .map((name) => name.slice(0, -RUN_EVENTS_SUFFIX.length))
    .filter((id) => id.length > 0);
  const byRun = runIds.map((id) => ({ runId: id, events: readDecisionEvents(id, { projectRoot }) }));
  return { dir, runIds, events: byRun.flatMap((r) => r.events), byRun };
}

/**
 * @param {string} fixturePath
 * @returns {Promise<{path: string, cases: object[]}>}
 */
export async function loadFixtureCases(fixturePath) {
  let raw;
  try {
    raw = await readFile(fixturePath, 'utf8');
  } catch {
    return { path: fixturePath, cases: [] };
  }
  return { path: fixturePath, cases: parseRunEventsText(raw) };
}

/**
 * @param {{events: object[], census: object, same_as_canonical?: boolean}} store
 * @returns {object}
 */
function ledgerStoreBlock(store) {
  const { census, events } = store;
  const block = {
    path: census.file.path,
    present: census.file.present,
    lines: { raw: census.lines.raw, nonblank: census.lines.nonblank },
    survivors: census.survivors,
    dropped_total: census.dropped_total,
    sessions: countSessions(events),
    events_by_type: countByType(events),
  };
  if (typeof store.same_as_canonical === 'boolean') {
    block.same_as_canonical = store.same_as_canonical;
  }
  return block;
}

/**
 * The stores an activation axis folds, and which of them the top-level counts
 * sum. ONE rule for every axis in this report: canonical + decisions, never the
 * fallback. `mission.deferral-rate` already excluded it unconditionally, and an
 * axis-dependent summing policy would make two rows of the same document mean
 * different things by the same field name. The fallback is pre-ADR-011 residue
 * that may overlap the canonical ledger — in a non-git root it IS the same file
 * — so it stays visible in `by_store` and out of the total.
 *
 * @param {object} ledgers
 * @param {object} decisions
 * @returns {Array<{key: string, events: object[], counted: boolean}>}
 */
function activationSources(ledgers, decisions) {
  return [
    { key: 'canonical', events: ledgers.canonical.events, counted: true },
    { key: 'fallback', events: ledgers.fallback.events, counted: false },
    { key: 'decisions', events: decisions.events, counted: true },
  ];
}

/**
 * One activation axis. The `note` is chosen by the denominator, not fixed: an
 * "UNMEASURED, no writer records this yet" sentence becomes FALSE the day the
 * writer lands, and a stale note on a row that now carries real numbers is
 * exactly the kind of frozen claim this report exists to avoid.
 *
 * @param {object} args
 * @returns {object}
 */
function activationAxis({ axis, pick, unmeasuredNote, measuredNote, ledgers, decisions, measuredAt }) {
  const byStore = {};
  let numerator = 0;
  let denominator = 0;
  for (const src of activationSources(ledgers, decisions)) {
    const counts = pick(foldActivation(src.events));
    byStore[src.key] = { numerator: counts.numerator, denominator: counts.denominator };
    if (!src.counted) continue;
    numerator += counts.numerator;
    denominator += counts.denominator;
  }
  return {
    axis,
    numerator,
    denominator,
    ratio: ratioOf(numerator, denominator),
    measured_at: measuredAt,
    ledger_path: ledgers.canonical.census.file.path,
    note: denominator === 0 ? unmeasuredNote : measuredNote,
    by_store: byStore,
  };
}

/**
 * Same three stores as `activationSources`, and the same summing rule, but run
 * bounded.
 *
 * @param {object} ledgers
 * @param {object} decisions
 * @returns {Array<{key: string, runs: Array<object>, counted: boolean}>}
 */
function hintFollowedSources(ledgers, decisions) {
  return [
    { key: 'canonical', runs: runsFromEvents(ledgers.canonical.events), counted: true },
    { key: 'fallback', runs: runsFromEvents(ledgers.fallback.events), counted: false },
    { key: 'decisions', runs: decisions.byRun ?? [], counted: true },
  ];
}

/**
 * Merge one store's per-hint counts into the running total.
 *
 * THE KEYS ARE NOT FILTERED. `foldHintFollowed` keeps any command-shaped hint
 * the writer admitted — `constructor` passes `SLASH_NAME_RE` and can reach disk
 * — so `into` must be null-prototype AND the lookup must be `Object.hasOwn`. A
 * plain `{}` with `into[hint] ?? (into[hint] = …)` resolves `into.constructor`
 * to the `Object` function, does `+=` on it (NaN, and a write onto a shared
 * global), and drops that hint from the breakdown, so `by_hint`'s denominators
 * would no longer sum to the axis denominator.
 *
 * @param {Record<string, object>} into - null-prototype accumulator
 * @param {Record<string, object>} from
 */
function mergeByHint(into, from) {
  for (const [hint, counts] of Object.entries(from)) {
    if (!Object.hasOwn(into, hint)) into[hint] = { numerator: 0, denominator: 0 };
    into[hint].numerator += counts.numerator;
    into[hint].denominator += counts.denominator;
  }
}

/**
 * The fourth axis. Shaped like the other three — `by_store` carries the same
 * `{numerator, denominator}` pair, so one field name means one thing across
 * rows — plus the four fields a reader needs to qualify the answer:
 * `unmapped`, `no_next`, `resolvable_denominator`, `ratio_resolvable`.
 *
 * `byHint` is null-prototype for the same reason `foldHintFollowed`'s is: its
 * keys come from disk. `byStore`'s three keys are literals written here.
 *
 * @param {object} args
 * @returns {object}
 */
function hintFollowedAxis({ ledgers, decisions, measuredAt }) {
  const byStore = {};
  const byHint = Object.create(null);
  const total = { numerator: 0, denominator: 0, unmapped: 0, no_next: 0 };
  for (const src of hintFollowedSources(ledgers, decisions)) {
    const counts = foldHintFollowed(src.runs);
    byStore[src.key] = { numerator: counts.numerator, denominator: counts.denominator };
    if (!src.counted) continue;
    for (const key of Object.keys(total)) total[key] += counts[key];
    mergeByHint(byHint, counts.by_hint);
  }
  const resolvable = total.denominator - total.no_next;
  return {
    axis: AXES.HINT_FOLLOWED,
    numerator: total.numerator,
    denominator: total.denominator,
    ratio: ratioOf(total.numerator, total.denominator),
    resolvable_denominator: resolvable,
    ratio_resolvable: ratioOf(total.numerator, resolvable),
    unmapped: total.unmapped,
    no_next: total.no_next,
    measured_at: measuredAt,
    ledger_path: ledgers.canonical.census.file.path,
    note:
      (total.denominator === 0
        ? 'UNMEASURED: no activation record in the counted stores carries a top-level ' +
          'hint_recommend yet, so denominator 0 is the result, not a defect. '
        : '') + `${HINT_FOLLOWED_COUNTS} ${HINT_FOLLOWED_BOUND} ${HINT_FOLLOWED_LIMITS} ${TOTALS_RULE}`,
    by_store: byStore,
    by_hint: { ...byHint },
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
function deferralAxis({ ledgers, decisions, measuredAt }) {
  const canonical = foldDeferral(ledgers.canonical.events);
  return {
    axis: AXES.DEFERRAL_RATE,
    numerator: canonical.numerator,
    denominator: canonical.denominator,
    ratio: ratioOf(canonical.numerator, canonical.denominator),
    measured_at: measuredAt,
    ledger_path: ledgers.canonical.census.file.path,
    note:
      'Auxiliary, NOT the §3.7 ≥90% axis. Top-level counts are the CANONICAL ledger only — ' +
      'the fallback is pre-ADR-011 residue that may overlap it, so never sum the stores; ' +
      'read by_store for each one separately.',
    by_store: {
      canonical,
      fallback: foldDeferral(ledgers.fallback.events),
      decisions: foldDeferral(decisions.events),
    },
  };
}

/**
 * @param {object[]} cases
 * @returns {Array<{id: string|null, command_activation: object|null}>}
 */
function fixtureExpectations(cases) {
  return cases.map((c) => ({
    id: typeof c?.id === 'string' ? c.id : null,
    command_activation: c?.expect?.[ACTIVATION_FIELDS.predicted] ?? null,
  }));
}

/**
 * Pure fold: stores in, report out. No I/O, so the whole schema is unit
 * testable without touching a real store.
 *
 * @param {{projectRoot: string, ledgers: object, decisions: object,
 *          fixture: {path: string, cases: object[]}, measuredAt: string}} input
 * @returns {object}
 */
export function buildReport({ projectRoot, ledgers, decisions, fixture, measuredAt }) {
  const expected = fixtureExpectations(fixture.cases);
  return {
    schema: SCHEMA,
    measured_at: measuredAt,
    project_root: projectRoot,
    stores: {
      canonical: ledgerStoreBlock(ledgers.canonical),
      fallback: ledgerStoreBlock(ledgers.fallback),
      decisions: {
        dir: decisions.dir,
        files: decisions.runIds.length,
        events: decisions.events.length,
        events_by_type: countByType(decisions.events),
      },
    },
    axes: [
      activationAxis({
        axis: AXES.SLASH_AGREEMENT,
        pick: (f) => f.slash,
        unmeasuredNote:
          `UNMEASURED: no writer records ${ACTIVATION_FIELDS.predicted} to any store yet ` +
          `(compileMission holds it in memory), so denominator 0 is the result, not a defect. ${SLASH_COUNTS}`,
        measuredNote: `${SLASH_COUNTS} ${TOTALS_RULE}`,
        ledgers,
        decisions,
        measuredAt,
      }),
      activationAxis({
        axis: AXES.HINT_ACCEPTANCE,
        pick: (f) => f.hint,
        unmeasuredNote:
          'UNMEASURED, and structurally so: the writer records the shown hint at ' +
          'data.hint_recommend (TOP LEVEL) and records no acceptance verdict at all, while this ' +
          `axis reads ${ACTIVATION_FIELDS.observed}.hint_recommend (nested) plus hint_accepted — ` +
          `read ${AXES.HINT_FOLLOWED} instead. ${HINT_COUNTS} ${HINT_NO_PROXY}`,
        measuredNote: `${HINT_COUNTS} ${HINT_NO_PROXY} ${TOTALS_RULE}`,
        ledgers,
        decisions,
        measuredAt,
      }),
      deferralAxis({ ledgers, decisions, measuredAt }),
      hintFollowedAxis({ ledgers, decisions, measuredAt }),
    ],
    fixture: {
      path: fixture.path,
      cases: fixture.cases.length,
      with_command_activation: expected.filter((c) => c.command_activation !== null).length,
      expected,
      warning: FIXTURE_WARNING,
    },
  };
}

/**
 * @param {string[]} args
 * @returns {{projectRoot: string, fixturePath: string}}
 */
export function parseArgs(args) {
  let projectRoot = null;
  let fixturePath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--project-root' && args[i + 1]) { projectRoot = args[i + 1]; i += 1; }
    else if (args[i] === '--fixture' && args[i + 1]) { fixturePath = args[i + 1]; i += 1; }
  }
  return {
    projectRoot: projectRoot ?? resolveProjectRoot(process.cwd()),
    fixturePath: fixturePath ?? defaultFixturePath(),
  };
}

/** @returns {Promise<void>} */
async function main() {
  const { projectRoot, fixturePath } = parseArgs(process.argv.slice(2));
  const stores = collectStores(projectRoot);
  const fixture = await loadFixtureCases(fixturePath);
  const report = buildReport({ ...stores, fixture, measuredAt: new Date().toISOString() });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// Only run when executed directly — the tests import the exports above, and an
// unguarded main() would print a whole report into the test worker's stdout.
// See scripts/hooks/_main-entry.js for why suffix-matching cannot do this.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[nl-activation-report] ${err.message || err}\n`);
    process.exit(1);
  });
}
