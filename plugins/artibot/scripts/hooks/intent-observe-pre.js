#!/usr/bin/env node
/**
 * PreToolUse(`Write|Edit`) — STAGE ② of mission id issuance.
 *
 * WHY THIS FILE EXISTS. Design §3.1 splits mission issuance in two, because the
 * two halves cannot be measured at the same moment:
 *
 *   ① At the prompt (`lib/runtime/middleware/tasks.js#recordMissionCompile`),
 *      only S3~S6 are measurable. S1 ("completion expectation includes a
 *      repository write") is a claim about a tool that has not run yet, so a
 *      prompt that looks like work but writes nothing must NOT open a mission.
 *      Stage ① therefore records `mission.candidate_deferred` and stops.
 *   ② At the first write tool of the session — here — S1 becomes a FACT: the
 *      host is about to call `Write` or `Edit`. That is the moment the deferred
 *      candidate is promoted to `mission.created`, the mission is registered in
 *      the StateStore, and `.artibot/missions/<M>/intent.md` is authored.
 *
 * PRETOOLUSE IS A BLOCK POINT, SO THIS HOOK IS MUTE. exit 2 (and a
 * `permissionDecision` on stdout) is how a PreToolUse hook CANCELS the tool
 * call, and a hook that can cancel the user's edit in order to do bookkeeping
 * is not an observer. Therefore, as in `route-observe-pre.js`:
 *
 *   - NOTHING is ever written to stdout. Not on success, not on failure. This
 *     module does not import `writeStdout` at all.
 *   - `main()` never throws — the body is wrapped, and the direct-run guard
 *     re-catches so even an import-time surprise cannot escape.
 *   - `process.exitCode` is pinned to 0 before anything else runs.
 *   - `tool_name` outside {@link WRITE_TOOLS} returns on the FIRST check,
 *     before any ledger, config or store module does any work. The `hooks.json`
 *     matcher already restricts this hook; this is the second, independent
 *     defence, and it is what makes a mis-scoped matcher cost nothing.
 *
 * WHICH `sessionFallbackMissionId` — A REAL FORK, NAMED HERE. Two different
 * functions carry that name in this repository:
 *
 *   `lib/runtime/event-writer.js`  (sessionId, when)      → null on bad input,
 *                                                           sha256 prefix when
 *                                                           the id yields < 8
 *                                                           alphanumerics
 *   `lib/mission/mission-id.js`    ({sessionId, nowMs})   → THROWS under 8
 *                                                           alphanumerics
 *
 * They agree for every session id with 8+ alphanumerics and DISAGREE below
 * that. Stage ① writes its candidate under the event-writer form
 * (`tasks.js#resolveMissionIdentity`), so stage ② reads under the same one —
 * otherwise a short session id makes this hook look for a row that stage ①
 * filed under a different name. `route-observe-pre.js` uses the mission-id.js
 * form; that is correct for it (it writes its own line under its own id) and
 * wrong for this file.
 *
 * WHAT THIS HOOK CANNOT SEE (rules §9 — write it next to the gate):
 *   - Writes that never go through the `Write`/`Edit` tools (a shell heredoc, a
 *     script the user runs, an MCP server). They produce no PreToolUse and no
 *     promotion, and that is a limit of the gate, not a defect of the mission.
 *   - S2 (commit / PR / deploy, `PreToolUse(Bash)`) is OUT OF SCOPE here and
 *     belongs to a later wave. A mission that only ever ships and never edits
 *     is therefore not promoted by this file.
 *   - Whether the promoted title is any GOOD. It is the stage ① title verbatim,
 *     or a filename when stage ① recorded none.
 *
 * @module scripts/hooks/intent-observe-pre
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseJSON, readStdin } from '../utils/index.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { isMissionId } from '../../lib/mission/mission-id.js';
import { compileMission } from '../../lib/mission/compiler.js';
import { serializeIntentMd } from '../../lib/intent/artifact.js';
import { apply, plan } from '../../lib/runtime/artifact-lifecycle.js';
import { missionMutator, openMissionStore } from '../../lib/runtime/middleware/tasks.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { isMainEntry } from './_main-entry.js';

/**
 * The tools this hook answers to. An ALLOWLIST, not a denylist: a host that
 * starts routing edits through a new tool name must be added deliberately
 * rather than silently promoting missions from something unexamined.
 *
 * The `hooks.json` matcher `Write|Edit` is an UNANCHORED regex on the host
 * side, so it also matches `MultiEdit` and `NotebookEdit` (hooks.json's own
 * `description` records this). Those payloads reach this process and are
 * dropped here, by name.
 * @type {Set<string>}
 */
export const WRITE_TOOLS = new Set(['Write', 'Edit']);

