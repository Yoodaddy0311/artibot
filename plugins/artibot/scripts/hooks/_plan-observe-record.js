/**
 * PreToolUse(`Write|Edit`) — the `plan.md` half of the write observer.
 * RECORD ONLY.
 *
 * SIBLING OF `intent-observe-pre.js`, NOT A HOOK. There is NO entry point here:
 * nothing in this file reads the process argv vector, so it is not a
 * direct-run-guard subject — the same shape as `_review-stop-record.js`. The
 * host never launches it; `intent-observe-pre.js#main` delegates to it after its
 * own observation has resolved.
 *
 * WHAT IT RECORDS. A write to `.artibot/missions/<M>/plan.md` is the only
 * evidence this process has that a plan was revised. Design §3.1 gives stage ②
 * the intent half (`mission.created` + `intent.md`); this is the plan half:
 *
 *   1. the StateStore row's `plan.revision` goes up by one, and
 *   2. a `plan.revised` ledger line records the new revision.
 *
 * Before this module, NOTHING in the repository raised `plan.revision`.
 * Measured 2026-09-14: the only two production `updateMission` callers are
 * `tasks.js#recordMissionState` and `intent-observe-pre.js#promote`, and both
 * pass `missionMutator`, which only ever SEEDS `plan` at revision 1
 * (`tasks.js#missionMutator`). So the store's plan revision was a constant.
 *
 * IT DECIDES NOTHING, AND IT IS MUTE. PreToolUse is a BLOCK POINT — exit 2 plus
 * a `permissionDecision` on stdout is how such a hook CANCELS the user's tool
 * call. This module therefore:
 *   - never writes to stdout (it imports no stdout writer),
 *   - never throws and never rejects (the whole body is wrapped, and the
 *     artifact tail has a second wrapper of its own),
 *   - never touches `process.exitCode`.
 * Its return value is an outcome object for TESTS and for a later live burn.
 * Nothing downstream consumes it.
 *
 * THE MISSION COMES FROM THE PATH, NOT THE SESSION. `plan.md` sits under
 * `.artibot/missions/<M>/`, so the mission id is already in the file path the
 * host is about to write. Deriving it from the session instead would attribute
 * a plan write to whichever mission the session most recently opened, which is
 * not the same statement.
 *
 * FAIL-CLOSED ON A MISSING STORE ROW. A `plan.md` for a mission the StateStore
 * never opened is neither bumped nor recorded — the same rule, and the same
 * reason, as `_review-stop-record.js#writeReviewArtifact`: the row is the only
 * source of the `based_on` revision, and inventing one would make the record
 * claim it revised a plan for an intent nobody registered.
 *
 * DEDUPE IS `tool_use_id`-SHAPED, AND WITHOUT ONE THERE IS NONE. A redelivered
 * PreToolUse payload carries the SAME `tool_use_id`, which is what
 * {@link alreadyRecorded} matches on. A payload that carries none cannot be
 * told apart from a genuine second edit, so it is treated as one and the
 * revision goes up again. That is HARMLESS but not INVISIBLE: the ledger fold
 * takes the maximum revision (`schemas/ledger-events.allowlist.json`,
 * `plan.revised` spec note), so a double bump reads as one revision — while the
 * line count says two.
 *
 * `tool_use_id` IS A DEDUPE KEY AND NOTHING ELSE. NOTHING HERE MAY DEPEND ON ITS
 * PRESENCE ON A PERSISTED LINE. It is an UNDECLARED `data` key, so it is subject
 * to the writer's oversize fold and can be dropped from a line that is already
 * on disk: `event-writer.js#foldOversized` (:658-675) keeps only
 * `requiredDataKeys(spec)` — `revision` and `mode` for this event — plus
 * `evidence_refs`, and everything else goes. The fold is not silent (it leaves a
 * `ledger-fold:dropped=…` marker in `evidence_refs`) and it fires only above
 * `maxLineBytes`, which a three-key `plan.revised` line is nowhere near — but
 * correctness must not rest on that margin. So a stored line WITHOUT the key
 * simply fails to match, the scan neither throws nor stops, and the write
 * proceeds as a new revision. Pinned by the "a folded line" case in
 * `tests/hooks/plan-observe-record.test.js`.
 *
 * LIVE BASELINE, so a first production line is recognisable as one: the parent
 * repository's ledger held 923 lines and ZERO `plan.revised` events when this
 * module was written (leader-measured 2026-09-14T08:01:35Z — not re-measured
 * here). Every line this hook appends is the first of its kind in production,
 * which is also why no back-compatibility case exists for an older line shape.
 *
 * WHAT THIS MODULE CANNOT SEE (rules §9 — write it next to the gate):
 *   - Plan writes that do not go through the `Write`/`Edit` tools (a shell
 *     heredoc, a script, an MCP server). No PreToolUse, no record.
 *   - WHETHER THE PLAN IS ANY GOOD, or even whether the tool call SUCCEEDED.
 *     PreToolUse fires BEFORE the tool runs, so a cancelled or failed write
 *     still produces a `plan.revised` line. The event names an intent to
 *     revise, observed at the last moment it is observable.
 *   - `mode`. The payload carries nothing that says which command authored the
 *     plan, so the constant `DEFAULT_PLAN_MODE` is always written and the
 *     `ultraplan` half of the enum is unreachable from this hook. See the
 *     `mode` assignment in {@link observePlanWrite} for the full reason.
 *
 * @module scripts/hooks/_plan-observe-record
 */

