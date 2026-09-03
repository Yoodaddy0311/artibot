/**
 * StateStore — the live truth for missions, the Task Graph, leases and the
 * mission controller lock.
 *
 * ── The three-way split this module implements (design §1-2, :218) ─────────
 *   StateStore  = now      (this file; JSONL journal + derived snapshot)
 *   ledger.jsonl = history (append-only, written through an INJECTED port)
 *   state.yaml   = view    (a projection, regenerable, never read back as truth)
 *
 * ── Backend, and why it is not SQLite (OD-4 / decision F1) ─────────────────
 * A JSONL journal plus a derived snapshot, serialised by `withFileLock` and
 * guarded by a `state_version` compare-and-set. `node:sqlite` would force
 * `engines` from >=20 to >=22.13 for a store this small, so the SQLite option
 * is kept as an interface shape only. Everything here sits behind
 * `createStateStore`, so swapping the backend later changes this file and no
 * call site.
 *
 * ── Location (decision F3) ────────────────────────────────────────────────
 * `<git-common-dir>/artibot/`, because every linked worktree shares one
 * common dir — putting the store under a worktree's own `.artibot/` is the
 * measured failure the design rejects (each `/split` window would keep its
 * own divergent copy). Git is reached through an INJECTED port so tests run
 * against a tmpdir and this L2 module never shells out on its own. When the
 * port yields nothing the store falls back to `<projectRoot>/.artibot/runtime/`
 * and REPORTS the fallback with a reason — a silent fallback would put a
 * per-worktree store back exactly where the design says it must not be.
 *
 * ── Write ordering, and why the ledger goes first ──────────────────────────
 * One committed write is: CAS check -> validate the draft -> append
 * `state.updated{state_version}` to the ledger -> append journal records ->
 * rename the snapshot -> (outside the lock) re-render state.yaml.
 *
 * Ledger-first is what keeps the design's invariant `ledger ⊇ store` true
 * under a crash. Crash after the ledger append and the ledger names a version
 * the store never reached — detectable, and the superset invariant still
 * holds. Crash the other way round and the store holds a version with no
 * event, which is precisely the lost update `/doctor` Check 8 exists to find,
 * now invisible. `ledger-events.allowlist.json` states the same order:
 * "append FIRST and projection second".
 *
 * If the ledger port refuses the event, the store write is ABANDONED. A store
 * write with no paired event would silently break the 1:1 pairing the
 * firewall gate asserts.
 *
 * ── Concurrency: what protects a write, and what does not ─────────────────
 * `lib/core/file-lock.js` is advisory and deliberately fail-OPEN: on timeout
 * it proceeds without the lock. It is a contention optimisation, not a
 * correctness guarantee.
 *
 * The real guard is the `state_version` CAS — and it is **opt-in**. Read the
 * two cases as different contracts, because they are:
 *
 *   - **`expectedVersion` passed** — the version is re-read INSIDE the lock
 *     and compared. A lost race becomes a returned
 *     `{ok:false, conflict:true, currentVersion}` for the caller to retry.
 *     Nothing is overwritten.
 *   - **`expectedVersion` omitted** — no comparison happens, so the write is
 *     **last-writer-wins**: a concurrent update made between this call's read
 *     and its rename is overwritten. The result's `warnings[]` carries
 *     `'cas:skipped'` so the outcome is at least not silent.
 *
 * Opt-in is deliberate for Phase 0 (Observe): callers do not yet track a
 * version to pass, and a mandatory CAS would reject every first write. It is
 * a phase decision, not the end state — when callers carry versions, the
 * default should invert.
 *
 * ── The clock is judged, never trusted ────────────────────────────────────
 * Timestamps come from `lib/core/clock.js#readClock(ctx.now, 'state-manager')`,
 * not from `ctx.now().toISOString()`. An unguarded call lets a port that
 * returns epoch milliseconds, an ISO string, or an Invalid Date produce a `ts`
 * of `undefined` or `"Invalid Date"` — which is then written durably to every
 * journal record AND to the paired ledger event, and found much later. The
 * shared judge throws at the boundary instead, and its label names which
 * module was misconfigured.
 *
 * ── Layer ─────────────────────────────────────────────────────────────────
 * L2 (design §1-8). It must not import `lib/runtime/`, which is L5 — hence
 * `appendEvent` arriving as a port rather than as an import of the event
 * writer. Its only lib edges are `lib/core` (file IO, locking, clock) and
 * sibling L2 modules.
 *
 * @module lib/project-state/state-manager
 */

