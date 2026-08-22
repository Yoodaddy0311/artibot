/**
 * External-repo acquisition for the `/repo` benchmark pipeline.
 *
 * This is the **single owner of the clone step**. Before it existed, three
 * documents each told a different actor to clone: `commands/repo.md`
 * § *Execution Flow* step 2 told the orchestrator, the same file's
 * ★ MANDATORY rule 1 told every spawned teammate ("First action =
 * `git clone --depth 1`"), and `agents/repo-benchmarker.md` § *Process*
 * step 1 told the standalone agent. Three owners meant three chances to
 * clone to the wrong place, skip the size guard, or lose the commit the
 * report was written against. The leader now calls `acquireRepo` once and
 * hands teammates a `localPath`.
 *
 * The cache contract is not re-invented here — it is read from
 * `skills/repo-benchmarking/SKILL.md` § *Cache Strategy*:
 *   - Location `~/.claude/artibot/repos/[repo-name]/`
 *   - Re-use with `git pull` when the directory already exists
 *   - Stale after 7 days (advisory), `--depth 1` by default
 *
 * **`sourceSha` is the load-bearing field.** A benchmark report cites
 * `file:line` in a tree that will have moved by the time anyone re-reads it;
 * without the commit the report was produced against, those citations are
 * unverifiable. `acquireRepo` resolves HEAD after every clone or update and
 * returns it, and {@link formatSourceStamp} renders it for the report header.
 *
 * Layer 2 (auxiliary): imports `lib/core` (L1) only.
 *
 * @module lib/git/repo-acquire
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getHomeDir } from '../core/platform.js';
import {
  assertRepoSize,
  DEFAULT_CLONE_DEPTH,
  isStaleCache,
  MAX_REPO_BYTES,
  parseRepoInput,
} from '../core/repo-input.js';

/**
 * Failure reasons specific to acquisition. Input-shaped rejections keep their
 * own `RepoInputError` codes from `lib/core/repo-input.js` — the two sets do
 * not overlap, so a caller can branch on `err.code` regardless of which threw.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REPO_ACQUIRE_ERRORS = Object.freeze({
  CACHE_CONFLICT: 'CACHE_CONFLICT',
  CACHE_MISS: 'CACHE_MISS',
  CLONE_FAILED: 'CLONE_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
  HEAD_UNRESOLVED: 'HEAD_UNRESOLVED',
});

/** Thrown when acquisition fails after the input itself was accepted. */
export class RepoAcquireError extends Error {
  /**
   * @param {string} code - A value from {@link REPO_ACQUIRE_ERRORS}.
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'RepoAcquireError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// git transport
// ---------------------------------------------------------------------------

/**
 * Default git runner: argv-array, shell-free, so a repo name can never be
 * interpreted as a shell token even if the allowlist in `repo-input.js` were
 * ever loosened.
 *
 * @param {string[]} args
 * @param {string|undefined} cwd
 * @returns {string} Trimmed stdout.
 */
function defaultRunGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run git and swallow failure. Used only for probes whose absence is a normal
 * state (no cache yet, no origin remote) — never for the clone itself.
 *
 * @param {(args: string[], cwd?: string) => string} runGit
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function probe(runGit, args, cwd) {
  try {
    const out = runGit(args, cwd);
    return typeof out === 'string' && out.trim() !== '' ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a remote URL for identity comparison: case, trailing slash, and
 * the optional `.git` suffix are all cosmetic on the same remote.
 *
 * @param {string|null} url
 * @returns {string}
 */
function normalizeRemote(url) {
  if (!url) return '';
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Cache location
// ---------------------------------------------------------------------------

/**
 * Resolve the repos cache root.
 *
 * @param {{cacheRoot?: string}} [opts] - `cacheRoot` redirects the whole cache,
 *   which is how tests stay out of the user's real `~/.claude`.
 * @returns {string} Absolute path to the repos cache root.
 */
export function resolveCacheRoot(opts = {}) {
  return opts.cacheRoot ?? path.join(getHomeDir(), '.claude', 'artibot', 'repos');
}

/**
 * Sum the byte size of every regular file under `dir`.
 *
 * Symlinks are counted by their own size and never followed: following them
 * would let a cloned tree inflate the measurement, or walk out of the cache.
 *
 * The walk stops as soon as the running total passes `maxBytes`, so an
 * oversized clone is rejected without paying for a full traversal. The return
 * value is therefore **exact when it is at or under `maxBytes`**, and a lower
 * bound above it — which is all the size guard needs.
 *
 * @param {string} dir
 * @param {number} [maxBytes]
 * @returns {number}
 */
export function measureTreeBytes(dir, maxBytes = MAX_REPO_BYTES) {
  let total = 0;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0 && total <= maxBytes) {
    const current = /** @type {string} */ (stack.pop());
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable subtree: skip rather than abort the benchmark
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += lstatSync(full).size;
      } catch {
        /* vanished mid-walk — ignore */
      }
      if (total > maxBytes) break;
    }
  }
  return total;
}

/**
 * Epoch ms of the last fetch into a clone, or null when unknowable.
 * `FETCH_HEAD` is written by every fetch/pull; `HEAD` dates the initial clone.
 *
 * @param {string} localPath
 * @returns {number|null}
 */
function lastFetchedAt(localPath) {
  for (const rel of ['.git/FETCH_HEAD', '.git/HEAD']) {
    const candidate = path.join(localPath, rel);
    try {
      return statSync(candidate).mtimeMs;
    } catch {
      /* try the next marker */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Report on the cache entry for an input **without changing anything**.
 *
 * Validates the input first, so a rejected URL never reveals whether a
 * directory exists.
 *
 * @param {string} input - Candidate clone source.
 * @param {{cacheRoot?: string, now?: number,
 *          runGit?: (args: string[], cwd?: string) => string}} [opts]
 * @returns {{cacheKey: string, localPath: string, exists: boolean,
 *            sourceUrl: string, originUrl: string|null, sourceSha: string|null,
 *            fetchedAt: number|null, stale: boolean}}
 * @throws {import('../core/repo-input.js').RepoInputError} On a rejected input.
 */
export function resolveCachedRepo(input, opts = {}) {
  const desc = parseRepoInput(input);
  const runGit = opts.runGit ?? defaultRunGit;
  const localPath = path.join(resolveCacheRoot(opts), desc.cacheKey);
  const exists = existsSync(path.join(localPath, '.git'));
  const fetchedAt = exists ? lastFetchedAt(localPath) : null;

  return {
    cacheKey: desc.cacheKey,
    localPath,
    exists,
    sourceUrl: desc.sourceUrl,
    originUrl: exists ? probe(runGit, ['remote', 'get-url', 'origin'], localPath) : null,
    sourceSha: exists ? probe(runGit, ['rev-parse', 'HEAD'], localPath) : null,
    fetchedAt,
    stale: isStaleCache(fetchedAt, opts.now ?? Date.now()),
  };
}

/**
 * Clone or update a tree. **Low-level transport step — does not validate.**
 * `acquireRepo` is the only supported entry point; a direct caller owns
 * validation itself.
 *
 * @param {{sourceUrl: string, localPath: string, depth: number|null,
 *          update: boolean, runGit?: (args: string[], cwd?: string) => string}} spec
 * @returns {void}
 * @throws {RepoAcquireError} `CLONE_FAILED` / `UPDATE_FAILED`.
 */
export function syncRepoTree(spec) {
  const runGit = spec.runGit ?? defaultRunGit;
  if (spec.update) {
    try {
      // `--ff-only`: an analysis cache must never produce a merge commit, and
      // a diverged cache is a signal worth surfacing rather than papering over.
      runGit(['pull', '--ff-only'], spec.localPath);
    } catch (err) {
      throw new RepoAcquireError(
        REPO_ACQUIRE_ERRORS.UPDATE_FAILED,
        `git pull failed in ${spec.localPath}: ${err?.message ?? err}`,
      );
    }
    return;
  }
  const args = ['clone'];
  if (spec.depth !== null) args.push('--depth', String(spec.depth));
  args.push('--', spec.sourceUrl, spec.localPath);
  try {
    runGit(args, undefined);
  } catch (err) {
    throw new RepoAcquireError(
      REPO_ACQUIRE_ERRORS.CLONE_FAILED,
      `git clone of ${spec.sourceUrl} failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Guard an existing cache directory: prove it holds the repo that was asked
 * for, or refuse to use it.
 *
 * The cache key is the repo name alone (SKILL.md § *Cache Strategy*), so two
 * owners publishing the same name map to one directory. Pulling one into the
 * other's tree would silently benchmark the wrong repository, so a mismatch
 * is a hard failure rather than a re-clone.
 *
 * **A missing origin is a failure, not a pass.** The first version of this
 * function returned early on `!originUrl` — "no remote, nothing to
 * contradict". That was fail-open, and reproduced end-to-end: an orphan
 * directory at the cache key (a stray `mkdir`, an interrupted clone, a
 * hand-made folder) combined with `skipClone: true` returned
 * `cacheStatus: 'fresh'` and stamped the *requested* `sourceUrl` plus the
 * orphan's own HEAD onto a tree that was never the requested repo. Since
 * `git clone` always writes an origin remote, refusing here cannot affect a
 * cache this module produced — only directories whose provenance is
 * genuinely unknown, which is exactly the set that must not be trusted.
 *
 * @param {string|null} originUrl
 * @param {string} sourceUrl
 * @param {string} localPath
 * @returns {void}
 * @throws {RepoAcquireError} `CACHE_CONFLICT`.
 */
function assertNoCacheConflict(originUrl, sourceUrl, localPath) {
  if (!originUrl) {
    throw new RepoAcquireError(
      REPO_ACQUIRE_ERRORS.CACHE_CONFLICT,
      `${localPath} exists but has no origin remote; its provenance cannot be proven. Remove it and re-clone.`,
    );
  }
  if (normalizeRemote(originUrl) === normalizeRemote(sourceUrl)) return;
  throw new RepoAcquireError(
    REPO_ACQUIRE_ERRORS.CACHE_CONFLICT,
    `${localPath} already holds ${originUrl}, not ${sourceUrl}. Remove it or benchmark under a distinct name.`,
  );
}

/**
 * Acquire an external repo for benchmarking: validate, clone or reuse the
 * cache, enforce the size ceiling, and stamp the commit that was analyzed.
 *
 * Order matters. Validation runs before anything touches the filesystem, so a
 * rejected input provably creates no directory — that is the property the
 * negative-control test asserts.
 *
 * `cacheStatus` distinguishes three outcomes the caller must be able to tell
 * apart when reporting: `created` (cloned now), `updated` (cache existed and
 * HEAD moved), `fresh` (cache existed and HEAD did not move, including the
 * `--skip-clone` / `--compare-only` path).
 *
 * @param {string} input - HTTPS clone source.
 * @param {{cacheRoot?: string, depth?: number, deep?: boolean,
 *          skipClone?: boolean, maxBytes?: number, now?: number,
 *          runGit?: (args: string[], cwd?: string) => string}} [opts]
 *   `deep` maps to `/repo --deep` (full history). `skipClone` maps to
 *   `--skip-clone` / `--compare-only`. `runGit` is a transport seam for tests;
 *   it does not bypass validation, which has already run by the time it is used.
 * @returns {Readonly<{localPath: string, sourceUrl: string, sourceSha: string,
 *   cacheStatus: 'created'|'updated'|'fresh', sizeBytes: number,
 *   depth: number|null, cacheKey: string, host: string, owner: string|null,
 *   repoName: string, stale: boolean, acquiredAt: number}>}
 *   `depth` is the value passed to `--depth`, or `null` for a full clone.
 * @throws {import('../core/repo-input.js').RepoInputError} Rejected input or
 *   an oversized tree.
 * @throws {RepoAcquireError} Clone/update/cache failures.
 * @example
 * const repo = acquireRepo('https://github.com/google/magika');
 * // → { localPath: '~/.claude/artibot/repos/magika', sourceSha: 'a1b2…', … }
 */
export function acquireRepo(input, opts = {}) {
  const desc = parseRepoInput(input);
  const runGit = opts.runGit ?? defaultRunGit;
  const now = opts.now ?? Date.now();
  const cacheRoot = resolveCacheRoot(opts);
  const localPath = path.join(cacheRoot, desc.cacheKey);
  const depth = opts.deep === true ? null : (opts.depth ?? DEFAULT_CLONE_DEPTH);

  const existed = existsSync(path.join(localPath, '.git'));
  /** @type {'created'|'updated'|'fresh'} */
  let cacheStatus;

  if (existed) {
    assertNoCacheConflict(
      probe(runGit, ['remote', 'get-url', 'origin'], localPath),
      desc.sourceUrl,
      localPath,
    );
    const before = probe(runGit, ['rev-parse', 'HEAD'], localPath);
    if (opts.skipClone === true) {
      cacheStatus = 'fresh';
    } else {
      syncRepoTree({ sourceUrl: desc.sourceUrl, localPath, depth, update: true, runGit });
      cacheStatus = probe(runGit, ['rev-parse', 'HEAD'], localPath) === before ? 'fresh' : 'updated';
    }
  } else if (opts.skipClone === true) {
    throw new RepoAcquireError(
      REPO_ACQUIRE_ERRORS.CACHE_MISS,
      `--skip-clone was requested but no cache exists at ${localPath}.`,
    );
  } else {
    mkdirSync(cacheRoot, { recursive: true });
    syncRepoTree({ sourceUrl: desc.sourceUrl, localPath, depth, update: false, runGit });
    cacheStatus = 'created';
  }

  const sourceSha = probe(runGit, ['rev-parse', 'HEAD'], localPath);
  if (!sourceSha) {
    throw new RepoAcquireError(
      REPO_ACQUIRE_ERRORS.HEAD_UNRESOLVED,
      `Cannot resolve HEAD in ${localPath}; the report would carry no source commit.`,
    );
  }

  const maxBytes = opts.maxBytes ?? MAX_REPO_BYTES;
  const sizeBytes = assertRepoSize(measureTreeBytes(localPath, maxBytes), maxBytes);

  return Object.freeze({
    localPath,
    sourceUrl: desc.sourceUrl,
    sourceSha,
    cacheStatus,
    sizeBytes,
    depth,
    cacheKey: desc.cacheKey,
    host: desc.host,
    owner: desc.owner,
    repoName: desc.repoName,
    stale: isStaleCache(lastFetchedAt(localPath), now),
    acquiredAt: now,
  });
}

/**
 * Render the one-line provenance stamp a benchmark report must carry.
 *
 * This is the surviving piece of the rejected report-schema work: the report
 * format stays prose, but the commit its citations were read at is machine-
 * produced rather than remembered.
 *
 * @param {{sourceUrl: string, sourceSha: string, depth: number|null,
 *          cacheStatus: string}} descriptor - Result of {@link acquireRepo}.
 * @returns {string}
 * @example
 * formatSourceStamp(repo);
 * // 'https://github.com/google/magika@a1b2c3d (depth 1, created)'
 */
export function formatSourceStamp(descriptor) {
  const short = descriptor.sourceSha.slice(0, 7);
  const depth = descriptor.depth === null ? 'full clone' : `depth ${descriptor.depth}`;
  return `${descriptor.sourceUrl}@${short} (${depth}, ${descriptor.cacheStatus})`;
}