/**
 * The tools this module answers to.
 *
 * MIRRORS `scripts/hooks/intent-observe-pre.js#WRITE_TOOLS` rather than
 * importing it: that module imports THIS one (the delegation in `main()`), so
 * importing back would close a cycle. An ALLOWLIST for the same reason it is one
 * there — a host that starts routing edits through a new tool name must be added
 * deliberately. `hooks.json`'s `Write|Edit` matcher is an unanchored regex on
 * the host side and also delivers `MultiEdit`/`NotebookEdit`; those are dropped
 * here, by name.
 * @type {Set<string>}
 */
const WRITE_TOOLS = new Set(['Write', 'Edit']);

/** Envelope `source`. `plan.revised` registers `["worker", "hook"]`. */
const LEDGER_SOURCE = 'hook';

/** The event this module appends, in one place so the dedupe read agrees. */
const PLAN_EVENT = 'plan.revised';

/** `updateMission` reason, and the ledger event name it pairs with. */
const STORE_REASON = 'plan.revised';

/**
 * A non-blank string, or null. Same helper and same reason as
 * `intent-observe-pre.js#str`: `''`, numbers and objects all degrade alike.
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Every `lib/` module this path needs, imported LAZILY.
 *
 * Same reason as `intent-observe-pre.js#loadDeps`: a STATIC import of a module
 * that throws while it is being evaluated kills the process before any catch
 * exists, and this file's promise is "never throws under any input". Inside the
 * try, an import-time failure is a caught rejection instead.
 *
 * Called only AFTER the plan-path check, so every non-plan write — which is
 * almost all of them — pays for none of this.
 *
 * @returns {Promise<object>} the named bindings, flat
 */
async function loadDeps() {
  const [git, ledger, lifecycle, tasks, commonDir, file, platform] = await Promise.all([
    import('../../lib/git/project-root.js'),
    import('../../lib/runtime/ledger.js'),
    import('../../lib/runtime/artifact-lifecycle.js'),
    import('../../lib/runtime/middleware/tasks.js'),
    import('../../lib/project-state/git-common-dir.js'),
    import('../../lib/core/file.js'),
    import('../../lib/core/platform.js'),
  ]);
  return {
    resolveProjectRoot: git.resolveProjectRoot,
    appendLedgerEvent: ledger.appendLedgerEvent,
    readAllEvents: ledger.readAllEvents,
    computeIdempotencyKey: lifecycle.computeIdempotencyKey,
    plan: lifecycle.plan,
    apply: lifecycle.apply,
    resolveArtifactGate: lifecycle.resolveArtifactGate,
    openMissionStore: tasks.openMissionStore,
    planRevisionMutator: tasks.planRevisionMutator,
    resolveGitCommonDir: commonDir.resolveGitCommonDir,
    readJsonFileSync: file.readJsonFileSync,
    getPluginRoot: platform.getPluginRoot,
  };
}

