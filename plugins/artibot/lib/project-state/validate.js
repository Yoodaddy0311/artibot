/**
 * StateStore validators — the checks JSON Schema draft-07 cannot express.
 *
 * `task-graph.schema.json` names this module's job in its own text: "Node ids
 * must be unique across the array and every dependency must name an existing
 * node; neither is expressible in draft-07, so both stay a validator
 * obligation of the StateStore (T-21), not of this schema." Same for
 * `task.mission_id === graph.mission_id`, which that schema also defers.
 *
 * This is NOT a re-implementation of the schemas. The repository ships no
 * JSON-Schema validator (zero runtime dependencies, measured 2026-09-02), so
 * these functions check the structural invariants the store must not violate
 * and nothing more. Anything a draft-07 validator would catch and this does
 * not is caught by the schema in CI, not here.
 *
 * Every function returns `string[]` of errors — empty means valid. Nothing
 * throws on invalid DATA: a store write that would corrupt state must be
 * refused with a reason the caller can report, not with an exception that
 * kills a supervisor loop. Bad ARGUMENTS (wrong types passed by a programmer)
 * still throw.
 *
 * @module lib/project-state/validate
 */

/**
 * Both accepted mission id forms: the issued `M-YYYYMMDD-NNN` (NNN free to
 * exceed three digits) and the session fallback `M-YYYYMMDD-S<sid8>`.
 *
 * BYTE-IDENTICAL to the `pattern` string in `project-state.schema.json`,
 * `task-graph.schema.json` and `ledger-envelope.schema.json`, and asserted to
 * stay that way by `tests/project-state/validate.test.js`. The spelling is
 * therefore not a free choice: `\d` and `[0-9]` mean the same thing to both
 * ECMA-262 and draft-07, so an equivalent-but-differently-spelled copy passes
 * every behavioural test while defeating the only cheap drift check there is.
 * If the schemas re-spell this, re-spell it here — do not "fix" the assertion.
 */
export const MISSION_ID_PATTERN = /^M-\d{8}-(?:\d{3,}|S[0-9A-Za-z]{8})$/;

/** Mission statuses — the 7 of v1.1 §16, per `project-state.schema.json`. */
export const MISSION_STATUSES = Object.freeze([
  'queued', 'planning', 'executing', 'blocked', 'reviewing', 'completed', 'failed',
]);

/** Task statuses — the 8 of `task-graph.schema.json`. A DIFFERENT vocabulary. */
export const TASK_STATUSES = Object.freeze([
  'queued', 'claimed', 'executing', 'blocked', 'reviewing', 'done', 'failed', 'cancelled',
]);

/** Task statuses that require an owner (`task-graph.schema.json` allOf #1). */
export const OWNED_TASK_STATUSES = Object.freeze(['claimed', 'executing', 'reviewing']);

/** Terminal task statuses — a dependency is satisfied when it reaches one. */
export const TERMINAL_TASK_STATUSES = Object.freeze(['done', 'cancelled']);

/** Blocked-reason allowlist from design §3.5. A deny-list would fail open. */
export const BLOCKER_PATTERN = /^(lane|gate|human|reconcile):.+/;

