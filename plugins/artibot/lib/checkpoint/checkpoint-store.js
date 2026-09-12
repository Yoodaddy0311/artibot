/**
 * The Checkpoint Store — the append port for mission checkpoints.
 *
 * ── What this module is for ───────────────────────────────────────────────
 * A mission's recoverable history is a sequence of checkpoints, and recovery
 * and replay both need two questions answered cheaply: "give me this exact
 * checkpoint" and "give me this mission's most recent one". This module owns
 * those four verbs (`save`, `load`, `latest`, `list`) and nothing else. It is
 * append-only: there is no update and no delete, because a checkpoint that can
 * be edited after the fact cannot be used to explain what a run actually did
 * (design ARTIBOT-5.0-DESIGN.md §8.2, §21-26).
 *
 * ── What it deliberately does NOT know ────────────────────────────────────
 * The checkpoint's field schema. `mission_id` is the ONLY field read here, and
 * only because `latest` and `list` are keyed on it. Validating the rest is
 * `checkpoint-validator.js`'s job; a second copy of the field list here would
 * be free to drift from the first, and two disagreeing validators are worse
 * than one. Anything else the caller puts in the body is stored verbatim.
 *
 * It also does not know WHERE its bytes go. Storage arrives as an injected
 * adapter with two methods, `append(record)` and `readAll()`, either of which
 * may be synchronous or return a promise. `createMemoryAdapter` below is the
 * reference implementation and the default for tests; the on-disk one is
 * `./adapters/file-store.js`. Injection is what lets the immutability gate run
 * the identical procedure against both.
 *
 * ── State isolation (scorecard §25, §52) ──────────────────────────────────
 * No reference the caller can reach is ever shared with the store. The save
 * input is deep-copied before it reaches the adapter, and every read result is
 * deep-copied before it is returned, using `structuredClone` — the same choice
 * `lib/project-state/projection.js#clone` makes for the same job, so the two
 * stores cannot drift on what "a deep copy" means here. Returned values are NOT
 * frozen: `tests/firewall/checkpoint-immutability.test.js` has the full
 * reasoning, including why freezing would make the gate's own procedure
 * impossible to run.
 *
 * ── Layer ─────────────────────────────────────────────────────────────────
 * L2. Pure over its injected ports — no clock of its own, no filesystem, no
 * randomness except the default id generator, all three replaceable at
 * construction. Its dependency ceiling is `lib/core`, and today it imports
 * nothing at all.
 *
 * @module lib/checkpoint/checkpoint-store
 */

/** Record envelope version. Bumping it is a migration, not a patch. */
export const CHECKPOINT_RECORD_VERSION = 1;

/** Per-process monotonic counter feeding {@link defaultNewId}. */
let idCounter = 0;

/**
 * Default checkpoint id.
 *
 * Ids must be distinct ACROSS processes, because one mission's checkpoints are
 * written by however many `/split` windows and hook processes are open on the
 * same file, and a collision would make `load` return the wrong run's state.
 * Four parts, each covering a case the others miss:
 *
 *   `cp`        — a human-readable kind marker in logs and filenames.
 *   timestamp   — orders ids roughly by time, base-36 for length.
 *   pid         — separates concurrent processes. Two processes can and do
 *                 write in the same millisecond, so the clock alone collides.
 *   counter     — separates saves WITHIN a process, where the pid is constant
 *                 and the clock frequently is too. This is what a pure
 *                 clock+pid id loses in a tight loop.
 *   random      — covers pid REUSE. An operating system recycles pids, so a
 *                 later process can present the same pid with a counter that
 *                 restarts at 1; without this suffix those two ids are equal.
 *
 * Not a UUID: this package carries zero runtime dependencies, and `randomUUID`
 * would hide the pid and ordering that make a collision diagnosable when one
 * does happen. Inject `newId` to make ids deterministic in a test.
 *
 * @returns {string} A process-unique checkpoint id.
 */
export function defaultNewId() {
  idCounter += 1;
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 8);
  return `cp-${stamp}-${process.pid}-${idCounter.toString(36)}-${salt}`;
}

/**
 * Deep-copy a JSON-shaped value.
 *
 * `structuredClone` rather than a JSON round trip: it preserves `undefined`
 * inside arrays and throws on a value it cannot copy, so a bug surfaces as an
 * error instead of a silently missing field.
 *
 * @template T
 * @param {T} value - Value to copy.
 * @returns {T} A deep copy.
 */
function copy(value) {
  return structuredClone(value);
}

/**
 * An in-process reference adapter — an array, and nothing else.
 *
 * It is the default for tests and the shape every other adapter must match. It
 * does no copying of its own on purpose: isolation is the STORE's guarantee,
 * and an adapter that also copied would hide a store that had stopped.
 *
 * @returns {{append: (record: object) => void, readAll: () => object[]}} Adapter.
 */
