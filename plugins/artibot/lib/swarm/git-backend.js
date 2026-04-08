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
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWARM_CLONE_DIR = path.join(ARTIBOT_DIR, 'swarm-git');
const MACHINE_HASH_PATH = path.join(ARTIBOT_DIR, 'swarm-machine-hash.json');

/** Git command timeout (ms) */
const GIT_TIMEOUT_MS = 30_000;

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

function runGit(args, cwd) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
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
  mkdirSync(SWARM_CLONE_DIR, { recursive: true });
  try {
    runGit(`clone --depth 20 ${repoUrl} "${SWARM_CLONE_DIR}"`, ARTIBOT_DIR);
  } catch (err) {
    throw new Error(`swarm clone failed: ${err.message || String(err)}`);
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
    runGit('pull --rebase --autostash origin main', cloneDir);
    return true;
  } catch {
    try {
      runGit('pull --rebase --autostash origin master', cloneDir);
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
    runGit('add -A', cloneDir);
    const status = runGit('status --porcelain', cloneDir);
    if (!status) return true; // nothing to commit
    runGit(`commit -m "${message.replace(/"/g, '\\"')}"`, cloneDir);
    try {
      runGit('push origin HEAD', cloneDir);
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

    const payload = {
      machineHash,
      version,
      uploadedAt: new Date().toISOString(),
      metadata: {
        sampleSize: metadata.sampleSize ?? 0,
        checksum: metadata.checksum ?? null,
      },
      weights,
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
        if (!aggregated[category]) aggregated[category] = {};
        if (typeof entries !== 'object' || entries === null) continue;
        for (const [key, value] of Object.entries(entries)) {
          // Naive last-write-wins; merge-weights will do proper averaging downstream.
          aggregated[category][key] = value;
        }
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
