/**
 * Lane-lease lifecycle arithmetic — the clock half of SH-12 and the reclaim
 * half of CA-09, for the Task Graph LANE lease (a `/split` limb's entry in
 * `task_leases`; owner decision 2026-09-30: the lane lease, not the mission
 * controller lease).
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * `scripts/split/task-feed.mjs#feedLimb` claims a limb's task at dispatch with
 * a 24h TTL. Measured by reading the callers (2026-09-30, grep for
 * `heartbeatWorker` over `plugins/`): only `lane-lease.mjs#syncLaneLease`
 * (reached from `lane-state.mjs#main`) and `task-feed.mjs#claimLimb` (a
 * re-dispatch) renew it — both at a moment the leader declares, neither on a
 * clock. And nothing looks at a lease that lapsed: `state-manager.js#claimTask`
 * can take an expired lease, but only when a claimer turns up, and `claimLimb`
 * never reaches that branch (it answers `held-by` first). A dead lane therefore
 * held its lease until a human noticed.
 *
 * ── Three questions, one TTL ───────────────────────────────────────────────
 * - {@link heartbeatCadence}: "is this lease due a heartbeat?" — once
 *   min(ttl/3, 45 min) has passed since its last beat. ttl/3 alone would be 8h
 *   on the shipped 24h lease, which is no heartbeat at all for a wave that
 *   lasts two hours; the cap makes the tick a clock. (The TTL itself stays an
 *   owner decision — `LIMB_LEASE_TTL_MS`.)
 * - {@link classifyLaneLiveness}: "may a tick keep this lane alive, and is its
 *   lease held back from the reclaim report?"
 * - {@link findReclaimCandidates} / {@link reclaimExpiredLaneLeases}: "which
 *   lapsed lane leases is no lane keeping alive?"
 * They share the span arithmetic and the expiry judgement, which is why they
 * live in one module: the cadence that keeps a lease alive and the rule that
 * calls it dead must agree on what "granted TTL" and "expired" mean.
 *
 * ── Liveness evidence: a heartbeat is a claim that the worker is alive ─────
 * A tick is an observer, not the worker, so it renews a lane only on POSITIVE
 * evidence (ADV-4): the worktree lock's pid is alive (`sessionPresent ===
 * true`), or — with no lock line at all (`null`) — the leader's own lane-state
 * activity (`run.json.lanes[limb].updated_at`, stamped by every
 * `writeWorkerState`, re-asserts included) falls inside the TTL window. With
 * neither, the lane is NOT renewed, so its lease can lapse into the report; a
 * dead pid (`false`) never renews. `active` alone is an undated word and proves
 * nothing. LIMIT, unmeasured: the pid probe has no start-time check, so a dead
 * session whose pid the OS handed to another process reads as alive and keeps
 * its lane renewed until the lock line goes (`git worktree unlock` / prune).
 *
 * ── A suspended lane is held, not renewed ──────────────────────────────────
 * `suspended` is an operator hold (compact wait, owner pause, a reboot
 * shutdown — its session is usually gone), not a failure (ADV-3). Its lease is
 * never renewed (`LANE_LEASE_ACTIONS`: nothing to say to the lease) but it is
 * kept OUT of the reclaim candidates: a parked lane must not be offered for
 * reclaim. A suspended lane that the trailer or the supervisor calls finished
 * is not held — that lease is leftover.
 *
 * ── REPORT-ONLY, and apply takes EXPLICIT ids ──────────────────────────────
 * The canon (`ARTIBOT-5.0-DESIGN.md` §9 row: "GA 전엔 reclaim 은 사람 확인")
 * keeps a human in front of every reclaim until GA. So {@link
 * reclaimExpiredLaneLeases} only ever calls `store.getState()` unless
 * `apply === true` — `'true'`, `1` and every other truthy look-alike stay
 * report-only — AND even then it releases only the ids in `ids`
 * (`<mission>/<task>`, see {@link parseReclaimIds}): the ids the human read in
 * the report (ADV-1). An id must be both listed and still expired after a
 * fresh read; nothing unlisted is ever touched, there is no rescan-and-release-
 * all, and an apply with no usable list is refused before the store is read.
 * There is NO config key here and this module reads no config: L4 receives the
 * answer as an option, and a config key is the leader's later decision.
 *
 * ── What apply does, and what it refuses to ────────────────────────────────
 * It releases the lease through `store.releaseTask` (never `claimTask`: there
 * is no natural new owner for an automatic scan). An OWNED node
 * (`claimed|executing|reviewing`) goes back to `queued` with no owner, so the
 * next dispatch claims it fresh; a finished, failed, blocked or queued node
 * only loses the dead lease and keeps its status; a BOUND node (it carries
 * `ops`, SH-11) keeps its status too — `split-state-sources.js#assertOpsStatusAgree`
 * makes `ops.state` and `status` agree a writer obligation, and a reclaim is
 * not the writer. Each release re-reads the store, re-judges expiry and owner,
 * and passes `expectedVersion`, so a holder that renews between the report and
 * the release keeps its lease (`skipped:not-expired`) and any other store write
 * in that window is a CAS `skipped:conflict` — retried by the next run, never
 * forced. The only ledger event is the store's own `state.updated`, attributed
 * by {@link LEASE_RECLAIM_REASON}: no new event name (D-B1).
 *
 * ── Keep-alive lanes are never candidates ──────────────────────────────────
 * The caller passes `keepAlive`: the lane ids {@link classifyLaneLiveness}
 * holds (a lane it renews, or a suspended one). A lapsed lease on such a lane
 * is reported as `protected`, not as a candidate.
 *
 * ── What a tick writes to the ledger (D11 / §9), and why it is not "nothing" ─
 * The canon says heartbeats update the store only and the central ledger gets
 * only `task.claimed/released` (design D11, §9 row, `ledger-events.allowlist.json`
 * `task.claimed`). But a renewal is a store commit, and the store appends its
 * own `state.updated` for EVERY commit: `ledger ⊇ store` is the canon's own
 * invariant (design §1-2; `state-manager.js` has no opt-out), and a no-op
 * ledger port would make each tick an `extraInStore` version — the exact
 * signature `/doctor` Check 8 reads as a lost update. A store-only write mode
 * needs `state-manager.js` and `reconcile.js` (not this lane's). Until then a
 * tick writes the store's pairing row with its OWN reason ({@link
 * LEASE_TICK_REASON}) and `heartbeat_source` ({@link LEASE_TICK_SOURCE}),
 * distinct from the lane-state emitter's `split.lane-lease` / `lane-heartbeat`,
 * and the 45-minute cap bounds it at 32 rows per lane-day. No new event name.
 *
 * ── What it cannot see (rules §9, written next to the code) ────────────────
 * It judges leases by clock and liveness by two weak signals, not by watching
 * the worker: a live worker whose lane is undeclared and lock-less reads the
 * same as a dead one once the window passes. It identifies a lane by the
 * feeder's own marker ({@link LANE_TASK_TITLE_PREFIX}) or by `ops`; a feeder
 * that changes both silences the report (pinned by the drift test against
 * `mergeLimbTasks`). It scans every mission in the store, not one run — a stale
 * lane lease of an older run is exactly what it is for — but `keepAlive` is
 * matched by lane id alone, so an older run's stale lease on a limb name the
 * current run is working stays protected until that lane ends (it errs toward
 * keeping). And every `store.getState()` re-parses the whole journal, which
 * the tests exercise on a handful of records only.
 *
 * ── Layer ──────────────────────────────────────────────────────────────────
 * L4 (`lib/topology/`, ceiling L2): pure except for the store passed in, reads
 * no file and no config, imports only `lib/` siblings.
 *
 * @module lib/topology/lease-reclaim
 */

