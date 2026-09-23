#!/usr/bin/env node
/**
 * SessionEnd dispatcher child — derive a mission completion DECLARATION and,
 * behind the kill switch, project it into `outcome.md`.
 *
 * WHAT IT DOES, IN ORDER. For every mission this session touched: if the ledger
 * shows at least one `verify.completed` and no `mission.completed`, append ONE
 * `mission.completed{accepted: null}` line (owner decision W11-Q4 (a), the WIDE
 * condition). Then, for every mission that now carries such a line, run the
 * completion gates (`lib/runtime/artifact-lifecycle.js#plan`) and report which
 * gate stopped it. Only an unblocked mission whose ARTIFACT GATE is open gets a
 * file.
 *
 * THE ARTIFACT GATE IS TWO CONDITIONS, NOT ONE, and this hook no longer reads
 * either of them itself. `lib/runtime/artifact-lifecycle.js#resolveArtifactGate`
 * is the single resolver: it opens only when the global kill switch
 * `runtime.artifactLifecycle.enabled` is exactly `true` AND the project opted
 * in by carrying the marker file named by `runtime.artifactLifecycle.projectMarker`
 * (shipped `.artibot/artifact-lifecycle.optin`) as a regular file under it.
 * Turning the global switch on therefore does NOT start seeding
 * `.artibot/missions/` in every repository a session happens to end in.
 *
 * THE PRODUCT OF THIS HOOK IS A DISTRIBUTION OF BLOCK REASONS, NOT FILES. On
 * the shipped configuration (`runtime.artifactLifecycle.enabled: false`) it
 * creates zero files by construction, and even with the switch open the live
 * ledger's `verify.completed` rows were all `unmeasured` when this limb was
 * briefed, so the UNMEASURED gate blocks first. Decision 5 (a): the reasons are
 * reported on STDERR, one line per evaluated mission, and recomputed on demand
 * by the read-only `scripts/ledger/outcome-census.mjs`. No new ledger event was
 * added for them — `schemas/ledger-events.allowlist.json` is untouched.
 *
 * OUTPUT CHANNELS. stdout is EMPTY on every path: the SessionEnd dispatcher
 * fans children out with `Promise.allSettled` and a byte on stdout is a
 * decision channel, not a log. Exit code is 0 on every path, including an
 * import-time throw — hence the lazy `import()` inside the try.
 *
 * -- WHAT THIS CANNOT SEE (rules §9 — written next to the gate) --------------
 *  ① THE DECLARATION IS DERIVED, NOT DECLARED. Nobody said this mission is
 *    complete. A `verify.completed` row means a verification gate fired, which
 *    is a much weaker fact than a person or an orchestrator calling the work
 *    done. The wide condition exists to create a DENOMINATOR; narrowing it to
 *    "review PASS and every question resolved" would have measured zero on the
 *    live ledger (`review.completed` 0 rows, `human.resolved` 0 rows).
 *  ② THE INPUT IS LEDGER ROWS, plus a read-only evidence-registry lookup. No
 *    self-report, transcript or model call: unledgered work is absent, not fewer.
 *  ③ `{accepted: null}` IS A TRIGGER, NOT A COMPLETION.
 *    `lib/runtime/ledger.js#currentMission` reads a null `accepted` as an OPEN
 *    mission, which is the intended reading: the 7-day observation window
 *    (design §D3) closes with a SECOND line carrying the verdict plus
 *    `supersedes`. Appending that second line is out of this limb's scope
 *    (decision 3), so nothing here ever writes a non-null `accepted`.
 *  ④ `verification_id` MAY COLLIDE ACROSS SESSIONS. The live ids come from the
 *    gate's constant verdict hash (`lib/verification/verify-rate.js`, brief
 *    §1.1), so two unrelated missions can carry the same id and the
 *    three-carrier join (`artifact-lifecycle-gates.js#verificationIdCarriers`)
 *    cannot tell them apart. An id match here is not proof of a shared
 *    verification.
 *  ⑤ MISSIONS OF STILL-ACTIVE SESSIONS ARE OUTSIDE THE DENOMINATOR. SessionEnd
 *    fires for THIS session; another session's open mission is not evaluated
 *    until its own teardown. A block-code distribution printed here is a
 *    distribution over ended sessions, exactly like
 *    `scripts/ledger/session-coverage.mjs`'s denominator.
 *  ⑥ REACH IS NOT COVERAGE. With every live `verify.completed` carrying
 *    `unmeasured`, the UNMEASURED gate blocks 100% of missions even under
 *    `requiredLayers: ["deterministic"]` — that figure is the brief's
 *    measurement (§1.1, 2026-09-14), NOT re-measured by this module. A green
 *    test suite here proves the classification, never the live distribution.
 *
 * @module scripts/hooks/mission-complete-record
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readStdin } from '../utils/index.js';
import { isMainEntry } from './_main-entry.js';

/** Prefix of every stderr line. One name, so a log grep finds all of them. */
const HOOK_NAME = 'mission-complete-record';

