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
 *     re-catches so even an import-time surprise cannot escape. The `lib/`
 *     imports are DEFERRED into that wrapped body (see {@link loadDeps}), so a
 *     dependency that throws while it loads is a caught rejection rather than
 *     an uncaught top-level one; measured, not assumed.
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
import { isMainEntry } from './_main-entry.js';

/**
 * Every `lib/` module this hook needs — imported LAZILY, inside the try.
 *
 * WHY NOT STATIC IMPORTS. A static `import` of a module that throws while it is
 * being evaluated kills the process BEFORE `main()` exists: Node prints the
 * stack on stderr and exits 1. stdout stays empty, so that failure mode never
 * breached the block point (only exit 2 cancels a tool call) — but "exit 0
 * under every input", which this file's header promises, was not true of it,
 * and it was UNMEASURABLE without editing this file. Moving the imports here
 * puts them inside {@link observeIntent}'s catch, which makes the promise true
 * and the measurement possible (`tests/hooks/intent-observe-pre.test.js`
 * replaces `lib/runtime/ledger.js` with a throwing module via a `load` hook).
 *
 * `node:fs`, `node:path` and `../utils/index.js` stay static on purpose: the
 * first two cannot fail, and the third is what `main()` needs to read stdin at
 * all. `Promise.all` rather than sequential awaits — these are ten independent
 * module graphs and any one of them rejecting is the same single failure.
 *
 * @returns {Promise<object>} the named bindings, flat
 */
async function loadDeps() {
  const [core, git, ledger, writer, missionId, compiler, artifact, lifecycle, tasks, commonDir] =
    await Promise.all([
      import('../../lib/core/config.js'),
      import('../../lib/git/project-root.js'),
      import('../../lib/runtime/ledger.js'),
      import('../../lib/runtime/event-writer.js'),
      import('../../lib/mission/mission-id.js'),
      import('../../lib/mission/compiler.js'),
      import('../../lib/intent/artifact.js'),
      import('../../lib/runtime/artifact-lifecycle.js'),
      import('../../lib/runtime/middleware/tasks.js'),
      import('../../lib/project-state/git-common-dir.js'),
    ]);
  return {
    loadConfig: core.loadConfig,
    resolveProjectRoot: git.resolveProjectRoot,
    appendLedgerEvent: ledger.appendLedgerEvent,
    readAllEvents: ledger.readAllEvents,
    sessionFallbackMissionId: writer.sessionFallbackMissionId,
    isMissionId: missionId.isMissionId,
    compileMission: compiler.compileMission,
    serializeIntentMd: artifact.serializeIntentMd,
    apply: lifecycle.apply,
    plan: lifecycle.plan,
    missionMutator: tasks.missionMutator,
    openMissionStore: tasks.openMissionStore,
    resolveGitCommonDir: commonDir.resolveGitCommonDir,
  };
}

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
 * Mission id DERIVED for this session: the payload's when it names a valid one,
 * else the session fallback.
 *
 * A FALLBACK, NOT THE ANSWER. The derived id carries today's UTC date, so it is
 * only the right id while stage ① and stage ② land on the same UTC day; the id
 * actually in force is the one on the candidate ROW (see
 * {@link latestCandidateForSession}), and this function is what runs when the
 * session has no row to adopt from.
 *
 * Uses the EVENT-WRITER form deliberately — see the fork note in the module
 * header. Never throws: a `null` here becomes a `no-mission` return, not a
 * cancelled tool call.
 *
 * @param {object} hookData - Parsed payload
 * @param {string|null} sessionId
 * @param {object|null} [deps] - Pre-loaded {@link loadDeps} bindings
 * @returns {Promise<string|null>}
 */
