/**
 * SubagentStop's review-observation path (v5 C2) — RECORD ONLY.
 *
 * Moved verbatim out of `scripts/hooks/subagent-handler.js` on 2026-09-13 under
 * the 800-line-per-file guidance; behaviour is unchanged and this module still
 * DECIDES NOTHING — see the block comment below, which is the design record and
 * moved with the code. There is NO entry point here: nothing in this file reads
 * the process argv vector, so it is not a direct-run-guard subject.
 *
 * @module scripts/hooks/_review-stop-record
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJsonFileSync } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { recordReviewOutcome } from '../../lib/review/verdict-writer.js';

// ---------------------------------------------------------------------------
// v5 review observation (C2) — RECORD ONLY.
//
// A reviewer's answer is a document that already exists; this block is the only
// thing that makes it COUNTABLE. `lib/review/verdict-writer.js` has been green
// since it was written and its own header says the uncomfortable part out loud:
// "No production caller wires these functions yet." This is that caller.
//
// IT DECIDES NOTHING. The hook's stdout is byte-identical in every condition —
// append ok, append refused, transcript missing, non-reviewer — and no branch
// here can block a deregistration or turn a REPAIR_REQUIRED into a pass. The
// verdict's EFFECT on the pipeline is the leader's job in `commands/team.md`
// Phase 4.5; the ledger line is a measurement of what was said.
//
// WHY THE MODEL COMES FROM THE TRANSCRIPT AND NOWHERE ELSE. `review.completed`
// requires an envelope `model` (`schemas/ledger-events.allowlist.json`), and
// the SubagentStop payload has NO model key (measured live on host 2.1.269,
// 2/2 runs, 2026-09-12). The transcript's last assistant line does
// (`$.message.model`). `canonicalModel` and `resolveModel` are NOT substitutes:
// they answer "which tier should this agent get", and writing that answer into
// a field meaning "which model served this turn" would make the model-policy
// measurement quote itself as evidence. When the transcript cannot supply one,
// the verdict line is SKIPPED — a visible absence beats a plausible invention.
//
// THE review.md ARTIFACT (added 2026-09-14) CHANGES NONE OF THAT. A ledger line
// is a measurement; `review.md` is the same measurement rendered where a human
// reads it. It is written by {@link planReviewArtifact}, which DECIDES NOTHING
// EITHER: it never throws, it is invisible to stdout, and it is entered only
// when the ledger line was actually APPENDED — so a skipped, refused or
// deduped verdict produces no file. The write itself is behind
// `runtime.artifactLifecycle.enabled`, which ships FALSE (4.61.0), so on the
// shipped configuration this path stops at a config read.
//
// SYNC PRE-FLIGHT, ASYNC TAIL — and why it has to be that shape.
// `subagent-handler.js#handleStop` is SYNCHRONOUS and `main()` calls it without
// `await`, so nothing here can be awaited into the stop's return path. The
// pre-flight is therefore sync (cheap: object reads and one config read) and
// the write is an unawaited async tail. The process outlives
// the stdout write because the success path has no `process.exit` — the
// dispatcher waits for the child's `exit` event, which fires when the event
// loop drains, pending dynamic imports included.
//
// NOTHING NEW IS STATICALLY IMPORTED. Every module this path needs is
// `import()`ed inside the tail. Marginal load cost, measured 2026-09-14 on a
// warm hook graph, 3 runs each, in ms:
//
//     lib/runtime/middleware/tasks.js        168.1 / 142.0 / 135.1
//     lib/runtime/artifact-lifecycle.js       16.9 /  12.1 /  17.8
//     lib/review/review-artifact.js           10.6 /  11.3 /   7.3
//     lib/project-state/git-common-dir.js      0.7 /   0.4 /   0.6
//
// A static import is paid by EVERY SubagentStop, and the ~24 non-reviewer agent
// types never reach this code. Even the cheapest of the four is ~10 ms of that
// tax, which is why `review-artifact.js` is dynamic too — and why the
// `already-exists` check lives in the tail rather than in the pre-flight, where
// it would have needed `reviewArtifactPath` synchronously. The check is worth
// almost nothing up front anyway: a REDELIVERED stop already stops at
// `review-not-appended`, so the only case that reaches the tail with a file
// present is a genuinely new verdict for an already-reviewed mission.
// ---------------------------------------------------------------------------

/**
 * Agent identities whose stop records a review document — an ALLOWLIST, not a
 * denylist. A new agent type is silently not-a-reviewer until it is named here,
 * which is the fail-closed direction: the failure mode of a denylist is that
 * any future agent's chatter lands in the review measurement as a verdict.
 *
 * Compared after the caller's `identityOf`, so `artibot:code-reviewer` matches.
 * @type {readonly string[]}
 */