import { isLeaseExpired } from '../project-state/lease.js';
import { MISSION_ID_PATTERN, OWNED_TASK_STATUSES } from '../project-state/validate.js';
import { isLaneOpsState } from '../supervisor/contracts.js';
import { HEARTBEAT_OPS_STATES } from './split-state-sources.js';
import { LIMB_LEASE_TTL_MS } from './split-task-feed.js';

/** A lease is due a heartbeat once this fraction of its granted span has passed: ttl / 3. */
export const HEARTBEAT_INTERVAL_DIVISOR = 3;

/** ...and never later than this: the interval is min(ttl / 3, 45 minutes). */
export const HEARTBEAT_MAX_INTERVAL_MS = 45 * 60 * 1000;

/**
 * The title `split-task-feed.js#seedTask` gives every limb node (`/split limb
 * <id>`). The one marker a LEGACY (unbound) lane node carries; a drift test
 * pins it against the real feeder.
 */
export const LANE_TASK_TITLE_PREFIX = '/split limb ';

/** Journal/ledger `reason` of the release a reclaim makes (the event is the store's own `state.updated`). */
export const LEASE_RECLAIM_REASON = 'split.lease-reclaim';

/** Journal/ledger `reason` of a tick's renewal — distinct from `lane-lease.mjs#LANE_LEASE_REASON`. */
export const LEASE_TICK_REASON = 'split.lease-tick';