/**
 * Read the plugin's config the gate resolver reads its keys from.
 *
 * The raw file under {@link loadDeps}'s `getPluginRoot`, not
 * `lib/core/config.js#loadConfig`. Same substitution, and the same honesty
 * bound, as `_review-stop-record.js#readPluginConfigSync`: `loadConfig` merges
 * the file over `DEFAULTS`, and `DEFAULTS` has no `runtime` key, so under
 * `runtime.artifactLifecycle` the raw file and the merged config agree — for
 * the global `enabled` switch and for the `projectMarker` path alike.
 * DEVIATION TO KNOW ABOUT: this skips `loadConfig`'s memoisation and any future
 * default it might grow for that path.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {object} nodePath `node:path`
 * @returns {object|null} parsed `artibot.config.json`, or null when unreadable
 */
function readPluginConfig(d, nodePath) {
  return d.readJsonFileSync(nodePath.join(d.getPluginRoot(), 'artibot.config.json'), null);
}

/**
 * Has this exact tool call already been recorded?
 *
 * `tool_use_id` is the host's identity for one tool call, so a REDELIVERY
 * carries the same one and a genuine second edit does not. Matched together
 * with the event name and the mission so a `tool_use_id` echoed by some other
 * event cannot suppress a real revision.
 *
 * Returns FALSE when there is no `tool_use_id` — see the module header: no id,
 * no dedupe.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {{projectRoot: string, sessionId: string, missionId: string,
 *   toolUseId: string|null}} ctx
 * @returns {boolean}
 */
function alreadyRecorded(d, ctx) {
  if (ctx.toolUseId === null) return false;
  return d.readAllEvents(ctx.projectRoot, { session_id: ctx.sessionId }).some(
    (e) => e?.event === PLAN_EVENT
      && e?.mission_id === ctx.missionId
      && e?.data?.tool_use_id === ctx.toolUseId,
  );
}

/**
 * Raise the row's `plan.revision`, with ONE retry on a conflict.
 *
 * One retry, not a loop — the same shape and the same reason as
 * `intent-observe-pre.js#promote`: a second conflict means sustained
 * contention, and a hook that spins on a lock delays the user's edit in order
 * to finish bookkeeping.
 *
 * @param {object} d {@link loadDeps} bindings
 * @param {object} store an open StateStore
 * @param {string} missionId
 * @param {number} revision the NEW revision
 * @returns {'written'|'conflict'|'rejected'}
 */
function bumpPlanRevision(d, store, missionId, revision) {
  const mutator = d.planRevisionMutator(missionId, revision);
  const opts = { reason: STORE_REASON };
  let commit = store.updateMission(missionId, mutator, {
    ...opts, expectedVersion: store.getState().state_version,
  });
  if (commit?.conflict === true) {
    commit = store.updateMission(missionId, mutator, {
      ...opts, expectedVersion: store.getState().state_version,
    });
  }
  if (commit?.ok === true) return 'written';
  return commit?.conflict === true ? 'conflict' : 'rejected';
}