const REVIEWER_AGENT_TYPES = Object.freeze([
  'code-reviewer', 'spec-reviewer', 'quality-reviewer', 'auditor',
]);

/**
 * Team spawns name their inspector `team-<sid>-inspector` (`commands/team.md`
 * Phase 4.5), so the identity is not a fixed string and the suffix is what the
 * allowlist can match on. Narrow on purpose: a suffix, not a substring.
 * @type {string}
 */
const INSPECTOR_NAME_SUFFIX = '-inspector';

/**
 * How far back a subagent transcript is read, in bytes. The wanted line is the
 * LAST assistant turn, so a tail is sufficient and a hook must not grow with a
 * transcript that has no bound.
 * @type {number}
 */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/** Cap for the `review_ledger` spawn column; it is a summary, not a report. */
const REVIEW_COLUMN_MAX = 160;

/**
 * Whether this stop belongs to a reviewer at all.
 *
 * Returning false means the review path is NOT ENTERED: no transcript read, no
 * ledger read, no ledger write, and no `review_ledger` column on the spawn
 * record. That is the cheap and the safe answer for the ~24 non-reviewer agents.
 *
 * `identityOf` is INJECTED rather than imported or re-implemented. It lives in
 * `scripts/hooks/subagent-handler.js`, which imports this module, so importing
 * it back would close a cycle; copying it would create a SECOND answer to "which
 * agent is this", which is exactly what its own doc comment warns against. The
 * caller passes the one normalizer its bind path already uses.
 *
 * @param {unknown} agentType `agent_type` from the payload, or the tracked one
 * @param {(value: unknown) => string|null} identityOf the caller's normalizer
 * @returns {boolean} true when the type is a reviewer or a team inspector
 */
export function isReviewerStop(agentType, identityOf) {
  const identity = identityOf(agentType);
  if (identity === null) return false;
  return REVIEWER_AGENT_TYPES.includes(identity)
    || identity.endsWith(INSPECTOR_NAME_SUFFIX);
}

/**
 * Parse one transcript line, or null. A line that is not a whole JSON object is
 * skipped rather than fatal: a transcript is written by another process and may
 * be mid-append while this hook reads it.
 *
 * @param {unknown} line one raw line
 * @returns {object|null} the parsed entry
 */
