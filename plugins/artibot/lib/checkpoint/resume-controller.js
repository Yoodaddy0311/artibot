/**
 * Resume Contract steps 1..9, as a REPORT.
 *
 * Scorecard §51 draws the Resume Contract as ten boxes, and every box after
 * the second is named with a verb: "Restore Task Graph", "Find expired worker
 * leases", "Reconcile Ledger", "Re-evaluate model". Design §7.3 puts v5 Shadow
 * at "compare/recover infra, transitions unchanged". Those two sentences are in
 * tension only if the verbs are obeyed, so this module reads each box as a
 * QUESTION instead: it answers "would this step hold?" and answers nothing
 * else. Nothing here restores, reclaims, repairs or selects. Step 10 "Resume"
 * is absent entirely — it is the one box that cannot be turned into a
 * question, and it belongs to the Canary stage.
 *
 * WHY A REPORT AND NOT A RESUME. A resume that acts while it inspects has no
 * dry run: the first way to learn whether a mission is resumable is to have
 * half-resumed it. Separating the judgement from the act makes the judgement
 * runnable in Shadow against live state, on a schedule, with no blast radius —
 * and leaves the act a separate, reviewable change.
 *
 * THREE-VALUED `ok`, AND WHY NOT TWO. Each step reports `true`, `false` or
 * `null`, where `null` means "could not judge". Folding `null` into `false`
 * would make a broken clock indistinguishable from an expired lease; folding
 * it into `true` would be fail-open, and fail-open is the failure this whole
 * report exists to avoid. So an absent port, a throwing port or a value the
 * step cannot interpret all degrade to `null` plus a blocking reason, and
 * never to `true`.
 *
 * ONE REASON PREFIX. Design §3.5 admits `lane:`, `gate:`, `human:` and
 * `reconcile:`. Everything this module can say is a reconciliation finding, so
 * every string in {@link RESUME_BLOCK_REASONS} carries the `reconcile:` prefix
 * and the constant is exported so reviewers can enumerate the whole vocabulary
 * without reading the body.
 *
 * TWO ASYMMETRIES ARE DELIBERATE, because the symmetric reading blocks the
 * normal case:
 *   - Task graph. An active task absent from the graph is drift; a graph task
 *     absent from `active_tasks` is ordinary (not every task is running) and is
 *     reported as evidence only. Treating the diff symmetrically would block
 *     every mission whose graph is larger than its running set, which is all
 *     of them.
 *   - Ledger. `extraInStore` is the broken invariant and blocks;
 *     `missingInStore` merely means the store is behind and does not. This
 *     mirrors the distinction `lib/project-state/reconcile.js` already draws in
 *     its own header, rather than inventing a second reading of the same two
 *     fields.
 *
 * WHAT IT IS NOT ALLOWED TO DECIDE. Whether a completed action result may be
 * REUSED is marked undecided in design §8.6, so step 6 counts them and stops.
 * A reuse rule invented here would be a decision nobody made, wearing the
 * clothes of a report.
 *
 * PORTS ONLY. This module imports nothing — no I/O, no clock, no config, no
 * store. Every input arrives as an injected function, which is what makes the
 * "no transition" claim checkable by inspection as well as by execution
 * (`tests/firewall/resume-contract-report-only.test.js`).
 *
 * Layer 2 (auxiliary domain service).
 *
 * @module lib/checkpoint/resume-controller
 */