/**
 * Plan the `plan.md` write this revision would cause, and — behind the kill
 * switch — carry it out.
 *
 * NEVER THROWS. `plan()` is pure and always runs, so the outcome always carries
 * the Shadow counts even when no file may be created; `apply()` THROWS when the
 * gate is shut — global switch off OR this project missing its marker — which
 * is why the gate is resolved BEFORE it is called rather than being allowed to
 * raise. One resolver owns both halves
 * (`lib/runtime/artifact-lifecycle.js#resolveArtifactGate`), and a resolver
 * that is missing or throws counts as SHUT.
 *
 * WHOSE BYTES WIN IS NOT DECIDED HERE. On this branch the tool call that
 * triggered us is ITSELF about to write `plan.md`. With the gate OPEN, a first
 * `Write` RACES the runtime's own render — `apply` writes only when the file is
 * absent, and the host's tool then overwrites it — while an `Edit` always finds
 * the file present and comes back `ALREADY_EXISTS`. Which document survives is
 * a Wave-11 decision (the outcome-md emitter owns the successor rule). This
 * module only proves the gated path works; on the SHIPPED configuration
 * (`runtime.artifactLifecycle.enabled: false`, 4.61.0) it writes nothing at all
 * and stops at a config read — as does any project without the marker file,
 * even once that switch is flipped on.
 *
 * @param {object} ctx `{d, nodePath, projectRoot, missionId, revision, mode,
 *   intentRevision, planArtifact}`
 * @returns {{status: string, wouldWrite: number, blocked: number,
 *   refused: number, skipped?: string[]}}
 */
function recordPlanArtifact(ctx) {
  const { d, projectRoot, missionId, revision, mode, intentRevision } = ctx;
  try {
    const planResult = d.plan({
      events: [{
        event: PLAN_EVENT,
        mission_id: missionId,
        seq: 0,
        data: { revision, mode },
      }],
      missionState: {
        missionId,
        intentRevision,
        planRevision: revision,
        appliedIdempotencyKeys: [],
      },
      projectRoot,
    });
    const artifact = {
      status: 'planned',
      wouldWrite: planResult.writes.filter((w) => !w.blocked).length,
      blocked: planResult.writes.filter((w) => Boolean(w.blocked)).length,
      refused: planResult.refused.length,
    };

    const config = readPluginConfig(d, ctx.nodePath);
    // ONE status for BOTH closed reasons. The resolver separates global-off
    // from project-off; this file deliberately does not, because
    // `write-disabled` is the vocabulary downstream tests and ledger summaries
    // pin. FAIL-CLOSED on a resolver that is absent or throws: a missing
    // binding makes the call a `TypeError`, and the catch below is not the
    // place to decide that means "write the file anyway".
    let open = false;
    try {
      open = d.resolveArtifactGate({ config, projectRoot })?.open === true;
    } catch {
      open = false;
    }
    if (!open) {
      artifact.status = 'write-disabled';
      return artifact;
    }

    const applied = d.apply(planResult, {
      // `dryRun: true` is the "I know this module" flag, not "do not write";
      // `write: true` is what authorises the filesystem. See `apply`'s doc.
      dryRun: true,
      write: true,
      projectRoot,
      config,
      content: {
        plan: ctx.planArtifact.serializePlanMd({
          missionId,
          revision,
          basedOn: { intentRevision },
          mode,
          actor: { type: 'hook', id: 'plan-observe-record' },
          ts: new Date().toISOString(),
        }),
      },
    });
    const written = Array.isArray(applied?.written) ? applied.written.length : 0;
    artifact.status = written > 0 ? 'written' : 'skipped';
    // REPORTED, not swallowed: `apply` refuses per write rather than throwing,
    // so without the codes a run that produced no file is indistinguishable
    // from one that produced a file — and this module cannot print.
    if (Array.isArray(applied?.skipped) && applied.skipped.length > 0) {
      artifact.skipped = applied.skipped.map((s) => String(s?.reason ?? 'unknown'));
    }
    return artifact;
  } catch (err) {
    // A throwing tail must not take down the ledger and store statuses the
    // caller has already earned — the same argument as
    // `_review-stop-record.js#planReviewArtifact`'s catch.
    return {
      status: 'plan-failed',
      wouldWrite: 0,
      blocked: 0,
      refused: 0,
      skipped: [String(err?.constructor?.name ?? 'Error')],
    };
  }
}

