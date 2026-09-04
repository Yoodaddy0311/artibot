/**
 * `/doctor` Check 8 and Check 9 — the judgement half, with no I/O of its own.
 *
 * Check 8 asks whether the three state artefacts still agree: does
 * `reduce(journal)` still render the `state.yaml` projection, does the ledger
 * still contain every `state_version` the store committed, and is the version
 * counter itself unbroken (design §3.6). Check 9 asks whether the
 * mission artifacts under `.artibot/missions/<id>/` are healthy, against the
 * ten-item list this file treats as canonical (Hardening §32).
 *
 * ── Why this module reads nothing ──────────────────────────────────────────
 * Every input arrives as an argument. The caller — the `/doctor` command — is
 * the half that touches the filesystem, so these functions have no clock, no
 * `node:fs`, and no randomness, and the same inputs always produce the same
 * verdict. `./journal.js` is imported for `reduceProjectState` and does itself
 * import `node:fs` for its reader; that reader is deliberately NOT imported
 * here, and `reduceProjectState` is pure (journal.js#reduceProjectState).
 *
 * ── "unmeasured" is a first-class verdict, not a soft pass ─────────────────
 * A check that never ran must not report the same thing as a check that ran
 * and found nothing. Every function here answers `unmeasured` when the input
 * it would need was not supplied, and `worstOf` ranks `unmeasured` ABOVE
 * `pass` so a partly-measured Check 9 cannot summarise itself as healthy. The
 * cost is that a caller supplying few inputs reads as `unmeasured` rather than
 * green, which is the intended direction.
 *
 * ── Why staleness arrives as an injected port ──────────────────────────────
 * `classifyStaleness` lives in `lib/runtime/artifact-lifecycle.js` (L5) and
 * this module is L2. ESLint blocks runtime-layer imports from L2
 * (eslint.config.js:154-207), and design §1-8 fixes the resolution: L2 modules
 * are "순수 모듈 + 포트 주입" and every upward call is received as an injected
 * port. So the classifier is passed in, never imported and never
 * reimplemented. When it is absent, its three items go `unmeasured`.
 * `STALE_STATE` below duplicates T-40's returned vocabulary as string
 * literals for the same reason; `tests/commands/doctor-checks-8-9.test.js`
 * asserts it still equals T-40's exported `StaleState`, so the copy cannot
 * drift silently.
 *
 * ── What these functions cannot see ────────────────────────────────────────
 * - Anything the caller did not read. A mission folder the caller skipped is
 *   invisible here, and nothing in this module can tell that apart from a
 *   project with fewer missions.
 * - Whether the frontmatter it was handed reflects the bytes on disk. Parsing
 *   is the caller's job, so a parser bug reads as artifact health.
 * - Live behaviour of any kind. These are comparisons over supplied records,
 *   never evidence that `/doctor` ran or that the store is being written.
 *
 * @module lib/project-state/doctor-checks
 */

import { buildProjection, renderProjection } from './projection.js';
import { reduceProjectState } from './journal.js';

/** The four verdicts every check in this module returns. */
export const CheckStatus = Object.freeze({
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
  UNMEASURED: 'unmeasured',
});

/**
 * Severity order. `unmeasured` outranks `pass` on purpose: a summary that let
 * an unmeasured item round down to green would recreate the exact "확인 안 한
 * 0" that Check 8 exists to expose.
 */
const RANK = Object.freeze({ pass: 0, unmeasured: 1, warn: 2, fail: 3 });

/**
 * T-40's `StaleState` values, duplicated as literals because L2 may not import
 * L5 (see the module header). Kept honest by a drift test, not by discipline.
 */
export const STALE_STATE = Object.freeze({
  CURRENT: 'CURRENT',
  STALE: 'STALE',
  INVALID: 'INVALID',
  NOT_ACCEPTABLE: 'NOT_ACCEPTABLE',
  BROKEN: 'BROKEN',
});

/**
 * The canonical document these ten items are transcribed from.
 *
 * This is the TRACKED copy (OD-3). A byte-identical file sits under `docs/`,
 * but `.gitignore:19` ignores `/docs/`, so a citation pointing there names a
 * path that does not exist in a fresh clone. Verified 2026-09-02: both files
 * hash to md5 2b96a0cf7124f494985b2eaddb460c4c, so the line numbers below hold
 * for either copy.
 */
