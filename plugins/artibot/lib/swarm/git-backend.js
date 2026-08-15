/**
 * Git-based swarm backend.
 *
 * Alternative to the HTTP swarm server — stores and syncs pattern weights
 * via a user-owned private git repository (e.g. `Yoodaddy0311/artibot-swarm`).
 *
 * Compliant with Artibot's DATA POLICY: all data stays inside the user's
 * own git repo under their own account. No third-party server involved.
 *
 * Architecture:
 *   ~/.claude/artibot/swarm-git/          ← local clone of swarm repo
 *     patterns/
 *       {machineHash}/
 *         weights-latest.json              ← current state for this machine
 *         history/
 *           weights-{timestamp}.json       ← per-sync snapshots
 *     metadata/
 *       machines.json                      ← registered machines
 *       last-sync.json                     ← last pull/push timestamp
 *
 * Sync flow:
 *   upload:   pull -> write weights -> commit -> push
 *   download: pull -> read all patterns/*\/weights-latest.json -> merge
 *
 * @module lib/swarm/git-backend
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';
import { scrubPattern as defaultScrubPii } from '../privacy/pii-scrubber.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWARM_CLONE_DIR = path.join(ARTIBOT_DIR, 'swarm-git');
const MACHINE_HASH_PATH = path.join(ARTIBOT_DIR, 'swarm-machine-hash.json');

/** Git command timeout (ms) */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Weight-map keys that must never be used as an index when aggregating a
 * payload pulled from the swarm repo. See `gitDownloadLatestWeights`.
 *
 * A deny-list is normally fail-open against future additions; these three are
 * the exception, being fixed by the language spec. `lib/core/config.js`
 * (`deepMerge`) and `lib/core/redaction.js` (`redactObject`) already carry the
 * same set for the same reason.
 */
const UNSAFE_WEIGHT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {string} key
 * @returns {boolean} true when `key` must not index an aggregation target.
 */
function isUnsafeWeightKey(key) {
  return UNSAFE_WEIGHT_KEYS.has(key);
}

/**
 * Copy one category's entries into the aggregation target (last write wins;
 * `mergeWeights` does the proper averaging downstream).
 *
 * Split out of `gitDownloadLatestWeights` rather than inlined: the key guard
 * needs a conditional inside the innermost loop, which would put that function
 * one block past the max-depth lint budget.
 *
 * @param {object} target
 * @param {object} entries
 */
function mergeCategoryEntries(target, entries) {
  for (const [key, value] of Object.entries(entries)) {
    if (isUnsafeWeightKey(key)) continue;
    target[key] = value;
  }
}

/**
 * Maximum commit message length. v4.8.0 audit L-2: spawnSync is shell-safe,
 * but unbounded message length (e.g. a stack trace mistakenly piped through)
 * can balloon `git commit -m` argv beyond the OS limit (Windows CreateProcess
 * tops out at ~32K). Hard-cap at 8KB to keep argv well below that bound.
 */
const COMMIT_MESSAGE_MAX_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Machine identity
// ---------------------------------------------------------------------------

/**
 * Compute a stable, anonymized machine hash. Uses hostname + home dir path
 * so it survives reinstalls but differs across machines.
 *
 * @returns {string} 8-char lowercase hex
 */
export function getMachineHash() {
  const raw = `${os.hostname()}|${os.homedir()}|${os.platform()}|${os.arch()}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

/**
 * Persist the machine hash (so we can detect identity drift later).
 *
 * @returns {Promise<string>}
 */
export async function ensureMachineHash() {
  const existing = await readJsonFile(MACHINE_HASH_PATH);
  if (existing?.hash) return existing.hash;
  const hash = getMachineHash();
  await writeJsonFile(MACHINE_HASH_PATH, {
    hash,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
  });
  return hash;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

// Strict allowlist for git remote URLs. Rejects anything containing shell
// metachars or whitespace so the URL is safe to pass as an argv slot even
// when downstream tooling re-emits it via a shell.
//   - scheme URL: https://host/path , git://host/path , ssh://user@host/path
//   - scp-style:  git@host:owner/repo.git
const GIT_URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[A-Za-z0-9._~%@:/?#\-+]+$/;
const GIT_URL_SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/~\-+]+$/;
const GIT_URL_FORBIDDEN_RE = /[\s;`$|&<>(){}\\"']/;

/**
 * Validate that a string is a safe git remote URL.
 * Throws on shell metachars or unrecognized format. Returns the URL on success.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function assertSafeGitUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('assertSafeGitUrl: url must be a non-empty string');
  }
  if (url.length > 2048) {
    throw new Error('assertSafeGitUrl: url too long');
  }
  if (GIT_URL_FORBIDDEN_RE.test(url)) {
    throw new Error(`assertSafeGitUrl: url contains forbidden characters: ${url}`);
  }
  if (!GIT_URL_SCHEME_RE.test(url) && !GIT_URL_SCP_RE.test(url)) {
    throw new Error(`assertSafeGitUrl: url is not a recognized git remote: ${url}`);
  }
  return url;
}

/**
 * Run a git subcommand with argv (no shell). Mirrors the prior `runGit` API
 * (string output, trimmed) but is immune to shell metachar injection because
 * `shell: false` and each token is a discrete argv slot.
 *
 * @param {string[]} argv - git subcommand + args (e.g. ['clone', url, dir])
 * @param {string} cwd
 * @returns {string}
 */
function runGit(argv, cwd) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('runGit: argv must be a non-empty array');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error('runGit: every argv slot must be a string');
    }
  }
  const result = spawnSync('git', argv, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    const stdout = (result.stdout || '').toString().trim();
    throw new Error(
      `git ${argv[0]} exited with status ${result.status}: ${stderr || stdout || '(no output)'}`,
    );
  }
  return (result.stdout || '').toString().trim();
}