export function createMemoryAdapter() {
  const records = [];
  return {
    append(record) {
      records.push(record);
    },
    readAll() {
      return records;
    },
  };
}

/**
 * Reject a checkpoint the store cannot key.
 *
 * A REJECTED PROMISE, not an `{ok: false}` result. The ledger
 * (`lib/runtime/event-writer.js`) returns a result object because refusal there
 * is routine and expected — an unregistered event name, an over-cap line — and
 * its callers are built to carry on. A checkpoint with no `mission_id` is not a
 * routine refusal; it is a caller bug, and the two useful behaviours are "stop"
 * and "stop loudly". Returning a value would let a caller that ignored it
 * believe a checkpoint exists when none was written, which is the silent
 * failure this whole subsystem exists to prevent.
 *
 * @param {unknown} checkpoint - Caller-supplied checkpoint body.
 * @returns {string} The validated mission id.
 * @throws {TypeError} When the body is not an object or has no usable mission id.
 */
function requireMissionId(checkpoint) {
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new TypeError('checkpoint store: save() expects a checkpoint object');
  }
  const missionId = checkpoint.mission_id;
  if (typeof missionId !== 'string' || missionId === '') {
    throw new TypeError(
      'checkpoint store: save() requires a non-empty string mission_id — latest() and list() are keyed on it',
    );
  }
  return missionId;
}

/**
 * Create a checkpoint store over an injected storage adapter.
 *
 * @param {object} params - Construction inputs.
 * @param {{append: Function, readAll: Function}} params.adapter - Storage port.
 * @param {() => Date} [params.now] - Clock, injected so records are pinnable.
 * @param {() => string} [params.newId] - Id source; see {@link defaultNewId}.
 * @returns {{save: Function, load: Function, latest: Function, list: Function}} Store.
 * @throws {TypeError} When the adapter does not implement both port methods.
 * @example
 * const store = createCheckpointStore({ adapter: createMemoryAdapter() });
 * const { checkpoint_id } = await store.save({ mission_id: 'M-1', phase: 'build' });
 */
export function createCheckpointStore({ adapter, now = () => new Date(), newId = defaultNewId } = {}) {
  if (!adapter || typeof adapter.append !== 'function' || typeof adapter.readAll !== 'function') {
    throw new TypeError('checkpoint store: adapter must implement append(record) and readAll()');
  }

  /**
   * Every record currently in storage, oldest first.
   * @returns {Promise<object[]>} Stored records.
   */
  const all = async () => {
    const records = await adapter.readAll();
    return Array.isArray(records) ? records : [];
  };

  return {
    /**
     * Append one checkpoint.
     *
     * @param {object} checkpoint - Checkpoint body; only `mission_id` is read here.
     * @returns {Promise<{checkpoint_id: string, ts: string}>} The new record's identity.
     */
    async save(checkpoint) {
      const missionId = requireMissionId(checkpoint);
      const record = {
        v: CHECKPOINT_RECORD_VERSION,
        checkpoint_id: newId(),
        mission_id: missionId,
        ts: now().toISOString(),
        // Copied BEFORE it leaves this function: a caller that keeps editing
        // its own object must not be able to rewrite what was stored.
        checkpoint: copy(checkpoint),
      };
      await adapter.append(record);
      return { checkpoint_id: record.checkpoint_id, ts: record.ts };
    },

    /**
     * Fetch one record by id.
     *
     * @param {string} checkpointId - Id returned by `save`.
     * @returns {Promise<object|null>} A copy of the record, or null when unknown.
     */
    async load(checkpointId) {
      if (typeof checkpointId !== 'string' || checkpointId === '') return null;
      const records = await all();
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i]?.checkpoint_id === checkpointId) return copy(records[i]);
      }
      return null;
    },

    /**
     * Fetch a mission's most recently saved record.
     *
     * Derived in memory by folding the record stream, not read from a separate
     * snapshot file — see `./adapters/file-store.js` for why there is no second
     * artifact to keep in sync.
     *
     * @param {string} missionId - Mission key.
     * @returns {Promise<object|null>} A copy of the last record, or null.
     */
    async latest(missionId) {
      if (typeof missionId !== 'string' || missionId === '') return null;
      const records = await all();
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i]?.mission_id === missionId) return copy(records[i]);
      }
      return null;
    },

    /**
     * A mission's checkpoint ids, in save order.
     *
     * @param {string} missionId - Mission key.
     * @returns {Promise<string[]>} Ids, oldest first. Empty when the mission is unknown.
     */
    async list(missionId) {
      if (typeof missionId !== 'string' || missionId === '') return [];
      const records = await all();
      return records
        .filter((r) => r?.mission_id === missionId)
        .map((r) => r.checkpoint_id);
    },
  };
}