import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { readClock } from '../core/clock.js';
import { atomicWriteTextSync, ensureDirSync, readJsonFileSync } from '../core/file.js';
import { withFileLock } from '../core/file-lock.js';
import { createLease, isLeaseExpired, renewLease } from './lease.js';
import { applyRecord, readJournal, reduceProjectState } from './journal.js';
import { buildProjection, clone, renderProjection } from './projection.js';
import { reconcileStore } from './reconcile.js';
import { validateMissionId, validateSnapshot } from './validate.js';

/** Journal + snapshot live in this directory under the git common dir (F3). */
export const STORE_DIR_NAME = 'artibot';

/** Derived snapshot: a cache. Delete it and the journal rebuilds it. */
export const SNAPSHOT_FILE = 'project-state.json';

/** Append-only journal of store records. The store's own source of truth. */
export const JOURNAL_FILE = 'project-state.jsonl';

/** Projection path, relative to `projectRoot`. Untracked (T-08). */
export const PROJECTION_RELATIVE = path.join('.artibot', 'state.yaml');

/** Fallback store root when the git common dir cannot be resolved. */
export const FALLBACK_RELATIVE = path.join('.artibot', 'runtime');

/**
 * Warning added to a commit result when the caller passed no `expectedVersion`
 * and the write therefore ran without a compare-and-set (last-writer-wins).
 *
 * Exported so a caller can test for it without matching a string literal, and
 * so `/doctor` can count unguarded writes rather than assume there are none.
 */
export const CAS_SKIPPED_WARNING = 'cas:skipped';

/**
 * Resolve where the store lives.
 *
 * @param {object} params - Resolution inputs.
 * @param {string} params.projectRoot - Absolute project root.
 * @param {string|null} [params.gitCommonDir] - Result of the injected git port.
 * @returns {{dir: string, source: 'git-common-dir'|'project-root-fallback', reason: string|null}}
 *   The store directory, which rule produced it, and why the primary rule failed.
 * @example
 * resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: '.git' }).dir;
 * // '/repo/.git/artibot'  — a RELATIVE common dir is resolved against projectRoot
 */
export function resolveStoreLocation({ projectRoot, gitCommonDir }) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new TypeError('createStateStore: projectRoot must be a non-empty absolute path');
  }
  if (typeof gitCommonDir === 'string' && gitCommonDir !== '') {
    // Measured on git 2.54.0.windows.1 (2026-09-02): `git rev-parse
    // --git-common-dir` prints a RELATIVE '.git' in a main checkout and an
    // ABSOLUTE path to the main .git in a linked worktree. path.resolve
    // handles both; treating the output as always-absolute would have
    // produced a store at the process CWD in the common case.
    return {
      dir: path.resolve(projectRoot, gitCommonDir, STORE_DIR_NAME),
      source: 'git-common-dir',
      reason: null,
    };
  }
  return {
    dir: path.join(projectRoot, FALLBACK_RELATIVE),
    source: 'project-root-fallback',
    reason:
      'git common dir unresolved (not a repository, git missing, or the injected port returned nothing) — '
      + 'the store is per-worktree here, so two /split windows would keep divergent copies',
  };
}

// Re-exported so a consumer of the store needs one import, not three. The
// definitions live in journal.js because reconcile.js needs them too and a
// cycle through state-manager.js would be fragile at module-init time.
export {
  STORE_RECORD_KINDS, SNAPSHOT_SCHEMA_VERSION,
  emptySnapshot, readJournal, reduceProjectState,
} from './journal.js';

