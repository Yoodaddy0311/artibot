/**
 * Replay barrel — the ledger's read model.
 *
 * Every module here is pure (design §1-8, L2): no clock, no filesystem, no
 * randomness. Effects arrive as injected ports. NOTHING IN THIS DIRECTORY
 * WRITES A FILE, and that is a contract rather than a coincidence — the index
 * is a regenerable projection of `.artibot/runtime/ledger.jsonl`, and the
 * ledger stays the one source of truth (design §8.3-2).
 *
 * `existence-audit.js` is T-44's and is intentionally absent here; `countBy`
 * and `foldByAction` are exported for it to build on.
 *
 * @module lib/replay
 */

export {
  ATTRIBUTION,
  GAP_TYPES,
  PROJECTED_EVENTS,
  REJECTED_EVENT,
  REQUIRED_ENVELOPE_KEYS,
  actionKeyOf,
  buildReplay,
  compareEvents,
  countBy,
  dedupeKey,
  envelopeFaults,
  findSeqGaps,
  foldByAction,
  foldMissionIndex,
  orderEvents,
  serializeIndex,
} from './replay.js';

export { loadReplay } from './load.js';
