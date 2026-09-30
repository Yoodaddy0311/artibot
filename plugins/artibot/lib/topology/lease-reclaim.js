/**
 * Lane-lease lifecycle arithmetic — the clock half of SH-12 and the reclaim
 * half of CA-09, for the Task Graph LANE lease (a `/split` limb's entry in
 * `task_leases`; owner decision 2026-09-30: the lane lease, not the mission
 * controller lease).
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * `scripts/split/task-feed.mjs#feedLimb` claims a limb's task at dispatch with
 * a 24h TTL. Measured by reading the callers (2026-09-30, repo-wide grep for
 * `heartbeatWorker`): only `lane-lease.mjs#syncLaneLease` (reached from
 * `lane-state.mjs#main`) and `task-feed.mjs#claimLimb` (a re-dispatch) renew
 * it — both at a moment the leader declares, neither on a clock. And nothing
 * looks at a lease that lapsed: `state-manager.js#claimTask` can take an
 * expired lease, but only when a claimer turns up, and `claimLimb` never
 * reaches that branch (it answers `held-by` first). A dead lane therefore held
 * its lease until a human noticed.
 *
 * ── Two functions, one TTL ─────────────────────────────────────────────────
 * - {@link heartbeatCadence} answers "is this lease due a heartbeat?" — once a
 *   third of the lease's own granted span has passed since its last beat
 *   (ttl/3, so two missed polls still leave the lease alive).
 * - {@link findReclaimCandidates} / {@link reclaimExpiredLaneLeases} answer
 *   "which lane leases lapsed and nobody is keeping alive?".
 * They share the span arithmetic and the expiry judgement, which is why they
 * live in one module: the cadence that keeps a lease alive and the rule that
 * calls it dead must agree on what "granted TTL" and "expired" mean.
 *
 * ── REPORT-ONLY unless `apply` is the literal `true` ───────────────────────
 * The canon (`ARTIBOT-5.0-DESIGN.md` §9 row: "GA 전엔 reclaim 은 사람 확인")
 * keeps a human in front of every reclaim until GA. So {@link
 * reclaimExpiredLaneLeases} only ever calls `store.getState()` unless
 * `apply === true` — `'true'`, `1` and every other truthy look-alike stay
 * report-only (the same stance as the SH-11 canary key: only a literal `true`
 * is on). There is NO config key here and this module reads no config: L4
 * receives the answer as an option, and a config key is the leader's later
 * decision.
 *
 * ── What `apply` does, and what it refuses to ──────────────────────────────
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
 * The caller (the `watch` poll) passes `keepAlive`: the lane ids it is keeping
 * alive by heartbeat. A lapsed lease on such a lane is reported as
 * `protected`, not as a candidate — a lane the leader declares working, whose
 * session is not known dead, must not be reclaimed out from under it. A lane
 * whose session IS known dead, or that finished, is not kept alive, so its
 * lease lapses into the report.
 *
 * ── What it cannot see (rules §9, written next to the code) ────────────────
 * It judges leases by clock, not liveness: a worker that is alive but whose
 * lane is undeclared reads the same as a dead one. It identifies a lane by the
 * feeder's own marker ({@link LANE_TASK_TITLE_PREFIX}) or by `ops`; a feeder
 * that changes both silences the report (pinned by the drift test against
 * `mergeLimbTasks`). It scans every mission in the store, not one run — a stale
 * lane lease of an older run is exactly what it is for — but `keepAlive` is
 * matched by lane id alone, so an older run's stale lease on a limb name the
 * current run is working stays protected until that lane ends (it errs toward
 * keeping). A lane parked as `suspended` holds a lease nobody renews
 * (`LANE_LEASE_ACTIONS`: nothing to say to the lease), so it lapses into the
 * report after the TTL like any other. And every `store.getState()` re-parses
 * the whole journal, which the tests exercise on a handful of records only.
 *
 * ── Layer ──────────────────────────────────────────────────────────────────
 * L4 (`lib/topology/`, ceiling L2): pure except for the store passed in, reads
 * no file and no config, imports only `lib/project-state/` siblings.
 *
 * @module lib/topology/lease-reclaim
 */

import { isLeaseExpired } from '../project-state/lease.js';
import { OWNED_TASK_STATUSES } from '../project-state/validate.js';

/** A lease is due a heartbeat once this fraction of its granted span has passed: ttl / 3. */
export const HEARTBEAT_INTERVAL_DIVISOR = 3;

/**
 * The title `split-task-feed.js#seedTask` gives every limb node (`/split limb
 * <id>`). The one marker a LEGACY (unbound) lane node carries; a drift test
 * pins it against the real feeder.
 */
export const LANE_TASK_TITLE_PREFIX = '/split limb ';