export const ARTIFACT_HEALTH_SOURCE = '.artibot/guides/v5-design/ADDENDUM-HARDENING.md';

/**
 * Hardening §32's ten checks, in document order, each with the line that
 * states it. The order is the document's; renaming or reordering a key is a
 * change to the canonical list, not a refactor.
 */
export const ARTIFACT_HEALTH_ITEMS = Object.freeze({
  missing_intent: `${ARTIFACT_HEALTH_SOURCE}:994 "Missing intent.md"`,
  broken_based_on: `${ARTIFACT_HEALTH_SOURCE}:995 "Broken based_on revision"`,
  stale_plan: `${ARTIFACT_HEALTH_SOURCE}:996 "Stale plan"`,
  invalid_review: `${ARTIFACT_HEALTH_SOURCE}:997 "Invalid review"`,
  duplicate_canonical_artifact: `${ARTIFACT_HEALTH_SOURCE}:998 "Duplicate canonical artifact"`,
  orphan_mission: `${ARTIFACT_HEALTH_SOURCE}:999 "Orphan mission"`,
  expired_task_lease: `${ARTIFACT_HEALTH_SOURCE}:1000 "Expired task lease"`,
  ledger_state_mismatch: `${ARTIFACT_HEALTH_SOURCE}:1001 "Ledger/state mismatch"`,
  missing_evidence_reference: `${ARTIFACT_HEALTH_SOURCE}:1002 "Missing evidence reference"`,
  unsupported_schema_version: `${ARTIFACT_HEALTH_SOURCE}:1003 "Unsupported schema version"`,
});

/** The four canonical basenames. Anything else in a mission folder is extra. */
const CANONICAL_STEMS = Object.freeze(['intent', 'plan', 'review', 'outcome']);

/** Derivative names governance 08 forbids outright (package-v1.1/08, "No derivative file rule"). */
const FORBIDDEN_STEMS = Object.freeze([
  'intent-final', 'intent-v3', 'plan2', 'status', 'progress', 'todo', 'new-plan',
]);

/**
 * Reduce a list of verdicts to the most severe one.
 *
 * @param {string[]} statuses - Verdicts to combine.
 * @returns {string} The most severe verdict, `pass` when the list is empty.
 */
export function worstOf(statuses) {
  let out = CheckStatus.PASS;
  for (const s of statuses) {
    if ((RANK[s] ?? 0) > RANK[out]) out = s;
  }
  return out;
}

/**
 * Serialise with keys in a fixed order so two structurally equal objects
 * always produce the same text.
 *
 * @param {*} value - Any JSON-representable value.
 * @returns {string} A key-order-independent serialisation.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Compare the rebuilt projection against the one the caller read.
 *
 * A STRING projection is compared byte for byte, which is design §3.6's rule
 * exactly. An OBJECT projection has no bytes left to compare — it already went
 * through a YAML parse, which does not preserve key order — so it is compared
 * structurally instead. The two are different strengths of evidence and the
 * finding says which one ran.
 *
 * @param {object} state - The snapshot folded from the journal.
 * @param {object|string} projection - The projection the caller read.
 * @returns {object[]} Zero or one finding.
 */
function compareProjection(state, projection) {
  if (typeof projection === 'string') {
    const rendered = renderProjection(state);
    if (rendered === projection) return [];
    return [{
      code: 'projection-drift', status: CheckStatus.FAIL, comparison: 'bytes',
      detail: `rendered state.yaml (${rendered.length} B) differs from the supplied text (${projection.length} B)`,
    }];
  }
  const rebuilt = stableStringify(buildProjection(state));
  if (rebuilt === stableStringify(projection)) return [];
  return [{
    code: 'projection-drift', status: CheckStatus.FAIL, comparison: 'structural',
    detail: 'the projection rebuilt from the journal differs from the supplied projection object',
  }];
}

/**
 * Collect the distinct, sorted `state_version` values in a record list.
 *
 * @param {object[]} records - Records carrying `state_version`.
 * @param {Function} pick - Reads the version out of one record.
 * @returns {number[]} Sorted distinct integer versions.
 */