/**
 * @typedef {object} StateStoreOptions
 * @property {string} projectRoot - Absolute project root. Every writer takes it injected.
 * @property {(event: object) => unknown} appendEvent - Ledger port (L5, injected —
 *   an L2 module may not import `lib/runtime/`). Receives a partial envelope
 *   `{event, mission_id, session_id, source, data}` and owns `v`/`ts`/`pid`/`seq`.
 *   Treated as REFUSED when it throws, returns `{ok: false}` (what the real
 *   writer `lib/runtime/event-writer.js#writeEvent` returns), or returns
 *   `{appended: false}` (simpler in-process ports). Anything else, `undefined`
 *   included, counts as appended. `ledgerRefusal` below is the single judge —
 *   this line stating a NARROWER contract than that function is what let the
 *   `{ok: false}` case go unhandled, so keep the two in step.
 * @property {string} sessionId - Session id for the ledger envelope (required field).
 * @property {() => (string|null)} [resolveGitCommonDir] - Git port. Omitted means
 *   "unresolved", which selects the reported fallback.
 * @property {string} [project] - Project name; defaults to the basename of `projectRoot`.
 * @property {() => Date} [now] - Clock port.
 * @property {string} [source='supervisor'] - Ledger envelope `source`.
 * @property {boolean} [renderProjectionFile=true] - Write `.artibot/state.yaml` after commits.
 */

/**
 * Create a StateStore.
 *
 * @param {StateStoreOptions} options - Store options.
 * @returns {object} The store: `{location, paths, getState, getMission, updateMission,
 *   claimTask, releaseTask, heartbeatWorker, appendEvent, reconcile, renderProjection}`.
 * @example
 * const store = createStateStore({
 *   projectRoot, sessionId: 's1',
 *   appendEvent: (e) => ledger.append(e),
 *   resolveGitCommonDir: () => '.git',
 * });
 * store.updateMission('M-20260902-001', () => mission, { reason: 'seed' });
 */
export function createStateStore(options) {
  const {
    projectRoot, appendEvent, sessionId,
    resolveGitCommonDir, project, now = () => new Date(),
    source = 'supervisor', renderProjectionFile = true,
  } = options ?? {};

  if (typeof appendEvent !== 'function') {
    throw new TypeError('createStateStore: appendEvent port is required (L2 may not import the L5 writer)');
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('createStateStore: sessionId is required — ledger envelopes require session_id');
  }

  const gitCommonDir = typeof resolveGitCommonDir === 'function' ? safeResolveGitDir(resolveGitCommonDir) : null;
  const location = resolveStoreLocation({ projectRoot, gitCommonDir });
  const projectName = project ?? path.basename(projectRoot);
  const paths = {
    dir: location.dir,
    snapshot: path.join(location.dir, SNAPSHOT_FILE),
    journal: path.join(location.dir, JOURNAL_FILE),
    projection: path.join(projectRoot, PROJECTION_RELATIVE),
  };

  const ctx = { paths, location, projectName, appendEvent, sessionId, source, now, renderProjectionFile };
  return buildStoreApi(ctx);
}

/**
 * Call the git port without letting it take the store down.
 *
 * @param {() => (string|null)} port - Injected resolver.
 * @returns {string|null} The common dir, or null on any failure.
 */