/** The event this module appends, spelled once so the dedupe read agrees. */
const COMPLETED_EVENT = 'mission.completed';

/** The event whose presence makes a mission declarable (decision W11-Q4 (a)). */
const VERIFY_EVENT = 'verify.completed';

/** Envelope `source`. `mission.completed` registers `["hook", "scheduler"]`. */
const LEDGER_SOURCE = 'hook';

/** `actor` written into `outcome.md` frontmatter. */
const ACTOR = Object.freeze({ type: 'hook', id: HOOK_NAME });

/**
 * Block codes this MODULE owns, for the missions that never reach `plan()`.
 *
 * FROZEN AND CLOSED, for the reason `foldOutcomeGateCensus` cannot enforce:
 * that fold accepts any non-empty string as a `blockCode`, so the closed
 * vocabulary has to hold HERE. Nothing below ever interpolates a ledger value,
 * a filesystem path or an error message into a code — a parse failure is
 * `ARTIFACT_UNPARSEABLE`, never the parser's message (Hardening §25).
 *
 * The three are distinct facts, and collapsing any two would lose the one
 * thing this distribution is for:
 *   - `STATE_ROW_ABSENT` — the StateStore has no row, so there are no
 *     revisions to judge freshness against. Not a gate result: fail-closed.
 *   - `ARTIFACT_ABSENT` — `plan.md` or `review.md` is not on disk. The upstream
 *     emitter never reached this mission (live: every mission, today).
 *   - `ARTIFACT_UNPARSEABLE` — the file IS there and its frontmatter is not
 *     readable. That is an emitter DEFECT, the opposite diagnosis from absence,
 *     which is why they are two codes and not one.
 */
export const HOOK_BLOCK_CODES = Object.freeze([
  'STATE_ROW_ABSENT',
  'ARTIFACT_ABSENT',
  'ARTIFACT_UNPARSEABLE',
]);

/** Named access to {@link HOOK_BLOCK_CODES}, so no call site spells a literal. */
export const HookBlockCode = Object.freeze({
  STATE_ROW_ABSENT: HOOK_BLOCK_CODES[0],
  ARTIFACT_ABSENT: HOOK_BLOCK_CODES[1],
  ARTIFACT_UNPARSEABLE: HOOK_BLOCK_CODES[2],
});

/**
 * The closed vocabulary of the `declared=` field on the stderr line.
 *
 * `refused` is the third value, and it is NOT cosmetic. `appendLedgerEvent`
 * NEVER THROWS — it RETURNS `{ok: false, reason}` for a read-only ledger, a
 * line over the byte cap, a source the allowlist does not register, and every
 * other refusal (`lib/runtime/event-writer.js#writeEvent`). Reporting `new`
 * without reading that result would claim a denominator row that does not
 * exist, and the census replayed from the ledger would then disagree with this
 * hook's own log with nobody able to say which was right. A `refused` mission
 * is NOT classified: there is no declaration to judge, so the gates would be
 * answering a question that was never asked.
 */
export const DECLARATION_STATUSES = Object.freeze(['new', 'existing', 'refused']);

/**
 * The closed vocabulary of the `write=` field on the stderr line.
 *
 * `WOULD_WRITE` covers two states the fixed vocabulary has no separate word
 * for: the writer was authorised and the filesystem declined for a reason that
 * is not `ALREADY_EXISTS` (`NO_CONTENT`, `PATH_OUTSIDE_MISSIONS_DIR`,
 * `WRITE_FAILED`), and the defensive case where `plan()` produced no outcome
 * write at all. Both are honestly "planned, unblocked, no file from this run";
 * neither is reachable from this hook's own inputs.
 */
export const WriteStatus = Object.freeze({
  WRITTEN: 'written',
  ALREADY_EXISTS: 'already-exists',
  WOULD_WRITE: 'would-write',
  WRITE_DISABLED: 'write-disabled',
  BLOCKED: 'blocked',
});