export async function resolveMissionId(hookData, sessionId, deps = null) {
  const d = deps ?? await loadDeps();
  const declared = hookData?.mission_id ?? hookData?.missionId;
  if (d.isMissionId(declared)) return declared;
  if (str(sessionId) === null) return null;
  try {
    const id = d.sessionFallbackMissionId(sessionId, new Date());
    return d.isMissionId(id) ? id : null;
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
 * The latest ledger line for this SESSION that could evidence a mission.
 *
 * THE SESSION IS THE KEY, AND THE ROW CARRIES THE ID. The mission id's date
 * part comes from the wall clock, so stage ② re-deriving it is wrong the moment
 * a session crosses 00:00 UTC — in KST that is every session spanning 09:00.
 * Filtering by a re-derived id made those sessions a permanent `no-candidate`
 * (review R1, Important 1). Stage ① is the half that ISSUES the id, so stage ②
 * reads by session and ADOPTS `mission_id` off the row it finds.
 *
 * `missionId` is passed only when the payload DECLARED one; then it is a
 * filter, because a declared id is the caller's assertion about which mission
 * this write belongs to and a row under a different id is not evidence for it.
 * When it is null, rows whose `mission_id` is not a well-formed mission id are
 * skipped — an adopted id goes straight into a filesystem path.
 *
 * LAST WINS. Ledger order is append order, so the last matching row is the
 * newest statement the session made about itself.
 *
 * @param {object} deps - {@link loadDeps} bindings
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string|null} [missionId] - filter, when the payload declared one
 * @returns {object|null}
 */
function latestCandidateForSession(deps, projectRoot, sessionId, missionId = null) {
  const events = deps.readAllEvents(projectRoot, { session_id: sessionId });
  let found = null;
  for (const e of events) {
    if (!CANDIDATE_EVENTS.has(e?.event)) continue;
    if (missionId === null ? !deps.isMissionId(e?.mission_id) : e?.mission_id !== missionId) {
      continue;
    }
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
 * @param {{deps: object, title: string, action: string, missionId: string,
 *   revision: number}} spec
 * @returns {object} `compileMission` result
 */
function compilePromotion(spec) {
  return spec.deps.compileMission({
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
 * @param {{deps: object, projectRoot: string, sessionId: string, missionId: string,
 *   title: string, revision: number, store: object}} ctx
 * @returns {{ok: boolean, reason?: string}}
 */
function promote(ctx) {
  const appended = ctx.deps.appendLedgerEvent(ctx.projectRoot, {
    event: 'mission.created',
    session_id: ctx.sessionId,
    mission_id: ctx.missionId,
    source: LEDGER_SOURCE,
    data: { title: ctx.title, intent_revision: ctx.revision },
  });
  if (appended?.ok !== true) {
    return { ok: false, reason: `append-failed:${appended?.reason ?? 'unknown'}` };
  }

  const mutator = ctx.deps.missionMutator(ctx.missionId, ctx.title, ctx.revision);
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
 * @param {{deps: object, projectRoot: string, missionId: string, title: string,
 *   revision: number, text: string, config: object|undefined}} ctx
 * @returns {{written: number, skipped: string[]}} `skipped` carries
 *   `SkipReason` codes, so a write that silently produced no file says why.
 */
function writeIntent(ctx) {
  const planResult = ctx.deps.plan({
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
  const applied = ctx.deps.apply(planResult, {
    dryRun: true,
    write: true,
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    content: { intent: ctx.text },
  });
  return {
    written: Array.isArray(applied?.written) ? applied.written.length : 0,
    // REPORTED, not swallowed. `apply` refuses per write rather than throwing
    // (`SkipReason.NO_CONTENT` · `PATH_OUTSIDE_MISSIONS_DIR` · `ALREADY_EXISTS`
    // · `WRITE_FAILED`), so without this a hook that produced no file is
    // indistinguishable from one that produced a file — and this hook cannot
    // print, which makes the return value the only place the reason can live.
    skipped: Array.isArray(applied?.skipped)
      ? applied.skipped.map((s) => String(s?.reason ?? 'unknown'))
      : [],
  };
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
    const deps = await loadDeps();
    const projectRoot = deps.resolveProjectRoot(cwd);
    if (str(projectRoot) === null) return { ok: false, reason: 'no-project-root' };

    const derivedId = await resolveMissionId(hookData, sessionId, deps);
    // THE FAST LATCH. The design says "the FIRST write tool of a session"; the
    // artifact's own existence is the cheapest true statement of "this session
    // already ran stage ②". It is checked against the DERIVED id first because
    // that costs one `existsSync`, and it is the id in force for every session
    // that did not cross 00:00 UTC — i.e. almost all of them.
    //
    // WHAT IT CANNOT SEE, AND WHAT THAT COSTS (rules §9). Two cases miss it and
    // pay one `readAllEvents` — a WHOLE-FILE read filtered in memory, not a
    // seek — on every write:
    //   - a session that crossed midnight, whose document sits under the
    //     adopted id (bounded: the second latch catches it from write 2 on);
    //   - any session at all while `runtime.artifactLifecycle.enabled` is
    //     false, because then no document is ever written and NO latch can
    //     fire. Unbounded in the ledger's size, and the reason the read is the
    //     thing to revisit if the ledger grows (review R1, Suggestion 2).
    if (derivedId !== null && existsSync(intentArtifactPath(projectRoot, derivedId))) {
      return {
        ok: true, reason: 'already-written', missionId: derivedId, promoted: false, written: 0,
      };
    }

    const declared = hookData?.mission_id ?? hookData?.missionId;
    // `undefined` = not read yet, `null` = read and absent. Two states, because
    // "no candidate" must not trigger a second full ledger read below.
    let candidate;
    let missionId = derivedId;
    if (!deps.isMissionId(declared)) {
      candidate = latestCandidateForSession(deps, projectRoot, sessionId);
      if (deps.isMissionId(candidate?.mission_id)) missionId = candidate.mission_id;
    }
    if (missionId === null) return { ok: false, reason: 'no-mission' };

    // THE LATCH, on the ADOPTED id. Without it the cross-midnight session would
    // promote on every single write: the fast latch above tests a path that
    // session never produces.
    const intentPath = intentArtifactPath(projectRoot, missionId);
    if (existsSync(intentPath)) {
      return { ok: true, reason: 'already-written', missionId, promoted: false, written: 0 };
    }

    let config;
    try {
      config = await deps.loadConfig();
    } catch {
      config = undefined;
    }

    const filePath = hookData?.tool_input?.file_path;
    const store = deps.openMissionStore(projectRoot, sessionId, Date.now(), {
      resolveGitCommonDir: deps.resolveGitCommonDir,
    });
    const existing = store.getMission(missionId);

    let title;
    let revision;
    let promoted = false;

    if (existing === null || existing === undefined) {
      // Only when the payload DECLARED an id: that path skips the lookup above,
      // and the row must then be one filed under the declared id.
      if (candidate === undefined) {
        candidate = latestCandidateForSession(deps, projectRoot, sessionId, missionId);
      }
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
          deps, title, action: s1Action(filePath), missionId, revision,
        });
        // Unreachable for all three S1 actions — asserted rather than assumed,
        // because a change to the substantive gate that stopped S1 firing would
        // otherwise turn this hook into a silent no-op.
        if (compiled.meta?.ledgerEvent !== 'mission.created') {
          return { ok: false, reason: 'not-substantive' };
        }
        const result = promote({
          deps, projectRoot, sessionId, missionId, title, revision, store,
        });
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
      deps, title, action: s1Action(filePath), missionId, revision,
    });
    const text = deps.serializeIntentMd(compiled.contract, { originalRequest: title });
    const result = writeIntent({
      deps, projectRoot, missionId, title, revision, text, config,
    });
    // `ok` stays TRUE on a skipped file. The records are the mission; the
    // document is a projection of them, and a failed projection must not be
    // reported as a failed promotion — the ledger line and the store row are
    // both on disk by this point and saying otherwise would be the lie.
    return result.written === 0 && result.skipped.length > 0
      ? { ok: true, missionId, promoted, written: 0, skipped: result.skipped }
      : { ok: true, missionId, promoted, written: result.written };
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