/**
 * Every blocking reason this module can emit. Frozen and exported so tests and
 * reviewers can enumerate the vocabulary; each value is prefixed `reconcile:`
 * per design §3.5.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RESUME_BLOCK_REASONS = Object.freeze({
  CHECKPOINT_MISSING: 'reconcile:checkpoint-missing',
  CHECKPOINT_INVALID: 'reconcile:checkpoint-invalid',
  CHECKPOINT_UNKNOWN: 'reconcile:checkpoint-unknown',
  REVISION_UNKNOWN: 'reconcile:revision-unknown',
  INTENT_REVISION: 'reconcile:intent-revision',
  PLAN_REVISION: 'reconcile:plan-revision',
  TASK_GRAPH_MISSING: 'reconcile:task-graph-missing',
  TASK_GRAPH_DRIFT: 'reconcile:task-graph-drift',
  ACTIVE_TASK_ID_UNKNOWN: 'reconcile:active-task-id-unknown',
  LEASE_EXPIRED: 'reconcile:lease-expired',
  LEASE_CLOCK_UNKNOWN: 'reconcile:lease-clock-unknown',
  LEASE_UNKNOWN: 'reconcile:lease-unknown',
  LEDGER_DRIFT: 'reconcile:ledger-drift',
  LEDGER_EXTRA_IN_STORE: 'reconcile:ledger-extra-in-store',
  LEDGER_GAPS: 'reconcile:ledger-gaps',
  LEDGER_UNKNOWN: 'reconcile:ledger-unknown',
  MODEL_UNKNOWN: 'reconcile:model-unknown',
});

const R = RESUME_BLOCK_REASONS;

/** Scorecard §51's own wording, so the report and the diagram read alike. */
const STEP_NAMES = Object.freeze({
  1: 'Load latest valid checkpoint',
  2: 'Validate schema',
  3: 'Validate Intent revision',
  4: 'Validate Plan revision',
  5: 'Restore Task Graph',
  6: 'Restore completed Action results',
  7: 'Find expired worker leases',
  8: 'Reconcile Ledger',
  9: 'Re-evaluate model/cache availability',
});

/**
 * Evidence for a step that reads the checkpoint when there is no valid one.
 * Distinct from a failure: the step was not judged, and saying so is the point.
 */
const SKIPPED = Object.freeze({ skipped: 'no-valid-checkpoint' });

/**
 * @param {number} step - Step number 1..9.
 * @param {boolean|null} ok - True, false, or null for "could not judge".
 * @param {object} evidence - What the judgement was made from.
 * @returns {{step: number, name: string, ok: boolean|null, evidence: object}} Entry.
 */
function makeStep(step, ok, evidence) {
  return { step, name: STEP_NAMES[step], ok, evidence };
}

/**
 * Ordered, de-duplicated reason collector. Two steps may reach the same
 * conclusion; the reader should see it once.
 *
 * @returns {{add: (reason: string) => void, list: () => string[]}} Collector.
 */
function createBlocks() {
  const seen = new Set();
  return { add: (reason) => { seen.add(reason); }, list: () => [...seen] };
}

/**
 * @param {unknown} value - Candidate.
 * @returns {unknown[]} The value when it is an array, otherwise an empty one.
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The one id rule, applied to both `active_tasks` and
 * `completed_action_results`: a non-empty string is its own id, and an object
 * is identified by the first non-empty string among `id`, `task_id`,
 * `action_id`. `id` leads because that is the field the live task graph uses
 * (`lib/project-state/journal.js` filters on `t.id`). Anything else has no id.
 *
 * @param {unknown} item - Entry from a checkpoint array or a task graph.
 * @returns {string|null} The id, or null when there is none.
 */
