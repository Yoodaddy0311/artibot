#!/usr/bin/env node
/**
 * Feed the dispatched `/split` limb into the Structured Task Graph (OB-12 / OB-15).
 *
 * `schemas/task-graph.schema.json` has named `/split plan.json` limbs as a
 * feeder since it was written, and `state-manager.js` has carried
 * `claimTask` / `releaseTask` / `heartbeatWorker` just as long. Measured
 * 2026-09-21 against the live store, NEITHER half had a caller: 0 `task.upsert`
 * and 0 `lease.set` records in `project-state.jsonl`, 0 `worker/task` events in
 * the ledger, and `file_ownership` present nowhere. This module is the first
 * production caller of both, and it is bound to exactly ONE moment — the
 * dispatch that hands a limb to a window.
 *
 * ── RECORD-ONLY, FAIL-OPEN, in full ──────────────────────────────────────
 * `feedLimb` NEVER throws and never alters what `dispatch` does. Every failure
 * — no session id, no mission row, a store constructor TypeError, a refused
 * ledger port, a CAS conflict — becomes a `skipped:<reason>` string in the
 * dispatch result. Nothing here may change an exit code, a written file or an
 * existing output key. The write side of `/split` (run.json, plan.json,
 * brief/prompt materialisation) does not consult this module's answer.
 *
 * ── Why a mission row is a PRECONDITION, never a side effect ─────────────
 * `state-manager.js#updateMission` creates the row when the mutator returns
 * one, but a store row whose mission has no `mission.created` ledger event is
 * an ORPHAN by `/doctor` Check 8-③'s own definition. The `mission.created`
 * append belongs to the UserPromptSubmit pipeline
 * (`lib/runtime/middleware/tasks.js`), not here, so this module reads the
 * mission and skips when there is none. Measured 2026-09-21: `mission.created`
 * 35 vs store writes 32 on the live ledger — "an event exists, therefore a row
 * exists" is FALSE, which is why the row is re-checked rather than assumed.
 *
 * ── Which mission ────────────────────────────────────────────────────────
 * A run that carries a binding (`plan.json.missionBinding`, SH-11) uses the
 * mission the binding names, whichever session dispatches — that is the whole
 * point of the record: the per-session join seeded ONE run into two leader
 * missions (measured 2026-09-28, 23 + 25 tasks with contradictory states) and
 * fails outright when a session tail matches two dated missions. A binding
 * that cannot be honoured (the mission is gone, the record is damaged) is a
 * REJECTION — never a quiet fall back to the session.
 *
 * A run with NO binding is the legacy case and is unchanged: the mission the
 * DISPATCHING session owns, by the `-S<sid8>` tail that
 * `post-compact-rehydrate.js#selectMissionForSession` already resolves
 * fail-closed (two candidates -> neither). That function is imported, not
 * re-derived: a second suffix rule would let the hook and this script disagree
 * about who owns a mission. Observed 2026-09-21: a mission row appears only
 * for sessions that passed UserPromptSubmit, so a `/split` WINDOW generally has
 * none — the leader session running `dispatch` is the one that does.
 *
 * {@link selectLegacyMission} is the ONE call site of that selector in the
 * split tooling, and `tests/firewall/split-state-binding.test.js` pins it: the
 * canonical (binding) code paths import it 0 times.
 *
 * ── Binding, and what a bound feed does differently ──────────────────────
 * `bind: true` (`dispatch` passes it, and only with the canary key on — see
 * below) lets the FIRST feed of a run write the
 * binding — to the mission the legacy rule just found, and only when that mission
 * exists (the row is a precondition, never a side effect). From then on the run
 * is bound. A bound feed differs from a legacy one in three ways, all stated
 * because each is a decision:
 *  - it backfills `ops` on the run's nodes from `run.json.lanes` (once), so the
 *    node can be the canonical "now" (`lib/topology/split-state-sources.js#attachRunOps`);
 *  - it does NOT claim: `claimTask` sets `status: claimed` over the node's own
 *    ops state, and the node is now the record of who holds the limb;
 *  - it leaves a limb another run owns in that mission alone (I2) and refuses
 *    to dispatch it (`task-run-mismatch`).
 *
 * ── The canary switch ────────────────────────────────────────────────────
 * Binding a run and making the StateStore its canonical lane state is a
 * BEHAVIOUR change, so it ships behind ONE key: `artibot.config.json#
 * split.missionBinding.enabled`, shipped `false` (design canon: SH-11 is
 * Shadow, "split integration" is Canary, one config key back).
 * {@link missionBindingEnabled} reads it — only a literal `true` is on. OFF
 * means two things: `bind: true` binds nothing, and a run that ALREADY carries
 * a record is fed by the legacy rule as if it did not. Such a result carries
 * `binding: { status: 'disabled' }`, so the off period is visible in the
 * output instead of silent. `lib/topology` is L4 and never reads config, so
 * the key reaches it as the `honorBinding` port of {@link resolveRunMission}.
 *
 * @module scripts/split/task-feed
 */

