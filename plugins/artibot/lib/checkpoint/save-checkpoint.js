/**
 * The `/save` checkpoint pass — one checkpoint per active mission, plus the
 * rows the command's prose renders.
 *
 * ── What this module is for ───────────────────────────────────────────────
 * `/save` used to end a session without leaving anything a later session could
 * resume from: the state store held the mission, but no checkpoint recorded
 * WHERE the run was, so `/resume` had nothing to load. This module is the step
 * that closes that gap. It walks the session's active missions, builds one
 * checkpoint body per mission from the live records, hands it to the checkpoint
 * service, asks (report-only) whether the result could be resumed, and
 * announces the save on the ledger. It returns rows; it renders nothing.
 *
 * ── Why the order is fixed ────────────────────────────────────────────────
 * The five ports run in the order the Resume Contract's mirror image implies —
 * read the mission, read the task graph, save, judge, announce — and that order
 * is exported as {@link SAVE_CHECKPOINT_PORT_ORDER} rather than left implicit.
 * Two of the steps are only correct in that position: the resume report is
 * asked AFTER the save so it can see the checkpoint that was just written, and
 * the ledger line is emitted LAST so it can carry the report's verdict. A
 * refactor that reorders them would still pass a test that only checked the
 * outputs, so the order itself is the assertion.
 *
 * ── What it refuses to invent ─────────────────────────────────────────────
 * No session id and no mission id is ever fabricated. Without a session id the
 * whole run is skipped rather than checkpointed under a made-up one, because a
 * checkpoint keyed to a session that never existed is worse than no checkpoint:
 * `/resume` would find it and trust it. A revision that is not an integer is
 * copied AS IS so `validateCheckpoint` rejects it and the row carries the real
 * reason — defaulting it to 0 would store a lie that validates.
 *
 * ── Failures that must not fail the save ──────────────────────────────────
 * Once the checkpoint is durable, nothing afterwards may turn the run into a
 * failure. A resume report that throws leaves `resumable: null` and the marker
 * `report:threw`; a ledger port that throws or refuses is recorded in the row.
 * Both are reported, neither is rethrown, and the row still reads `saved` —
 * because it was.
 *
 * ── Layer ─────────────────────────────────────────────────────────────────
 * L2, pure over its ports. No filesystem, no config read, no import from
 * `lib/runtime` or `lib/project-state`. The one import is the sibling resume
 * controller, used only as the default report port.
 *
 * @module lib/checkpoint/save-checkpoint
 */

import { buildResumeReport as defaultBuildResumeReport } from './resume-controller.js';

/**
 * Config key that turns the pass on. Read by the CALLER — this module never
 * touches a config file, and exports the path so the canary has one spelling.
 */
export const SAVE_CHECKPOINT_CONFIG_PATH = 'runtime.checkpoint.saveOnSave';

/** The trigger recorded on every checkpoint this pass writes. */
export const SAVE_CHECKPOINT_TRIGGER = '/save';

/**
 * Ledger source for the announcement. `supervisor`, not `save`: the event's
 * allowlist admits `supervisor` and `scheduler` only, and `save` is not even a
 * valid envelope source, so it would be refused one layer earlier.
 */
export const SAVE_CHECKPOINT_SOURCE = 'supervisor';

/** Ledger event name for a written checkpoint. */
export const SAVE_CHECKPOINT_EVENT = 'mission.checkpointed';

/** The per-mission port call order. Frozen; asserted, not assumed. */
export const SAVE_CHECKPOINT_PORT_ORDER = Object.freeze([
  'getMission',
  'getTaskGraph',
  'checkpoint',
  'buildResumeReport',
  'appendEvent',
]);

/** Reasons a mission, or the whole pass, produced no checkpoint. */
export const SAVE_SKIP_REASONS = Object.freeze({
  SESSION_MISSING: 'skip:session-missing',
  NO_ACTIVE_MISSION: 'skip:no-active-mission',
  MISSION_MISSING: 'skip:mission-missing',
});

/** Marker recorded when the resume report itself threw. */
const REPORT_THREW = 'report:threw';