/** `heartbeat_source` a tick stamps — distinct from the lane-state emitter's `lane-heartbeat`. */
export const LEASE_TICK_SOURCE = 'lease-tick';

/** How far back lane-state activity counts as liveness evidence: the limb lease TTL, so an owner's TTL change moves it too. */
export const LIVENESS_EVIDENCE_WINDOW_MS = LIMB_LEASE_TTL_MS;

/** A lane-state timestamp this far in the future is still "now" (host clock adjustments); further is not evidence. */
const EVIDENCE_SKEW_TOLERANCE_MS = 60 * 1000;

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} iso @returns {number} epoch ms, or NaN */
function toMs(iso) {
  return typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
}

/** @param {number} ms @returns {string|null} */
function isoOrNull(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** @param {unknown} v @returns {boolean} A finite number greater than zero. */
function isPositiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * The span a lease was granted, read the way `lease.js#renewLease` reads it:
 * `expires_at - heartbeat_at`, falling back to `expires_at - acquired_at` for a
 * record with no usable `heartbeat_at`. A drift test pins this against
 * `renewLease` itself — `lease.js#grantedSpan` is private, so this is a copy,
 * and the test is what keeps it one.
 *
 * @param {object} lease
 * @returns {number|null} ms, or null when neither span is positive and finite
 */
function grantedSpanMs(lease) {
  const expires = toMs(lease.expires_at);
  if (!Number.isFinite(expires)) return null;
  const fromBeat = expires - toMs(lease.heartbeat_at);
  if (fromBeat > 0) return fromBeat;
  const fromAcquired = expires - toMs(lease.acquired_at);
  return fromAcquired > 0 ? fromAcquired : null;
}

/**
 * @typedef {object} HeartbeatVerdict
 * @property {boolean} due - True when the lease is due a heartbeat.
 * @property {'due'|'fresh'|'no-lease'|'bad-lease'|'bad-clock'} reason
 * @property {number} [ttlMs] - The granted span (absent on the three non-judgements).
 * @property {number} [intervalMs] - `min(ttlMs / divisor, maxIntervalMs)`.
 * @property {number} [ageMs] - `nowMs` minus the last heartbeat (acquisition when there is none); negative under clock skew.
 * @property {boolean} [expired] - True when `nowMs` is strictly after `expires_at`.
 */

/**
 * Is this lease due a heartbeat at `nowMs`? Pure and total.
 *
 * Due once `ageMs >= min(ttlMs / divisor, maxIntervalMs)`, where the age runs
 * from the LAST heartbeat and the TTL is the span the lease was granted — so a
 * 24h lease is due at 45 minutes and again 45 minutes after each renewal,
 * never sooner, while a 60-minute lease is bound by its own ttl/3 (20 minutes).
 * A lease that has already lapsed is due too (the caller decides whether a
 * lapsed lease on a lane it still keeps alive is renewed back; `expired` says
 * it lapsed).
 *
 * @param {unknown} lease - A `lease.schema.json` record, or null.
 * @param {number} nowMs - The caller's clock (epoch ms).
 * @param {{ divisor?: number, maxIntervalMs?: number }} [opts] - `divisor` >= 1 and `maxIntervalMs` > 0, both
 *   finite; anything else falls back to {@link HEARTBEAT_INTERVAL_DIVISOR} / {@link HEARTBEAT_MAX_INTERVAL_MS}.
 * @returns {HeartbeatVerdict}
 * @example
 * heartbeatCadence(lease, Date.parse(lease.acquired_at) + 45 * 60_000).due; // true for a 24h lease
 */
export function heartbeatCadence(lease, nowMs, opts) {
  if (lease === null || lease === undefined) return { due: false, reason: 'no-lease' };
  if (!isPlainObject(lease)) return { due: false, reason: 'bad-lease' };
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { due: false, reason: 'bad-clock' };
  const ttlMs = grantedSpanMs(lease);
  const beat = toMs(lease.heartbeat_at);
  const since = Number.isFinite(beat) ? beat : toMs(lease.acquired_at);
  if (ttlMs === null || !Number.isFinite(since)) return { due: false, reason: 'bad-lease' };

  const asked = opts?.divisor;
  const divisor = typeof asked === 'number' && Number.isFinite(asked) && asked >= 1 ? asked : HEARTBEAT_INTERVAL_DIVISOR;
  const cap = isPositiveFinite(opts?.maxIntervalMs) ? opts.maxIntervalMs : HEARTBEAT_MAX_INTERVAL_MS;
  const intervalMs = Math.min(ttlMs / divisor, cap);
  const ageMs = nowMs - since;
  const due = ageMs >= intervalMs;
  return { due, reason: due ? 'due' : 'fresh', ttlMs, intervalMs, ageMs, expired: isLeaseExpired(lease, nowMs) };
}

/**
 * Does this task node carry a LANE lease — is it a `/split` limb? True for a
 * node the feeder seeded (its title starts with {@link LANE_TASK_TITLE_PREFIX})
 * and for a bound node (it carries an `ops` object), which keeps the answer
 * even if the title is rewritten. A `/team` task is not a lane.
 *
 * @param {unknown} task
 * @returns {boolean}
 */
export function isLaneTask(task) {
  if (!isPlainObject(task)) return false;
  if (typeof task.title === 'string' && task.title.startsWith(LANE_TASK_TITLE_PREFIX)) return true;
  return isPlainObject(task.ops);
}

/**
 * Is a lane-state timestamp inside the evidence window? A future stamp counts
 * only within {@link EVIDENCE_SKEW_TOLERANCE_MS}; an unparseable one, a missing
 * clock and a missing stamp are not evidence.
 *
 * @param {unknown} updatedAt - ISO instant (`run.json.lanes[limb].updated_at`).
 * @param {number} nowMs
 * @param {number} windowMs
 * @returns {boolean}
 */
function laneStateIsFresh(updatedAt, nowMs, windowMs) {
  if (!Number.isFinite(nowMs)) return false;
  const at = toMs(updatedAt);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= -EVIDENCE_SKEW_TOLERANCE_MS && age <= windowMs;
}

/**
 * @typedef {object} LaneLiveness
 * @property {boolean} working - The lane's ops word is one of the working states (`HEARTBEAT_OPS_STATES`).
 * @property {boolean} renew - A tick may renew this lane's lease (when it is due).
 * @property {boolean} keepAlive - The lane's lease is held back from the reclaim candidates: it is renewed, or suspended.
 * @property {string|null} reason - Why it is not renewed: `ops-state:<word|unknown>` | `lane-complete` |
 *   `lane-state-done` | `session-absent` | `no-liveness-evidence`; null when it is.
 * @property {'session-alive'|'lane-state-fresh'|null} evidence - What made it renewable.
 */

/**
 * What a tick owes one lane's lease. Pure and total.
 *
 * RENEW only a WORKING lane (ops word in `HEARTBEAT_OPS_STATES`) that is not
 * known finished (trailer `complete`, supervisor DONE) or dead (`sessionPresent
 * === false`) AND has positive liveness evidence — a live lock pid, or, with no
 * lock line (`null`), lane-state activity inside the window (module header,
 * ADV-4). HOLD a `suspended` lane that is not finished (ADV-3): not renewed,
 * not a candidate. Everything else gets nothing, and its lease may lapse into
 * the report.
 *
 * @param {unknown} lane - One `watch.mjs#collect` lane: `{ opsState, complete, health, sessionPresent, opsUpdatedAt }`.
 * @param {{ nowMs?: number, evidenceWindowMs?: number }} [ctx] - `nowMs` is the clock (without it only a live pid is
 *   evidence); `evidenceWindowMs` > 0 defaults to {@link LIVENESS_EVIDENCE_WINDOW_MS}.
 * @returns {LaneLiveness}
 */
export function classifyLaneLiveness(lane, { nowMs, evidenceWindowMs } = {}) {
  const l = isPlainObject(lane) ? lane : {};
  const nothing = (reason, working = false) => ({ working, renew: false, keepAlive: false, reason, evidence: null });
  if (!isLaneOpsState(l.opsState)) return nothing('ops-state:unknown');
  const finished = l.complete === true || l.health?.health === 'done';
  if (l.opsState === 'suspended') return { ...nothing('ops-state:suspended'), keepAlive: !finished };
  if (!HEARTBEAT_OPS_STATES.includes(l.opsState)) return nothing(`ops-state:${l.opsState}`);
  if (l.complete === true) return nothing('lane-complete', true);
  if (l.health?.health === 'done') return nothing('lane-state-done', true);
  if (l.sessionPresent === false) return nothing('session-absent', true);

  const windowMs = isPositiveFinite(evidenceWindowMs) ? evidenceWindowMs : LIVENESS_EVIDENCE_WINDOW_MS;
  let evidence = null;
  if (l.sessionPresent === true) evidence = 'session-alive';
  else if (laneStateIsFresh(l.opsUpdatedAt, nowMs, windowMs)) evidence = 'lane-state-fresh';
  if (evidence === null) return nothing('no-liveness-evidence', true);
  return { working: true, renew: true, keepAlive: true, reason: null, evidence };
}

/**
 * Is this a `<mission>/<task>` id: a mission id in one of the store's two forms,
 * a slash, and a task id with no whitespace or comma (a slash inside it is fine —
 * the mission id has none, so the FIRST slash splits).
 *
 * @param {unknown} s
 * @returns {boolean}
 */
function isReclaimId(s) {
  if (typeof s !== 'string') return false;
  const at = s.indexOf('/');
  if (at < 1) return false;
  const task = s.slice(at + 1);
  return MISSION_ID_PATTERN.test(s.slice(0, at)) && task.length > 0 && !/[\s,]/.test(task);
}

/**
 * Validate the explicit id list an apply takes (ADV-1). ALL-or-nothing: one
 * malformed id refuses the whole list, because a half-applied confirmation is
 * the surprise a confirmation must not have.
 *
 * @param {unknown} ids - An array of `<mission>/<task>` strings.
 * @returns {{ ok: true, ids: string[] } | { ok: false, error: string }} `ids` is the input without duplicates, in order.
 */
export function parseReclaimIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: 'apply needs an explicit, non-empty list of <mission>/<task> ids' };
  }
  const out = [];
  for (const raw of ids) {
    if (!isReclaimId(raw)) return { ok: false, error: `not a <mission>/<task> id: ${String(raw)}` };
    if (!out.includes(raw)) out.push(raw);
  }
  return { ok: true, ids: out };
}