/** A non-blank string, or null. Same helper and reason as `_plan-observe-record.js#str`. */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The idempotency key of the declaration line.
 *
 * `<event>:<identity…>` — the spelling
 * `lib/verification/verify-writer.js#verifyCompletedIdempotencyKey` uses. The
 * identity is the mission plus the literal `null`, because the SECOND line of
 * the pair (decision 3, out of scope here) carries a verdict and must not
 * collide with this one.
 *
 * THE KEY IS NOT ENFORCED BY THE WRITER. Measured 2026-09-15 against
 * `lib/runtime/event-writer.js#writeEvent`: it validates and appends, and the
 * READER's dedupe key is `(session_id, source, pid, seq, ts)`
 * (`lib/runtime/ledger.js#dedupeKey`) — `idempotency_key` is carried, never
 * compared. So a second fire from a second process would produce a SECOND line
 * that survives the reader. The re-read in {@link declareCompletion} is what
 * makes re-firing idempotent; the key is provenance for a later consumer.
 *
 * @param {string} missionId
 * @returns {string}
 */
export function missionCompletedIdempotencyKey(missionId) {
  return `${COMPLETED_EVENT}:${missionId}:null`;
}

/**
 * Every `lib/` module this hook needs, imported LAZILY.
 *
 * Same reason as `_plan-observe-record.js#loadDeps`: a STATIC import of a
 * module that throws during evaluation kills the process before any catch
 * exists, and this file's promise is "never throws, exit 0". Inside a try, an
 * import-time failure is a caught rejection instead.
 *
 * @returns {Promise<object>} the named bindings, flat
 */
export async function loadDeps() {
  const [
    git, ledger, lifecycle, gates, tasks, commonDir, file, platform, outcome, missionIds,
    planning, review, registry,
  ] = await Promise.all([
      import('../../lib/git/project-root.js'),
      import('../../lib/runtime/ledger.js'),
      import('../../lib/runtime/artifact-lifecycle.js'),
      import('../../lib/runtime/artifact-lifecycle-gates.js'),
      import('../../lib/runtime/middleware/tasks.js'),
      import('../../lib/project-state/git-common-dir.js'),
      import('../../lib/core/file.js'),
      import('../../lib/core/platform.js'),
      import('../../lib/mission/outcome-artifact.js'),
      import('../../lib/mission/mission-id.js'),
      import('../../lib/planning/plan-artifact.js'),
      import('../../lib/review/review-artifact.js'),
      import('../../lib/verification/evidence-registry.js'),
    ]);
  return {
    resolveProjectRoot: git.resolveProjectRoot,
    appendLedgerEvent: ledger.appendLedgerEvent,
    readAllEvents: ledger.readAllEvents,
    plan: lifecycle.plan,
    apply: lifecycle.apply,
    // May be `undefined` on a tree where the resolver has not landed. Read
    // through `artifactGateOpen`, which treats that as a SHUT gate.
    resolveArtifactGate: lifecycle.resolveArtifactGate,
    ArtifactKind: gates.ArtifactKind,
    BlockCode: gates.BlockCode,
    openMissionStore: tasks.openMissionStore,
    resolveGitCommonDir: commonDir.resolveGitCommonDir,
    readJsonFileSync: file.readJsonFileSync,
    getPluginRoot: platform.getPluginRoot,
    isMissionId: missionIds.isMissionId,
    outcomeArtifactPath: outcome.outcomeArtifactPath,
    assertOutcomeFilePath: outcome.assertOutcomeFilePath,
    serializeOutcomeMd: outcome.serializeOutcomeMd,
    planArtifactPath: planning.planArtifactPath,
    parsePlanMd: planning.parsePlanMd,
    reviewArtifactPath: review.reviewArtifactPath,
    parseReviewMd: review.parseReviewMd,
    FIRST_REVIEW_REVISION: review.FIRST_REVIEW_REVISION,
    citedEvidenceIds: registry.citedEvidenceIds,
  };
}

/**
 * Read the plugin's config for the keys this file gates on — the two
 * `review.verify` policy keys plus the whole `runtime.artifactLifecycle` object,
 * which is handed to `resolveArtifactGate` rather than picked apart here.
 *
 * The raw file under `getPluginRoot()`, not `lib/core/config.js#loadConfig` —
 * same substitution and same honesty bound as
 * `_review-stop-record.js#readPluginConfigSync` and
 * `_plan-observe-record.js#readPluginConfig`: `loadConfig` merges the file over
 * `DEFAULTS`, and `DEFAULTS` carries neither `runtime` nor `review.verify`, so
 * for these keys the raw file and the merged config agree. DEVIATION TO KNOW
 * ABOUT: this skips `loadConfig`'s memoisation and any future default it grows
 * for those paths.
 *
 * @param {object} d {@link loadDeps} bindings
 * @returns {object|null} parsed `artibot.config.json`, or null when unreadable
 */