function versionSet(records, pick) {
  const seen = records.map(pick).filter((v) => Number.isInteger(v));
  return [...new Set(seen)].sort((a, b) => a - b);
}

/**
 * Check the "ledger is a superset of the store" invariant (design §1-2).
 *
 * The two directions are reported separately because they mean opposite
 * things. A version in the ledger but not the store is a crash between the two
 * appends: the store is behind, and the invariant still holds. A version in the
 * store but not the ledger is a committed write with no event, which is the
 * invariant broken and the lost-update signature itself.
 *
 * @param {object[]} journal - Store records.
 * @param {object[]} events - Ledger events.
 * @returns {object[]} Findings.
 */
function compareLedgerVersions(journal, events) {
  const store = versionSet(journal, (r) => r?.state_version);
  const ledger = versionSet(
    events.filter((e) => e?.event === 'state.updated'),
    (e) => e?.data?.state_version,
  );
  const ledgerSet = new Set(ledger);
  const storeSet = new Set(store);
  const findings = [];
  const extraInStore = store.filter((v) => !ledgerSet.has(v));
  const missingInStore = ledger.filter((v) => !storeSet.has(v));
  if (extraInStore.length > 0) {
    findings.push({
      code: 'ledger-subset-violation', status: CheckStatus.FAIL, versions: extraInStore,
      detail: 'committed store version(s) with no paired state.updated event — the superset invariant is broken',
    });
  }
  if (missingInStore.length > 0) {
    findings.push({
      code: 'store-behind-ledger', status: CheckStatus.WARN, versions: missingInStore,
      detail: 'ledger version(s) absent from the store — a crash between the two appends; the invariant holds',
    });
  }
  return findings;
}

/**
 * Check 8, first half — does `reduce(journal)` still equal `state.yaml`, and
 * does the ledger still hold every version the store committed?
 *
 * All THREE inputs are required. A parity verdict reached without one of them
 * would be a partial comparison reported as a whole one, so their absence
 * produces `unmeasured` rather than a narrower pass.
 *
 * The reader's line census (F-30) is a FOURTH, optional input, reported under
 * its own key, NOT in `findings` — `worstOf` ranks `unmeasured` above `pass`,
 * so an unmeasured census finding would demote every caller without one. Only
 * `dropped_total.loss > 0` adds a finding, and it is `warn`: damaged lines do
 * not change the parity verdict and the ledger is the truth (no `--fix`).
 *
 * @param {object} input - Check inputs.
 * @param {object[]} input.events - Ledger events (`readLedgerCensus().events`).
 * @param {object[]} input.journal - Store journal records.
 * @param {object|string} input.projection - The `state.yaml` projection, parsed or raw.
 * @param {string} [input.project] - Project name for the base snapshot.
 * @param {object} [input.census] - `readLedgerCensus().census`; absent = NOT COUNTED.
 * @returns {{status: string, findings: object[], census: object}} The verdict,
 *   its findings, and the census verdict (`unmeasured` | `pass` | `warn`).
 */
export function checkLedgerStateParity(input = {}) {
  const { events, journal, projection, project, census } = input ?? {};
  const censusVerdict = judgeCensus(census);
  const absent = [];
  if (!Array.isArray(events)) absent.push('events (ledger)');
  if (!Array.isArray(journal)) absent.push('journal (store)');
  if (projection === null || projection === undefined) absent.push('projection (state.yaml)');
  if (absent.length > 0) {
    return {
      status: CheckStatus.UNMEASURED,
      findings: [{
        code: 'parity-inputs-absent', status: CheckStatus.UNMEASURED, absent,
        detail: `not supplied: ${absent.join(', ')} — parity was not compared, not compared and found equal`,
      }],
      census: censusVerdict,
    };
  }
  const projectName = project
    ?? (typeof projection === 'object' ? projection.project : undefined)
    ?? 'artibot';
  const { state, warnings } = reduceProjectState(journal, { project: projectName });
  const findings = warnings.map((w) => ({
    code: 'journal-warning', status: CheckStatus.WARN, detail: w,
  }));
  findings.push(...compareProjection(state, projection));
  findings.push(...compareLedgerVersions(journal, events));
  if (censusVerdict.status === CheckStatus.WARN) {
    findings.push({
      code: 'ledger-lines-dropped', status: CheckStatus.WARN,
      loss: censusVerdict.loss, selection: censusVerdict.selection, path: censusVerdict.path,
      detail: `the reader dropped ${censusVerdict.loss.corrupt + censusVerdict.loss.malformed_envelope + censusVerdict.loss.duplicate} damaged line(s) of ${censusVerdict.nonblank} — see census.loss; selection drops are deliberate and not counted here`,
    });
  }
  return { status: worstOf(findings.map((f) => f.status)), findings, census: censusVerdict };
}

