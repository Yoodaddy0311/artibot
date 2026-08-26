/**
 * Batch landing — N split limbs → one `ci/split-<run>` SHA → one CI run → master.
 *
 * ── Why batch, and what `strict:true` costs ──────────────────────────────────
 * Branch protection on this repo is `strict:true` + `enforce_admins:true`
 * (live `gh api`, 2026-08-26). `strict` means a SHA may only land on master if
 * its checks ran ON TOP OF the current master; the moment master moves, every
 * other green branch is stale and must be rebased and re-checked. Landing N
 * limbs one after another therefore costs N full CI runs *serially*, and each
 * landing invalidates the next (PRD § 근거: 통증 ⑥, CI 5분 × 랜딩마다).
 * Batching folds N limbs into one commit first, so the happy path is exactly
 * one CI run. The price of `strict` does not disappear — it moves to the
 * contention case: if master moves while we wait for green, the whole batch
 * is rebuilt on the new base and CI runs again (once). A second move hands the
 * problem to a human rather than looping.
 *
 *   happy path ........ 1 × CI
 *   master moved once .. 2 × CI (rebuild + re-green)
 *   master moved twice . stop, `needs-human`
 *
 * ── How the batch commit is built (no checkout) ──────────────────────────────
 * The combined SHA is produced entirely in the object database:
 * `merge-tree --write-tree` (via `merge-preflight.js`) folds each limb into the
 * running head, `commit-tree` records a two-parent merge commit, and
 * `update-ref` points `refs/heads/ci/split-<run>` at the result. The index and
 * working tree are never touched — this is what makes it safe to run from a
 * shared checkout while other sessions are editing. The integration branch is
 * by design never checked out anywhere; `update-ref` on a branch some worktree
 * has checked out would move that worktree's HEAD under it.
 *
 * ── Ported from `.github/workflows/release.yml` (ff mode) ────────────────────
 * `waitForGreen` is a line-for-line port of the `wait_for_green()` bash
 * function there (40 attempts × 15s = 10 min ceiling; green = every check run
 * completed and none concluded outside success/neutral/skipped; deliberately
 * NOT a copy of the required-context list — branch protection stays the
 * authority and simply rejects the push if the set is unmet). The
 * push → wait → ff → (moved? fetch, rebuild, `--force-with-lease`, wait, ff)
 * → give-up sequence is the same shape as `release.yml` § "Land badge sync via
 * ci/** side branch", generalised from "one badge commit" to "N limbs".
 * What was NOT ported: `open_issue` escalation (that is a release-job concern
 * with GITHUB_TOKEN in scope; here the result object carries the reason and the
 * caller decides).
 *
 * ── Fail-closed points ───────────────────────────────────────────────────────
 *   1. Lock held by another landing → `locked`, nothing pushed.
 *   2. Pre-flight unsupported (git < 2.38) → `degraded`, nothing pushed; the
 *      caller lands serially.
 *   3. Any pair conflict, or a conflict that only appears when folding the
 *      Nth limb onto the accumulated head → `conflict`, nothing pushed.
 *   4. Not green within the ceiling → `not-green`; the branch stays on the
 *      remote for a human.
 *   5. No `fetchCheckRuns` supplied → `waitForGreen` refuses (returns not
 *      green) rather than assuming.
 *
 * ── What this module cannot see ─────────────────────────────────────────────
 * merge-tree green ≠ semantic safety (see `merge-preflight.js` header) — CI is
 * the only judge of that. The local lock cannot see another machine; the base
 * re-check right before the fast-forward push and `--force-with-lease` on the
 * integration branch are the guards for the remote race, and a writer that
 * pushes in the microseconds between the re-check and the push is caught by
 * git's own non-fast-forward rejection, which is then handled as "moved".
 *
 * @module lib/git/batch-landing
 */

import { spawnSync } from 'node:child_process';
import {
  DEGRADE_SERIAL,
  mergeTreePair,
  preflightBranches,
  runGit,
} from './merge-preflight.js';
import {
  acquireLandingLock,
  buildLandingLockKey,
  releaseLandingLock,
} from './landing-lock.js';
import { getRepoIdentity } from './repo-identity.js';

export const INTEGRATION_BRANCH_PREFIX = 'ci/split-';
/** 40 × 15s = 10 min — the ceiling measured in release.yml against PR #100. */
export const WAIT_FOR_GREEN_ATTEMPTS = 40;
export const WAIT_FOR_GREEN_POLL_MS = 15_000;
/** Exactly one rebuild when master moves; the next writer is a human. */
export const MAX_REBUILDS = 1;

const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * `ci/split-<run>` with the run id reduced to a branch-safe token.
 *
 * @param {string} runId
 * @returns {string}
 */