/**
 * What a reclaim does to a node: the status it ends in and the name of that act.
 *
 * @param {{ status?: unknown, ops?: unknown }} task
 * @returns {{ carriesOps: boolean, targetStatus: string, action: 'release-to-queued'|'clear-lease' }}
 */
function reclaimPlan(task) {
  const carriesOps = isPlainObject(task.ops);
  const targetStatus = OWNED_TASK_STATUSES.includes(task.status) && !carriesOps ? 'queued' : task.status;
  return { carriesOps, targetStatus, action: targetStatus === task.status ? 'clear-lease' : 'release-to-queued' };
}

/**
 * @param {unknown} keepAlive
 * @returns {Set<string>} Only an array or a Set is accepted; a string or a number is nothing.
 */
function toIdSet(keepAlive) {
  return keepAlive instanceof Set || Array.isArray(keepAlive) ? new Set(keepAlive) : new Set();
}

/** @param {object|null|undefined} snapshot @param {string} missionId @param {string} taskId @returns {object|null} */
function findTask(snapshot, missionId, taskId) {
  const tasks = snapshot?.task_graphs?.[missionId]?.tasks;
  return Array.isArray(tasks) ? tasks.find((t) => t?.id === taskId) ?? null : null;
}

/**
 * @typedef {object} ReclaimCandidate
 * @property {string} id - `<missionId>/<taskId>`: what `--apply-reclaim` takes.
 * @property {string} missionId
 * @property {string} taskId - The lane (limb) id.
 * @property {string} owner - Who holds the lapsed lease.
 * @property {boolean} ownerIsLane - `owner === taskId`: the lane holds its own lease, as the feeder makes it.
 * @property {string} status - The node's task status.
 * @property {boolean} carriesOps - A bound node: its status is kept.
 * @property {string} acquiredAt
 * @property {string} heartbeatAt
 * @property {string} expiresAt
 * @property {number} expiredForMs - `nowMs - expires_at`.
 * @property {number} silentForMs - `nowMs` minus the last heartbeat (acquisition when none).
 * @property {string|null} heartbeatSource - The node's `heartbeat_source`, when it has one.
 * @property {'release-to-queued'|'clear-lease'} action
 * @property {string} targetStatus - The status the node ends in if applied.
 */