export function readPluginConfig(d) {
  return d.readJsonFileSync(path.join(d.getPluginRoot(), 'artibot.config.json'), null);
}

/**
 * The gate policy, read from config and FAIL-CLOSED on every absence.
 *
 * `gates.js` reads no config by design (its `DEFAULT_POLICY` header says so);
 * this hook is the caller that injects it, which is the whole of owner decision
 * C4 (i). An unreadable config yields the strict policy, never the loose one.
 *
 * @param {object|null} config
 * @returns {{unmeasuredBlocksOutcome: boolean, requiredLayers: string[]|null}}
 */
export function policyFromConfig(config) {
  const verify = config?.review?.verify;
  return {
    unmeasuredBlocksOutcome: verify?.unmeasuredBlocksOutcome ?? true,
    requiredLayers: verify?.requiredLayers ?? null,
  };
}

/**
 * The evidence pointers for one mission (decision 7 (a)): POINTER STRINGS for
 * the `mission.completed` line and outcome.md's `## Changes` body (never empty,
 * as a section must be), never its frontmatter, which holds §23 ids
 * ({@link registeredEvidenceIds}). A ref is `ledger:<idempotency_key>` when the
 * row carries one, else `ledger:<event>:<mission>` — ambiguous BY MISSION on
 * purpose, because a fabricated per-row key would resolve to nothing.
 *
 * @param {object[]} history full mission history, ledger order
 * @param {string} sessionId
 * @returns {string[]} non-empty; the transcript pointer is always last
 */
export function evidencePointers(history, sessionId) {
  const refs = [];
  const lastVerify = lastOf(history, VERIFY_EVENT);
  if (lastVerify !== null) refs.push(pointerFor(lastVerify, VERIFY_EVENT));
  const lastReview = lastOf(history, 'review.completed');
  if (lastReview !== null) refs.push(pointerFor(lastReview, 'review.completed'));
  refs.push(`transcript:${sessionId}`);
  return refs;
}

/** §23 ids per `lib/verification/evidence-registry.js#citedEvidenceIds`; `[]` for null or a throw. */
export function registeredEvidenceIds(d, projectRoot, history, verificationId) {
  try {
    return d.citedEvidenceIds(history, verificationId, { projectRoot, resolveGitCommonDir: d.resolveGitCommonDir }) ?? [];
  } catch { return []; }
}

/** The last row of `event` in ledger order, or null. */
function lastOf(history, event) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.event === event) return history[i];
  }
  return null;
}

/** `ledger:<key>`, falling back to `ledger:<event>:<mission>` when unkeyed. */
function pointerFor(row, event) {
  const key = str(row.idempotency_key);
  return key === null ? `ledger:${event}:${row.mission_id}` : `ledger:${key}`;
}

/** The last `verification_id` any `verify.completed` row carried, or null. */
export function lastVerificationId(history) {
  let found = null;
  for (const row of history) {
    if (row?.event === VERIFY_EVENT && str(row?.data?.verification_id) !== null) {
      found = row.data.verification_id;
    }
  }
  return found;
}

/**
 * Append the declaration line, unless one already exists.
 *
 * The re-read is the idempotency mechanism (see
 * {@link missionCompletedIdempotencyKey}: the writer does not dedupe). It is a
 * FRESH read rather than a filter over the history already in hand, because
 * this hook and a sibling process can reach the same mission in the same
 * second, and the cheap read narrows that window to the append itself.
 *
 * @param {object} d {@link loadDeps} bindings
 * THE WRITER'S RESULT IS READ, NOT ASSUMED. `appendLedgerEvent` never throws;
 * it RETURNS `{ok: false, reason}` — measured 2026-09-15 against
 * `lib/runtime/event-writer.js#writeEvent`, whose only success field is `ok`.
 * A read-only ledger and a rejected envelope both come back that way, so a
 * caller that ignored the result would print `declared=new` over zero rows.
 *
 * @param {{projectRoot: string, sessionId: string, missionId: string,
 *   history: object[]}} ctx
 * @returns {'new'|'existing'|'refused'|null} null when the mission is not
 *   declarable at all; `refused` when the append was attempted and declined
 */