/** Journal/ledger `reason` of the release a reclaim makes (the event is the store's own `state.updated`). */
export const LEASE_RECLAIM_REASON = 'split.lease-reclaim';

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
 * @property {number} [intervalMs] - `ttlMs / divisor`.
 * @property {number} [ageMs] - `nowMs` minus the last heartbeat (acquisition when there is none); negative under clock skew.
 * @property {boolean} [expired] - True when `nowMs` is strictly after `expires_at`.
 */

/**
 * Is this lease due a heartbeat at `nowMs`? Pure and total.
 *
 * Due once `ageMs >= ttlMs / divisor`, where the age runs from the LAST
 * heartbeat and the TTL is the span the lease was granted — so a 24h lease is
 * due at 8h, and is due again 8h after each renewal, never sooner. A lease that
 * has already lapsed is due too (the caller decides whether a lapsed lease on a
 * lane still declared working is renewed back; `expired` says it lapsed).
 *
 * @param {unknown} lease - A `lease.schema.json` record, or null.
 * @param {number} nowMs - The caller's clock (epoch ms).
 * @param {{ divisor?: number }} [opts] - `divisor` >= 1; anything else falls back to {@link HEARTBEAT_INTERVAL_DIVISOR}.
 * @returns {HeartbeatVerdict}
 * @example
 * heartbeatCadence(lease, Date.parse(lease.acquired_at) + 8 * 3600_000).due; // true for a 24h lease
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
  const intervalMs = ttlMs / divisor;
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
 * @returns {{ nowMs: number, at: string|null, scanned: { missions: number, leases: number, laneLeases: number }, live: number, protected: Array<{ missionId: string, taskId: string, owner: string, expiredForMs: number }>, candidates: ReclaimCandidate[], malformed: Array<{ missionId: string, taskId: string, reason: string }> }}
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
      report.scanned.leases += 1;
      const lease = leases[taskId];
      const task = findTask(state, missionId, taskId);
      if (task === null) {
        report.malformed.push({ missionId, taskId, reason: isPlainObject(lease) ? 'no-task-node' : 'not-an-object' });
        continue;
      }
      if (!isLaneTask(task)) continue;
      report.scanned.laneLeases += 1;
      if (!isPlainObject(lease)) {
        report.malformed.push({ missionId, taskId, reason: 'not-an-object' });
        continue;
      }
      const expiresMs = toMs(lease.expires_at);
      if (!Number.isFinite(expiresMs)) {
        report.malformed.push({ missionId, taskId, reason: 'bad-expires_at' });
        continue;
      }
      if (!isLeaseExpired(lease, nowMs)) {
        report.live += 1;
        continue;
      }
      const expiredForMs = nowMs - expiresMs;
      if (keep.has(taskId)) {
        report.protected.push({ missionId, taskId, owner: lease.owner, expiredForMs });
        continue;
      }
      const beat = toMs(lease.heartbeat_at);
      const since = Number.isFinite(beat) ? beat : toMs(lease.acquired_at);
      const plan = reclaimPlan(task);
      report.candidates.push({
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
 * @returns {{ missionId: string, taskId: string, outcome: string }} `outcome` is `reclaimed:<status>` |
 *   `skipped:no-lease` | `skipped:not-expired` | `skipped:lease-changed` | `skipped:no-task` |
 *   `skipped:conflict` | `refused:<msg>` | `refused:threw:<msg>`.
 */
function applyOne(store, candidate, nowMs) {
  const { missionId, taskId } = candidate;
  const result = (outcome) => ({ missionId, taskId, outcome });
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
 * Report the lapsed lane leases of a store — and release them only when `apply`
 * is the literal `true`.
 *
 * REPORT mode (the default) calls `store.getState()` and nothing else: no
 * write port is touched, so the version, the journal and the ledger are exactly
 * what they were. APPLY mode re-reads and re-judges each candidate before
 * releasing it (see {@link findReclaimCandidates} and the module header), one
 * commit per lease.
 *
 * @param {object} [input]
 * @param {object} input.store - A StateStore (`getState`, and `releaseTask` in apply mode).
 * @param {number} input.nowMs - The clock (epoch ms).
 * @param {Iterable<string>|string[]} [input.keepAlive] - Lane ids never reclaimed (see the header).
 * @param {boolean} [input.apply=false] - Only the literal `true` applies.
 * @returns {ReturnType<typeof findReclaimCandidates> & { mode: 'report'|'apply', applied: boolean, results: Array<{ missionId: string, taskId: string, outcome: string }> }}
 *   `applied` is true when at least one lease was released. `results` is empty in report mode.
 */
export function reclaimExpiredLaneLeases({ store, nowMs, keepAlive = [], apply = false } = {}) {
  const report = findReclaimCandidates({ state: store.getState(), nowMs, keepAlive });
  if (apply !== true) return { mode: 'report', applied: false, ...report, results: [] };
  const results = report.candidates.map((candidate) => applyOne(store, candidate, nowMs));
  return { mode: 'apply', applied: results.some((r) => r.outcome.startsWith('reclaimed:')), ...report, results };
}