/**
 * Is the `/save` checkpoint pass enabled?
 *
 * Strict `=== true`, so a config value of `'true'` or `1` reads as OFF. A
 * canary that a stray string can switch on is not a canary.
 *
 * @param {unknown} config - Parsed config object, or anything at all.
 * @returns {boolean} True only for a literal boolean true at the canary path.
 */
export function isSaveCheckpointEnabled(config) {
  return /** @type {any} */ (config)?.runtime?.checkpoint?.saveOnSave === true;
}

/**
 * A blank row. Every field is present from the start, so a caller never has to
 * tell "absent" from "not reached".
 *
 * @param {string} missionId - Mission the row describes.
 * @returns {object} Row scaffold.
 */
function newRow(missionId) {
  return {
    mission_id: missionId,
    status: 'skipped',
    reason: null,
    checkpoint_id: null,
    ts: null,
    resumable: null,
    blocked_by: [],
    errors: [],
    ledger: null,
  };
}

/**
 * The ids of the tasks a resume would still have to do.
 *
 * Anything not `done` counts, including `failed` and `cancelled`: judging
 * whether a failed task is worth resuming is the resume side's call, and
 * dropping it here would hide it from that decision entirely.
 *
 * @param {object|null} graph - Live task graph, or null.
 * @returns {string[]} Task ids.
 */
function activeTaskIds(graph) {
  const tasks = /** @type {any} */ (graph)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => t?.status !== 'done').map((t) => t?.id);
}

/**
 * Build the checkpoint body for one mission.
 *
 * An allowlist, not a copy of the mission: every field is either read from a
 * named place or set to the design's "step absent" value. The Epoch step is
 * not in this pass, so `routing_epoch`, `current_model` and both cursors are
 * `null` rather than guessed.
 *
 * @param {string} missionId - Mission id.
 * @param {string} sessionId - Session id, already validated by the caller.
 * @param {object} mission - Live mission record.
 * @param {object|null} graph - Live task graph, or null.
 * @returns {object} Checkpoint content for `validateCheckpoint`.
 */
function buildContent(missionId, sessionId, mission, graph) {
  return {
    mission_id: missionId,
    session_id: sessionId,
    intent_revision: /** @type {any} */ (mission)?.intent?.revision,
    plan_revision: /** @type {any} */ (mission)?.plan?.revision,
    active_tasks: activeTaskIds(graph),
    completed_action_results: [],
    routing_epoch: null,
    current_model: null,
    artifact_versions: {},
    replay_cursor: null,
    ledger_cursor: null,
    resumable: true,
  };
}

/**
 * Ask the resume report whether the mission could be resumed. Never throws.
 *
 * A report that fails is a lost opinion, not a lost checkpoint, so its failure
 * becomes a blocker marker on the row and the pass continues to the ledger.
 *
 * @param {object} ports - Injected ports.
 * @param {string} missionId - Mission id.
 * @returns {Promise<{resumable: boolean|null, blocked_by: string[]}>} Verdict.
 */
async function judge(ports, missionId) {
  const report = ports.buildResumeReport ?? defaultBuildResumeReport;
  try {
    const result = await report(
      {
        latestValid: ports.checkpointService?.latestValid,
        getMission: ports.getMission,
        getTaskGraph: ports.getTaskGraph,
      },
      { missionId },
    );
    return {
      resumable: typeof result?.resumable === 'boolean' ? result.resumable : null,
      blocked_by: Array.isArray(result?.blocked_by) ? result.blocked_by : [],
    };
  } catch {
    return { resumable: null, blocked_by: [REPORT_THREW] };
  }
}

/**
 * Announce the saved checkpoint. Never throws.
 *
 * @param {object} ports - Injected ports.
 * @param {object} row - The row being filled, read for its ids.
 * @param {string} sessionId - Session id.
 * @param {string} trigger - Trigger recorded on the checkpoint.
 * @returns {Promise<{ok: boolean, reason: string|null}>} Ledger outcome.
 */