export function declareCompletion(d, ctx) {
  const { projectRoot, missionId } = ctx;
  const already = d.readAllEvents(projectRoot, { mission_id: missionId, event: COMPLETED_EVENT });
  if (already.length > 0) return 'existing';
  const verified = ctx.history.some((e) => e?.event === VERIFY_EVENT);
  if (!verified) return null;

  const verificationId = lastVerificationId(ctx.history);
  const data = {
    accepted: null,
    evidence_refs: evidencePointers(ctx.history, ctx.sessionId),
  };
  // Optional per the allowlist. Omitted rather than defaulted: an invented id
  // would make the three-carrier join agree on a value nobody measured.
  if (verificationId !== null) data.verification_id = verificationId;

  const result = d.appendLedgerEvent(projectRoot, {
    event: COMPLETED_EVENT,
    session_id: ctx.sessionId,
    mission_id: missionId,
    source: LEDGER_SOURCE,
    idempotency_key: missionCompletedIdempotencyKey(missionId),
    data,
  });
  // `=== true`, never truthy: a refusal result carries other fields
  // (`rejected`, `recorded`, `path`) and a loose check would read one of them.
  // The writer's `reason` is NOT propagated to the stderr line — it quotes
  // envelope values, and that line is a closed vocabulary (Hardening §25).
  return result?.ok === true ? 'new' : 'refused';
}

/**
 * Read the two upstream artifacts a completion gate needs.
 *
 * ABSENCE AND UNREADABILITY ARE TWO ANSWERS. An absent file means the emitter
 * never reached this mission; a present-but-unparseable file means it reached
 * it and produced something the reader refuses. Both stop the mission before
 * `plan()` is called at all — there is no `based_on` to judge — and both are
 * counted separately, which is the point of the distribution.
 *
 * A FAILED READ JOINS THE UNPARSEABLE SIDE, AND THE READ IS GUARDED. The path
 * exists — `existsSync` said so — so this is not absence; it is a file this
 * process cannot turn into a document, which is the same diagnosis as one
 * whose frontmatter does not parse. The guard is not hypothetical: a `plan.md`
 * that is a DIRECTORY makes `readFileSync` throw `EISDIR`, and an unguarded
 * throw would escape {@link classifyMissionOutcome}, whose contract is that it
 * never throws, and abort the whole session's pass — every LATER mission
 * losing its declaration permanently, because SessionEnd fires once.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {string} projectRoot
 * @param {string} missionId
 * @returns {{blockCode: string}|{plan: object, review: object}}
 */
function readUpstreamArtifacts(d, projectRoot, missionId) {
  const planFile = d.planArtifactPath(projectRoot, missionId);
  const reviewFile = d.reviewArtifactPath(projectRoot, missionId);
  if (!existsSync(planFile) || !existsSync(reviewFile)) {
    return { blockCode: HookBlockCode.ARTIFACT_ABSENT };
  }
  let parsedPlan;
  let parsedReview;
  try {
    parsedPlan = d.parsePlanMd(readFileSync(planFile, 'utf-8'));
    parsedReview = d.parseReviewMd(readFileSync(reviewFile, 'utf-8'));
  } catch {
    return { blockCode: HookBlockCode.ARTIFACT_UNPARSEABLE };
  }
  if (!parsedPlan.ok || !parsedReview.ok) {
    // The parser's own error messages are NOT propagated: they quote file
    // content, and a block code is a closed vocabulary (Hardening §25).
    return { blockCode: HookBlockCode.ARTIFACT_UNPARSEABLE };
  }
  return { plan: parsedPlan.plan, review: parsedReview.review };
}

/**
 * Build the `missionState` `plan()` reads, from the store row and the two
 * parsed artifacts.
 *
 * The `based_on` edges are the ARTIFACTS' declarations, not the row's live
 * revisions: Hardening §5 asks whether the document on disk was written against
 * the revisions the mission has now, so reading both sides from the row would
 * compare a value with itself and never report staleness.
 */
function buildMissionState(d, missionId, row, artifacts) {
  const planRevision = Number.isInteger(row.plan?.revision) ? row.plan.revision : null;
  const reviewRevision = Number.isInteger(artifacts.review.revision)
    ? artifacts.review.revision
    : d.FIRST_REVIEW_REVISION;
  return {
    missionId,
    intentRevision: row.intent.revision,
    planRevision,
    reviewRevision,
    artifacts: {
      plan: { based_on: { intent_revision: artifacts.plan.basedOn.intentRevision } },
      review: {
        based_on: {
          intent_revision: artifacts.review.basedOn.intentRevision,
          plan_revision: artifacts.review.basedOn.planRevision,
        },
      },
    },
    appliedIdempotencyKeys: [],
  };
}