/**
 * Turn the reader's census into Check 8's census verdict: `unmeasured` when
 * absent, malformed, or counted over an absent/unreadable file (zero lines of
 * nothing is not a clean ledger); `warn` on any damage; `pass` otherwise.
 * Selection drops never warn — they are the caller's own filters.
 *
 * @param {unknown} census - `readLedgerCensus().census`, or absent.
 * @returns {{status: string, reason?: string, loss?: object, selection?: object,
 *   nonblank?: number, path?: string|null, file?: object}} The census verdict.
 */
function judgeCensus(census) {
  if (!isCensusShaped(census)) {
    return {
      status: CheckStatus.UNMEASURED,
      reason: 'census not supplied — line loss was not counted, not counted and found zero',
    };
  }
  const file = { present: census.file?.present === true, readable: census.file?.readable === true };
  const path = census.file?.path ?? null;
  if (!file.present || !file.readable) {
    const what = file.present ? 'ledger file present but unreadable' : 'ledger file absent';
    return { status: CheckStatus.UNMEASURED, file, path, reason: `${what} — no line was counted; not a clean ledger` };
  }
  return {
    status: census.dropped_total.loss > 0 ? CheckStatus.WARN : CheckStatus.PASS,
    file, path, nonblank: census.lines?.nonblank ?? null,
    loss: { ...census.dropped.loss }, selection: { ...census.dropped.selection },
  };
}

/**
 * Whether `census` carries the F-30 shape — every counter an integer, not a
 * truthy container (a string there would print `NaN damaged line(s)`).
 * @param {unknown} census - candidate.
 * @returns {boolean} true when every counted field is an integer.
 */
function isCensusShaped(census) {
  if (census === null || typeof census !== 'object') return false;
  const ints = (obj, keys) => obj !== null && typeof obj === 'object'
    && keys.every((k) => Number.isInteger(obj[k]));
  return ints(census.dropped_total, ['loss', 'selection']) && ints(census.lines, ['nonblank'])
    && ints(census.dropped?.loss, ['corrupt', 'malformed_envelope', 'duplicate'])
    && ints(census.dropped?.selection, ['rejected_excluded', 'filtered_out']);
}

/**
 * Enumerate the ways the `state_version` counter can be broken.
 *
 * `state_version` increases by one per committed write, so a hole in the
 * sequence is a lost update (design §3.6). Regressions and duplicates are the
 * same failure in the other two shapes — a record numbered below one already
 * seen, and two records claiming one number — and all three are reported as
 * failures. Listing only holes would be a denial list, which fails open on the
 * two shapes it does not name.
 *
 * @param {object} input - Check inputs.
 * @param {object[]} input.journal - Store journal records, in append order.
 * @returns {{status: string, findings: object[], versions: number[], gaps: number[],
 *   regressions: object[], duplicates: number[]}} The verdict and the enumerations.
 */
export function checkStateVersionGaps(input = {}) {
  const { journal } = input ?? {};
  if (!Array.isArray(journal)) {
    return {
      status: CheckStatus.UNMEASURED,
      findings: [{
        code: 'journal-absent', status: CheckStatus.UNMEASURED,
        detail: 'no journal supplied — the version sequence was not read',
      }],
      versions: [], gaps: [], regressions: [], duplicates: [],
    };
  }
  const versions = journal.map((r) => r?.state_version).filter((v) => Number.isInteger(v));
  const { gaps, regressions, duplicates } = scanVersions(versions);
  const findings = buildVersionFindings({ journal, versions, gaps, regressions, duplicates });
  return {
    status: worstOf(findings.map((f) => f.status)),
    findings, versions, gaps, regressions, duplicates,
  };
}