function idOf(item) {
  if (typeof item === 'string' && item.length > 0) return item;
  if (item === null || typeof item !== 'object') return null;
  for (const key of ['id', 'task_id', 'action_id']) {
    const value = /** @type {Record<string, unknown>} */ (item)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * @param {unknown} list - Candidate array of entries.
 * @returns {{ids: string[], unidentified: number}} Ids and the count that had none.
 */
function collectIds(list) {
  const ids = [];
  let unidentified = 0;
  for (const item of asArray(list)) {
    const id = idOf(item);
    if (id === null) unidentified += 1;
    else ids.push(id);
  }
  return { ids, unidentified };
}

/**
 * Call a read port defensively. A missing port and a throwing port are the
 * same thing to the caller: no answer. The step that wanted the answer decides
 * what that means, because only it knows which reason to record.
 *
 * @param {unknown} fn - Candidate port.
 * @param {...unknown} args - Arguments.
 * @returns {unknown} The result, or null.
 */
function readPort(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try {
    return fn(...args) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} err - Whatever was thrown.
 * @returns {string} A short description, never an object.
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Steps 1 and 2, which one port answers together: `latestValid` loads the
 * latest record AND validates it (`lib/checkpoint/checkpoint-service.js`,
 * `loadLatestValid`, measured 2026-09-14 at lines 120-129).
 *
 * Its three outcomes are kept distinct here exactly as the service keeps them.
 * Non-empty `errors` with `ok:false` means a record WAS stored and failed
 * validation, so step 1 is `true` and step 2 is `false` — even though the
 * service withholds the record itself.
 *
 * @param {object} ports - Injected ports.
 * @param {string} missionId - Mission id.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {Promise<{checkpoint: object|null, record: object|null, entries: object[]}>} Steps 1-2.
 */
async function loadCheckpoint(ports, missionId, blocks) {
  const unknown = (evidence) => {
    blocks.add(R.CHECKPOINT_UNKNOWN);
    return { checkpoint: null, record: null, entries: [makeStep(1, null, evidence), makeStep(2, null, SKIPPED)] };
  };
  if (typeof ports.latestValid !== 'function') return unknown({ reason: 'port-missing' });

  let result;
  try {
    result = await ports.latestValid(missionId);
  } catch (err) {
    return unknown({ error: messageOf(err) });
  }

  const errors = asArray(result?.errors);
  if (result?.ok !== true) {
    if (errors.length === 0) {
      blocks.add(R.CHECKPOINT_MISSING);
      return { checkpoint: null, record: null, entries: [makeStep(1, false, { checkpoint_id: null }), makeStep(2, null, SKIPPED)] };
    }
    blocks.add(R.CHECKPOINT_INVALID);
    return { checkpoint: null, record: null, entries: [makeStep(1, true, { checkpoint_id: null }), makeStep(2, false, { errors })] };
  }

  const record = result.record ?? null;
  const checkpoint = record?.checkpoint ?? null;
  if (!checkpoint) return unknown({ reason: 'record-without-checkpoint' });
  return {
    checkpoint,
    record,
    entries: [
      makeStep(1, true, { checkpoint_id: record.checkpoint_id ?? null, ts: record.ts ?? null }),
      makeStep(2, true, { errors: [] }),
    ],
  };
}

/**
 * Steps 3 and 4 — the checkpoint's revision against the live mission's.
 *
 * The live revisions are NESTED (`mission.intent.revision`), measured
 * 2026-09-14 against the project-state store at state_version 17 across its 9
 * missions. A top-level `intent_revision` on the mission record does not exist
 * and reading one would silently compare against `undefined`.
 *
 * @param {number} step - 3 or 4.
 * @param {object|null} checkpoint - The valid checkpoint, or null.
 * @param {object|null} mission - The live mission record, or null.
 * @param {'intent'|'plan'} field - Which revision.
 * @param {string} mismatchReason - Reason to record on a mismatch.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {object} The step entry.
 */
function stepRevision(step, checkpoint, mission, field, mismatchReason, blocks) {
  if (!checkpoint) return makeStep(step, null, SKIPPED);
  const fromCheckpoint = checkpoint[`${field}_revision`];
  const fromMission = mission?.[field]?.revision;
  const evidence = {
    checkpoint: Number.isInteger(fromCheckpoint) ? fromCheckpoint : null,
    mission: Number.isInteger(fromMission) ? fromMission : null,
  };
  if (evidence.checkpoint === null || evidence.mission === null) {
    blocks.add(R.REVISION_UNKNOWN);
    return makeStep(step, null, evidence);
  }
  if (evidence.checkpoint === evidence.mission) return makeStep(step, true, evidence);
  blocks.add(mismatchReason);
  return makeStep(step, false, evidence);
}

/**
 * Step 5 — the diff between the checkpoint's active tasks and the live graph.
 * Nothing is restored; see the module header for why the diff is asymmetric.
 *
 * @param {object|null} checkpoint - The valid checkpoint, or null.
 * @param {object|null} graph - The live task graph, or null.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {object} The step entry.
 */
function stepTaskGraph(checkpoint, graph, blocks) {
  if (!checkpoint) return makeStep(5, null, SKIPPED);
  if (!graph) {
    blocks.add(R.TASK_GRAPH_MISSING);
    return makeStep(5, null, { graph: null });
  }
  const active = collectIds(checkpoint.active_tasks);
  const graphTasks = collectIds(graph.tasks).ids;
  const evidence = {
    active_tasks: active.ids,
    graph_tasks: graphTasks,
    missing_in_graph: active.ids.filter((id) => !graphTasks.includes(id)),
    extra_in_graph: graphTasks.filter((id) => !active.ids.includes(id)),
    unidentified: active.unidentified,
  };
  if (active.unidentified > 0) {
    blocks.add(R.ACTIVE_TASK_ID_UNKNOWN);
    return makeStep(5, null, evidence);
  }
  if (evidence.missing_in_graph.length > 0) {
    blocks.add(R.TASK_GRAPH_DRIFT);
    return makeStep(5, false, evidence);
  }
  return makeStep(5, true, evidence);
}

/**
 * Step 6 — count the completed action results and name them. Whether any may
 * be REUSED is undecided (design §8.6), so nothing here blocks on them and no
 * reuse rule is implied by the count.
 *
 * @param {object|null} checkpoint - The valid checkpoint, or null.
 * @returns {object} The step entry.
 */
function stepActionResults(checkpoint) {
  if (!checkpoint) return makeStep(6, null, SKIPPED);
  const list = asArray(checkpoint.completed_action_results);
  const { ids, unidentified } = collectIds(list);
  return makeStep(6, true, { count: list.length, ids, unidentified });
}

/**
 * Read the injected clock. `isLeaseExpired` throws a TypeError on anything
 * that is not a Date or a finite epoch-ms number (`lib/project-state/lease.js`,
 * `isLeaseExpired`, measured 2026-09-14 at line 198), so the value is checked
 * here rather than being discovered inside a per-lease try/catch.
 *
 * @param {object} ports - Injected ports.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {{ok: boolean, value: unknown}} The clock reading.
 */
function readClock(ports, blocks) {
  const reject = () => {
    blocks.add(R.LEASE_CLOCK_UNKNOWN);
    return { ok: false, value: null };
  };
  if (typeof ports.now !== 'function') return reject();
  let value;
  try {
    value = ports.now();
  } catch {
    return reject();
  }
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return reject();
  return { ok: true, value };
}

/**
 * Step 7 — which worker leases have expired. Listed, never reclaimed:
 * `claimTask` sits on the same store object and is not among this module's
 * ports for exactly that reason.
 *
 * @param {object} ports - Injected ports.
 * @param {string} missionId - Mission id.
 * @param {object|null} graph - The live task graph (the task id source), or null.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {object} The step entry.
 */
function stepLeases(ports, missionId, graph, blocks) {
  if (typeof ports.getLease !== 'function' || typeof ports.isLeaseExpired !== 'function' || !graph) {
    blocks.add(R.LEASE_UNKNOWN);
    return makeStep(7, null, { reason: graph ? 'port-missing' : 'no-task-graph' });
  }
  const clock = readClock(ports, blocks);
  if (!clock.ok) return makeStep(7, null, { clock: null });

  const taskIds = collectIds(graph.tasks).ids;
  const expired = [];
  const unjudged = [];
  let checked = 0;
  for (const taskId of taskIds) {
    let lease;
    try {
      lease = ports.getLease(missionId, taskId);
    } catch {
      unjudged.push(taskId);
      continue;
    }
    if (!lease) continue;
    checked += 1;
    try {
      if (ports.isLeaseExpired(lease, clock.value) === true) expired.push(taskId);
    } catch {
      unjudged.push(taskId);
    }
  }
  const evidence = { tasks: taskIds.length, checked, expired, unjudged };
  if (unjudged.length > 0) {
    blocks.add(R.LEASE_UNKNOWN);
    return makeStep(7, null, evidence);
  }
  if (expired.length > 0) {
    blocks.add(R.LEASE_EXPIRED);
    return makeStep(7, false, evidence);
  }
  return makeStep(7, true, evidence);
}

/**
 * Step 8 — ask the store whether its journal, snapshot and ledger still agree.
 *
 * `{ apply: false }` is a literal, not a forwarded option: `reconcileStore`
 * rewrites the snapshot the moment it sees `apply: true`
 * (`lib/project-state/reconcile.js`, `reconcileStore`, measured 2026-09-14 at
 * line 51), and a caller-supplied flag is precisely how a report turns into a
 * repair. `ledgerVersions` is likewise NOT passed: measured 2026-09-14, no
 * production supplier of it exists, and without it the two ledger comparisons
 * come back empty by construction rather than by agreement.
 *
 * This step reads the store and not the checkpoint, so it runs even when there
 * is no valid checkpoint to resume from.
 *
 * @param {object} ports - Injected ports.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {object} The step entry.
 */
function stepLedger(ports, blocks) {
  if (typeof ports.reconcile !== 'function') {
    blocks.add(R.LEDGER_UNKNOWN);
    return makeStep(8, null, { reason: 'port-missing' });
  }
  let result;
  try {
    result = ports.reconcile({ apply: false });
  } catch (err) {
    blocks.add(R.LEDGER_UNKNOWN);
    return makeStep(8, null, { error: messageOf(err) });
  }
  const evidence = {
    drifted: result?.drifted === true,
    applied: result?.applied === true,
    gaps: asArray(result?.gaps),
    extraInStore: asArray(result?.extraInStore),
    missingInStore: asArray(result?.missingInStore),
    warnings: asArray(result?.warnings),
    storeVersion: result?.storeVersion ?? null,
    snapshotVersion: result?.snapshotVersion ?? null,
  };
  const found = [
    [evidence.drifted, R.LEDGER_DRIFT],
    [evidence.extraInStore.length > 0, R.LEDGER_EXTRA_IN_STORE],
    [evidence.gaps.length > 0, R.LEDGER_GAPS],
  ].filter(([hit]) => hit);
  for (const [, reason] of found) blocks.add(reason);
  return makeStep(8, found.length === 0, evidence);
}

/**
 * Step 9 — what model the checkpoint ran under, and what would resolve now.
 * Recorded, never selected, and a CHANGE never blocks: re-evaluating the model
 * is the point of the resume, not an obstacle to it. Only an unresolvable
 * model is a block, because then the comparison itself is unavailable.
 *
 * @param {object} ports - Injected ports.
 * @param {object|null} checkpoint - The valid checkpoint, or null.
 * @param {{add: Function}} blocks - Reason collector.
 * @returns {object} The step entry.
 */
function stepModel(ports, checkpoint, blocks) {
  if (!checkpoint) return makeStep(9, null, SKIPPED);
  const previous = typeof checkpoint.current_model === 'string' ? checkpoint.current_model : null;
  const unknown = () => {
    blocks.add(R.MODEL_UNKNOWN);
    return makeStep(9, null, { previous, current: null, same: null });
  };
  if (typeof ports.resolveModel !== 'function') return unknown();
  let current;
  try {
    current = ports.resolveModel(previous);
  } catch {
    return unknown();
  }
  if (typeof current !== 'string' || current.length === 0) return unknown();
  return makeStep(9, true, { previous, current, same: previous === current });
}

/**
 * Roll the per-step evidence up into one summary block, so a reader who wants
 * the headline does not have to walk nine steps for it.
 *
 * @param {object|null} record - The checkpoint record, or null.
 * @param {object[]} steps - The nine step entries.
 * @param {string[]} blockedBy - The collected reasons.
 * @returns {object} Summary evidence.
 */
function summarise(record, steps, blockedBy) {
  const at = (step) => steps.find((s) => s.step === step)?.evidence ?? {};
  const model = at(9);
  return {
    checkpoint_id: record?.checkpoint_id ?? null,
    ts: record?.ts ?? null,
    previous_model: model.previous ?? null,
    current_model: model.current ?? null,
    counts: {
      active_tasks: asArray(at(5).active_tasks).length,
      graph_tasks: asArray(at(5).graph_tasks).length,
      completed_action_results: at(6).count ?? 0,
      expired_leases: asArray(at(7).expired).length,
      blocked_by: blockedBy.length,
    },
  };
}

/**
 * Judge, without changing anything, whether a mission could be resumed.
 *
 * Returns a report of Resume Contract steps 1..9. It does NOT resume, and it
 * performs no state transition: every port it is given is a read, `reconcile`
 * is always called report-only, and no write binding is even accepted.
 *
 * Rejects only on a bad `missionId`, which is a caller error. A port that is
 * missing or throws is a runtime condition the report describes rather than
 * propagates, so the report is always produced.
 *
 * @param {object} ports - Injected read ports.
 * @param {(missionId: string) => Promise<{ok: boolean, record: object|null, errors: string[]}>} [ports.latestValid] - Steps 1-2.
 * @param {(missionId: string) => object|null} [ports.getMission] - Live mission record.
 * @param {(missionId: string) => object|null} [ports.getTaskGraph] - Live task graph.
 * @param {(missionId: string, taskId: string) => object|null} [ports.getLease] - Live lease.
 * @param {(lease: object, now: Date|number) => boolean} [ports.isLeaseExpired] - Expiry judgement.
 * @param {(opts: {apply: boolean}) => object} [ports.reconcile] - Report-only store reconcile.
 * @param {(previousModel: string|null) => string|null} [ports.resolveModel] - Model resolution.
 * @param {() => Date|number} [ports.now] - Clock, for lease expiry only.
 * @param {object} options - Options.
 * @param {string} options.missionId - Mission to report on.
 * @returns {Promise<{mission_id: string, steps: object[], blocked_by: string[], resumable: boolean, evidence: object}>} The report.
 */
export async function buildResumeReport(ports, options = {}) {
  const missionId = options?.missionId;
  if (typeof missionId !== 'string' || missionId.length === 0) {
    throw new TypeError('buildResumeReport: missionId must be a non-empty string');
  }
  const p = ports ?? {};
  const blocks = createBlocks();

  const loaded = await loadCheckpoint(p, missionId, blocks);
  const { checkpoint } = loaded;
  // Fetched once each and shared: steps 3 and 4 read one mission record, and
  // steps 5 and 7 read one task graph. Two calls would invite two answers.
  const mission = /** @type {object|null} */ (readPort(p.getMission, missionId));
  const graph = /** @type {object|null} */ (readPort(p.getTaskGraph, missionId));

  const steps = [
    ...loaded.entries,
    stepRevision(3, checkpoint, mission, 'intent', R.INTENT_REVISION, blocks),
    stepRevision(4, checkpoint, mission, 'plan', R.PLAN_REVISION, blocks),
    stepTaskGraph(checkpoint, graph, blocks),
    stepActionResults(checkpoint),
    stepLeases(p, missionId, graph, blocks),
    stepLedger(p, blocks),
    stepModel(p, checkpoint, blocks),
  ];

  const blockedBy = blocks.list();
  return {
    mission_id: missionId,
    steps,
    blocked_by: blockedBy,
    resumable: blockedBy.length === 0 && checkpoint?.resumable === true,
    evidence: summarise(loaded.record, steps, blockedBy),
  };
}