/**
 * Classify ONE declared mission: which gate, if any, stops its `outcome.md`.
 *
 * SHARED WITH THE CENSUS CLI ON PURPOSE. `scripts/ledger/outcome-census.mjs`
 * calls this same function, so the number the CLI prints and the reason this
 * hook logs cannot disagree — two spellings of one classification would
 * eventually be two classifications.
 *
 * NEVER THROWS. A throw would be a block code nobody could count.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {{projectRoot: string, sessionId: string, missionId: string,
 *   history: object[], declared: boolean, policy: object}} ctx
 * @returns {{missionId: string, declared: boolean, blockCode: string|null,
 *   wouldWrite: boolean, planResult: object|null, missionState: object|null}}
 */
export function classifyMissionOutcome(d, ctx) {
  const base = {
    missionId: ctx.missionId,
    declared: ctx.declared,
    blockCode: null,
    wouldWrite: false,
    planResult: null,
    missionState: null,
  };
  if (!ctx.declared) return base;

  const row = readStoreRow(d, ctx);
  if (row === null) return { ...base, blockCode: HookBlockCode.STATE_ROW_ABSENT };

  const artifacts = readUpstreamArtifacts(d, ctx.projectRoot, ctx.missionId);
  if (artifacts.blockCode !== undefined) return { ...base, blockCode: artifacts.blockCode };

  const missionState = buildMissionState(d, ctx.missionId, row, artifacts);
  const planResult = d.plan({
    events: ctx.history,
    missionState,
    projectRoot: ctx.projectRoot,
    policy: ctx.policy,
  });
  const write = planResult.writes.find((w) => w.kind === d.ArtifactKind.OUTCOME) ?? null;
  return {
    ...base,
    blockCode: write?.blocked ?? null,
    wouldWrite: write !== null && write.blocked === undefined,
    planResult,
    missionState,
  };
}

/**
 * The StateStore row, or null when it is unusable.
 *
 * A row without an integer `intent.revision` counts as ABSENT rather than as a
 * separate code: both mean "no revision to judge freshness against", and
 * `_review-stop-record.js#writeReviewArtifact` already refuses on exactly that
 * pair for the same reason (inventing revision 1 would make the artifact claim
 * an intent nobody recorded).
 */
function readStoreRow(d, ctx) {
  try {
    const store = d.openMissionStore(ctx.projectRoot, ctx.sessionId, Date.now(), {
      resolveGitCommonDir: d.resolveGitCommonDir,
    });
    const row = store.getMission(ctx.missionId);
    return Number.isInteger(row?.intent?.revision) ? row : null;
  } catch {
    return null;
  }
}

/** One `## Verification` line per measured layer, from `plan()`'s findings. */
function verificationLines(planResult) {
  const lines = [];
  for (const finding of planResult?.findings ?? []) {
    const c = finding.counts ?? {};
    lines.push(
      `${finding.layer}: pass=${c.pass ?? 0} fail=${c.fail ?? 0} `
      + `unmeasured=${c.unmeasured ?? 0} other=${c.other ?? 0} (rows ${finding.total ?? 0})`,
    );
  }
  if (lines.length === 0) lines.push(`${VERIFY_EVENT} rows: 0`);
  return lines;
}

/**
 * The five REQUIRED sections, with real text.
 *
 * Real text rather than the serializer's `_(not yet recorded)_` placeholder,
 * because `parseOutcomeMd` reports a placeholder in a required section as a
 * `REQUIRED_SECTION_EMPTY` FINDING — a file this hook wrote that its own reader
 * flags would be the emitter defect the census is supposed to detect.
 * `Remaining Blindspots` and `Follow-ups` are omitted deliberately: design
 * `:180` allows exactly those two to be empty, and inventing content for them
 * would put this module's guesses in a record of what happened.
 */
function outcomeSections(ctx) {
  return {
    mission: [
      `mission id: ${ctx.missionId}`,
      `declared by: ${HOOK_NAME} (derived from ${VERIFY_EVENT}, not a human declaration)`,
      `session: ${ctx.sessionId}`,
    ],
    accepted_result: [
      'accepted: null — 판정 유예. 완료 선언이지 완료가 아니다',
      '이 줄은 7일 관측 창(design §D3)이 닫힐 때 두 번째 줄로 확정된다',
    ],
    changes: evidencePointers(ctx.history, ctx.sessionId).map((ref) => `evidence: ${ref}`),
    verification: verificationLines(ctx.planResult),
    review: [
      `last verdict: ${str(ctx.lastVerdict) ?? 'none recorded'}`,
      `verification_id: ${ctx.verificationId}`,
    ],
  };
}