/**
 * Scan a store snapshot for lapsed lane leases. PURE: reads `state`, writes
 * nothing, reads no clock (hence the required `nowMs`).
 *
 * A lease is a candidate only when it parses, is strictly past `expires_at`
 * (`lease.js#isLeaseExpired`), sits on a lane node, and its lane is not in
 * `keepAlive`. Everything it cannot judge — no task node, a lease that is not an
 * object, an unparseable `expires_at` — is listed in `malformed` with a reason
 * and is never a candidate (an allowlist: only a positively parsed, expired
 * lease qualifies). Output order is mission id, then task id.
 *
 * @param {object} [input]
 * @param {object} input.state - A `store.getState()` snapshot (`task_leases`, `task_graphs`).
 * @param {number} input.nowMs - The clock (epoch ms).
 * @param {Iterable<string>|string[]} [input.keepAlive] - Lane ids the caller keeps alive; an array or a Set.
 * @returns {{ nowMs: number, at: string|null, scanned: { missions: number, leases: number, laneLeases: number }, live: number, liveIds: string[], protected: Array<{ id: string, missionId: string, taskId: string, owner: string, expiredForMs: number }>, candidates: ReclaimCandidate[], malformed: Array<{ id: string, missionId: string, taskId: string, reason: string }> }}
 * @throws {TypeError} When `nowMs` is not a finite number.
 */
