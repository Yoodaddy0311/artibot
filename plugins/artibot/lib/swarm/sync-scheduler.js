/**
 * Sync Scheduler - Manages synchronization timing for swarm intelligence.
 *
 * Schedules weight uploads at session end and downloads at session start.
 * Supports configurable intervals and manual force-sync.
 *
 * Zero external dependencies.
 *
 * @module lib/swarm/sync-scheduler
 */

import path from 'node:path';
import os from 'node:os';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';
import { uploadWeights, downloadLatestWeights, flushOfflineQueue } from './swarm-client.js';
import { packagePatterns, unpackWeights, mergeWeights } from './pattern-packager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARTIBOT_DIR = path.join(os.homedir(), '.claude', 'artibot');
const SYNC_STATE_PATH = path.join(ARTIBOT_DIR, 'swarm-sync-state.json');
const MERGED_WEIGHTS_PATH = path.join(ARTIBOT_DIR, 'swarm-merged-weights.json');

/** Default sync interval */
const DEFAULT_INTERVAL = 'session';

/** Periodic sync intervals in ms */
const INTERVAL_MS = {
  session: null, // Manual trigger only
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setTimeout> | null} */
let _syncTimer = null;

/** @type {boolean} */
let _syncInProgress = false;

// ---------------------------------------------------------------------------
// Sync State Persistence
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SyncState
 * @property {string|null} lastUpload - ISO timestamp of last upload
 * @property {string|null} lastDownload - ISO timestamp of last download
 * @property {number} pendingUploads - Count of queued offline uploads
 * @property {string|null} nextSync - ISO timestamp of next scheduled sync
 * @property {string|null} currentVersion - Current local weight version
 * @property {string} interval - Sync interval setting
 * @property {number} totalUploads - Total successful uploads
 * @property {number} totalDownloads - Total successful downloads
 */

/**
 * Load sync state from disk.
 *
 * @returns {Promise<SyncState>}
 */
async function loadSyncState() {
  const data = await readJsonFile(SYNC_STATE_PATH);
  return {
    lastUpload: data?.lastUpload ?? null,
    lastDownload: data?.lastDownload ?? null,
    pendingUploads: data?.pendingUploads ?? 0,
    nextSync: data?.nextSync ?? null,
    currentVersion: data?.currentVersion ?? null,
    interval: data?.interval ?? DEFAULT_INTERVAL,
    totalUploads: data?.totalUploads ?? 0,
    totalDownloads: data?.totalDownloads ?? 0,
  };
}

/**
 * Save sync state to disk.
 *
 * @param {SyncState} state
 * @returns {Promise<void>}
 */
async function saveSyncState(state) {
  await ensureDir(ARTIBOT_DIR);
  await writeJsonFile(SYNC_STATE_PATH, state);
}

// ---------------------------------------------------------------------------
// Schedule Management
// ---------------------------------------------------------------------------

/**
 * Schedule periodic synchronization.
 *
 * Sets up a timer for automatic sync at the configured interval.
 * Use 'session' interval for manual-only sync (session start/end hooks).
 *
 * @param {object} [options]
 * @param {string} [options.interval] - 'session' | 'hourly' | 'daily'
 * @param {object} [options.config] - Swarm config section
 * @param {function} [options.scrubPii] - PII scrubber function
 * @param {function} [options.addNoise] - Differential privacy noise function
 * @returns {Promise<{ scheduled: boolean, interval: string, nextSync: string|null }>}
 */
export async function scheduleSync(options = {}) {
  const interval = options.interval ?? DEFAULT_INTERVAL;

  // Clear existing timer
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }

  const state = await loadSyncState();
  state.interval = interval;

  const intervalMs = INTERVAL_MS[interval];

  if (intervalMs) {
    const nextSync = new Date(Date.now() + intervalMs).toISOString();
    state.nextSync = nextSync;

    _syncTimer = setTimeout(async () => {
      await performSync(options);
      // Re-schedule after sync completes
      await scheduleSync(options);
    }, intervalMs);

    await saveSyncState(state);

    return { scheduled: true, interval, nextSync };
  }

  // Session-based: no timer, manual trigger
  state.nextSync = null;
  await saveSyncState(state);

  return { scheduled: false, interval, nextSync: null };
}

/**
 * Cancel any scheduled sync timer.
 *
 * @returns {void}
 */