/**
 * Is the artifact gate open for THIS project? FAIL-CLOSED on every doubt.
 *
 * The one reader of the gate in this file. `resolveArtifactGate` is contracted
 * never to throw, and this `catch` is not a second opinion about that: it is
 * what makes a MISSING binding — a tree where the resolver has not landed, so
 * `d.resolveArtifactGate` is `undefined` and the call is a TypeError — come out
 * as a shut gate rather than as an exception escaping `writeOutcome`. Open is
 * asserted positively (`=== true`), so any other return shape is also shut.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {object|null} config parsed `artibot.config.json`
 * @param {string} projectRoot the project the marker is looked for under
 * @returns {boolean} true only when both halves of the gate said yes
 */
function artifactGateOpen(d, config, projectRoot) {
  try {
    return d.resolveArtifactGate({ config, projectRoot }).open === true;
  } catch {
    return false;
  }
}

/**
 * Render and write `outcome.md`, behind the artifact gate.
 *
 * `apply()` THROWS when the gate is not open — since B4 that covers the
 * per-project half too, not only the global kill switch — which is why the gate
 * is read BEFORE it is called rather than being allowed to raise; the same
 * shape as `_plan-observe-record.js#recordPlanArtifact`.
 *
 * ONE STATUS FOR BOTH HALVES. A globally disabled switch and a project that
 * never opted in both come out as {@link WriteStatus.WRITE_DISABLED}. The
 * stderr vocabulary is closed and pinned by this hook's tests; the gate's own
 * `reason` (`global-off` vs `project-off`) is deliberately not surfaced here,
 * because a new status string would be a new decision channel for a hook whose
 * whole contract is that it decides nothing.
 *
 * `assertOutcomeFilePath` runs immediately before the write even though
 * `apply()` builds the path itself and contains it to the missions directory.
 * Two independent guards, because the derived-name rule
 * (`outcome-v2.md`/`outcome-final.md`) is the outcome artifact's own invariant
 * and containment does not express it.
 *
 * @returns {string} a {@link WriteStatus} value
 */
function writeOutcome(d, ctx) {
  const config = ctx.config;
  if (!artifactGateOpen(d, config, ctx.projectRoot)) return WriteStatus.WRITE_DISABLED;

  const text = d.serializeOutcomeMd({
    missionId: ctx.missionId,
    basedOn: {
      intentRevision: ctx.missionState.intentRevision,
      planRevision: ctx.missionState.planRevision,
      reviewRevision: ctx.missionState.reviewRevision,
    },
    verificationId: ctx.verificationId,
    evidenceRefs: registeredEvidenceIds(d, ctx.projectRoot, ctx.history, lastVerificationId(ctx.history)),
    // Never `supersedes`: the serializer REFUSES it beside `accepted: null`.
    accepted: null,
    actor: ACTOR,
    ts: new Date().toISOString(),
    sections: outcomeSections(ctx),
  });
  d.assertOutcomeFilePath(d.outcomeArtifactPath(ctx.projectRoot, ctx.missionId));

  const applied = d.apply(ctx.planResult, {
    // `dryRun: true` is the "I know this module" flag, not "do not write";
    // `write: true` is what authorises the filesystem. See `apply`'s doc.
    dryRun: true,
    write: true,
    projectRoot: ctx.projectRoot,
    config,
    content: { outcome: text },
  });
  if (applied.written.length > 0) return WriteStatus.WRITTEN;
  const skipped = (applied.skipped ?? []).find((s) => s.kind === d.ArtifactKind.OUTCOME);
  return skipped?.reason === 'ALREADY_EXISTS'
    ? WriteStatus.ALREADY_EXISTS
    : WriteStatus.WOULD_WRITE;
}

/**
 * Declare, classify and (maybe) write ONE mission. Returns its stderr line, or
 * null when the mission was not declarable and therefore not evaluated.
 */