export function findReclaimCandidates({ state, nowMs, keepAlive } = {}) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('lease-reclaim: nowMs must be a finite epoch-ms number (a pure function does not read the clock)');
  }
  const keep = toIdSet(keepAlive);
  const report = {
    nowMs,
    at: isoOrNull(nowMs),
    scanned: { missions: 0, leases: 0, laneLeases: 0 },
    live: 0,
    liveIds: [],
    protected: [],
    candidates: [],
    malformed: [],
  };
  const byMission = isPlainObject(state?.task_leases) ? state.task_leases : {};
  for (const missionId of Object.keys(byMission).sort()) {
    const leases = byMission[missionId];
    if (!isPlainObject(leases)) continue;
    report.scanned.missions += 1;
    for (const taskId of Object.keys(leases).sort()) {
      const id = `${missionId}/${taskId}`;
      report.scanned.leases += 1;
      const lease = leases[taskId];
      const task = findTask(state, missionId, taskId);
      if (task === null) {
        report.malformed.push({ id, missionId, taskId, reason: isPlainObject(lease) ? 'no-task-node' : 'not-an-object' });
        continue;
      }
      if (!isLaneTask(task)) continue;
      report.scanned.laneLeases += 1;
      if (!isPlainObject(lease)) {
        report.malformed.push({ id, missionId, taskId, reason: 'not-an-object' });
        continue;
      }
      const expiresMs = toMs(lease.expires_at);
      if (!Number.isFinite(expiresMs)) {
        report.malformed.push({ id, missionId, taskId, reason: 'bad-expires_at' });
        continue;
      }
      if (!isLeaseExpired(lease, nowMs)) {
        report.live += 1;
        report.liveIds.push(id);
        continue;
      }
      const expiredForMs = nowMs - expiresMs;
      if (keep.has(taskId)) {
        report.protected.push({ id, missionId, taskId, owner: lease.owner, expiredForMs });
        continue;
      }
      const beat = toMs(lease.heartbeat_at);
      const since = Number.isFinite(beat) ? beat : toMs(lease.acquired_at);
      const plan = reclaimPlan(task);
      report.candidates.push({
        id,
        missionId,
        taskId,
        owner: lease.owner,
        ownerIsLane: lease.owner === taskId,
        status: task.status,
        carriesOps: plan.carriesOps,
        acquiredAt: lease.acquired_at,
        heartbeatAt: lease.heartbeat_at,
        expiresAt: lease.expires_at,
        expiredForMs,
        silentForMs: Number.isFinite(since) ? nowMs - since : expiredForMs,
        heartbeatSource: typeof task.heartbeat_source === 'string' ? task.heartbeat_source : null,
        action: plan.action,
        targetStatus: plan.targetStatus,
      });
    }
  }
  return report;
}