/**
 * Validate a mission id.
 *
 * @param {unknown} missionId - Candidate id.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateMissionId(missionId) {
  if (typeof missionId !== 'string' || missionId === '') {
    return ['mission_id must be a non-empty string'];
  }
  if (!MISSION_ID_PATTERN.test(missionId)) {
    return [`mission_id '${missionId}' matches neither M-YYYYMMDD-NNN nor M-YYYYMMDD-S<sid8>`];
  }
  return [];
}

/**
 * Validate a mission entry as stored (the projection adds `workers`).
 *
 * `intent` and `plan` are required by `project-state.schema.json`; a mission
 * without them cannot be projected, so the store refuses to hold one.
 *
 * @param {unknown} mission - Candidate mission.
 * @param {string} missionId - Id, used in error messages.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateMission(mission, missionId) {
  const errors = [];
  if (mission === null || typeof mission !== 'object' || Array.isArray(mission)) {
    return [`mission ${missionId}: must be an object`];
  }
  if (!MISSION_STATUSES.includes(mission.status)) {
    errors.push(
      `mission ${missionId}: status '${String(mission.status)}' is not one of ${MISSION_STATUSES.join('|')}`,
    );
  }
  for (const field of ['intent', 'plan']) {
    const ref = mission[field];
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      errors.push(`mission ${missionId}: ${field} must be a {path, revision} object`);
      continue;
    }
    if (typeof ref.path !== 'string' || ref.path === '') {
      errors.push(`mission ${missionId}: ${field}.path must be a non-empty string`);
    }
    if (!Number.isInteger(ref.revision) || ref.revision < 1) {
      errors.push(`mission ${missionId}: ${field}.revision must be an integer >= 1`);
    }
  }
  errors.push(...validateBlockers(mission.blocked_by, `mission ${missionId}: blocked_by`));
  errors.push(...validateController(mission.controller, missionId));
  return errors;
}

/**
 * Validate a blocker-reason list against the design §3.5 allowlist.
 *
 * @param {unknown} blockers - Candidate list; `undefined` is allowed (absent).
 * @param {string} label - Prefix for error messages.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateBlockers(blockers, label) {
  if (blockers === undefined) return [];
  if (!Array.isArray(blockers)) return [`${label} must be an array`];
  const errors = [];
  blockers.forEach((reason, i) => {
    if (typeof reason !== 'string' || !BLOCKER_PATTERN.test(reason)) {
      errors.push(`${label}[${i}]: '${String(reason)}' must match lane:|gate:|human:|reconcile: prefix`);
    }
  });
  return errors;
}

/**
 * Validate `mission.controller` — both fields required, per
 * `project-state.schema.json` ("a controller entry without a lease would be a
 * claim nobody can time out").
 *
 * @param {unknown} controller - Candidate controller; `undefined` is allowed.
 * @param {string} missionId - Id, used in error messages.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateController(controller, missionId) {
  if (controller === undefined) return [];
  if (controller === null || typeof controller !== 'object' || Array.isArray(controller)) {
    return [`mission ${missionId}: controller must be an object`];
  }
  const errors = [];
  if (typeof controller.session_id !== 'string' || controller.session_id === '') {
    errors.push(`mission ${missionId}: controller.session_id is required`);
  }
  errors.push(...validateLease(controller.lease, `mission ${missionId}: controller.lease`));
  return errors;
}

/**
 * Validate a lease against the four required fields of `lease.schema.json`.
 *
 * @param {unknown} lease - Candidate lease.
 * @param {string} label - Prefix for error messages.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateLease(lease, label) {
  if (lease === null || typeof lease !== 'object' || Array.isArray(lease)) {
    return [`${label} must be an object`];
  }
  const errors = [];
  if (typeof lease.owner !== 'string' || lease.owner === '') {
    errors.push(`${label}.owner is required`);
  }
  for (const field of ['acquired_at', 'expires_at', 'heartbeat_at']) {
    if (typeof lease[field] !== 'string' || Number.isNaN(Date.parse(lease[field]))) {
      errors.push(`${label}.${field} must be an ISO-8601 instant`);
    }
  }
  return errors;
}

/**
 * Validate one task node.
 *
 * @param {unknown} task - Candidate task.
 * @param {string} graphMissionId - The owning graph's mission id.
 * @param {number} index - Position in `tasks[]`, used in error messages.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateTask(task, graphMissionId, index) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    return [`tasks[${index}]: must be an object`];
  }
  const label = `task ${typeof task.id === 'string' ? task.id : `#${index}`}`;
  const errors = [];
  if (typeof task.id !== 'string' || task.id === '') errors.push(`${label}: id must be a non-empty string`);
  if (task.mission_id !== graphMissionId) {
    errors.push(`${label}: mission_id '${String(task.mission_id)}' !== graph mission_id '${graphMissionId}'`);
  }
  if (!TASK_STATUSES.includes(task.status)) {
    errors.push(`${label}: status '${String(task.status)}' is not one of ${TASK_STATUSES.join('|')}`);
  }
  if (OWNED_TASK_STATUSES.includes(task.status)
    && (typeof task.owner !== 'string' || task.owner === '')) {
    errors.push(`${label}: status '${task.status}' requires a non-empty owner`);
  }
  if (task.status === 'blocked' && !(Array.isArray(task.blockers) && task.blockers.length > 0)) {
    errors.push(`${label}: status 'blocked' requires at least one blocker`);
  }
  errors.push(...validateBlockers(task.blockers, `${label}: blockers`));
  return errors;
}

/**
 * Validate a whole Task Graph, including the two cross-node invariants
 * draft-07 cannot state: unique ids and non-dangling dependencies.
 *
 * @param {unknown} graph - Candidate graph.
 * @param {string} missionId - Mission the graph must belong to.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateTaskGraph(graph, missionId) {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    return [`task graph for ${missionId}: must be an object`];
  }
  const errors = [];
  if (!Number.isInteger(graph.schema_version) || graph.schema_version < 1) {
    errors.push(`task graph for ${missionId}: schema_version must be an integer >= 1`);
  }
  if (graph.mission_id !== missionId) {
    errors.push(`task graph keyed ${missionId} carries mission_id '${String(graph.mission_id)}'`);
  }
  if (!Array.isArray(graph.tasks)) {
    errors.push(`task graph for ${missionId}: tasks must be an array`);
    return errors;
  }
  const ids = new Set();
  graph.tasks.forEach((task, i) => {
    errors.push(...validateTask(task, missionId, i));
    const id = task?.id;
    if (typeof id === 'string' && id !== '') {
      if (ids.has(id)) errors.push(`task graph for ${missionId}: duplicate task id '${id}'`);
      ids.add(id);
    }
  });
  errors.push(...validateDependencies(graph.tasks, ids, missionId));
  return errors;
}

/**
 * Check that every dependency names an existing node.
 *
 * Dangling dependencies are refused rather than warned about: a task that
 * waits on a node nobody will ever create is indistinguishable from a task
 * that is merely slow, and the store is the last place that can still tell
 * the difference.
 *
 * @param {object[]} tasks - Task nodes.
 * @param {Set<string>} ids - Ids present in the graph.
 * @param {string} missionId - Mission id, used in error messages.
 * @returns {string[]} Errors; empty when valid.
 */