function processMission(d, ctx) {
  const history = d.readAllEvents(ctx.projectRoot, { mission_id: ctx.missionId });
  const declared = declareCompletion(d, { ...ctx, history });
  if (declared === null) return null;
  if (declared === 'refused') {
    // No declaration exists, so the gates have nothing to judge. Classifying
    // anyway would print a block code for a mission the ledger never recorded
    // as declared — and the census, which reads the ledger, would not count it.
    return `[artibot:${HOOK_NAME}] mission=${ctx.missionId} declared=refused `
      + `block=none write=${WriteStatus.BLOCKED}`;
  }

  // RE-READ: the declaration is part of the history the gates fold, and
  // `foldGateState` takes `mission.completed` as a carrier of the join id.
  const full = d.readAllEvents(ctx.projectRoot, { mission_id: ctx.missionId });
  const verdict = lastOf(full, 'review.completed')?.data?.verdict ?? null;
  const classified = classifyMissionOutcome(d, { ...ctx, history: full, declared: true });

  let write = WriteStatus.BLOCKED;
  if (classified.blockCode === null) {
    write = classified.wouldWrite
      ? writeOutcome(d, {
        ...ctx,
        history: full,
        planResult: classified.planResult,
        missionState: classified.missionState,
        verificationId: lastVerificationId(full) ?? `${VERIFY_EVENT}:${ctx.missionId}`,
        lastVerdict: verdict,
      })
      : WriteStatus.WOULD_WRITE;
  }
  return `[artibot:${HOOK_NAME}] mission=${ctx.missionId} declared=${declared} `
    + `block=${classified.blockCode ?? 'none'} write=${write}`;
}

/**
 * Distinct, WELL-FORMED `mission_id` values in this session's rows, in
 * first-seen order.
 *
 * SHAPE-CHECKED, because this value is the one piece of ledger text that
 * reaches the stderr line, and that line's grammar is whitespace-delimited
 * (`mission=<M> declared=...`). A `mission_id` carrying a space would split the
 * line into fields a reader cannot rejoin — the Hardening §25 failure in its
 * quietest form: no crash, just a log nobody can parse.
 *
 * Skipped SILENTLY rather than reported: the writer refuses such an id on the
 * way in (`event-writer.js` validates `mission_id` against the same shape), so
 * a row carrying one arrived by a path this hook cannot name, and a fabricated
 * block code for it would be a measurement of nothing.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {object[]} events
 * @returns {string[]}
 */
function missionIdsOf(d, events) {
  const ids = [];
  const seen = new Set();
  for (const e of events) {
    const id = str(e?.mission_id);
    if (id === null || seen.has(id) || !d.isMissionId(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The whole pass, for one payload. Returns the stderr lines rather than writing
 * them, so a test can assert the vocabulary without parsing a stream.
 *
 * @param {object} payload the SessionEnd hook payload
 * @returns {Promise<string[]>}
 */
export async function recordMissionCompletions(payload) {
  const cwd = str(payload?.cwd);
  const sessionId = str(payload?.session_id);
  // Case (d): no root to resolve, or no session to attribute the line to.
  // Doing nothing is the only safe answer — a guessed root writes into whatever
  // repository the shell happened to be in.
  if (cwd === null || sessionId === null) return [];

  const d = await loadDeps();
  const projectRoot = d.resolveProjectRoot(cwd);
  if (str(projectRoot) === null) return [];

  const config = readPluginConfig(d);
  const policy = policyFromConfig(config);
  const sessionEvents = d.readAllEvents(projectRoot, { session_id: sessionId });

  const lines = [];
  for (const missionId of missionIdsOf(d, sessionEvents)) {
    // PER MISSION, not around the loop. SessionEnd fires ONCE, so a throw that
    // escaped here would cost every LATER mission of this session its
    // declaration permanently — a loss with no retry and no trace. Defence in
    // depth: every known throw is handled inside, and this catches the one
    // nobody modelled.
    try {
      lines.push(processMission(d, { d, projectRoot, sessionId, missionId, config, policy }));
    } catch (err) {
      // The last-resort form, deliberately OUTSIDE the closed vocabulary: it
      // carries an error message, so it must not look like a parseable line.
      lines.push(`[artibot:${HOOK_NAME}] ${err?.message || 'mission failed'}`);
    }
  }
  return lines.filter((line) => line !== null);
}

/**
 * Entry point. stdout stays empty; every line goes to stderr; exit is 0.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let payload;
  try {
    const stdin = await readStdin();
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {
    return; // tolerate empty/malformed stdin — nothing to record
  }
  const lines = await recordMissionCompletions(payload);
  for (const line of lines) process.stderr.write(`${line}\n`);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    // Last-resort guard: a bookkeeping failure must never surface to the host
    // or change the exit code. The message is the error's, not a block code —
    // this line is outside the closed vocabulary on purpose and is never parsed.
    process.stderr.write(`[artibot:${HOOK_NAME}] ${err?.message || 'failed'}\n`);
  });
}