/**
 * Release ONE reported candidate, re-judged against a fresh read. Never throws.
 *
 * @param {object} store - StateStore.
 * @param {ReclaimCandidate} candidate
 * @param {number} nowMs
 * @returns {{ id: string, missionId: string, taskId: string, outcome: string }} `outcome` is `reclaimed:<status>` |
 *   `skipped:no-lease` | `skipped:not-expired` | `skipped:lease-changed` | `skipped:no-task` |
 *   `skipped:conflict` | `refused:<msg>` | `refused:threw:<msg>`.
 */
function applyOne(store, candidate, nowMs) {
  const { id, missionId, taskId } = candidate;
  const result = (outcome) => ({ id, missionId, taskId, outcome });
  try {
    const snapshot = store.getState();
    const lease = snapshot?.task_leases?.[missionId]?.[taskId] ?? null;
    if (!isPlainObject(lease)) return result('skipped:no-lease');
    // Expiry first: a holder that renewed is ALIVE, which is the more useful thing to say than "changed".
    if (!isLeaseExpired(lease, nowMs)) return result('skipped:not-expired');
    if (lease.owner !== candidate.owner) return result('skipped:lease-changed');
    const task = findTask(snapshot, missionId, taskId);
    if (task === null) return result('skipped:no-task');
    const { targetStatus } = reclaimPlan(task);
    const released = store.releaseTask({
      missionId,
      taskId,
      owner: lease.owner,
      token: lease.token,
      status: targetStatus,
      expectedVersion: snapshot.state_version,
      reason: LEASE_RECLAIM_REASON,
    });
    if (released?.ok === true) return result(`reclaimed:${targetStatus}`);
    if (released?.conflict === true) return result('skipped:conflict');
    return result(`refused:${released?.errors?.[0] ?? 'unknown'}`);
  } catch (err) {
    return result(`refused:threw:${err?.message ?? 'unknown'}`);
  }
}