/**
 * Walk the version sequence once, collecting all three defect shapes.
 *
 * @param {number[]} versions - Versions in append order.
 * @returns {{gaps: number[], regressions: object[], duplicates: number[]}} Defects found.
 */
function scanVersions(versions) {
  const regressions = [];
  const duplicates = [];
  const seen = new Set();
  let highest = null;
  versions.forEach((v, index) => {
    if (seen.has(v)) duplicates.push(v);
    else seen.add(v);
    if (highest !== null && v < highest) regressions.push({ index, version: v, after: highest });
    if (highest === null || v > highest) highest = v;
  });
  const gaps = [];
  for (let i = 1; i <= (highest ?? 0); i += 1) {
    if (!seen.has(i)) gaps.push(i);
  }
  return { gaps, regressions, duplicates: [...new Set(duplicates)] };
}

/**
 * Turn the three enumerations into findings.
 *
 * @param {object} scan - `{journal, versions, gaps, regressions, duplicates}`.
 * @returns {object[]} Findings.
 */
function buildVersionFindings(scan) {
  const { journal, versions, gaps, regressions, duplicates } = scan;
  const findings = [];
  if (journal.length > 0 && versions.length === 0) {
    findings.push({
      code: 'no-versioned-records', status: CheckStatus.WARN,
      detail: `${journal.length} journal record(s), none carrying an integer state_version`,
    });
  }
  if (gaps.length > 0) {
    findings.push({
      code: 'state-version-gap', status: CheckStatus.FAIL, versions: gaps,
      detail: `missing state_version(s): ${gaps.join(', ')} — a committed write was lost`,
    });
  }
  if (regressions.length > 0) {
    findings.push({
      code: 'state-version-regression', status: CheckStatus.FAIL, regressions,
      detail: regressions.map((r) => `record ${r.index} is version ${r.version} after ${r.after}`).join('; '),
    });
  }
  if (duplicates.length > 0) {
    findings.push({
      code: 'state-version-duplicate', status: CheckStatus.FAIL, versions: duplicates,
      detail: `state_version(s) claimed twice: ${duplicates.join(', ')} — two writes for one CAS slot`,
    });
  }
  return findings;
}

/**
 * Build one item verdict.
 *
 * @param {string} key - Item key.
 * @param {string} status - Verdict.
 * @param {object[]} [findings] - Supporting findings.
 * @returns {object} `{status, canonical, findings}`.
 */
function item(key, status, findings = []) {
  return { status, canonical: ARTIFACT_HEALTH_ITEMS[key], findings };
}

/**
 * An item whose required input the caller never supplied.
 *
 * @param {string} key - Item key.
 * @param {string} why - What was missing.
 * @returns {object} An `unmeasured` item verdict.
 */
function unmeasuredItem(key, why) {
  return item(key, CheckStatus.UNMEASURED, [{
    code: 'input-absent', status: CheckStatus.UNMEASURED, detail: why,
  }]);
}

/**
 * Item 1 — a mission folder with no `intent.md`.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @returns {object} Item verdict.
 */