function validateDependencies(tasks, ids, missionId) {
  const errors = [];
  for (const task of tasks) {
    const deps = task?.dependencies;
    if (deps === undefined) continue;
    if (!Array.isArray(deps)) {
      errors.push(`task ${String(task?.id)}: dependencies must be an array`);
      continue;
    }
    for (const dep of deps) {
      if (!ids.has(dep)) {
        errors.push(
          `task graph for ${missionId}: task '${String(task?.id)}' depends on '${String(dep)}', which is not a node in this graph`,
        );
      }
      if (dep === task?.id) {
        errors.push(`task graph for ${missionId}: task '${String(dep)}' depends on itself`);
      }
    }
  }
  return errors;
}

/**
 * Validate a full store snapshot.
 *
 * @param {unknown} snapshot - Candidate snapshot.
 * @returns {string[]} Errors; empty when valid.
 */
export function validateSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['snapshot: must be an object'];
  }
  const errors = [];
  if (typeof snapshot.project !== 'string' || snapshot.project === '') {
    errors.push('snapshot: project must be a non-empty string');
  }
  if (!Number.isInteger(snapshot.state_version) || snapshot.state_version < 0) {
    errors.push('snapshot: state_version must be an integer >= 0');
  }
  const missions = snapshot.active_missions ?? {};
  for (const [missionId, mission] of Object.entries(missions)) {
    errors.push(...validateMissionId(missionId));
    errors.push(...validateMission(mission, missionId));
  }
  for (const [missionId, graph] of Object.entries(snapshot.task_graphs ?? {})) {
    if (!Object.hasOwn(missions, missionId)) {
      errors.push(`task graph for ${missionId}: no such mission in active_missions`);
    }
    errors.push(...validateTaskGraph(graph, missionId));
  }
  return errors;
}