export function integrationBranchName(runId) {
  const token = String(runId ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!token) throw new TypeError('runId must contain at least one branch-safe character');
  return `${INTEGRATION_BRANCH_PREFIX}${token}`;
}

/**
 * @param {typeof runGit} exec
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} trimmed stdout
 * @throws {Error} when git exits non-zero
 */
function gitOut(exec, args, cwd) {
  const r = exec(args, { cwd });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout.trim();
}

/**
 * Read a remote branch tip without fetching objects. Null when absent.
 *
 * @param {{exec: typeof runGit, cwd: string, remote: string, branch: string}} p
 * @returns {string|null}
 */
export function readRemoteTip({ exec, cwd, remote, branch }) {
  const r = exec(['ls-remote', '--heads', remote, `refs/heads/${branch}`], { cwd });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const sha = line.split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * @typedef {Object} BatchBuild
 * @property {'built'|'degraded'|'conflict'} status
 * @property {string|null} sha          - Batch head commit (status 'built')
 * @property {string[]} order           - Limbs in the order they were folded
 * @property {Array<{limb:string, tree:string, commit:string}>} steps
 * @property {import('./merge-preflight.js').PreflightResult} preflight
 * @property {{limb:string, files:string[], stderr:string}|null} conflict
 */

/**
 * Fold `limbs` onto `base` into a single merge-commit chain. Pure object-db
 * work; no checkout, no index, no working-tree access.
 *
 * @param {Object} p
 * @param {string} p.base                - Ref or SHA the batch sits on
 * @param {string[]} p.limbs             - Limb refs
 * @param {string} p.cwd
 * @param {string} [p.branch]            - When given, `update-ref refs/heads/<branch>` to the result
 * @param {typeof runGit} [p.exec]
 * @param {(limb:string, index:number) => string} [p.message]
 * @returns {BatchBuild}
 */
export function buildBatchCommit({ base, limbs, cwd, branch, exec = runGit, message }) {
  const preflight = preflightBranches([base, ...limbs], { cwd, exec });
  if (!preflight.supported) {
    return { status: 'degraded', sha: null, order: [], steps: [], preflight, conflict: null };
  }
  if (preflight.blocked) {
    const first = preflight.conflicts[0];
    return {
      status: 'conflict',
      sha: null,
      order: [],
      steps: [],
      preflight,
      conflict: { limb: `${first.ours} <-> ${first.theirs}`, files: first.conflictFiles, stderr: first.stderr },
    };
  }
  // Base first in the recommended order is guaranteed only if it has zero
  // conflicts, which `blocked === false` already implies; drop it explicitly.
  const order = preflight.mergeOrder.filter((b) => b !== base);
  let head = gitOut(exec, ['rev-parse', '--verify', `${base}^{commit}`], cwd);
  const steps = [];
  for (let i = 0; i < order.length; i += 1) {
    const limb = order[i];
    const pair = mergeTreePair(head, limb, { cwd, exec });
    if (pair.kind !== 'clean') {
      return {
        status: 'conflict',
        sha: null,
        order: order.slice(0, i),
        steps,
        preflight,
        conflict: { limb, files: pair.conflictFiles, stderr: pair.stderr },
      };
    }
    const limbSha = gitOut(exec, ['rev-parse', '--verify', `${limb}^{commit}`], cwd);
    const msg = message ? message(limb, i) : `merge(split): fold ${limb} into batch [${i + 1}/${order.length}]`;
    const commit = gitOut(exec, ['commit-tree', pair.tree, '-p', head, '-p', limbSha, '-m', msg], cwd);
    steps.push({ limb, tree: pair.tree, commit });
    head = commit;
  }
  if (branch) gitOut(exec, ['update-ref', `refs/heads/${branch}`, head], cwd);
  return { status: 'built', sha: head, order, steps, preflight, conflict: null };
}

/**
 * Classify one check-runs payload the way release.yml's jq does.
 *
 * @param {{total_count?:number, check_runs?:Array<{status?:string, conclusion?:string|null}>}|null} payload
 * @returns {{total:number, pending:number, failed:number}}
 */
export function summarizeCheckRuns(payload) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const total = Number.isFinite(payload?.total_count) ? payload.total_count : runs.length;
  const pending = runs.filter((r) => r.status !== 'completed').length;
  const failed = runs.filter((r) => r.conclusion !== null && r.conclusion !== undefined && !GREEN_CONCLUSIONS.has(r.conclusion)).length;
  return { total, pending, failed };
}

/**
 * Wait until every check run on `sha` completed green. Port of
 * `wait_for_green()` in release.yml: an empty/zero payload is "not yet",
 * any failed conclusion is an immediate red, the ceiling is a red.
 *
 * @param {string} sha
 * @param {Object} opts
 * @param {(sha:string) => Promise<object|null>} opts.fetchCheckRuns
 * @param {number} [opts.attempts]
 * @param {number} [opts.pollMs]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{green:boolean, reason:string, polls:number, last:{total:number,pending:number,failed:number}|null}>}
 */
