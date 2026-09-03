/**
 * Lease record adapter — `lease.schema.json` <-> `lib/git/landing-lock.js`.
 *
 * Two shapes describe the same idea and neither can be changed to match the
 * other, so this module converts between them in both directions.
 *
 * | axis       | lease.schema.json        | landing-lock.js record        |
 * |------------|--------------------------|-------------------------------|
 * | field case | snake_case               | camelCase (`acquiredAt`)      |
 * | time       | ISO-8601 strings         | epoch milliseconds            |
 * | expiry     | stored (`expires_at`)    | derived from `staleMs`        |
 * | renew      | `heartbeat_at`           | absent                        |
 * | identity   | `owner` (required)       | `sessionId` (nullable)        |
 *
 * The schema's own description names this conversion as a StateStore
 * obligation ("A StateStore adapter must convert in both directions"), which
 * is why it lives here and not in `lib/git/`: `landing-lock.js` is prior art
 * that predates the schema and is not being changed.
 *
 * ── Two lossy edges, both deliberate ────────────────────────────────────────
 * 1. `landing-lock.js` has no `owner` field. `toLease` derives one as
 *    `sessionId` when present, else `host:pid` — a stable identifier for the
 *    same holder either way. It never invents a placeholder, because a lease
 *    whose owner is fictional cannot be reclaimed against.
 * 2. `landing-lock.js` has no slot for `expires_at` or `heartbeat_at`.
 *    `toLandingLockRecord` therefore returns `staleMs` alongside the record so
 *    a caller can rebuild `expires_at`; the renew instant genuinely has
 *    nowhere to go and is dropped. Round-tripping a lease that has been
 *    renewed through the landing-lock shape and back yields
 *    `heartbeat_at === acquired_at`, and `toLease` says so via
 *    `derived.heartbeat_at`.
 *
 * @module lib/project-state/lease
 */

import { DEFAULT_STALE_MS } from '../git/landing-lock.js';

export { DEFAULT_STALE_MS };

/** Fields `lease.schema.json` marks required. */
export const LEASE_REQUIRED_FIELDS = Object.freeze([
  'owner', 'acquired_at', 'expires_at', 'heartbeat_at',
]);

/**
 * Convert epoch milliseconds to an ISO-8601 instant.
 *
 * @param {number} ms - Epoch milliseconds.
 * @param {string} at - Field name, used in error messages.
 * @returns {string} ISO-8601 string with a `Z` offset.
 * @throws {TypeError} When the value is not a finite, representable instant.
 */
function toIso(ms, at) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(`lease adapter: ${at} must be a finite epoch-ms number, got ${String(ms)}`);
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`lease adapter: ${at} is not a representable instant (${ms})`);
  }
  return d.toISOString();
}

/**
 * Convert an ISO-8601 instant to epoch milliseconds.
 *
 * @param {string} iso - ISO-8601 instant.
 * @param {string} at - Field name, used in error messages.
 * @returns {number} Epoch milliseconds.
 * @throws {TypeError} When the value is not a parseable instant.
 */
function toEpoch(iso, at) {
  if (typeof iso !== 'string' || iso === '') {
    throw new TypeError(`lease adapter: ${at} must be a non-empty ISO-8601 string`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new TypeError(`lease adapter: ${at} is not a parseable ISO-8601 instant (${iso})`);
  }
  return ms;
}

/**
 * Derive a lease owner from a landing-lock record.
 *
 * @param {object} record - A `landing-lock.js` holder record.
 * @returns {string} `sessionId`, else `host:pid`.
 * @throws {TypeError} When neither identity is usable.
 */
function deriveOwner(record) {
  if (typeof record.sessionId === 'string' && record.sessionId !== '') return record.sessionId;
  const host = typeof record.host === 'string' && record.host !== '' ? record.host : null;
  const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
  if (host && pid) return `${host}:${pid}`;
  throw new TypeError(
    'lease adapter: cannot derive owner — record has no sessionId and no usable host/pid pair',
  );
}

/**
 * Build a `lease.schema.json` record from a landing-lock holder record.
 *
 * @param {object} record - Holder record: `{token, pid, host, sessionId, acquiredAt}`.
 * @param {object} [opts] - Conversion options.
 * @param {number} [opts.staleMs=DEFAULT_STALE_MS] - TTL used to derive `expires_at`.
 * @param {string} [opts.owner] - Explicit owner, overriding the derivation.
 * @param {number} [opts.heartbeatAt] - Epoch ms of the last renew, when known.
 * @returns {{lease: object, derived: {owner: boolean, expires_at: boolean, heartbeat_at: boolean}}}
 *   The lease plus which of its required fields were derived rather than read.
 * @throws {TypeError} When the record cannot produce a schema-valid lease.
 * @example
 * toLease({ token: 't', pid: 42, host: 'h', sessionId: 's1', acquiredAt: 0 });
 * // lease.acquired_at === '1970-01-01T00:00:00.000Z'
 */
export function toLease(record, opts = {}) {
  if (record === null || typeof record !== 'object') {
    throw new TypeError('lease adapter: record must be an object');
  }
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) {
    throw new TypeError(`lease adapter: staleMs must be a positive finite number, got ${String(staleMs)}`);
  }
  const acquiredMs = toEpoch(toIso(record.acquiredAt, 'acquiredAt'), 'acquiredAt');
  const ownerGiven = typeof opts.owner === 'string' && opts.owner !== '';
  const heartbeatGiven = typeof opts.heartbeatAt === 'number';

  const lease = {
    owner: ownerGiven ? opts.owner : deriveOwner(record),
    acquired_at: toIso(acquiredMs, 'acquiredAt'),
    expires_at: toIso(acquiredMs + staleMs, 'expires_at'),
    heartbeat_at: heartbeatGiven ? toIso(opts.heartbeatAt, 'heartbeatAt') : toIso(acquiredMs, 'acquiredAt'),
  };
  if (typeof record.token === 'string' && record.token !== '') lease.token = record.token;
  if (Number.isInteger(record.pid) && record.pid > 0) lease.pid = record.pid;
  if (typeof record.host === 'string' && record.host !== '') lease.host = record.host;
  if (typeof record.sessionId === 'string' && record.sessionId !== '') lease.session_id = record.sessionId;

  return {
    lease,
    derived: { owner: !ownerGiven, expires_at: true, heartbeat_at: !heartbeatGiven },
  };
}