/**
 * The answer for ONE listed id: release it if it is a candidate, else say why not.
 *
 * @param {object} store
 * @param {ReturnType<typeof findReclaimCandidates>} report
 * @param {string} id - A validated `<mission>/<task>` id.
 * @param {number} nowMs
 * @returns {{ id: string, missionId: string, taskId: string, outcome: string }} Also `skipped:protected` |
 *   `skipped:not-expired` | `skipped:malformed` | `skipped:not-a-candidate` (unknown id, non-lane lease, no lease).
 */
function releaseListed(store, report, id, nowMs) {
  const candidate = report.candidates.find((c) => c.id === id);
  if (candidate) return applyOne(store, candidate, nowMs);
  const at = id.indexOf('/');
  const skipped = (why) => ({ id, missionId: id.slice(0, at), taskId: id.slice(at + 1), outcome: `skipped:${why}` });
  if (report.protected.some((p) => p.id === id)) return skipped('protected');
  if (report.liveIds.includes(id)) return skipped('not-expired');
  if (report.malformed.some((m) => m.id === id)) return skipped('malformed');
  return skipped('not-a-candidate');
}

/**
 * @param {number} nowMs
 * @param {string} reason
 * @returns {object} The shape of a report with nothing in it, mode `refused`.
 */
function refusedReport(nowMs, reason) {
  const finite = typeof nowMs === 'number' && Number.isFinite(nowMs);
  return {
    mode: 'refused',
    applied: false,
    reason,
    nowMs: finite ? nowMs : null,
    at: finite ? isoOrNull(nowMs) : null,
    scanned: { missions: 0, leases: 0, laneLeases: 0 },
    live: 0,
    liveIds: [],
    protected: [],
    candidates: [],
    malformed: [],
    results: [],
  };
}

/**
 * Report the lapsed lane leases of a store — and release the LISTED ones only
 * when `apply` is the literal `true`.
 *
 * REPORT mode (the default) calls `store.getState()` and nothing else: no
 * write port is touched, so the version, the journal and the ledger are exactly
 * what they were, whether or not `ids` was passed. APPLY mode refuses — before
 * it reads the store — unless `ids` is a usable list ({@link parseReclaimIds});
 * then it re-reads, releases each listed id that is still a candidate (re-read
 * and re-judged once more, one commit per lease) and answers every listed id.
 * Nothing unlisted is ever touched.
 *
 * @param {object} [input]
 * @param {object} input.store - A StateStore (`getState`, and `releaseTask` in apply mode).
 * @param {number} input.nowMs - The clock (epoch ms).
 * @param {Iterable<string>|string[]} [input.keepAlive] - Lane ids never reclaimed (see the header).
 * @param {boolean} [input.apply=false] - Only the literal `true` applies.
 * @param {string[]} [input.ids] - `<mission>/<task>` ids to release; required, and only read, when `apply` is `true`.
 * @returns {ReturnType<typeof findReclaimCandidates> & { mode: 'report'|'apply'|'refused', applied: boolean, reason?: string, results: Array<{ id: string, missionId: string, taskId: string, outcome: string }> }}
 *   `applied` is true when at least one lease was released. `results` is empty in report and refused mode.
 */
export function reclaimExpiredLaneLeases({ store, nowMs, keepAlive = [], apply = false, ids } = {}) {
  if (apply !== true) {
    const report = findReclaimCandidates({ state: store.getState(), nowMs, keepAlive });
    return { mode: 'report', applied: false, ...report, results: [] };
  }
  const listed = parseReclaimIds(ids);
  if (!listed.ok) return refusedReport(nowMs, listed.error);
  const report = findReclaimCandidates({ state: store.getState(), nowMs, keepAlive });
  const results = listed.ids.map((id) => releaseListed(store, report, id, nowMs));
  return { mode: 'apply', applied: results.some((r) => r.outcome.startsWith('reclaimed:')), ...report, results };
}