export async function waitForGreen(sha, opts) {
  if (typeof opts?.fetchCheckRuns !== 'function') {
    return { green: false, reason: 'no fetchCheckRuns supplied (fail-closed)', polls: 0, last: null };
  }
  const attempts = Number.isFinite(opts.attempts) ? opts.attempts : WAIT_FOR_GREEN_ATTEMPTS;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : WAIT_FOR_GREEN_POLL_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    await sleep(pollMs);
    let payload;
    try {
      payload = await opts.fetchCheckRuns(sha);
    } catch {
      payload = null;
    }
    if (!payload) continue;
    last = summarizeCheckRuns(payload);
    if (last.total === 0) continue;
    if (last.failed !== 0) return { green: false, reason: `${last.failed} check run(s) failed`, polls: i, last };
    if (last.pending === 0) return { green: true, reason: 'all check runs completed green', polls: i, last };
  }
  return { green: false, reason: `not green within ${attempts} polls`, polls: attempts, last };
}

/**
 * Default check-run source: `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`.
 * Untested against the live API in this module's own suite — the suite injects
 * a fake fetcher. Returns null on any failure so `waitForGreen` keeps polling.
 *
 * @param {{repo: string, cwd?: string}} p  - `repo` as `owner/name`
 * @returns {(sha:string) => Promise<object|null>}
 */