/**
 * Observe one write tool call that targets a mission's `plan.md`.
 *
 * NEVER THROWS, NEVER PRINTS, NEVER CHANGES THE EXIT CODE. Every exit is NAMED,
 * so a run that recorded nothing is explainable from its return value alone
 * rather than looking like a silent failure. The checks are ordered by cost: the
 * tool name and the file path first (object reads plus one string test), and
 * only then the ledger, the store and the config.
 *
 * THE ORDER OF THE TWO RECORDS IS THE RULE, not a preference — the same rule as
 * `intent-observe-pre.js#promote`. The ledger line goes first; a failed append
 * is followed by NO store write, because a bumped row with no event behind it
 * is an orphan by the design's own definition.
 *
 * A STORE FAILURE IS A FAILURE — same rule as `promote` (:361 returns
 * `{ok: false, reason: 'store-failed'}`, and `observeIntent` :530 propagates
 * it). An earlier revision of this file returned `ok: true` there, reasoning
 * that the ledger line is the record and the row is only a projection of it.
 * THAT WAS WRONG, and it borrowed a sentence about something else:
 * `observeIntent`'s "`ok` stays TRUE" is about the artifact FILE being skipped,
 * not about the store.
 *
 * WHAT THE WRONG ANSWER WOULD HAVE COST. The revision is computed from the ROW,
 * and the row wins over the ledger when the two disagree
 * (`artifact-lifecycle.js:264`, "Live revisions: StateStore wins"). So a row
 * left at 1 by a failed bump makes the NEXT plan.md write compute revision 2
 * all over again and append a second line under the SAME idempotency key
 * `mission:<M>:plan:rev-2` — a silently duplicated revision, reported as a
 * success. `ok: false` is what makes that state visible to a caller.
 *
 * The dryRun artifact record is still attached on that path: the ledger line
 * genuinely exists, and dropping its Shadow counts would lose a measurement
 * that was legitimately taken.
 *
 * @param {object|null} hookData parsed PreToolUse payload
 * @returns {Promise<{ok: boolean, reason?: string, missionId?: string,
 *   revision?: number, mode?: string, ledger?: string, store?: string,
 *   artifact?: object}>}
 */