import path from 'node:path';
import { readJsonFileSync } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { readRunJson } from '../../lib/git/split-run-file.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { bindRunToMission, readMissionBinding } from '../../lib/topology/split-state.js';
import {
  attachRunOps,
  BINDING_DISABLED,
  foreignRunLimbs,
  honorsBinding,
  missionEnvFromBinding,
  ownsFromPlan,
  readMissionBindingEnabled,
} from '../../lib/topology/split-state-sources.js';
import { LIMB_LEASE_TTL_MS, mergeLimbTasks } from '../../lib/topology/split-task-feed.js';
import { TERMINAL_TASK_STATUSES } from '../../lib/project-state/validate.js';
import { selectMissionForSession } from '../hooks/post-compact-rehydrate.js';

/** Ledger/journal `reason` for the graph write this module makes. */
export const FEED_REASON = 'split.task-feed';

/**
 * The shipped `artibot.config.json`, read synchronously — the same file
 * `loadConfig()` reads (`<pluginRoot>/artibot.config.json`; `lib/core/config.js`
 * merges it over defaults that carry no `split` key, so for the canary key the
 * two agree). Synchronous because `lane-state` / `lane-lease` are synchronous
 * writers. Anything that goes wrong — no file, malformed JSON, an unresolvable
 * plugin root — is `null`, and `null` means the key is OFF.
 *
 * @returns {object|null}
 */
export function readShippedConfigSync() {
  try {
    return readJsonFileSync(path.join(getPluginRoot(), 'artibot.config.json'), null);
  } catch {
    return null;
  }
}

/**
 * Whether the SH-11 canary key (`split.missionBinding.enabled`) is on. The one
 * reader the split tooling shares; only a literal `true` counts.
 *
 * `ports.config` wins when it is given at all — `null` there means "no config"
 * and is OFF, it never falls through to the file (a test that injects `null`
 * must not be handed the host's real configuration). Only an ABSENT `config`
 * reads the shipped file.
 *
 * @param {{ config?: object|null }} [ports]
 * @returns {boolean}
 */
export function missionBindingEnabled(ports = {}) {
  const config = ports?.config === undefined ? readShippedConfigSync() : ports.config;
  return readMissionBindingEnabled(config);
}

/**
 * The session id, from the host env.
 *
 * `CLAUDE_CODE_SESSION_ID` is what the host actually sets; `CLAUDE_SESSION_ID`
 * is read as a fallback because the docs used that spelling and a script that
 * trusted it alone measured an empty string (Wave 16, 2026-09-21). An empty or
 * absent value is reported as absent rather than defaulted — a fabricated id
 * would bind the graph to a session that never ran.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment.
 * @returns {string|null} The session id, or null.
 */