/**
 * Ensure the swarm repo is cloned locally. Idempotent.
 *
 * @param {string} repoUrl - Git URL of the swarm repo
 * @returns {Promise<{ cloneDir: string, freshClone: boolean }>}
 */
export async function ensureSwarmClone(repoUrl) {
  await ensureDir(ARTIBOT_DIR);
  if (existsSync(path.join(SWARM_CLONE_DIR, '.git'))) {
    return { cloneDir: SWARM_CLONE_DIR, freshClone: false };
  }
  assertSafeGitUrl(repoUrl);
  mkdirSync(SWARM_CLONE_DIR, { recursive: true });
  try {
    runGit(['clone', '--depth', '20', '--', repoUrl, SWARM_CLONE_DIR], ARTIBOT_DIR);
  } catch (err) {
    throw new Error(`swarm clone failed: ${err.message || String(err)}`, { cause: err });
  }
  return { cloneDir: SWARM_CLONE_DIR, freshClone: true };
}

/**
 * Pull the latest changes from the remote swarm repo.
 * Returns `true` if pull succeeded, `false` on conflict/error.
 *
 * @param {string} cloneDir
 * @returns {boolean}
 */
export function pullSwarm(cloneDir) {
  try {
    runGit(['pull', '--rebase', '--autostash', 'origin', 'main'], cloneDir);
    return true;
  } catch {
    try {
      runGit(['pull', '--rebase', '--autostash', 'origin', 'master'], cloneDir);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Commit and push a set of changed files in the swarm clone.
 *
 * @param {string} cloneDir
 * @param {string} message - Commit message
 * @returns {boolean}
 */
export function commitAndPushSwarm(cloneDir, message) {
  try {
    runGit(['add', '-A'], cloneDir);
    const status = runGit(['status', '--porcelain'], cloneDir);
    if (!status) return true; // nothing to commit
    // -m takes the message as a single argv slot — no shell escaping needed.
    // L-2: enforce a hard cap (COMMIT_MESSAGE_MAX_BYTES) so a runaway caller
    // can't blow past the OS argv limit. Slice on character count is a safe
    // upper bound for UTF-8 byte count at our 8KB ceiling.
    const rawMessage = typeof message === 'string' ? message : String(message);
    const safeMessage = rawMessage.length > COMMIT_MESSAGE_MAX_BYTES
      ? rawMessage.slice(0, COMMIT_MESSAGE_MAX_BYTES) + '\n... (truncated)'
      : rawMessage;
    runGit(['commit', '-m', safeMessage], cloneDir);
    try {
      runGit(['push', 'origin', 'HEAD'], cloneDir);
      return true;
    } catch {
      // Push may fail if remote moved; caller will retry on next sync.
      return false;
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Upload / download
// ---------------------------------------------------------------------------

/**
 * Upload local weights to the swarm git repo.
 * Mirrors the contract of `uploadWeights` in `swarm-client.js`.
 *
 * @param {object} weights - Packaged local weights
 * @param {object} [metadata] - Optional metadata
 * @param {object} [options]
 * @param {string} [options.repoUrl] - Override swarm repo URL
 * @returns {Promise<{ success: boolean, version: string|null, queued: boolean, error: string|null }>}
 */
export async function gitUploadWeights(weights, metadata = {}, options = {}) {
  const repoUrl = options.repoUrl;
  if (!repoUrl) {
    return { success: false, version: null, queued: false, error: 'no repoUrl configured' };
  }
  try {
    const { cloneDir } = await ensureSwarmClone(repoUrl);
    pullSwarm(cloneDir); // best-effort; even if it fails we still try to push

    const machineHash = await ensureMachineHash();
    const version = metadata.version || new Date().toISOString();

    const latestPath = path.join(cloneDir, 'patterns', machineHash, 'weights-latest.json');
    const historyPath = path.join(
      cloneDir,
      'patterns',
      machineHash,
      'history',
      `weights-${version.replace(/[:.]/g, '-')}.json`,
    );

    // Privacy chain — mirror swarm-client.uploadWeights so the git backend
    // (the multi-device default) honours the same PII-scrub + DP-noise contract
    // its README and config promise. Step 1 scrub is default-on; Step 2 noise
    // only when the caller (sync-scheduler) supplies an addNoise fn from config.
    const scrubber = typeof options.scrubPii === 'function' ? options.scrubPii : defaultScrubPii;
    let processedWeights = scrubber(weights);
    if (typeof options.addNoise === 'function') {
      processedWeights = options.addNoise(processedWeights);
    }

    const payload = {
      machineHash,
      version,
      uploadedAt: new Date().toISOString(),
      metadata: {
        sampleSize: metadata.sampleSize ?? 0,
        checksum: metadata.checksum ?? null,
      },
      weights: processedWeights,
    };

    await writeJsonFile(latestPath, payload);
    await writeJsonFile(historyPath, payload);

    const pushed = commitAndPushSwarm(
      cloneDir,
      `swarm: upload weights from ${machineHash} (v${version})`,
    );

    if (!pushed) {
      return { success: false, version, queued: true, error: 'push failed — will retry next sync' };
    }
    return { success: true, version, queued: false, error: null };
  } catch (err) {
    return {
      success: false,
      version: null,
      queued: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Download and aggregate the latest weights from all machines in the swarm.
 * Uses read-only git pull — merges weights from every `patterns/{machineHash}/weights-latest.json`.
 *
 * @param {string|null} currentVersion - Local current version (unused for git backend)
 * @param {object} [options]
 * @param {string} [options.repoUrl]
 * @returns {Promise<{ success: boolean, weights: object|null, version: string|null, error: string|null }>}
 */
export async function gitDownloadLatestWeights(currentVersion, options = {}) {
  const repoUrl = options.repoUrl;
  if (!repoUrl) {
    return { success: false, weights: null, version: null, error: 'no repoUrl configured' };
  }
  try {
    const { cloneDir } = await ensureSwarmClone(repoUrl);
    pullSwarm(cloneDir);

    const patternsRoot = path.join(cloneDir, 'patterns');
    if (!existsSync(patternsRoot)) {
      return { success: true, weights: {}, version: null, error: null };
    }

    const { readdirSync, statSync } = await import('node:fs');
    const machineDirs = readdirSync(patternsRoot).filter((name) => {
      try {
        return statSync(path.join(patternsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    });

    const aggregated = {};
    const sources = [];
    const myMachineHash = await ensureMachineHash();

    for (const dir of machineDirs) {
      if (dir === myMachineHash) continue; // skip own uploads — avoids echo
      const latestFile = path.join(patternsRoot, dir, 'weights-latest.json');
      const payload = await readJsonFile(latestFile);
      if (!payload || !payload.weights) continue;
      sources.push({ machineHash: dir, version: payload.version });

      // Shallow merge weights per category/key — caller will re-merge with mergeWeights().
      for (const [category, entries] of Object.entries(payload.weights)) {
        // Both indices come from another machine's weights-latest.json, so both
        // are attacker-controlled if that file is. A category of `__proto__` is
        // not merely a bad key here: `aggregated[category]` READS the inherited
        // accessor and yields Object.prototype, which is truthy — so the
        // `if (!aggregated[category])` guard below never fires, and the inner
        // assignment writes straight onto Object.prototype, process-wide.
        // Verified 2026-08-15: `{"weights":{"__proto__":{"pwned":1}}}` through
        // this loop leaves `({}).pwned === 1` for every object in the process.
        if (isUnsafeWeightKey(category)) continue;
        if (!aggregated[category]) aggregated[category] = {};
        if (typeof entries !== 'object' || entries === null) continue;
        mergeCategoryEntries(aggregated[category], entries);
      }
    }

    const version = sources.length > 0
      ? `git-${new Date().toISOString()}-n${sources.length}`
      : null;

    return { success: true, weights: aggregated, version, error: null };
  } catch (err) {
    return {
      success: false,
      weights: null,
      version: null,
      error: err.message || String(err),
    };
  }
}

/**
 * Quick health check: does the repo clone exist and is the remote reachable?
 *
 * @param {object} [options]
 * @param {string} [options.repoUrl]
 * @returns {Promise<{ ok: boolean, message: string, cloneExists: boolean, canPull: boolean }>}
 */
export async function gitHealthCheck(options = {}) {
  const repoUrl = options.repoUrl;
  if (!repoUrl) {
    return { ok: false, message: 'no repoUrl configured', cloneExists: false, canPull: false };
  }
  const cloneExists = existsSync(path.join(SWARM_CLONE_DIR, '.git'));
  if (!cloneExists) {
    return { ok: false, message: 'clone not initialized — run swarm init', cloneExists: false, canPull: false };
  }
  const canPull = pullSwarm(SWARM_CLONE_DIR);
  return {
    ok: canPull,
    message: canPull ? 'ok' : 'pull failed',
    cloneExists,
    canPull,
  };
}