/** Envelope `source`; both mission events are registered `sources: ["hook"]`. */
const LEDGER_SOURCE = 'hook';

/**
 * Cap on a title this hook authors. Same number and same reason as
 * `tasks.js#MISSION_TITLE_MAX`: `mission.created` REQUIRES `title`, so the
 * writer's oversize fold cannot drop it, and an unbounded string would push the
 * whole line past the ledger's 4 KB cap and get it rejected outright.
 * @type {number}
 */
const TITLE_MAX = 120;

/** First revision. Revisions are a later task's; a first intent.md is r1. */
const FIRST_REVISION = 1;

/** The two ledger events that can evidence a mission for this session. */
const CANDIDATE_EVENTS = new Set(['mission.candidate_deferred', 'mission.created']);

/**
 * A non-blank string, or null. Used for every key read off the payload so that
 * `''`, numbers and objects all degrade the same way.
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The one allowed intent artifact path for a mission.
 *
 * Mirrors `lib/runtime/artifact-lifecycle.js#plan`'s own join
 * (`MISSIONS_DIR` + missionId + `intent.md`) so the LATCH below tests the same
 * path the writer would produce. The basename rule itself is owned by
 * `lib/intent/artifact.js#assertIntentFilePath`.
 *
 * @param {string} projectRoot
 * @param {string} missionId
 * @returns {string}
 */
export function intentArtifactPath(projectRoot, missionId) {
  return path.join(projectRoot, '.artibot', 'missions', missionId, 'intent.md');
}

/**
 * Mission id for this session: the payload's when it names a valid one, else
 * the session fallback.
 *
 * Uses the EVENT-WRITER form deliberately — see the fork note in the module
 * header. Never throws: a `null` here becomes a `no-mission` return, not a
 * cancelled tool call.
 *
 * @param {object} hookData - Parsed payload
 * @param {string|null} sessionId
 * @returns {string|null}
 */
export function resolveMissionId(hookData, sessionId) {
  const declared = hookData?.mission_id ?? hookData?.missionId;
  if (isMissionId(declared)) return declared;
  if (str(sessionId) === null) return null;
  try {
    const id = sessionFallbackMissionId(sessionId, new Date());
    return isMissionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The S1 completion action this write tool evidences — an ALLOWLIST over the
 * three members of `lib/mission/mission-id.js#S1_WRITE_ACTIONS`.
 *
 * Deliberately NOT a "everything unknown is not a write" denylist: reaching
 * this function already means the host is about to call `Write`/`Edit`, so a
 * repository write is a FACT and the only open question is which of the three
 * names it. `implement` is the honest default for that, and the allowlist
 * shape is what keeps a new file extension from silently producing a
 * non-S1 verb (verification-discipline §8).
 *
 * @param {unknown} filePath - `tool_input.file_path`
 * @returns {'test'|'artifact'|'implement'}
 */
export function s1Action(filePath) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s !== '');
  const base = segments.length > 0 ? segments[segments.length - 1] : '';
  const dirs = segments.slice(0, -1);
  if (dirs.includes('tests') || dirs.includes('test') || dirs.includes('__tests__')) return 'test';
  if (/\.(test|spec)\./i.test(base)) return 'test';
  if (/\.md$/i.test(base)) return 'artifact';
  return 'implement';
}

/**
 * The title for the promoted mission.
 *
 * Stage ①'s `title` wins whenever it exists, because it is derived from the
 * user's own prompt. THE FALLBACK IS A FILENAME, and that is a deliberate
 * downgrade, not a guess at intent: when stage ① recorded no title (an older
 * ledger line, or a candidate written before the title carrier landed) the file
 * about to be written is the only evidence in hand, and a mission named after
 * one file is at least checkable against the ledger. It is never a paraphrase
 * of a prompt this process cannot see.
 *
 * @param {object|undefined} data - The candidate event's `data`
 * @param {unknown} filePath - `tool_input.file_path`
 * @returns {string}
 */
export function promotionTitle(data, filePath) {
  const recorded = str(data?.title);
  if (recorded !== null) return recorded.slice(0, TITLE_MAX);
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s !== '');
  const base = segments.length > 0 ? segments[segments.length - 1] : '';
  return (base === '' ? 'untitled mission' : base).slice(0, TITLE_MAX);
}

/**
 * The latest ledger line for this mission that could evidence a mission.
 *
 * Read per SESSION and filtered by mission id, because the session is the only
 * key stage ① and stage ② share for certain — the mission id is DERIVED from
 * it, so filtering by session first means a mismatch in the derivation shows up
 * as `no-candidate` rather than as a silent read of the wrong session's rows.
 *
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string} missionId
 * @returns {object|null}
 */