export function sessionIdFromEnv(env = process.env) {
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const v = env?.[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

/**
 * Open the StateStore this module writes through.
 *
 * `resolveGitCommonDir` is bound DELIBERATELY: without it `resolveStoreLocation`
 * takes the reported per-worktree fallback and `/split` would grow a second,
 * divergent store next to the one every other writer uses.
 *
 * @param {string} projectRoot - Parent (main checkout) root.
 * @param {string} sessionId - Dispatching session id.
 * @returns {object} A StateStore.
 */
export function openFeedStore(projectRoot, sessionId) {
  return createStateStore({
    projectRoot,
    sessionId,
    source: 'supervisor',
    // The projection is `/split`'s own `state.yaml` surface and is owned by
    // `lib/topology/split-state.js`; re-rendering it from here would put two
    // writers on one file for a bookkeeping write.
    renderProjectionFile: false,
    appendEvent: (envelope) => appendLedgerEvent(projectRoot, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(projectRoot),
  });
}

/**
 * The legacy, per-SESSION mission rule: the one mission this session owns by
 * its `-S<sid8>` tail (two candidates -> none). Kept as a named function so it
 * has exactly ONE call site of `selectMissionForSession` in the split tooling
 * — `tests/firewall/split-state-binding.test.js` pins that, and pins that no
 * canonical (binding) path imports the selector at all.
 *
 * @param {object} state - A StateStore snapshot.
 * @param {string} sessionId - The dispatching session id.
 * @returns {{ missionId: string|null, basedOn?: object }} The selector's own answer.
 */
export function selectLegacyMission(state, sessionId) {
  return selectMissionForSession(state, sessionId);
}

/**
 * Which mission a run's Task Graph writes go to.
 *
 *  - `bound`    the run carries a binding and its mission is in the store
 *  - `legacy`   the run carries none: the per-session rule, unchanged. Also the
 *               answer for a run that DOES carry a record while the canary
 *               switch is off — then the result adds `binding: {status:'disabled'}`
 *               and the record is neither judged nor deleted
 *  - `rejected` the run carries a binding this call cannot honour (damaged, or
 *               its mission is gone): the caller must NOT fall back to the
 *               session, which is exactly the join this replaces
 *
 * `honorBinding` is the canary switch as a port (`true`, or a function
 * returning `true`; anything else — absent included — is OFF, see
 * `split-state-sources.js#honorsBinding`). It is asked only when the run
 * carries a record, so a legacy run never reaches the config.
 *
 * Reads plan.json / run.json (through `readMissionBinding`), so a corrupt
 * file throws — callers are record-only and turn that into a skip.
 *
 * @param {{ parentRoot: string, state: object, sessionId: unknown, honorBinding?: boolean|(() => boolean) }} p
 * @returns {{ mode: 'bound', missionId: string, binding: Readonly<object> } | { mode: 'legacy', missionId: string|null, binding?: Readonly<{status: 'disabled'}> } | { mode: 'rejected', reason: string, missionId: string|null }}
 */
export function resolveRunMission({ parentRoot, state, sessionId, honorBinding }) {
  const probe = readMissionBinding({ runDir: path.join(parentRoot, '.artibot', 'split') });
  if (probe.status === 'none') return { mode: 'legacy', missionId: selectLegacyMission(state, sessionId).missionId ?? null };
  if (!honorsBinding(honorBinding)) return { mode: 'legacy', missionId: selectLegacyMission(state, sessionId).missionId ?? null, binding: BINDING_DISABLED };
  if (probe.status === 'invalid') return { mode: 'rejected', reason: probe.reason, missionId: null };
  const missionId = probe.binding.mission_id;
  if (!state?.active_missions?.[missionId]) return { mode: 'rejected', reason: 'binding-dangling', missionId };
  return { mode: 'bound', missionId, binding: probe.binding };
}

/** @param {string} reason @returns {object} The skip result shape. */
function skipped(reason) {
  return { fed: false, skipped: reason, missionId: null, taskId: null, added: [], refreshed: [], claim: null };
}

/**
 * Merge the plan into the snapshot's graph and write it, with ONE CAS retry.
 *
 * The graph is merged from `state` and the CAS is guarded by THAT snapshot's
 * `state_version`, so a commit landing between the read and the write is a
 * conflict. On a conflict the snapshot is re-read and the merge re-run before
 * the retry — the graph is passed whole as `opts.graph`, not computed inside
 * the lock, so retrying with a fresh version alone would rewrite the stale
 * graph over the intervening commit (a concurrent limb's claim, measured).
 *
 * One retry and not a loop, matching `lib/runtime/middleware/tasks.js`: a
 * second conflict means sustained contention, and spinning on a lock would
 * delay the dispatch the leader is waiting on.
 *
 * The mutator is `(cur) => cur` — PRESERVING. `updateMission` writes whatever
 * the mutator returns, so composing a title or an intent here would overwrite
 * the dispatching session's own mission with this script's idea of it.
 * That same mutator is why the mission is re-checked after the re-read: on a
 * row removed in between it returns null, and `updateMission` writes null as
 * a `mission.remove` — a feed write that deletes instead of seeding.
 *
 * @param {object} store - StateStore.
 * @param {object} state - The snapshot the mission was selected from.
 * @param {string} missionId - Mission id.
 * @param {object|null} plan - Parsed `plan.json`.
 * @param {string} limb - The dispatched limb.
 * @returns {{merged: object|null, commit: object|null}} The last merge, and its commit
 *   result (null when nothing was written: an unchanged merge, or no `limb` task).
 *   `merged` is null when the mission was gone at the re-read.
 */
function mergeAndWrite(store, state, missionId, plan, limb) {
  let snapshot = state;
  for (let attempt = 0; ; attempt += 1) {
    if (!snapshot.active_missions?.[missionId]) return { merged: null, commit: null };
    const graph = snapshot.task_graphs?.[missionId] ?? null;
    const merged = mergeLimbTasks({ graph, plan, missionId, now: new Date() });
    // A limb absent from the merge is skipped by the caller; seed nothing for it.
    if (merged.unchanged || !merged.graph.tasks.some((t) => t.id === limb)) return { merged, commit: null };
    const commit = store.updateMission(missionId, (cur) => cur, {
      reason: FEED_REASON, graph: merged.graph, expectedVersion: snapshot.state_version,
    });
    if (commit.conflict !== true || attempt >= 1) return { merged, commit };
    snapshot = store.getState();
  }
}

/**
 * Claim the limb's task, or renew the claim this same limb already holds.
 *
 * A lease held by SOMEONE ELSE is reported, never broken — whether or not it
 * has expired, since `getLease` does not judge expiry and reclaiming is CA-09's
 * decision, which the design puts behind a Canary. A lease held by this limb
 * is a re-dispatch of a window that is still working, so the heartbeat is
 * renewed instead.
 *
 * A task that already reached a TERMINAL status is left alone. `releaseTask`
 * clears the lease when a limb finishes, so without this guard a second
 * dispatch of a landed limb would find no lease, claim it, and walk `done`
 * back to `claimed` — measured, and exactly the regression the merge is
 * written to prevent. `failed` is NOT terminal here (`TERMINAL_TASK_STATUSES`):
 * re-dispatching a failed limb IS the retry.
 *
 * @param {object} store - StateStore.
 * @param {string} missionId - Mission id.
 * @param {string} limb - Task id and owner.
 * @param {object|undefined} task - The merged task node for `limb`.
 * @returns {string} One of `claimed` | `reclaimed` | `renewed` | `terminal:<status>` |
 *   `held-by:<owner>` | `refused:<msg>`.
 */
function claimLimb(store, missionId, limb, task) {
  if (TERMINAL_TASK_STATUSES.includes(task?.status)) return `terminal:${task.status}`;
  const held = store.getLease(missionId, limb);
  if (held && held.owner !== limb) return `held-by:${held.owner}`;
  if (held) {
    const beat = store.heartbeatWorker({ missionId, taskId: limb, owner: limb, reason: FEED_REASON });
    return beat.ok ? 'renewed' : `refused:${beat.errors?.[0] ?? 'heartbeat-failed'}`;
  }
  const claim = store.claimTask({ missionId, taskId: limb, owner: limb, ttlMs: LIMB_LEASE_TTL_MS, reason: FEED_REASON });
  if (!claim.ok) return `refused:${claim.errors?.[0] ?? 'claim-failed'}`;
  return claim.reclaimed ? 'reclaimed' : 'claimed';
}

/**
 * The bound variant of {@link mergeAndWrite}: the same CAS-guarded merge with
 * ONE retry, plus the backfill of `ops` on the run's own nodes.
 *
 * Limbs another run already owns in this mission (`ops.run_id` of a different
 * run) are filtered OUT of the plan before the merge, so their
 * `file_ownership` is not rewritten under them (I2), and are reported in
 * `foreign`. A repeat feed changes nothing: the merge is unchanged and every
 * node already has its ops, so no store commit — and no ledger row — is made.
 *
 * @param {object} store - StateStore.
 * @param {object} state - The snapshot the mission was resolved from.
 * @param {string} missionId - The bound mission.
 * @param {object|null} plan - Parsed `plan.json`.
 * @param {string} limb - The dispatched limb.
 * @param {{ runId: string, lanes: unknown, now: () => Date }} run - The run's id, its run.json lanes, the clock port.
 * @returns {{merged: object|null, attached?: object, foreign?: string[], graph?: object, commit?: object|null}}
 *   `merged` is null when the mission was gone at the re-read.
 */
function mergeAndWriteBound(store, state, missionId, plan, limb, { runId, lanes, now }) {
  const limbs = Object.keys(ownsFromPlan(plan));
  let snapshot = state;
  for (let attempt = 0; ; attempt += 1) {
    if (!snapshot.active_missions?.[missionId]) return { merged: null };
    const graph = snapshot.task_graphs?.[missionId] ?? null;
    const foreign = foreignRunLimbs(graph, { runId, limbs });
    const mergeable = foreign.length === 0 ? plan : { ...plan, limbs: plan.limbs.filter((l) => !foreign.includes(l?.limb)) };
    const at = now();
    const merged = mergeLimbTasks({ graph, plan: mergeable, missionId, now: at });
    const attached = attachRunOps(merged.graph, { runId, limbs, lanes, nowIso: at.toISOString() });
    const done = { merged, attached, foreign, graph: attached.graph, commit: null };
    if (foreign.includes(limb) || (merged.unchanged && !attached.changed) || !attached.graph.tasks.some((t) => t.id === limb)) return done;
    const commit = store.updateMission(missionId, (cur) => cur, {
      reason: FEED_REASON, graph: attached.graph, expectedVersion: snapshot.state_version,
    });
    if (commit.conflict !== true || attempt >= 1) return { ...done, commit };
    snapshot = store.getState();
  }
}

/**
 * First feed of a run that asked to be bound: write the binding, or say why not.
 *
 * Refuses to bind a run to a mission whose graph already holds the dispatched
 * limb for ANOTHER run — the run could never write that limb there (I2), and a
 * binding is for keeps. Everything else (`plan-run-id-missing`,
 * `run-id-mismatch`, `plan-missing`, …) is the binder's own reason.
 *
 * @returns {{ record: Readonly<object>, created: boolean } | { reason: string }}
 */
function tryBind({ parentRoot, plan, limb, state, missionId, sid, store, now }) {
  const runId = typeof plan?.runId === 'string' ? plan.runId : null;
  if (runId && foreignRunLimbs(state.task_graphs?.[missionId], { runId, limbs: [limb] }).length > 0) return { reason: 'task-run-mismatch' };
  const res = bindRunToMission({ runDir: path.join(parentRoot, '.artibot', 'split'), missionId, sessionId: sid, now, store });
  return res.ok ? { record: res.binding, created: res.bound } : { reason: res.reason };
}

/**
 * Feed one limb of a BOUND run: merge the plan into the bound mission's graph,
 * attach `ops`, and stop there — there is deliberately no claim (see the
 * module header). Returns the same result shape as the legacy feed, with
 * `claim: 'bound:node'` and three extra keys: `binding`, `opsAttached` and,
 * when non-empty, `opsSkipped`.
 */
function feedBound({ store, state, parentRoot, plan, limb, missionId, binding, now }) {
  const runId = binding.record.run_id;
  const out = mergeAndWriteBound(store, state, missionId, plan, limb, { runId, lanes: readRunJson(parentRoot)?.lanes, now });
  if (!out.merged) return { ...skipped('no-mission'), missionId };
  if (out.foreign.includes(limb)) return { ...skipped('task-run-mismatch'), missionId };
  if (!out.graph.tasks.some((t) => t.id === limb)) return skipped('limb-not-in-plan');

  let stateVersion = state.state_version;
  if (out.commit) {
    if (!out.commit.ok) return { ...skipped(`graph-write-refused:${out.commit.errors?.[0] ?? 'unknown'}`), missionId };
    stateVersion = out.commit.state_version ?? stateVersion;
  }
  return {
    fed: true,
    skipped: null,
    missionId,
    taskId: limb,
    added: out.merged.added,
    refreshed: out.merged.refreshed,
    claim: 'bound:node',
    stateVersion: store.getState().state_version ?? stateVersion,
    location: store.location?.source ?? null,
    binding: {
      status: binding.created ? 'created' : 'reused',
      mission_id: missionId,
      run_id: runId,
      generation: binding.record.generation,
      env: missionEnvFromBinding(binding.record),
    },
    opsAttached: out.attached.attached,
    ...(out.attached.skipped.length > 0 ? { opsSkipped: out.attached.skipped } : {}),
  };
}

/**
 * Seed and claim one dispatched limb. Total — returns a result for every input.
 *
 * A run that carries a binding is fed through {@link feedBound} instead (no
 * claim; see the module header). `bind: true` lets this call write the binding
 * when the run has none and the legacy rule finds a live mission for the session.
 * Both are subject to the canary key ({@link missionBindingEnabled}): with it
 * off, `bind: true` binds nothing and a record already on disk is not honoured.
 *
 * @param {object} params - Feed inputs.
 * @param {string} params.parentRoot - Parent (main checkout) root.
 * @param {object|null} params.plan - Parsed `plan.json`, as `dispatch` already read it.
 * @param {string} params.limb - The limb being dispatched.
 * @param {boolean} [params.dryRun=false] - True writes NOTHING and opens no store.
 * @param {string|null} [params.sessionId] - Override; defaults to the host env.
 * @param {boolean} [params.bind=false] - Bind an unbound run to the mission the session owns. Off by default: only `dispatch` asks, and only with the canary key on (this function asks the key again).
 * @param {{ openStore?: Function, now?: () => Date, config?: object|null }} [ports] - Test seam. `config`: the parsed artibot.config.json the canary key is read from; `null` is "no config" (off); absent reads the shipped file.
 * @returns {{fed: boolean, skipped: string|null, missionId: string|null, taskId: string|null,
 *   added: string[], refreshed: string[], claim: string|null, stateVersion?: number, location?: string,
 *   binding?: object, opsAttached?: string[], opsSkipped?: object[]}} `binding` appears on a bound feed, on a legacy feed that asked to bind and could not (`{status:'unbound', reason}`), and on any legacy result of a run whose record the switch is not honouring (`{status:'disabled'}`).
 * @example
 * feedLimb({ parentRoot, plan, limb: 'auth' }); // { fed: true, claim: 'claimed', ... }
 */
export function feedLimb({ parentRoot, plan, limb, dryRun = false, sessionId, bind = false }, ports = {}) {
  try {
    if (dryRun) return skipped('dry-run');
    if (typeof parentRoot !== 'string' || parentRoot === '') return skipped('no-project-root');
    if (typeof limb !== 'string' || limb === '') return skipped('no-limb');
    const sid = sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') return skipped('no-session-id');

    const store = (ports.openStore ?? openFeedStore)(parentRoot, sid);
    const state = store.getState();
    // The canary key, asked lazily and at most once: a run with no record that
    // does not ask to bind never reads the config file.
    let enabled = null;
    const honorBinding = () => {
      if (enabled === null) enabled = missionBindingEnabled(ports);
      return enabled;
    };
    const resolved = resolveRunMission({ parentRoot, state, sessionId: sid, honorBinding });
    if (resolved.mode === 'rejected') return { ...skipped(resolved.reason), missionId: resolved.missionId };
    const { missionId } = resolved;
    // A legacy result of a run whose record the switch is not honouring says so.
    const disabled = resolved.mode === 'legacy' && resolved.binding ? { binding: resolved.binding } : {};
    // Re-checked against the snapshot rather than trusted: the selector's
    // contract is "a mission this session owns", and creating one here is the
    // orphan this module must not make.
    if (!missionId || !state.active_missions?.[missionId]) return { ...skipped('no-mission'), ...disabled };

    const now = ports.now ?? (() => new Date());
    let binding = resolved.mode === 'bound' ? { record: resolved.binding, created: false } : null;
    let unbound = null;
    if (binding === null && bind && honorBinding()) {
      const attempt = tryBind({ parentRoot, plan, limb, state, missionId, sid, store, now });
      if (attempt.record) binding = attempt;
      else unbound = { status: 'unbound', reason: attempt.reason };
    }
    if (binding !== null) return feedBound({ store, state, parentRoot, plan, limb, missionId, binding, now });

    const { merged, commit } = mergeAndWrite(store, state, missionId, plan, limb);
    if (!merged) return { ...skipped('no-mission'), ...disabled };
    const task = merged.graph.tasks.find((t) => t.id === limb);
    if (!task) return { ...skipped('limb-not-in-plan'), ...disabled };

    let stateVersion = state.state_version;
    if (commit) {
      if (!commit.ok) return { ...skipped(`graph-write-refused:${commit.errors?.[0] ?? 'unknown'}`), missionId, ...disabled };
      stateVersion = commit.state_version ?? stateVersion;
    }

    const claim = claimLimb(store, missionId, limb, task);
    return {
      fed: true,
      skipped: null,
      missionId,
      taskId: limb,
      added: merged.added,
      refreshed: merged.refreshed,
      claim,
      stateVersion: store.getState().state_version ?? stateVersion,
      location: store.location?.source ?? null,
      ...(unbound ? { binding: unbound } : {}),
      ...disabled,
    };
  } catch (err) {
    // Including the store constructor's TypeErrors. A dispatch must not fail
    // because bookkeeping did.
    return skipped(`store-threw:${err?.message ?? 'unknown'}`);
  }
}