function parseTranscriptLine(line) {
  try {
    const trimmed = String(line).trim();
    if (!trimmed.startsWith('{')) return null;
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Scan backwards for the last `type:"assistant"` entry carrying a message.
 *
 * BACKWARDS, not forwards: a reviewer's final answer is its last turn, and a
 * forward scan of a long transcript would both cost more and pick the wrong
 * turn. The LAST line is often not an assistant line (a summary or a tool
 * result follows), which is why this looks for the last of a KIND.
 *
 * @param {string[]} lines transcript lines in file order
 * @returns {object|null} the entry
 */
function findLastAssistantEntry(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parseTranscriptLine(lines[i]);
    const message = entry?.message;
    if (entry?.type === 'assistant' && message && typeof message === 'object') return entry;
  }
  return null;
}

/**
 * The last assistant entry of a subagent transcript, read from a bounded tail.
 *
 * NEVER THROWS. A missing, unreadable, corrupt or empty transcript yields null,
 * which costs the review line and nothing else. The first line of the window is
 * dropped when the read started mid-file, because a byte-offset read almost
 * always lands mid-line and a truncated object that happens to parse is worse
 * than a line not read.
 *
 * @param {unknown} transcriptPath `agent_transcript_path` from the payload
 * @returns {object|null} the entry
 */
function readLastAssistantEntry(transcriptPath) {
  let fd = null;
  try {
    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null;
    if (!existsSync(transcriptPath)) return null;
    const size = statSync(transcriptPath).size;
    const start = size > TRANSCRIPT_TAIL_BYTES ? size - TRANSCRIPT_TAIL_BYTES : 0;
    const length = size - start;
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return findLastAssistantEntry(lines);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

/**
 * The text of an assistant entry: its `content` string, or every text block of
 * its content array joined. Blocks that are not text (tool uses, thinking) are
 * dropped rather than stringified — a JSON blob of a tool call is not an answer.
 *
 * @param {object|null} entry {@link readLastAssistantEntry} output
 * @returns {string|null} the text, or null when there is none
 */
function assistantEntryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim() === '' ? null : content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
  }
  const joined = parts.join('\n');
  return joined.trim() === '' ? null : joined;
}

/**
 * The reviewer's answer: `last_assistant_message` when the host supplied one,
 * otherwise the transcript's final assistant text.
 *
 * The payload field WINS because it is what the host itself calls the final
 * message. The transcript is the fallback for the case the C1 probe could not
 * measure — whether the host truncates a long report in that field — and for a
 * payload shape that omits it entirely.
 *
 * @param {object} hookData parsed hook payload
 * @param {object|null} entry the already-read transcript entry
 * @returns {string|null} the answer text
 */
function reviewerText(hookData, entry) {
  const direct = hookData?.last_assistant_message;
  if (typeof direct === 'string' && direct.trim() !== '') return direct;
  return assistantEntryText(entry);
}

/**
 * The model that served the reviewer's final turn, from the transcript only.
 *
 * @param {object|null} entry the already-read transcript entry
 * @returns {string|null} an exact provider model id, or null
 */
function reviewerModel(entry) {
  const model = entry?.message?.model;
  return typeof model === 'string' && model.trim() !== '' ? model : null;
}

/**
 * A compact summary with both halves skipped for one shared reason — used for
 * the pre-flight refusals, which happen before any port is built.
 *
 * @param {string} reason short machine-readable cause
 * @returns {object} summary in the shape {@link recordReviewFromStop} returns
 */
function reviewSkipped(reason) {
  return {
    review: 'skipped',
    reviewReason: reason,
    claimAudit: 'skipped',
    claimAuditReason: reason,
    parsed: null,
  };
}

/**
 * Read the plugin's config SYNCHRONOUSLY, for the one key this file gates on.
 *
 * `lib/core/config.js#loadConfig` is async and cannot be used from a sync
 * pre-flight. The precedent for this exact substitution is
 * `lib/runtime/middleware/tasks.js:673`, and it is honest for THIS key only:
 * `loadConfig` merges the file over `DEFAULTS`, and `DEFAULTS` has no `runtime`
 * key, so for `runtime.artifactLifecycle.enabled` the raw file and the merged
 * config agree. DEVIATION TO KNOW ABOUT: this skips `loadConfig`'s memoisation
 * and any future default it might grow for that path.
 *
 * @returns {object|null} parsed `artibot.config.json`, or null when unreadable
 */
function readPluginConfigSync() {
  return readJsonFileSync(path.join(getPluginRoot(), 'artibot.config.json'), null);
}

/**
 * Decide — synchronously and without throwing — whether to start a `review.md`
 * write, and start it.
 *
 * NEVER THROWS AND NEVER AWAITS. Its return value is a label for the caller's
 * summary and nothing else reads it; `scheduled` means the tail was STARTED,
 * not that a file exists. Every refusal is named so the absence of a file is
 * explainable from the summary alone rather than looking like a silent failure.
 *
 * The order of the checks is the order of increasing cost: object reads, then
 * one config read. `review-not-appended` is first and catches the most cases —
 * a skipped verdict, a refused one, and a REDELIVERED stop, whose ledger half
 * dedupes to `skipped`. That is why a redelivery cannot even reach the store.
 *
 * @param {{outcome: object, ids: {agentType: string, sessionId: string,
 *   missionId: string|null}, projectRoot: string, model: string|null,
 *   findingsRef: string}} ctx the caller's already-built inputs
 * @returns {{status: 'skipped'|'scheduled', reason?: string}} what was decided
 */
export function planReviewArtifact(ctx) {
  try {
    const { outcome, ids, projectRoot } = ctx;
    if (outcome?.review?.status !== 'appended') {
      return { status: 'skipped', reason: 'review-not-appended' };
    }
    const missionId = ids?.missionId ?? null;
    if (typeof missionId !== 'string' || missionId === '') {
      return { status: 'skipped', reason: 'no-mission' };
    }
    // Unreachable from `recordReviewFromStop`, which refuses a null root before
    // any of this. Kept because this function's contract is "never throws".
    if (typeof projectRoot !== 'string' || projectRoot === '') {
      return { status: 'skipped', reason: 'no-cwd' };
    }
    const config = readPluginConfigSync();
    if (config?.runtime?.artifactLifecycle?.enabled !== true) {
      return { status: 'skipped', reason: 'write-disabled' };
    }
    // Deliberately NOT awaited: see the module header. The tail cannot reject.
    void writeReviewArtifact({ ...ctx, missionId, config });
    return { status: 'scheduled' };
  } catch {
    // A pre-flight that throws would take `recordReviewFromStop`'s whole
    // summary down to `{ error }` and lose the ledger statuses with it.
    return { status: 'skipped', reason: 'plan-failed' };
  }
}

/**
 * Write `review.md`, in the background, on a best-effort basis.
 *
 * NEVER REJECTS. Every failure is silent by design: this runs after the hook
 * has already printed its stdout, so there is no longer anywhere to report to,
 * and an unhandled rejection here would change the hook's exit code — the one
 * thing the whole review path is forbidden to touch.
 *
 * FAIL-CLOSED ON A MISSING STORE ROW. When the StateStore has no row for this
 * mission, nothing is written. The row is the only source of the `based_on`
 * revisions, and `intent.md` itself is only ever written for a mission that has
 * a row; inventing revision 1 here would make `review.md` claim it reviewed an
 * intent nobody recorded.
 *
 * @param {object} ctx {@link planReviewArtifact}'s ctx plus `missionId`,`config`
 * @returns {Promise<void>} resolves when the attempt is over, always fulfilled
 */
async function writeReviewArtifact(ctx) {
  try {
    const { ids, projectRoot, missionId, config } = ctx;
    const [lifecycle, tasks, gitDir, artifact] = await Promise.all([
      import('../../lib/runtime/artifact-lifecycle.js'),
      import('../../lib/runtime/middleware/tasks.js'),
      import('../../lib/project-state/git-common-dir.js'),
      import('../../lib/review/review-artifact.js'),
    ]);
    const { FIRST_REVIEW_REVISION, reviewArtifactPath, serializeReviewMd } = artifact;

    // `apply()` would refuse this anyway (ALREADY_EXISTS, never a clobber); the
    // check is here to skip the store read, not to make the write safe.
    if (existsSync(reviewArtifactPath(projectRoot, missionId))) return;

    const store = tasks.openMissionStore(projectRoot, ids.sessionId, Date.now(), {
      resolveGitCommonDir: gitDir.resolveGitCommonDir,
    });
    const row = store.getMission(missionId);
    if (row === null) return;
    const intentRevision = row.intent?.revision;
    if (!Number.isInteger(intentRevision)) return;
    // `plan.revision` is optional in a way `intent.revision` is not: the schema
    // requires the key, but a row seeded before a plan existed can still carry
    // a non-integer, and `null` is the serializer's word for "no plan yet".
    const planRevision = Number.isInteger(row.plan?.revision) ? row.plan.revision : null;

    const verdict = ctx.outcome.parsed.verdict;
    const text = serializeReviewMd({
      missionId,
      verdict: verdict.verdict,
      findingsRef: ctx.findingsRef,
      verificationId: verdict.verificationId,
      // Always the first revision. Superseding an existing `review.md` is not
      // implemented anywhere in the pipeline — no caller bumps a review
      // revision — so a second review of one mission stops at ALREADY_EXISTS.
      revision: FIRST_REVIEW_REVISION,
      basedOn: { intentRevision, planRevision },
      reviewerId: ids.agentType,
      model: ctx.model,
      ts: new Date().toISOString(),
    });

    // The envelope is REBUILT rather than reused: `recordReviewOutcome` returns
    // statuses, not the line it appended. These are the two `data` keys
    // `REQUIRED_EVENT_DATA['review.completed']` names, plus the id the ledger
    // line also carries, and they come from the same parse the ledger used.
    const planResult = lifecycle.plan({
      events: [{
        event: 'review.completed',
        mission_id: missionId,
        seq: 0,
        data: {
          verdict: verdict.verdict,
          findings_ref: ctx.findingsRef,
          verification_id: verdict.verificationId,
        },
      }],
      missionState: {
        missionId,
        intentRevision,
        planRevision,
        reviewRevision: FIRST_REVIEW_REVISION,
        appliedIdempotencyKeys: [],
      },
      projectRoot,
    });
    lifecycle.apply(planResult, {
      // `dryRun: true` is the "I know this module" flag, not "do not write";
      // `write: true` is what authorises the filesystem. See `apply`'s doc.
      dryRun: true,
      write: true,
      projectRoot,
      config,
      content: { review: text },
    });
  } catch {
    /* best-effort: the hook has already answered. */
  }
}

/**
 * Record a reviewer's answer as up to two ledger lines.
 *
 * The ports are built HERE rather than inside the writer because
 * `lib/review/verdict-writer.js` is L2 and may not import `lib/runtime/` — the
 * same split `unified-verifier.js#recordVerification` already uses. The
 * `existingKeys` port is what makes a redelivered stop dedupe instead of
 * inflating the §4.1 denominator with a second copy of one verdict.
 *
 * NEVER THROWS: anything unexpected becomes `{ error: '<ConstructorName>' }`,
 * which lands in the spawn column and nowhere else.
 *
 * On the APPENDED path it also starts the `review.md` write (see
 * {@link planReviewArtifact}); the returned `artifact` label says what that
 * decided. The pre-flight refusals from {@link reviewSkipped} return before any
 * of this and carry no `artifact` key at all.
 *
 * @param {object} hookData parsed hook payload
 * @param {{agentId: string, agentType: string, sessionId: string|null,
 *   missionId: string|null}} ids identity of this stop
 * @param {string|null} projectRoot root from `subagent-handler.js#payloadProjectRoot`
 * @returns {object} compact summary of what happened to each half
 */
export function recordReviewFromStop(hookData, ids, projectRoot) {
  try {
    const { sessionId } = ids;
    if (typeof sessionId !== 'string' || sessionId === '') return reviewSkipped('no-session');
    if (projectRoot === null) return reviewSkipped('no-cwd');
    const entry = readLastAssistantEntry(hookData?.agent_transcript_path);
    const verdictText = reviewerText(hookData, entry);
    if (verdictText === null) return reviewSkipped('no-text');

    const model = reviewerModel(entry);
    // Leader decision 2026-09-12: the agent id, never the transcript PATH — a
    // path carries a home directory and a session id into a tracked ledger.
    const findingsRef = `transcript:${ids.agentId}`;

    const outcome = recordReviewOutcome({
      verdictText,
      sessionId,
      missionId: ids.missionId,
      // The reviewer's own model, from its transcript. Absent ⇒ the verdict
      // line is skipped by the writer; see the block comment above.
      model,
      findingsRef,
      reviewerId: ids.agentType,
    }, {
      append: (input) => appendLedgerEvent(projectRoot, input),
      existingKeys: () => readAllEvents(projectRoot, { session_id: sessionId })
        .map((event) => event?.idempotency_key)
        .filter((key) => typeof key === 'string' && key.length > 0),
    });

    return {
      review: outcome.review.status,
      reviewReason: outcome.review.reason ?? null,
      claimAudit: outcome.claimAudit.status,
      claimAuditReason: outcome.claimAudit.reason ?? null,
      // NOT carried into `reviewLedgerColumn`: the spawn column is a summary of
      // what the LEDGER recorded, and widening its grammar would change a
      // string the vocabulary firewall pins. The label is for callers/tests.
      artifact: planReviewArtifact({
        outcome, ids, projectRoot, model, findingsRef,
      }),
      parsed: {
        ok: outcome.parsed.verdict.ok === true,
        // The legacy fold is an OBSERVATION, not a verdict: it says what an
        // APPROVE would have meant, while no line was written for it.
        foldedVerdict: outcome.parsed.verdict.foldedVerdict ?? null,
        sources: outcome.parsed.verdict.sources ?? [],
      },
    };
  } catch (err) {
    return { error: err?.constructor?.name || 'Error' };
  }
}

/**
 * Serialize the summary into the one string the spawn ledger can carry.
 *
 * A STRING, not the object, because `lib/learning/ledger/spawn-ledger.js`
 * coerces every allowlisted text column through `scrubbed()` and would store an
 * object as null (measured 2026-09-12, `spawn-ledger.js#applyOptionalFields`).
 * The grammar mirrors `route_ledger`'s `<status>:<reason>` so one reader habit
 * covers both columns: `review=<status>[:<reason>],audit=<status>[:<reason>]`
 * plus `,verdict=<folded>` when a legacy answer was folded for measurement.
 *
 * @param {object} summary {@link recordReviewFromStop} output
 * @returns {string} the column value
 */
export function reviewLedgerColumn(summary) {
  if (typeof summary?.error === 'string') {
    return `error=${summary.error}`.slice(0, REVIEW_COLUMN_MAX);
  }
  const half = (label, status, reason) => (typeof reason === 'string' && reason !== ''
    ? `${label}=${status}:${reason}`
    : `${label}=${status}`);
  const parts = [
    half('review', summary.review, summary.reviewReason),
    half('audit', summary.claimAudit, summary.claimAuditReason),
  ];
  const folded = summary.parsed?.foldedVerdict ?? null;
  if (typeof folded === 'string' && folded !== '') parts.push(`verdict=${folded}`);
  return parts.join(',').slice(0, REVIEW_COLUMN_MAX);
}