/**
 * Build a landing-lock holder record from a `lease.schema.json` record.
 *
 * @param {object} lease - A schema-shaped lease.
 * @returns {{record: object, staleMs: number, dropped: string[]}} The record, the
 *   TTL implied by `expires_at - acquired_at` (so `expires_at` is rebuildable),
 *   and the field names that have no landing-lock slot.
 * @throws {TypeError} When a required lease field is missing or unparseable.
 * @example
 * toLandingLockRecord(lease).staleMs; // 1_800_000 for a 30-minute lease
 */
export function toLandingLockRecord(lease) {
  if (lease === null || typeof lease !== 'object') {
    throw new TypeError('lease adapter: lease must be an object');
  }
  for (const field of LEASE_REQUIRED_FIELDS) {
    if (lease[field] === undefined || lease[field] === null) {
      throw new TypeError(`lease adapter: lease.${field} is required by lease.schema.json`);
    }
  }
  const acquiredMs = toEpoch(lease.acquired_at, 'acquired_at');
  const expiresMs = toEpoch(lease.expires_at, 'expires_at');
  const staleMs = expiresMs - acquiredMs;
  if (staleMs <= 0) {
    throw new TypeError(
      `lease adapter: expires_at (${lease.expires_at}) is not after acquired_at (${lease.acquired_at})`,
    );
  }
  const record = {
    token: typeof lease.token === 'string' ? lease.token : null,
    pid: Number.isInteger(lease.pid) ? lease.pid : null,
    host: typeof lease.host === 'string' ? lease.host : null,
    sessionId: typeof lease.session_id === 'string' ? lease.session_id : null,
    acquiredAt: acquiredMs,
  };
  // `owner` survives only when it IS the sessionId; otherwise the landing-lock
  // shape has nowhere to put it. Reported, never silently folded into another
  // field.
  const dropped = ['heartbeat_at'];
  if (record.sessionId !== lease.owner) dropped.unshift('owner');
  return { record, staleMs, dropped };
}

/**
 * Judge whether a lease is reclaimable at a given instant.
 *
 * Expiry is a DERIVED judgement, never a stored boolean
 * (`lease.schema.json` description) — which is why this is a function of
 * `(lease, now)` and not a field.
 *
 * @param {object} lease - A schema-shaped lease.
 * @param {Date|number} [now=Date.now()] - The instant to judge at.
 * @returns {boolean} True when `now` is past `expires_at`.
 */
export function isLeaseExpired(lease, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('lease adapter: now must be a Date or finite epoch-ms number');
  }
  return nowMs > toEpoch(lease?.expires_at, 'expires_at');
}

/**
 * Build a fresh lease.
 *
 * @param {object} params - Lease parameters.
 * @param {string} params.owner - Stable holder id.
 * @param {Date|number} params.now - Acquisition instant.
 * @param {number} [params.ttlMs=DEFAULT_STALE_MS] - Lifetime.
 * @param {string} [params.token] - Optional release guard.
 * @param {string} [params.sessionId] - Optional session id.
 * @returns {object} A `lease.schema.json`-shaped record.
 */
export function createLease({ owner, now, ttlMs = DEFAULT_STALE_MS, token, sessionId }) {
  if (typeof owner !== 'string' || owner === '') {
    throw new TypeError('lease adapter: owner must be a non-empty string');
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const acquired = toIso(nowMs, 'now');
  const lease = {
    owner,
    acquired_at: acquired,
    expires_at: toIso(nowMs + ttlMs, 'expires_at'),
    heartbeat_at: acquired,
  };
  if (typeof token === 'string' && token !== '') lease.token = token;
  if (typeof sessionId === 'string' && sessionId !== '') lease.session_id = sessionId;
  return lease;
}

/**
 * Renew a lease, moving both the heartbeat and the expiry forward.
 *
 * @param {object} lease - The lease to renew.
 * @param {object} params - Renewal parameters.
 * @param {Date|number} params.now - Renewal instant.
 * @param {number} [params.ttlMs] - New lifetime; defaults to the lease's own.
 * @returns {object} A new lease; the input is not mutated.
 */
export function renewLease(lease, { now, ttlMs }) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const span = ttlMs ?? (toEpoch(lease.expires_at, 'expires_at') - toEpoch(lease.acquired_at, 'acquired_at'));
  return {
    ...lease,
    heartbeat_at: toIso(nowMs, 'now'),
    expires_at: toIso(nowMs + span, 'expires_at'),
  };
}