export async function observePlanWrite(hookData) {
  try {
    if (!WRITE_TOOLS.has(hookData?.tool_name)) return { ok: false, reason: 'not-write-tool' };

    // THE CHEAP COMMON EXIT. Every write that is not a mission plan stops here,
    // before the ledger, the store, the lifecycle or the config module has been
    // loaded at all. Only `lib/planning/plan-artifact.js` — which owns the path
    // rule and imports nothing heavy — is paid for.
    const planArtifact = await import('../../lib/planning/plan-artifact.js');
    const filePath = hookData?.tool_input?.file_path;
    if (!planArtifact.isAllowedPlanFilePath(filePath)) {
      return { ok: false, reason: 'not-plan-path' };
    }
    const missionId = planArtifact.missionIdFromPlanPath(filePath);
    // Unreachable while `isAllowedPlanFilePath` is the same predicate as the
    // extractor's. Asserted rather than assumed: an id from a path goes on to
    // become a ledger `mission_id` and a filesystem path.
    if (str(missionId) === null) return { ok: false, reason: 'not-plan-path' };

    const sessionId = str(hookData?.session_id) ?? str(hookData?.sessionId);
    if (sessionId === null) return { ok: false, reason: 'no-session' };
    const cwd = str(hookData?.cwd);
    if (cwd === null) return { ok: false, reason: 'no-cwd' };

    const d = await loadDeps();
    const nodePath = await import('node:path');
    const projectRoot = str(d.resolveProjectRoot(cwd));
    if (projectRoot === null) return { ok: false, reason: 'no-project-root' };

    const toolUseId = str(hookData?.tool_use_id);
    if (alreadyRecorded(d, { projectRoot, sessionId, missionId, toolUseId })) {
      return {
        ok: true, reason: 'deduped', missionId, ledger: 'deduped', store: 'skipped',
      };
    }

    const store = d.openMissionStore(projectRoot, sessionId, Date.now(), {
      resolveGitCommonDir: d.resolveGitCommonDir,
    });
    const row = store.getMission(missionId);
    if (row === null || row === undefined) {
      return { ok: false, reason: 'no-mission-row', missionId };
    }

    // The seed is revision 1 (`tasks.js#missionMutator`), so the FIRST plan.md
    // write of a mission records revision 2. A row carrying a non-integer or a
    // sub-1 revision is read as the seed rather than trusted, because
    // `validateMission` requires an integer >= 1 and anything else is a row
    // this module cannot count from.
    const seeded = Number.isInteger(row.plan?.revision) && row.plan.revision >= 1
      ? row.plan.revision
      : planArtifact.FIRST_PLAN_REVISION;
    const revision = seeded + 1;
    // ALWAYS THE DEFAULT (leader decision 5, 2026-09-14). `plan.revised`
    // REQUIRES `mode`, enum `plan_mode` = ["plan", "ultraplan"], and the
    // PreToolUse payload has no source for it: it carries the tool name, the
    // path and the content, nothing that says which command authored the plan.
    // Reading the content and guessing would put a guess into a measurement. A
    // `worker`-sourced emitter that DOES know its mode is what will carry the
    // other value.
    const mode = planArtifact.DEFAULT_PLAN_MODE;
    const intentRevision = Number.isInteger(row.intent?.revision) ? row.intent.revision : null;
    // `based_on.intent_revision` is what makes the plan a plan FOR something.
    // Without it the record would have to invent an edge, which is the one
    // thing the staleness table cannot recover from.
    //
    // DEFENSIVE, AND UNREACHABLE THROUGH A VALIDATED ROW: `validateMission`
    // (`lib/project-state/validate.js:94-97`) refuses to commit a mission whose
    // `intent.revision` is not an integer >= 1, so the store cannot hand back a
    // row that lands here. Kept because this function's contract is "never
    // throws" and `getMission` is a port like any other. Pinned by the
    // stubbed-store case in `tests/hooks/plan-observe-record.test.js`.
    if (intentRevision === null) return { ok: false, reason: 'no-intent-revision', missionId };

    const data = { revision, mode };
    // Only when the host gave us one. The key is UNDECLARED in the allowlist
    // (`event-writer.js#validateDeclaredFields` type-checks declared keys only),
    // which is the same pass-through the `mission.candidate_deferred` title
    // carrier relies on in `tasks.js#buildMissionLedgerData`.
    if (toolUseId !== null) data.tool_use_id = toolUseId;

    const appended = d.appendLedgerEvent(projectRoot, {
      event: PLAN_EVENT,
      session_id: sessionId,
      mission_id: missionId,
      source: LEDGER_SOURCE,
      idempotency_key: d.computeIdempotencyKey({ missionId, kind: 'plan', revision }),
      data,
    });
    if (appended?.ok !== true) {
      return {
        ok: false,
        reason: `append-failed:${appended?.reason ?? 'unknown'}`,
        missionId,
        revision,
      };
    }

    const storeStatus = bumpPlanRevision(d, store, missionId, revision);
    const artifact = recordPlanArtifact({
      d, nodePath, projectRoot, missionId, revision, mode, intentRevision, planArtifact,
    });
    return storeStatus === 'written'
      ? { ok: true, missionId, revision, mode, ledger: 'appended', store: 'written', artifact }
      : {
        // FALSE. See the header: the row is what the next revision is computed
        // from, so a row left behind makes the next write reuse this revision.
        ok: false,
        reason: 'store-failed',
        missionId,
        revision,
        mode,
        ledger: 'appended',
        store: storeStatus,
        artifact,
      };
  } catch (err) {
    return { ok: false, reason: err?.message || 'observe-plan-failed' };
  }
}