function latestCandidate(projectRoot, sessionId, missionId) {
  const events = readAllEvents(projectRoot, { session_id: sessionId });
  let found = null;
  for (const e of events) {
    if (e?.mission_id !== missionId) continue;
    if (!CANDIDATE_EVENTS.has(e?.event)) continue;
    found = e;
  }
  return found;
}

/**
 * Compile the Mission Contract for a promotion.
 *
 * `stage: 'execution'` is what lets S1 fire at all —
 * `mission-id.js#judgeSubstantive` refuses to evaluate S1/S2 at the prompt
 * stage. `system: 'system2'` selects the FULL contract, which is the only mode
 * that carries `mission_id`/`intent_revision` through
 * `compiler.js#assignOptionalFields` into the document.
 *
 * @param {{title: string, action: string, missionId: string, revision: number}} spec
 * @returns {object} `compileMission` result
 */
function compilePromotion(spec) {
  return compileMission({
    prompt: spec.title,
    stage: 'execution',
    completion: { expected_actions: [spec.action] },
    missionId: spec.missionId,
    intentRevision: spec.revision,
    status: 'queued',
    system: 'system2',
  });
}

/**
 * Append the `mission.created` line, then register the row — in that order.
 *
 * THE ORDER IS THE RULE, not a preference. A store row whose mission has no
 * `mission.created` event is an orphan by the design's own definition
 * (`/doctor` Check 8-③, restated in `tasks.js#recordMissionState`), so a failed
 * append must not be followed by a store write that invents one.
 *
 * @param {{projectRoot: string, sessionId: string, missionId: string, title: string,
 *   revision: number, store: object}} ctx
 * @returns {{ok: boolean, reason?: string}}
 */
function promote(ctx) {
  const appended = appendLedgerEvent(ctx.projectRoot, {
    event: 'mission.created',
    session_id: ctx.sessionId,
    mission_id: ctx.missionId,
    source: LEDGER_SOURCE,
    data: { title: ctx.title, intent_revision: ctx.revision },
  });
  if (appended?.ok !== true) {
    return { ok: false, reason: `append-failed:${appended?.reason ?? 'unknown'}` };
  }

  const mutator = missionMutator(ctx.missionId, ctx.title, ctx.revision);
  const opts = { reason: 'mission.created' };
  let commit = ctx.store.updateMission(ctx.missionId, mutator, {
    ...opts, expectedVersion: ctx.store.getState().state_version,
  });
  // ONE retry, not a loop. A second conflict means sustained contention, and a
  // hook that spins on a lock delays the user's edit to fix bookkeeping.
  if (commit?.conflict === true) {
    commit = ctx.store.updateMission(ctx.missionId, mutator, {
      ...opts, expectedVersion: ctx.store.getState().state_version,
    });
  }
  return commit?.ok === true ? { ok: true } : { ok: false, reason: 'store-failed' };
}

/**
 * Write `intent.md` through the artifact lifecycle.
 *
 * Goes through `plan()` + `apply()` rather than `fs.writeFileSync` so the
 * idempotency key, the refusal codes and the three gates all apply to this
 * write the same way they apply to every other artifact. This is the one
 * production caller that opens `apply`'s gate 3 (`write: true`); a `skipped`
 * entry (`SkipReason.ALREADY_EXISTS`, `NO_CONTENT`, …) is a 0 here, not a
 * failure — the artifact is never clobbered and the hook stays mute.
 *
 * @param {{projectRoot: string, missionId: string, title: string, revision: number,
 *   text: string, config: object|undefined}} ctx
 * @returns {number} files written
 */
function writeIntent(ctx) {
  const planResult = plan({
    events: [{
      event: 'mission.created',
      mission_id: ctx.missionId,
      seq: 0,
      data: { title: ctx.title, intent_revision: ctx.revision },
    }],
    missionState: {
      missionId: ctx.missionId,
      intentRevision: ctx.revision,
      appliedIdempotencyKeys: [],
    },
    projectRoot: ctx.projectRoot,
  });
  const applied = apply(planResult, {
    dryRun: true,
    write: true,
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    content: { intent: ctx.text },
  });
  return Array.isArray(applied?.written) ? applied.written.length : 0;
}

/**
 * Observe one write tool call: confirm S1, promote, register, author intent.md.
 *
 * Returns a short outcome for tests and for a later live burn; NOTHING
 * downstream consumes it, and nothing is printed. Never throws.
 *
 * @param {object|null} hookData - Parsed payload
 * @returns {Promise<{ok: boolean, reason?: string, missionId?: string,
 *   promoted?: boolean, written?: number}>}
 */
