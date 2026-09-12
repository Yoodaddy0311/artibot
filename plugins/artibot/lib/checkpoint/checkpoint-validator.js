/**
 * Checkpoint schema validation — the entry point `lib/checkpoint/*` callers
 * use, deliberately thin.
 *
 * **Where the field list lives, and why not here.** The design's module tree
 * puts a `checkpoint-validator` in this directory, but the checkpoint shape is
 * a supervisor contract: it sits beside the event envelope, run state and lane
 * state that `lib/supervisor/contracts.js#validateCheckpoint` already owns,
 * and the vNext addendum's instruction is one home for the field list and no
 * JSON copy under `schemas/`. Two options were open — author the rules here,
 * or author them in `contracts.js` and delegate. Delegation was chosen: a
 * checkpoint is validated both by the supervisor (before it takes one) and by
 * resume (before it trusts one), so the rules would otherwise be imported
 * across layers anyway, and a second list is a list that drifts. This file
 * therefore adds only what is specific to the checkpoint directory: the
 * record-level predicate below. It contains no field names.
 *
 * Layer 2 (auxiliary domain service). Imports Layer 2 only; no runtime deps.
 *
 * @module lib/checkpoint/checkpoint-validator
 */

import { validateCheckpoint } from '../supervisor/contracts.js';

export {
  CHECKPOINT_FIELDS,
  CHECKPOINT_REQUIRED_FIELDS,
  validateCheckpoint,
} from '../supervisor/contracts.js';

/**
 * Is this stored record one that resume may build on?
 *
 * Takes a store *record* (`{ v, checkpoint_id, mission_id, ts, checkpoint }`),
 * not a bare checkpoint, because that is what `store.latest` hands back and
 * unwrapping at each call site is where the two get confused.
 *
 * True requires both halves: the content validates AND it says
 * `resumable: true`. A checkpoint may be perfectly well formed and still
 * declare itself unusable — that is what the flag is for. Anything unexpected
 * (null, a bare checkpoint, an array) is false rather than an exception: the
 * fail-closed answer is the safe one, and callers asking this question are
 * deciding whether to resume, not debugging the record. Use
 * {@link validateCheckpoint} when the reasons matter.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isResumable(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const checkpoint = /** @type {Record<string, unknown>} */ (record).checkpoint;
  if (!validateCheckpoint(checkpoint).ok) return false;
  return /** @type {Record<string, unknown>} */ (checkpoint).resumable === true;
}
