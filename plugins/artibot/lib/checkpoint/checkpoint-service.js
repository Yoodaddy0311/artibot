/**
 * Checkpoint service — validate-then-save, and the first two steps of the
 * Resume Contract.
 *
 * Two operations sit between a caller and the checkpoint store, and neither
 * belongs in the store itself: refusing to persist a malformed checkpoint, and
 * refusing to hand back a stored one that no longer validates. Keeping them
 * here leaves the store a plain read/write device and leaves the field rules
 * in `lib/supervisor/contracts.js#validateCheckpoint`, their single home (see
 * `checkpoint-validator.js` for why they live there).
 *
 * **Scope.** `latestValid` stops after the Resume Contract's second step,
 * "Validate schema". Comparing intent and plan revisions against the live
 * mission, restoring the Task Graph and completed action results, expiring
 * worker leases, reconciling the ledger and re-evaluating the model are later
 * steps owned elsewhere; doing any of them here would put half a resume in a
 * module named for checkpoints. Judging whether a completed idempotent action
 * result may be *reused* is likewise absent — the design marks that undecided,
 * and guessing would bake a rule nobody agreed to.
 *
 * The two operations are written as module-level functions taking a resolved
 * dependency record, and the factory only binds them. That keeps each one
 * short enough to read whole, and keeps the factory a wiring step rather than
 * an eighty-line closure.
 *
 * Layer 2 (auxiliary domain service). No runtime deps; all I/O is injected.
 *
 * @module lib/checkpoint/checkpoint-service
 */

import { validateCheckpoint } from '../supervisor/contracts.js';

/**
 * @typedef {object} CheckpointStore
 * @property {(checkpoint: object) => Promise<{ checkpoint_id: string, ts?: string }>} save
 * @property {(missionId: string) => Promise<object|null>} latest
 */

/**
 * @typedef {object} ServiceDeps
 * @property {CheckpointStore} store
 * @property {(checkpoint: unknown) => { ok: boolean, errors: string[] }} validate
 * @property {((envelope: object) => unknown)|null} appendEvent
 * @property {() => string} now
 */

/**
 * Announce a saved checkpoint through the ledger port. Never throws.
 *
 * No `source` key is set: the ledger allowlist admits `mission.checkpointed`
 * from more than one source and which one applies is not this module's call,
 * so it is left to whoever wires the emitter rather than defaulted to a guess.
 *
 * A port failure never fails the checkpoint — it is already durable by the
 * time this runs, and losing the announcement is strictly better than telling
 * the caller their saved checkpoint did not happen. Rejections and synchronous
 * throws are swallowed alike.
 *
 * @param {ServiceDeps} deps
 * @param {string} missionId
 * @param {string} checkpointId
 * @param {unknown} trigger
 * @returns {Promise<void>}
 */
async function announce(deps, missionId, checkpointId, trigger) {
  if (typeof deps.appendEvent !== 'function') return;
  const data = { checkpoint_id: checkpointId };
  // Omitted rather than defaulted: the allowlist marks `trigger` optional, and
  // an invented value would read as a real trigger in the ledger.
  if (typeof trigger === 'string' && trigger.length > 0) data.trigger = trigger;
  try {
    await deps.appendEvent({ event: 'mission.checkpointed', mission_id: missionId, data });
  } catch {
    /* best-effort: see the note above */
  }
}

/**
 * Validate a checkpoint and, if it holds, save it.
 *
 * Nothing reaches the store when validation fails, so an invalid checkpoint
 * cannot later be found by `latestValid` and re-rejected there.
 *
 * A store failure REJECTS rather than returning `{ ok: false }`: a full disk
 * is not a malformed checkpoint, and collapsing the two would leave callers
 * unable to tell "fix your input" from "retry later".
 *
 * @param {ServiceDeps} deps
 * @param {object} content
 * @param {{ trigger?: string }} [options]
 * @returns {Promise<{ ok: boolean, checkpoint_id?: string, ts?: string, errors: string[] }>}
 */
async function saveCheckpoint(deps, content, { trigger } = {}) {
  const verdict = deps.validate(content);
  if (!verdict.ok) return { ok: false, errors: verdict.errors };
  const saved = await deps.store.save(content);
  const checkpointId = saved?.checkpoint_id;
  await announce(deps, /** @type {string} */ (content?.mission_id), checkpointId, trigger);
  return { ok: true, checkpoint_id: checkpointId, ts: saved?.ts ?? deps.now(), errors: [] };
}

/**
 * Resume Contract steps 1-2: load a mission's latest checkpoint and validate
 * its schema.
 *
 * Three outcomes, kept distinct on purpose:
 * - nothing stored → `{ ok: false, record: null, errors: [] }`. Empty `errors`
 *   is the signal: a mission with no checkpoint yet is a normal state, not a
 *   fault, and a caller that cannot tell it from corruption reports the wrong
 *   thing.
 * - stored but invalid → `{ ok: false, record: null, errors: [...] }`. The
 *   record is withheld: this function's name is a promise, and returning an
 *   invalid record beside `ok: false` invites a caller to use it anyway.
 * - valid → `{ ok: true, record, errors: [] }`.
 *
 * @param {ServiceDeps} deps
 * @param {string} missionId
 * @returns {Promise<{ ok: boolean, record: object|null, errors: string[] }>}
 */
async function loadLatestValid(deps, missionId) {
  if (typeof missionId !== 'string' || missionId.length === 0) {
    return { ok: false, record: null, errors: ['mission_id: must be a non-empty string'] };
  }
  const record = await deps.store.latest(missionId);
  if (!record) return { ok: false, record: null, errors: [] };
  const verdict = deps.validate(/** @type {Record<string, unknown>} */ (record).checkpoint);
  if (!verdict.ok) return { ok: false, record: null, errors: verdict.errors };
  return { ok: true, record, errors: [] };
}

/**
 * Build the service over a store.
 *
 * `appendEvent` is a PORT, default `null`, and null means nothing is called —
 * the service never reaches for a ledger of its own. `now` is consulted only
 * when the store returns no timestamp of its own; the store's own clock wins
 * because its value is the one that was written.
 *
 * Throws on a missing or incomplete store rather than returning an error
 * object: that is a wiring mistake at construction time, not a runtime
 * condition a caller can handle.
 *
 * @param {object} deps
 * @param {CheckpointStore} deps.store
 * @param {(checkpoint: unknown) => { ok: boolean, errors: string[] }} [deps.validate]
 * @param {((envelope: object) => unknown)|null} [deps.appendEvent]
 * @param {() => string} [deps.now] - ISO timestamp source
 * @returns {{ checkpoint: Function, latestValid: Function }}
 */
export function createCheckpointService({
  store,
  validate = validateCheckpoint,
  appendEvent = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store || typeof store.save !== 'function' || typeof store.latest !== 'function') {
    throw new TypeError('createCheckpointService: store must provide save() and latest()');
  }
  const deps = Object.freeze({ store, validate, appendEvent, now });
  return {
    checkpoint: (content, options) => saveCheckpoint(deps, content, options),
    latestValid: (missionId) => loadLatestValid(deps, missionId),
  };
}