export function makeGhCheckRunsFetcher({ repo, cwd }) {
  return async (sha) => {
    const r = spawnSync('gh', ['api', `repos/${repo}/commits/${sha}/check-runs`], {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
}

/**
 * @typedef {Object} LandResult
 * @property {'landed'|'locked'|'degraded'|'conflict'|'push-failed'|'not-green'|'needs-human'|'error'} status
 * @property {string} branch                 - Integration branch name
 * @property {string|null} sha               - Batch SHA last pushed (null if none)
 * @property {string|null} base              - Base SHA the batch was built on
 * @property {number} rebuilds               - 0 on the happy path, 1 after one master move
 * @property {string} reason
 * @property {string[]} log
 * @property {BatchBuild|null} build
 * @property {object} [holder]               - Present when status is 'locked'
 */

/**
 * Land `limbs` onto `base` as one SHA. Every remote interaction goes through
 * `exec` (git) and `fetchCheckRuns` (CI) so the whole sequence is testable
 * against a local bare remote with no CI at all.
 *
 * @param {Object} p
 * @param {string} p.cwd
 * @param {string[]} p.limbs
 * @param {string} p.runId
 * @param {string} [p.repoIdentity]        - Lock key half; defaults to `getRepoIdentity(cwd)`; error when neither resolves
 * @param {string} p.lockDir
 * @param {string} [p.base='master']
 * @param {string} [p.remote='origin']
 * @param {string} [p.sessionId]
 * @param {typeof runGit} [p.exec]
 * @param {(sha:string) => Promise<object|null>} [p.fetchCheckRuns]
 * @param {{attempts?:number, pollMs?:number, sleep?:(ms:number)=>Promise<void>}} [p.wait]
 * @param {number} [p.maxRebuilds]
 * @returns {Promise<LandResult>}
 */
export async function landBatch(p) {
  const {
    cwd,
    limbs,
    runId,
    repoIdentity,
    lockDir,
    base = 'master',
    remote = 'origin',
    sessionId,
    exec = runGit,
    fetchCheckRuns,
    wait = {},
    maxRebuilds = MAX_REBUILDS,
  } = p ?? {};
  const branch = integrationBranchName(runId);
  const log = [];
  const result = (status, extra = {}) => ({
    status, branch, sha: null, base: null, rebuilds: 0, reason: '', log, build: null, ...extra,
  });

  if (!Array.isArray(limbs) || limbs.length === 0) {
    return result('error', { reason: 'no limbs to land' });
  }

  const identity = repoIdentity ?? getRepoIdentity(cwd);
  if (!identity) {
    return result('error', { reason: 'repository identity unresolved (no remote, no root commit?) — refusing to lock on a guess' });
  }
  const key = buildLandingLockKey(identity, base);
  const lock = acquireLandingLock(key, { lockDir, sessionId });
  if (!lock.ok) {
    log.push(`lock ${key} held by pid=${lock.holder?.pid ?? '?'} host=${lock.holder?.host ?? '?'}`);
    return result('locked', { reason: `another landing holds ${key}`, holder: lock.holder });
  }
  log.push(`lock ${key} acquired`);

  const ctx = { cwd, limbs, branch, base, remote, exec, fetchCheckRuns, wait, log, result, pushedSha: null };
  try {
    // One attempt = fetch base → build → push → wait → re-check → ff. Runs at
    // most 1 + maxRebuilds times; `moved` is the only way round the loop.
    for (let rebuilds = 0; ; rebuilds += 1) {
      const outcome = await attemptLanding(ctx, rebuilds);
      if (outcome.done) return outcome.done;
      if (rebuilds >= maxRebuilds) {
        return result('needs-human', {
          reason: `${base} moved again after ${rebuilds} rebuild(s); ${branch} @ ${ctx.pushedSha} is green on a stale base — a human lands or discards it`,
          build: outcome.build, sha: ctx.pushedSha, base: outcome.baseSha, rebuilds,
        });
      }
    }
  } finally {
    releaseLandingLock(key, { lockDir, token: lock.token });
    log.push(`lock ${key} released`);
  }
}

/**
 * One landing attempt on the current remote base. Returns `{done}` with a
 * final result, or `{moved:true}` when the base moved and the caller may
 * rebuild. Mutates `ctx.pushedSha` so a rebuild can `--force-with-lease`
 * against the previous batch head.
 *
 * @param {object} ctx
 * @param {number} rebuilds
 * @returns {Promise<{done?: LandResult, moved?: boolean, build?: BatchBuild, baseSha?: string}>}
 */
async function attemptLanding(ctx, rebuilds) {
  const { cwd, limbs, branch, base, remote, exec, fetchCheckRuns, wait, log, result } = ctx;

  if (exec(['fetch', '--quiet', remote, base], { cwd }).status !== 0) {
    return { done: result('error', { reason: `git fetch ${remote} ${base} failed`, rebuilds }) };
  }
  const baseSha = readRemoteTip({ exec, cwd, remote, branch: base });
  if (!baseSha) return { done: result('error', { reason: `cannot read ${remote}/${base} tip`, rebuilds }) };
  log.push(`base ${remote}/${base} = ${baseSha}${rebuilds ? ' (rebuild)' : ''}`);

  const build = buildBatchCommit({ base: baseSha, limbs, cwd, branch, exec });
  if (build.status === 'degraded') {
    return { done: result('degraded', {
      reason: `git too old for merge-tree --write-tree (${build.preflight.probe.reason}); degrade=${DEGRADE_SERIAL}`,
      build, base: baseSha, rebuilds,
    }) };
  }
  if (build.status === 'conflict') {
    return { done: result('conflict', {
      reason: `conflict folding ${build.conflict.limb}: ${build.conflict.files.join(', ') || build.conflict.stderr}`,
      build, base: baseSha, rebuilds,
    }) };
  }
  log.push(`built ${build.sha} from [${build.order.join(', ')}]`);

  // First push is plain; a rebuild replaces the previous batch head and must
  // prove nobody else moved the integration branch meanwhile.
  const pushArgs = ctx.pushedSha
    ? ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${ctx.pushedSha}`, remote, `${build.sha}:refs/heads/${branch}`]
    : ['push', '--quiet', remote, `${build.sha}:refs/heads/${branch}`];
  const push = exec(pushArgs, { cwd });
  if (push.status !== 0) {
    return { done: result('push-failed', {
      reason: `push ${branch} failed: ${(push.stderr || push.stdout).trim()}`,
      build, sha: build.sha, base: baseSha, rebuilds,
    }) };
  }
  ctx.pushedSha = build.sha;
  log.push(`pushed ${branch} @ ${build.sha}`);

  const green = await waitForGreen(build.sha, { fetchCheckRuns, ...wait });
  log.push(`wait_for_green: ${green.reason} (polls=${green.polls})`);
  if (!green.green) {
    return { done: result('not-green', { reason: green.reason, build, sha: build.sha, base: baseSha, rebuilds }) };
  }

  // Base re-check immediately before the fast-forward push. A move here is
  // the strict:true race; the plain (non-force) push would also refuse it, but
  // reading first gives an honest "moved" instead of a bare rejection when the
  // push itself races.
  const baseNow = readRemoteTip({ exec, cwd, remote, branch: base });
  if (baseNow !== baseSha) {
    log.push(`${base} moved ${baseSha} -> ${baseNow} while waiting`);
    return { moved: true, build, baseSha };
  }
  const ff = exec(['push', '--quiet', remote, `${build.sha}:refs/heads/${base}`], { cwd });
  if (ff.status === 0) {
    log.push(`fast-forwarded ${base} onto ${branch} @ ${build.sha}`);
    return { done: result('landed', { reason: 'fast-forward push accepted', build, sha: build.sha, base: baseSha, rebuilds }) };
  }
  log.push(`ff push refused: ${(ff.stderr || ff.stdout).trim()}`);
  return { moved: true, build, baseSha };
}