export function cancelSync() {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Sync Execution
// ---------------------------------------------------------------------------

/**
 * Force an immediate synchronization cycle.
 *
 * Performs both upload and download in sequence:
 * 1. Flush offline queue
 * 2. Package and upload local patterns
 * 3. Download latest global weights
 * 4. Merge global weights into local patterns
 *
 * @param {object} [options]
 * @param {object} [options.config] - Swarm config section
 * @param {function} [options.scrubPii] - PII scrubber function
 * @param {function} [options.addNoise] - Differential privacy noise function
 * @param {number[]} [options.mergeRatio] - [local, global] ratio
 * @returns {Promise<{
 *   success: boolean,
 *   uploaded: boolean,
 *   downloaded: boolean,
 *   merged: boolean,
 *   flushed: number,
 *   version: string|null,
 *   error: string|null
 * }>}
 */
export async function forceSync(options = {}) {
  return performSync(options);
}

/**
 * Internal sync execution.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function performSync(options = {}) {
  if (_syncInProgress) {
    return {
      success: false,
      uploaded: false,
      downloaded: false,
      merged: false,
      flushed: 0,
      version: null,
      error: 'Sync already in progress',
    };
  }

  _syncInProgress = true;

  try {
    const state = await loadSyncState();
    let uploaded = false;
    let downloaded = false;
    let merged = false;
    let flushed = 0;
    let version = state.currentVersion;

    // Step 1: Flush offline queue
    const flushResult = await flushOfflineQueue({ config: options.config });
    flushed = flushResult.flushed;
    state.pendingUploads = flushResult.remaining;

    // Step 2: Package and upload local patterns
    const packaged = await packagePatterns();
    if (packaged.metadata.packagedCount > 0) {
      const uploadResult = await uploadWeights(
        packaged.weights,
        {
          version: state.currentVersion,
          sampleSize: packaged.metadata.patternCount,
          checksum: packaged.checksum,
        },
        {
          config: options.config,
          scrubPii: options.scrubPii,
          addNoise: options.addNoise,
        },
      );

      if (uploadResult.success) {
        uploaded = true;
        state.lastUpload = new Date().toISOString();
        state.totalUploads++;
        if (uploadResult.version) {
          version = uploadResult.version;
        }
      } else if (uploadResult.queued) {
        state.pendingUploads++;
      }
    }

    // Step 3: Download latest global weights
    const downloadResult = await downloadLatestWeights(
      state.currentVersion,
      { config: options.config },
    );

    if (downloadResult.success && downloadResult.weights) {
      downloaded = true;
      state.lastDownload = new Date().toISOString();
      state.totalDownloads++;

      if (downloadResult.version) {
        version = downloadResult.version;
      }

      // Step 4: Merge global weights into local
      const globalPatterns = unpackWeights(downloadResult.weights);
      if (globalPatterns.length > 0) {
        const localWeights = packaged.weights;
        const mergedWeights = mergeWeights(
          localWeights,
          downloadResult.weights,
          options.mergeRatio,
        );

        await writeJsonFile(MERGED_WEIGHTS_PATH, {
          weights: mergedWeights,
          mergedAt: new Date().toISOString(),
          localVersion: state.currentVersion,
          globalVersion: downloadResult.version,
        });

        merged = true;
      }
    }

    state.currentVersion = version;
    await saveSyncState(state);

    return {
      success: true,
      uploaded,
      downloaded,
      merged,
      flushed,
      version,
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      uploaded: false,
      downloaded: false,
      merged: false,
      flushed: 0,
      version: null,
      error: err.message,
    };
  } finally {
    _syncInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Session Hooks
// ---------------------------------------------------------------------------

/**
 * Hook for session start: download latest weights.
 *
 * @param {object} [options]
 * @param {object} [options.config] - Swarm config section
 * @returns {Promise<{ downloaded: boolean, version: string|null }>}
 */
export async function onSessionStart(options = {}) {
  const state = await loadSyncState();

  const result = await downloadLatestWeights(
    state.currentVersion,
    { config: options.config },
  );

  if (result.success && result.weights) {
    state.lastDownload = new Date().toISOString();
    state.totalDownloads++;
    if (result.version) {
      state.currentVersion = result.version;
    }

    // Merge into local
    const mergedWeights = mergeWeights(
      (await packagePatterns()).weights,
      result.weights,
      options.mergeRatio,
    );

    await writeJsonFile(MERGED_WEIGHTS_PATH, {
      weights: mergedWeights,
      mergedAt: new Date().toISOString(),
      globalVersion: result.version,
    });

    await saveSyncState(state);
    return { downloaded: true, version: result.version ?? null };
  }

  return { downloaded: false, version: state.currentVersion };
}

/**
 * Hook for session end: upload local patterns.
 *
 * @param {object} [options]
 * @param {object} [options.config] - Swarm config section
 * @param {function} [options.scrubPii] - PII scrubber function
 * @param {function} [options.addNoise] - Differential privacy noise function
 * @returns {Promise<{ uploaded: boolean, version: string|null, queued: boolean }>}
 */
export async function onSessionEnd(options = {}) {
  const state = await loadSyncState();

  // Flush offline queue first
  await flushOfflineQueue({ config: options.config });

  const packaged = await packagePatterns();
  if (packaged.metadata.packagedCount === 0) {
    return { uploaded: false, version: state.currentVersion, queued: false };
  }

  const result = await uploadWeights(
    packaged.weights,
    {
      version: state.currentVersion,
      sampleSize: packaged.metadata.patternCount,
      checksum: packaged.checksum,
    },
    {
      config: options.config,
      scrubPii: options.scrubPii,
      addNoise: options.addNoise,
    },
  );

  if (result.success) {
    state.lastUpload = new Date().toISOString();
    state.totalUploads++;
    if (result.version) {
      state.currentVersion = result.version;
    }
    await saveSyncState(state);
    return { uploaded: true, version: result.version ?? null, queued: false };
  }

  if (result.queued) {
    state.pendingUploads++;
    await saveSyncState(state);
    return { uploaded: false, version: state.currentVersion, queued: true };
  }

  return { uploaded: false, version: state.currentVersion, queued: false };
}

// ---------------------------------------------------------------------------
// Status Query
// ---------------------------------------------------------------------------

/**
 * Get current synchronization status.
 *
 * @returns {Promise<SyncState>}
 */
export async function getSyncStatus() {
  return loadSyncState();
}