function safeResolveGitDir(port) {
  try {
    const value = port();
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Load the snapshot, rebuilding from the journal when it is absent or stale.
 *
 * The journal wins whenever the two disagree: it is the append-only record
 * and the snapshot is an explicitly deletable cache.
 *
 * @param {object} ctx - Store context.
 * @returns {{snapshot: object, rebuilt: boolean, warnings: string[]}} Current state.
 */
function loadSnapshot(ctx) {
  const onDisk = readJsonFileSync(ctx.paths.snapshot, null);
  const { records, torn } = readJournal(ctx.paths.journal);
  const warnings = torn > 0 ? [`journal has ${torn} unparseable line(s) — skipped`] : [];

  const journalVersion = records.reduce(
    (max, r) => (Number.isInteger(r?.state_version) ? Math.max(max, r.state_version) : max), 0,
  );
  if (onDisk && Number.isInteger(onDisk.state_version) && onDisk.state_version >= journalVersion) {
    return { snapshot: onDisk, rebuilt: false, warnings };
  }
  const { state, warnings: foldWarnings } = reduceProjectState(records, { project: ctx.projectName });
  if (onDisk) {
    warnings.push(
      `snapshot at version ${onDisk.state_version} is behind the journal at ${journalVersion} — rebuilt from the journal`,
    );
  }
  state.project = onDisk?.project ?? ctx.projectName;
  return { snapshot: state, rebuilt: true, warnings: [...warnings, ...foldWarnings] };
}

/**
 * Run one committed write: CAS, validate, ledger, journal, snapshot, projection.
 *
 * @param {object} ctx - Store context.
 * @param {object} params - Commit parameters.
 * @param {string} params.missionId - Mission the write belongs to.
 * @param {string} params.reason - Why the write happened; lands in the ledger event.
 * @param {number} [params.expectedVersion] - CAS guard; omit to skip the check.
 * @param {(snapshot: object) => {records?: object[], errors?: string[]}} params.plan -
 *   Produces the records for this write from the CURRENT snapshot.
 * @returns {object} `{ok, state_version, records, warnings}` or a failure shape.
 */
function commit(ctx, { missionId, reason, expectedVersion, plan }) {
  ensureDirSync(ctx.paths.dir);
  const result = withFileLock(ctx.paths.snapshot, () => commitLocked(ctx, { missionId, reason, expectedVersion, plan }));
  if (result.ok && ctx.renderProjectionFile) writeProjection(ctx, result.snapshot);
  return result;
}

/**
 * The body of a commit, executed while holding the lock.
 *
 * @param {object} ctx - Store context.
 * @param {object} params - Same parameters as `commit`.
 * @returns {object} Commit result, including the committed snapshot on success.
 */
function commitLocked(ctx, { missionId, reason, expectedVersion, plan }) {
  const { snapshot, warnings: readWarnings } = loadSnapshot(ctx);
  if (expectedVersion !== undefined && expectedVersion !== snapshot.state_version) {
    return {
      ok: false, conflict: true, currentVersion: snapshot.state_version,
      expectedVersion, warnings: readWarnings,
      errors: [`CAS conflict: expected state_version ${expectedVersion}, store is at ${snapshot.state_version}`],
    };
  }
  // Past this point the write is unguarded when the caller passed no version.
  // Announcing it beats leaving it to be inferred from an absent argument: a
  // caller reading only `{ok:true}` cannot otherwise tell a CAS-checked write
  // from a last-writer-wins one.
  const warnings = expectedVersion === undefined
    ? [...readWarnings, CAS_SKIPPED_WARNING]
    : readWarnings;

  const planned = plan(snapshot);
  if (planned.errors?.length) return { ok: false, conflict: false, errors: planned.errors, warnings };
  const records = planned.records ?? [];
  if (records.length === 0) return { ok: true, unchanged: true, state_version: snapshot.state_version, warnings };

  const ts = readClock(ctx.now, 'state-manager');
  const nextVersion = snapshot.state_version + 1;
  const stamped = records.map((r) => ({ v: 1, ts, state_version: nextVersion, ...r }));

  const draft = clone(snapshot);
  const applyWarnings = [];
  for (const record of stamped) applyRecord(draft, record, applyWarnings);
  draft.state_version = nextVersion;
  draft.updated_at = ts;

  const errors = validateSnapshot(draft);
  if (errors.length > 0) return { ok: false, conflict: false, errors, warnings: [...warnings, ...applyWarnings] };

  const ledger = emitStateUpdated(ctx, { missionId, ts, nextVersion, draft, prior: snapshot, reason });
  if (!ledger.ok) return { ok: false, conflict: false, errors: ledger.errors, warnings };

  // Journal first, then the snapshot: the journal is the record, the snapshot
  // is its cache, and loadSnapshot prefers the journal when they disagree.
  appendFileSync(ctx.paths.journal, stamped.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  atomicWriteTextSync(ctx.paths.snapshot, JSON.stringify(draft, null, 2) + '\n');

  return {
    ok: true, state_version: nextVersion, records: stamped, snapshot: draft,
    warnings: [...warnings, ...applyWarnings],
  };
}

/**
 * Append the `state.updated` event that pairs 1:1 with this store write.
 *
 * @param {object} ctx - Store context.
 * @param {object} params - Event inputs.
 * @returns {{ok: boolean, errors?: string[]}} Whether the ledger accepted the event.
 */
function emitStateUpdated(ctx, { missionId, ts, nextVersion, draft, prior, reason }) {
  // A removed mission has left active_missions, so its status is read from
  // the pre-write snapshot. Defaulting to 'failed' would have logged an
  // archived, completed mission as a failure — the event would be a lie about
  // the very transition it records.
  const status = draft.active_missions[missionId]?.status
    ?? prior.active_missions[missionId]?.status
    ?? 'queued';
  const envelope = {
    event: 'state.updated',
    mission_id: missionId,
    session_id: ctx.sessionId,
    source: ctx.source,
    ts,
    data: { state_version: nextVersion, status, reason },
  };
  let outcome;
  try {
    outcome = ctx.appendEvent(envelope);
  } catch (err) {
    return {
      ok: false,
      errors: [`ledger port threw on state.updated{state_version:${nextVersion}}: ${err.message}`],
    };
  }
  const refusal = ledgerRefusal(outcome);
  if (refusal === null) return { ok: true };
  return {
    ok: false,
    errors: [
      `ledger refused state.updated{state_version:${nextVersion}}: ${refusal}`,
      'store write abandoned — a write with no paired event breaks lost-update detection',
    ],
  };
}

/**
 * Did the ledger port refuse the event?
 *
 * SAME RULE as `lib/topology/split-state.js#ledgerRefusal` (T-46), and it must
 * stay the same: two modules disagreeing about what "the ledger said no" means
 * is how one of them ends up committing unpaired writes.
 *
 * Both `{ok: false}` and `{appended: false}` count. `ok` is what the real
 * writer returns — `lib/runtime/event-writer.js#writeEvent` yields
 * `{ok: true, …}` on success and `{ok: false, reason}` on every failure, and
 * never emits an `appended` key at all (measured 2026-09-03). Checking only
 * `appended` therefore read EVERY writer failure as success and let the store
 * commit a write with no paired event — manufacturing the exact
 * `extraInStore` signature that `/doctor` Check 8 exists to detect, and
 * breaking the `ledger ⊇ store` invariant the ledger-first ordering is built
 * to preserve. `appended` is kept because simpler in-process ports use it.
 *
 * A non-object outcome (including `undefined`) is NOT a refusal: a port that
 * returns nothing is the common shape for "appended, nothing to report", and
 * treating silence as failure would fail every such write closed.
 *
 * @param {unknown} outcome - Whatever the injected port returned.
 * @returns {string|null} The stated reason when refused, else null.
 */
function ledgerRefusal(outcome) {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  if (outcome.appended !== false && outcome.ok !== false) return null;
  const stated = outcome.reason
    ?? (Array.isArray(outcome.errors) ? outcome.errors.join('; ') : null);
  return typeof stated === 'string' && stated ? stated : 'no reason given';
}

/**
 * Re-render the projection. Outside the lock, and never fatal.
 *
 * The projection is regenerable by definition, so a failed render must not
 * fail a committed store write — the store is already correct, and the next
 * commit re-renders.
 *
 * @param {object} ctx - Store context.
 * @param {object} snapshot - The committed snapshot.
 * @returns {{written: boolean, error?: string}} Render outcome.
 */
function writeProjection(ctx, snapshot) {
  try {
    ensureDirSync(path.dirname(ctx.paths.projection));
    atomicWriteTextSync(ctx.paths.projection, renderProjection(snapshot));
    return { written: true };
  } catch (err) {
    return { written: false, error: err.message };
  }
}

/**
 * Assemble the public store API.
 *
 * @param {object} ctx - Store context.
 * @returns {object} The StateStore.
 */
function buildStoreApi(ctx) {
  const readState = () => loadSnapshot(ctx).snapshot;

  return {
    location: { ...ctx.location },
    paths: ctx.paths,
    getState: () => clone(readState()),
    getProjection: () => buildProjection(readState()),
    getMission: (missionId) => clone(readState().active_missions[missionId] ?? null),
    getTaskGraph: (missionId) => clone(readState().task_graphs[missionId] ?? null),
    getLease: (missionId, taskId) => clone(readState().task_leases[missionId]?.[taskId] ?? null),
    updateMission: (missionId, mutator, opts) => updateMission(ctx, missionId, mutator, opts),
    claimTask: (params) => claimTask(ctx, params),
    releaseTask: (params) => releaseTask(ctx, params),
    heartbeatWorker: (params) => heartbeatWorker(ctx, params),
    appendEvent: (event) => ctx.appendEvent(event),
    reconcile: (opts) => reconcileStore(ctx, opts),
    renderProjection: () => renderProjection(readState()),
    writeProjection: () => writeProjection(ctx, readState()),
  };
}

/**
 * Create or replace a mission, and optionally its Task Graph.
 *
 * @param {object} ctx - Store context.
 * @param {string} missionId - Mission id.
 * @param {(mission: object|null) => object|null} mutator - Receives a clone of the
 *   current mission (or null) and returns the next one; returning null removes it.
 * @param {object} [opts] - Write options.
 * @param {number} [opts.expectedVersion] - CAS guard.
 * @param {string} [opts.reason='mission.update'] - Ledger reason.
 * @param {object} [opts.graph] - Full Task Graph to write alongside the mission.
 * @param {object} [opts.meta] - Human-authored fields for `project_meta` (D14).
 * @returns {object} Commit result.
 */
function updateMission(ctx, missionId, mutator, opts = {}) {
  const idErrors = validateMissionId(missionId);
  if (idErrors.length > 0) return { ok: false, conflict: false, errors: idErrors, warnings: [] };

  return commit(ctx, {
    missionId,
    reason: opts.reason ?? 'mission.update',
    expectedVersion: opts.expectedVersion,
    plan: (snapshot) => {
      const current = snapshot.active_missions[missionId] ?? null;
      const next = mutator(current ? clone(current) : null);
      if (next === null) return { records: [{ kind: 'mission.remove', mission_id: missionId }] };
      const records = [{ kind: 'mission.upsert', mission_id: missionId, mission: next }];
      if (opts.graph !== undefined) {
        records.push({ kind: 'graph.upsert', mission_id: missionId, graph: opts.graph });
      } else if (!snapshot.task_graphs[missionId]) {
        records.push({
          kind: 'graph.upsert',
          mission_id: missionId,
          graph: { schema_version: 1, mission_id: missionId, tasks: [] },
        });
      }
      if (opts.meta !== undefined) {
        records.push({ kind: 'meta.upsert', mission_id: missionId, meta: opts.meta });
      }
      return { records };
    },
  });
}

/**
 * Claim a task for a worker, taking a lease.
 *
 * A claim on a task already held by a live lease is REFUSED. A claim on a
 * task whose lease has expired succeeds and reports `reclaimed: true` —
 * expiry is judged from `expires_at` against the injected clock, never read
 * from a stored boolean (`lease.schema.json`).
 *
 * @param {object} ctx - Store context.
 * @param {object} params - Claim parameters.
 * @returns {object} Commit result, with `lease` and `reclaimed` on success.
 */
function claimTask(ctx, { missionId, taskId, owner, ttlMs, expectedVersion, reason, token }) {
  let outcome = {};
  const result = commit(ctx, {
    missionId,
    reason: reason ?? `task.claim:${taskId}`,
    expectedVersion,
    plan: (snapshot) => {
      const task = findTask(snapshot, missionId, taskId);
      if (!task) return { errors: [`claimTask: no task '${taskId}' in mission ${missionId}`] };
      const held = snapshot.task_leases[missionId]?.[taskId] ?? null;
      if (held && !isLeaseExpired(held, ctx.now())) {
        return {
          errors: [
            `claimTask: '${taskId}' is held by '${held.owner}' until ${held.expires_at} — not expired at ${ctx.now().toISOString()}`,
          ],
        };
      }
      const lease = createLease({ owner, now: ctx.now(), ttlMs, token, sessionId: ctx.sessionId });
      outcome = { lease, reclaimed: Boolean(held) };
      return {
        records: [
          { kind: 'task.upsert', mission_id: missionId, task: { ...clone(task), owner, status: 'claimed' } },
          { kind: 'lease.set', mission_id: missionId, task_id: taskId, lease },
        ],
      };
    },
  });
  return result.ok ? { ...result, ...outcome } : result;
}

/**
 * Release a task, dropping its lease and setting a terminal-or-queued status.
 *
 * The release is guarded by `token` when the lease carries one, mirroring
 * `landing-lock.js#release`: an evicted holder's late release must not remove
 * a lease someone else has since reclaimed.
 *
 * @param {object} ctx - Store context.
 * @param {object} params - Release parameters.
 * @returns {object} Commit result.
 */
function releaseTask(ctx, { missionId, taskId, owner, token, status = 'queued', expectedVersion, reason }) {
  return commit(ctx, {
    missionId,
    reason: reason ?? `task.release:${taskId}`,
    expectedVersion,
    plan: (snapshot) => {
      const task = findTask(snapshot, missionId, taskId);
      if (!task) return { errors: [`releaseTask: no task '${taskId}' in mission ${missionId}`] };
      const held = snapshot.task_leases[missionId]?.[taskId] ?? null;
      if (held?.token && held.token !== token) {
        return { errors: [`releaseTask: token mismatch on '${taskId}' — the lease was reclaimed by '${held.owner}'`] };
      }
      if (held && owner !== undefined && held.owner !== owner) {
        return { errors: [`releaseTask: '${taskId}' is held by '${held.owner}', not '${owner}'`] };
      }
      const next = { ...clone(task), status };
      // The 8-state vocabulary requires an owner for claimed/executing/reviewing
      // and permits none otherwise; dropping it here keeps the graph valid.
      if (!['claimed', 'executing', 'reviewing'].includes(status)) next.owner = null;
      return {
        records: [
          { kind: 'task.upsert', mission_id: missionId, task: next },
          { kind: 'lease.clear', mission_id: missionId, task_id: taskId },
        ],
      };
    },
  });
}

/**
 * Renew a worker's lease and stamp its derived heartbeat.
 *
 * `heartbeat_source` is written next to `heartbeat_at` because the value is
 * DERIVED, not emitted: design §3.5 records that no heartbeat emitter exists,
 * and design §3.5 requires the source to travel with the derived instant so a
 * reader can tell the two apart.
 *
 * @param {object} ctx - Store context.
 * @param {object} params - Heartbeat parameters.
 * @returns {object} Commit result.
 */
function heartbeatWorker(ctx, { missionId, taskId, owner, heartbeatSource = 'lane-heartbeat', expectedVersion, reason }) {
  return commit(ctx, {
    missionId,
    reason: reason ?? `worker.heartbeat:${taskId}`,
    expectedVersion,
    plan: (snapshot) => {
      const task = findTask(snapshot, missionId, taskId);
      if (!task) return { errors: [`heartbeatWorker: no task '${taskId}' in mission ${missionId}`] };
      const held = snapshot.task_leases[missionId]?.[taskId] ?? null;
      if (!held) return { errors: [`heartbeatWorker: '${taskId}' holds no lease to renew`] };
      if (owner !== undefined && held.owner !== owner) {
        return { errors: [`heartbeatWorker: '${taskId}' is held by '${held.owner}', not '${owner}'`] };
      }
      const at = ctx.now();
      return {
        records: [
          {
            kind: 'task.upsert',
            mission_id: missionId,
            task: { ...clone(task), heartbeat_at: at.toISOString(), heartbeat_source: heartbeatSource },
          },
          {
            kind: 'lease.set',
            mission_id: missionId,
            task_id: taskId,
            lease: renewLease(held, { now: at }),
          },
        ],
      };
    },
  });
}

/**
 * Find a task node in a snapshot.
 *
 * @param {object} snapshot - Store snapshot.
 * @param {string} missionId - Mission id.
 * @param {string} taskId - Task id.
 * @returns {object|null} The task, or null.
 */
function findTask(snapshot, missionId, taskId) {
  return snapshot.task_graphs[missionId]?.tasks.find((t) => t.id === taskId) ?? null;
}