function itemMissingIntent(missions) {
  const findings = missions
    .filter((m) => m.files.intent === null || m.files.intent === undefined)
    .map((m) => ({
      code: 'missing-intent', status: CheckStatus.FAIL, mission_id: m.mission_id,
      detail: `${m.mission_id} has no intent.md — the mission has no root artifact`,
    }));
  return item('missing_intent', worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Run the injected classifier over every derived artifact of every mission.
 *
 * The live revision each `based_on` is judged against is the mission's own
 * artifacts' `revision` fields, which is what `state.yaml` projects
 * (package-v1.1/06). An ABSENT derived artifact is skipped rather than failed:
 * a mission with no review yet has no broken edge, it has no edge.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @param {Function} classify - Injected `classifyStaleness` port.
 * @returns {object[]} One result per classified artifact.
 */
function classifyAll(missions, classify) {
  const out = [];
  for (const m of missions) {
    const current = {
      intentRevision: m.files.intent?.revision,
      planRevision: m.files.plan?.revision,
      reviewRevision: m.files.review?.revision,
    };
    for (const kind of ['plan', 'review', 'outcome']) {
      const fm = m.files[kind];
      if (fm === null || fm === undefined) continue;
      const verdict = classify({ kind, basedOn: fm.based_on, current });
      out.push({ mission_id: m.mission_id, kind, ...verdict });
    }
  }
  return out;
}

/**
 * Turn classifier results into one item, selecting by returned state.
 *
 * @param {string} key - Item key.
 * @param {object[]} results - Classifier results.
 * @param {string} state - The `STALE_STATE` value this item owns.
 * @param {string[]} kinds - Artifact kinds this item covers.
 * @returns {object} Item verdict.
 */
function itemFromStaleness(key, results, state, kinds) {
  const findings = results
    .filter((r) => r.state === state && kinds.includes(r.kind))
    .map((r) => ({
      code: key.replace(/_/g, '-'), status: CheckStatus.FAIL, mission_id: r.mission_id,
      kind: r.kind, state: r.state, staleMembers: r.staleMembers,
      detail: `${r.mission_id}/${r.kind}.md is ${r.state} (based_on: ${(r.staleMembers ?? []).join(', ') || 'n/a'})`,
    }));
  return item(key, worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Item 5 — a second file competing with a canonical artifact.
 *
 * Judged against an ALLOWLIST of the four canonical basenames: any extra file
 * whose stem starts with a canonical stem, plus governance 08's named
 * derivatives. A denial list of today's known bad names would pass every new
 * one invented tomorrow.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @returns {object} Item verdict.
 */
function itemDuplicateCanonical(missions) {
  const measurable = missions.filter((m) => Array.isArray(m.extraFiles));
  if (measurable.length === 0) {
    return unmeasuredItem('duplicate_canonical_artifact',
      'no mission supplied extraFiles — the folder listing was never read');
  }
  const findings = [];
  for (const m of measurable) {
    for (const name of m.extraFiles) {
      const stem = String(name).replace(/\.md$/i, '').toLowerCase();
      if (CANONICAL_STEMS.includes(stem)) continue;
      const competes = CANONICAL_STEMS.some((c) => stem.startsWith(c))
        || FORBIDDEN_STEMS.includes(stem);
      if (!competes) continue;
      findings.push({
        code: 'duplicate-canonical-artifact', status: CheckStatus.FAIL,
        mission_id: m.mission_id, file: name,
        detail: `${m.mission_id}/${name} competes with a canonical artifact (governance 08 forbids derivative files)`,
      });
    }
  }
  return item('duplicate_canonical_artifact', worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Item 6 — a mission folder the live state does not know about.
 *
 * A mission that is absent from the active set BUT carries an `outcome.md` is
 * a closed mission, not an orphan; that is the normal end state. An orphan is
 * one that left the live state with no outcome to show for it.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @param {string[]|undefined} activeMissionIds - Mission ids the store holds.
 * @returns {object} Item verdict.
 */
function itemOrphanMission(missions, activeMissionIds) {
  if (!Array.isArray(activeMissionIds)) {
    return unmeasuredItem('orphan_mission',
      'no activeMissionIds supplied — folders were not compared against the live state');
  }
  const active = new Set(activeMissionIds);
  const findings = missions
    .filter((m) => !active.has(m.mission_id))
    .filter((m) => m.files.outcome === null || m.files.outcome === undefined)
    .map((m) => ({
      code: 'orphan-mission', status: CheckStatus.FAIL, mission_id: m.mission_id,
      detail: `${m.mission_id} is in no active mission and produced no outcome.md`,
    }));
  return item('orphan_mission', worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Item 7 — a task lease whose `expires_at` is already past.
 *
 * @param {object|undefined} leases - `task_leases` from the snapshot.
 * @param {string|undefined} now - The instant to judge against, ISO-8601.
 * @returns {object} Item verdict.
 */
function itemExpiredLease(leases, now) {
  const nowMs = now === undefined || now === null ? NaN : new Date(now).getTime();
  if (leases === null || leases === undefined || Number.isNaN(nowMs)) {
    return unmeasuredItem('expired_task_lease',
      'leases and a readable `now` are both required — no lease was evaluated');
  }
  const findings = [];
  for (const [missionId, byTask] of Object.entries(leases)) {
    for (const [taskId, lease] of Object.entries(byTask ?? {})) {
      const expiresMs = new Date(lease?.expires_at).getTime();
      if (Number.isNaN(expiresMs) || expiresMs > nowMs) continue;
      findings.push({
        code: 'expired-task-lease', status: CheckStatus.FAIL, mission_id: missionId,
        task_id: taskId, expires_at: lease.expires_at,
        detail: `${missionId}/${taskId} lease expired at ${lease.expires_at} (owner ${lease?.owner ?? 'unknown'})`,
      });
    }
  }
  return item('expired_task_lease', worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Item 8 — the Check 8 verdict, referenced rather than recomputed.
 *
 * @param {object|undefined} parity - A `checkLedgerStateParity` result.
 * @returns {object} Item verdict.
 */
function itemLedgerStateMismatch(parity) {
  if (parity === null || parity === undefined || typeof parity.status !== 'string') {
    return unmeasuredItem('ledger_state_mismatch',
      'no Check 8 parity result supplied — ledger/state agreement was not evaluated');
  }
  return item('ledger_state_mismatch', parity.status, parity.findings ?? []);
}

/**
 * Item 9 — an `evidence_refs` entry naming an id the registry does not hold.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @param {string[]|undefined} evidenceIds - Ids the evidence registry holds.
 * @returns {object} Item verdict.
 */
function itemMissingEvidence(missions, evidenceIds) {
  if (!Array.isArray(evidenceIds)) {
    return unmeasuredItem('missing_evidence_reference',
      'no evidenceIds supplied — evidence_refs were not resolved');
  }
  const known = new Set(evidenceIds);
  const findings = [];
  for (const m of missions) {
    for (const [kind, fm] of Object.entries(m.files)) {
      const refs = Array.isArray(fm?.evidence_refs) ? fm.evidence_refs : [];
      for (const ref of refs.filter((r) => !known.has(r))) {
        findings.push({
          code: 'missing-evidence-reference', status: CheckStatus.FAIL,
          mission_id: m.mission_id, kind, ref,
          detail: `${m.mission_id}/${kind}.md cites evidence ${ref}, which the registry does not hold`,
        });
      }
    }
  }
  return item('missing_evidence_reference', worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Item 10 — an artifact declaring a schema version this build cannot read.
 *
 * An artifact with NO declared version is reported too: `schema_version` is
 * required by design §28-29, so its absence is an unreadable version rather
 * than a supported one.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @param {Array|undefined} supported - Schema versions this build accepts.
 * @returns {object} Item verdict.
 */
function itemUnsupportedSchema(missions, supported) {
  if (!Array.isArray(supported)) {
    return unmeasuredItem('unsupported_schema_version',
      'no supportedSchemaVersions supplied — declared versions were not checked');
  }
  const ok = new Set(supported);
  const findings = [];
  for (const m of missions) {
    for (const [kind, fm] of Object.entries(m.files)) {
      if (fm === null || fm === undefined) continue;
      const declared = fm.schema_version ?? fm.v;
      if (ok.has(declared)) continue;
      findings.push({
        code: 'unsupported-schema-version', status: CheckStatus.FAIL,
        mission_id: m.mission_id, kind, declared: declared ?? null,
        detail: `${m.mission_id}/${kind}.md declares schema_version ${declared ?? '(none)'}, not in [${supported.join(', ')}]`,
      });
    }
  }
  return item('unsupported_schema_version', worstOf(findings.map((f) => f.status)), findings);
}

/**
 * Normalise one caller-supplied mission entry.
 *
 * @param {object} raw - A `missionDirs` entry.
 * @returns {object} `{mission_id, files, extraFiles}`.
 */
function normaliseMission(raw) {
  const files = raw?.files ?? {};
  return {
    mission_id: raw?.mission_id ?? '(unnamed)',
    files: {
      intent: files.intent ?? null,
      plan: files.plan ?? null,
      review: files.review ?? null,
      outcome: files.outcome ?? null,
    },
    extraFiles: raw?.extraFiles,
  };
}

/**
 * Build the three staleness items, or three unmeasured ones.
 *
 * @param {object[]} missions - Normalised mission entries.
 * @param {Function|undefined} classify - Injected `classifyStaleness` port.
 * @returns {{items: object, extra: object[]}} Items plus any off-list findings.
 */
function stalenessItems(missions, classify) {
  if (typeof classify !== 'function') {
    const why = 'no classifyStaleness port injected — based_on edges were not evaluated';
    return {
      items: {
        broken_based_on: unmeasuredItem('broken_based_on', why),
        stale_plan: unmeasuredItem('stale_plan', why),
        invalid_review: unmeasuredItem('invalid_review', why),
      },
      extra: [],
    };
  }
  const results = classifyAll(missions, classify);
  // §32's ten items have no slot for a NOT_ACCEPTABLE outcome, which T-40's §5
  // propagation table does produce. Reporting it inside one of the ten would
  // misattribute it, and dropping it would hide a mission whose outcome is not
  // acceptable, so it is carried outside the ten and named as such.
  const extra = results
    .filter((r) => r.state === STALE_STATE.NOT_ACCEPTABLE)
    .map((r) => ({
      code: 'outcome-not-acceptable', status: CheckStatus.FAIL, mission_id: r.mission_id,
      kind: r.kind, state: r.state, outsideCanonicalTen: true,
      detail: `${r.mission_id}/outcome.md is NOT_ACCEPTABLE — no §32 item covers this state`,
    }));
  return {
    items: {
      broken_based_on: itemFromStaleness(
        'broken_based_on', results, STALE_STATE.BROKEN, ['plan', 'review', 'outcome'],
      ),
      stale_plan: itemFromStaleness('stale_plan', results, STALE_STATE.STALE, ['plan']),
      invalid_review: itemFromStaleness('invalid_review', results, STALE_STATE.INVALID, ['review']),
    },
    extra,
  };
}

/**
 * Check 9 — Artifact Health, the ten checks of Hardening §32.
 *
 * Every item reports `pass`, `fail` or `unmeasured` independently, and an item
 * whose input was not supplied is `unmeasured` — never a pass. The summary
 * takes the most severe item verdict, so a run that measured four items and
 * skipped six reports `unmeasured`, not green.
 *
 * @param {object} input - Check inputs.
 * @param {object[]} input.missionDirs - `[{mission_id, files, extraFiles}]`, each
 *   file being parsed frontmatter or null.
 * @param {Function} [input.classifyStaleness] - Injected T-40 port (items 2-4).
 * @param {string[]} [input.activeMissionIds] - Live mission ids (item 6).
 * @param {object} [input.leases] - `task_leases` from the snapshot (item 7).
 * @param {string} [input.now] - ISO instant to judge leases against (item 7).
 * @param {object} [input.parity] - A `checkLedgerStateParity` result (item 8).
 * @param {string[]} [input.evidenceIds] - Evidence registry ids (item 9).
 * @param {Array} [input.supportedSchemaVersions] - Readable schema versions (item 10).
 * @returns {{status: string, items: object, findings: object[]}} Verdict, ten items, off-list findings.
 */
export function checkArtifactHealth(input = {}) {
  const src = input ?? {};
  if (!Array.isArray(src.missionDirs)) {
    const why = 'no missionDirs supplied — no mission folder was read';
    const items = {};
    for (const key of Object.keys(ARTIFACT_HEALTH_ITEMS)) items[key] = unmeasuredItem(key, why);
    return { status: CheckStatus.UNMEASURED, items, findings: [] };
  }
  const missions = src.missionDirs.map(normaliseMission);
  const stale = stalenessItems(missions, src.classifyStaleness);
  const items = {
    missing_intent: itemMissingIntent(missions),
    broken_based_on: stale.items.broken_based_on,
    stale_plan: stale.items.stale_plan,
    invalid_review: stale.items.invalid_review,
    duplicate_canonical_artifact: itemDuplicateCanonical(missions),
    orphan_mission: itemOrphanMission(missions, src.activeMissionIds),
    expired_task_lease: itemExpiredLease(src.leases, src.now),
    ledger_state_mismatch: itemLedgerStateMismatch(src.parity),
    missing_evidence_reference: itemMissingEvidence(missions, src.evidenceIds),
    unsupported_schema_version: itemUnsupportedSchema(missions, src.supportedSchemaVersions),
  };
  const statuses = Object.values(items).map((i) => i.status)
    .concat(stale.extra.map((f) => f.status));
  return { status: worstOf(statuses), items, findings: stale.extra };
}