async function announce(ports, row, sessionId, trigger) {
  try {
    const outcome = await ports.appendEvent({
      event: SAVE_CHECKPOINT_EVENT,
      mission_id: row.mission_id,
      session_id: sessionId,
      source: SAVE_CHECKPOINT_SOURCE,
      data: { checkpoint_id: row.checkpoint_id, trigger, resumable: row.resumable },
    });
    const ok = /** @type {any} */ (outcome)?.ok === true;
    return { ok, reason: ok ? null : (/** @type {any} */ (outcome)?.reason ?? null) };
  } catch (err) {
    return { ok: false, reason: `threw:${/** @type {any} */ (err)?.constructor?.name ?? 'Error'}` };
  }
}

/**
 * Run the pass for one mission. Ports are called in
 * {@link SAVE_CHECKPOINT_PORT_ORDER} and the function returns early at each
 * point where a later port would have nothing valid to act on.
 *
 * @param {object} ports - Injected ports.
 * @param {string} missionId - Mission id.
 * @param {string} sessionId - Session id.
 * @param {string} trigger - Trigger to record.
 * @returns {Promise<object>} The row.
 */
async function saveOne(ports, missionId, sessionId, trigger) {
  const row = newRow(missionId);

  const mission = await ports.getMission(missionId);
  if (!mission) {
    row.reason = SAVE_SKIP_REASONS.MISSION_MISSING;
    return row;
  }

  const graph = await ports.getTaskGraph(missionId);
  const content = buildContent(missionId, sessionId, mission, graph);

  const saved = await ports.checkpointService.checkpoint(content, { trigger });
  if (!/** @type {any} */ (saved)?.ok) {
    row.status = 'rejected';
    row.errors = Array.isArray(/** @type {any} */ (saved)?.errors) ? saved.errors : [];
    return row;
  }
  row.status = 'saved';
  row.checkpoint_id = /** @type {any} */ (saved).checkpoint_id ?? null;
  row.ts = /** @type {any} */ (saved).ts ?? null;

  const verdict = await judge(ports, missionId);
  row.resumable = verdict.resumable;
  row.blocked_by = verdict.blocked_by;

  row.ledger = await announce(ports, row, sessionId, trigger);
  return row;
}

/**
 * Write one checkpoint per active mission and report what happened.
 *
 * Missions are processed SEQUENTIALLY, not in parallel: the ledger is one
 * append-only stream and the rows are rendered in order, so interleaving would
 * buy nothing and make the output order depend on port latency.
 *
 * @param {object} ports - Injected ports.
 * @param {() => string[]} ports.listActiveMissionIds - Every active mission id.
 * @param {(missionId: string) => object|null} ports.getMission - Live mission record.
 * @param {(missionId: string) => object|null} ports.getTaskGraph - Live task graph.
 * @param {{checkpoint: Function, latestValid: Function}} ports.checkpointService - Validate-then-save.
 * @param {Function} [ports.buildResumeReport] - Report port; defaults to the sibling controller.
 * @param {(envelope: object) => unknown} ports.appendEvent - Ledger port.
 * @param {object} [options] - Options.
 * @param {string} [options.sessionId] - REQUIRED; the whole pass skips without it.
 * @param {string} [options.trigger] - Trigger to record; defaults to `/save`.
 * @param {string[]} [options.missionIds] - Explicit targets, replacing the list port.
 * @returns {Promise<{skipped: string|null, rows: object[]}>} Skip reason and rows.
 */
export async function buildSaveCheckpoint(ports, options = {}) {
  const sessionId = options?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { skipped: SAVE_SKIP_REASONS.SESSION_MISSING, rows: [] };
  }

  const ids = Array.isArray(options?.missionIds)
    ? options.missionIds
    : (await ports.listActiveMissionIds() ?? []);
  if (!Array.isArray(ids) || ids.length === 0) {
    return { skipped: SAVE_SKIP_REASONS.NO_ACTIVE_MISSION, rows: [] };
  }

  const trigger = typeof options?.trigger === 'string' && options.trigger.length > 0
    ? options.trigger
    : SAVE_CHECKPOINT_TRIGGER;

  const rows = [];
  for (const id of ids) {
    rows.push(await saveOne(ports, id, sessionId, trigger));
  }
  return { skipped: null, rows };
}