export async function observeIntent(hookData) {
  try {
    if (!WRITE_TOOLS.has(hookData?.tool_name)) return { ok: false, reason: 'not-write-tool' };

    const sessionId = str(hookData?.session_id) ?? str(hookData?.sessionId);
    if (sessionId === null) return { ok: false, reason: 'no-session' };
    const cwd = str(hookData?.cwd);
    if (cwd === null) return { ok: false, reason: 'no-cwd' };
    const projectRoot = resolveProjectRoot(cwd);
    if (str(projectRoot) === null) return { ok: false, reason: 'no-project-root' };
    const missionId = resolveMissionId(hookData, sessionId);
    if (missionId === null) return { ok: false, reason: 'no-mission' };

    // THE LATCH, and it is deliberately the FIRST filesystem read. The design
    // says "the FIRST write tool of a session"; the artifact's own existence is
    // the cheapest true statement of "this session already ran stage ②", and it
    // costs one `existsSync` instead of a whole ledger read on every subsequent
    // edit of the session.
    const intentPath = intentArtifactPath(projectRoot, missionId);
    if (existsSync(intentPath)) {
      return { ok: true, reason: 'already-written', missionId, promoted: false, written: 0 };
    }

    let config;
    try {
      config = await loadConfig();
    } catch {
      config = undefined;
    }

    const filePath = hookData?.tool_input?.file_path;
    const store = openMissionStore(projectRoot, sessionId, Date.now(), { resolveGitCommonDir });
    const existing = store.getMission(missionId);

    let title;
    let revision;
    let promoted = false;

    if (existing === null || existing === undefined) {
      const candidate = latestCandidate(projectRoot, sessionId, missionId);
      // FAIL-CLOSED. No candidate means stage ① never judged this session, and
      // opening a mission from a bare tool call would invent the one thing the
      // two-stage split exists to avoid.
      if (candidate === null) return { ok: false, reason: 'no-candidate' };

      title = promotionTitle(candidate.data, filePath);
      revision = FIRST_REVISION;

      if (candidate.event === 'mission.created') {
        // The ledger opened this mission but the store has no row — a torn
        // stage ① write. NOT repaired here: a second `mission.created` would
        // duplicate the fold's start point, and a store row written without an
        // append of its own is the orphan rule read backwards. The intent
        // document is still authored, since the mission demonstrably exists.
        revision = Number.isInteger(candidate.data?.intent_revision)
          ? candidate.data.intent_revision
          : FIRST_REVISION;
      } else {
        const compiled = compilePromotion({
          title, action: s1Action(filePath), missionId, revision,
        });
        // Unreachable for all three S1 actions — asserted rather than assumed,
        // because a change to the substantive gate that stopped S1 firing would
        // otherwise turn this hook into a silent no-op.
        if (compiled.meta?.ledgerEvent !== 'mission.created') {
          return { ok: false, reason: 'not-substantive' };
        }
        const result = promote({ projectRoot, sessionId, missionId, title, revision, store });
        if (result.ok !== true) return { ok: false, reason: result.reason };
        promoted = true;
      }
    } else {
      // Stage ① already created the mission. No append, no store write: the
      // only thing missing is the document.
      title = str(existing.title) ?? promotionTitle(undefined, filePath);
      revision = Number.isInteger(existing.intent?.revision)
        ? existing.intent.revision
        : FIRST_REVISION;
    }

    // The gate is checked AFTER the records, on purpose: ledger and store
    // writes are Observe-legal, artifact FILES are not, so a closed gate must
    // suppress the file and nothing else (design §7.3).
    if (config?.runtime?.artifactLifecycle?.enabled !== true) {
      return { ok: true, reason: 'write-disabled', missionId, promoted, written: 0 };
    }

    const compiled = compilePromotion({
      title, action: s1Action(filePath), missionId, revision,
    });
    const text = serializeIntentMd(compiled.contract, { originalRequest: title });
    const written = writeIntent({ projectRoot, missionId, title, revision, text, config });
    return { ok: true, missionId, promoted, written };
  } catch (err) {
    return { ok: false, reason: err?.message || 'observe-failed' };
  }
}

/**
 * Hook entry. Reads stdin, records, and returns — no stdout, no non-zero exit,
 * no throw, under every input.
 * @returns {Promise<object>}
 */
export async function main() {
  process.exitCode = 0;
  try {
    const raw = await readStdin();
    // parseJSON returns null on malformed input; observeIntent then falls out
    // at its first check. Non-JSON stdin is a no-op, not an error.
    return await observeIntent(parseJSON(raw));
  } catch (err) {
    return { ok: false, reason: err?.message || 'main-failed' };
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// The extra `.catch` is redundant with main()'s own try/catch by design — this
// is a block point, and one guarantee with two independent implementations is
// cheaper than one cancelled user edit in production.
if (isMainEntry(import.meta.url)) {
  main().catch(() => { process.exitCode = 0; });
}
