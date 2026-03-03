/**
 * Storage abstraction for Federated Swarm server.
 *
 * Provides in-memory store (default) and optional Cloud Firestore adapter.
 * Cloud Run containers are stateless, so in-memory data is lost on restart.
 * For persistence, set FIRESTORE_PROJECT_ID env var to enable Firestore.
 *
 * @module server/store
 */

import { createHash } from 'node:crypto';
import {
  flushAll,
  initDataDir,
  mapToObject,
  objectToMap,
  readData,
  scheduleSave,
} from './file-store.js';

// ---------------------------------------------------------------------------
// In-Memory Store
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} Version -> weight snapshot */
let weightVersions = new Map();

/** @type {object|null} Current merged global weights */
let currentGlobalWeights = null;

/** @type {number} Monotonic version counter */
let versionCounter = 0;

/** @type {Map<string, object>} clientId -> stats */
let clientStats = new Map();

/** @type {object[]} Telemetry records (capped) */
const telemetryRecords = [];

/** Max telemetry records to keep in memory */
const MAX_TELEMETRY = 10000;

/** Max weight versions to keep */
const MAX_VERSIONS = 100;

/** Whether file persistence is available */
let persistenceEnabled = false;

// ---------------------------------------------------------------------------
// File Persistence Layer
// ---------------------------------------------------------------------------

const DATA_FILES = {
  WEIGHTS: 'weights.json',
  STATS: 'client-stats.json',
  TELEMETRY: 'telemetry.json',
  GLOBAL: 'global-weights.json',
};

/** Data providers for flushAll (graceful shutdown) */
const dataProviders = new Map([
  [DATA_FILES.WEIGHTS, () => ({
    versionCounter,
    snapshots: mapToObject(weightVersions),
  })],
  [DATA_FILES.STATS, () => mapToObject(clientStats)],
  [DATA_FILES.TELEMETRY, () => telemetryRecords],
  [DATA_FILES.GLOBAL, () => currentGlobalWeights],
]);

/**
 * Schedule a debounced save for a data file.
 * @param {string} filename
 */
function persist(filename) {
  if (!persistenceEnabled) return;
  const provider = dataProviders.get(filename);
  if (provider) scheduleSave(filename, provider);
}

/**
 * Initialize the store, loading persisted data from disk if available.
 * Call once at server startup.
 *
 * @returns {boolean} true if persistence is available
 */
export function initStore() {
  persistenceEnabled = initDataDir();

  if (!persistenceEnabled) return false;

  // Restore weights
  const savedWeights = readData(DATA_FILES.WEIGHTS);
  if (savedWeights && typeof savedWeights === 'object') {
    versionCounter = savedWeights.versionCounter ?? 0;
    if (savedWeights.snapshots) {
      weightVersions = objectToMap(savedWeights.snapshots);
    }
  }

  // Restore client stats
  const savedStats = readData(DATA_FILES.STATS);
  if (savedStats && typeof savedStats === 'object') {
    clientStats = objectToMap(savedStats);
  }

  // Restore telemetry
  const savedTelemetry = readData(DATA_FILES.TELEMETRY);
  if (Array.isArray(savedTelemetry)) {
    telemetryRecords.push(...savedTelemetry.slice(-MAX_TELEMETRY));
  }

  // Restore global weights
  const savedGlobal = readData(DATA_FILES.GLOBAL);
  if (savedGlobal && typeof savedGlobal === 'object') {
    currentGlobalWeights = savedGlobal;
  }

  return true;
}

/**
 * Flush all pending saves to disk synchronously.
 * Call during graceful shutdown.
 *
 * @returns {number} Number of files flushed
 */
export function flushStore() {
  if (!persistenceEnabled) return 0;
  return flushAll(dataProviders);
}

// ---------------------------------------------------------------------------
// Weight Storage
// ---------------------------------------------------------------------------

/**
 * Store uploaded weights and return the new version.
 *
 * @param {object} weights - Weight data
 * @param {object} metadata - Upload metadata (clientId, checksum, etc.)
 * @returns {{ version: string, timestamp: string }}
 */
export function storeWeights(weights, metadata) {
  versionCounter++;
  const version = `v${versionCounter}`;
  const timestamp = new Date().toISOString();

  const snapshot = {
    weights,
    metadata: { ...metadata, version, storedAt: timestamp },
    version,
    timestamp,
  };

  weightVersions.set(version, snapshot);

  // Prune old versions
  if (weightVersions.size > MAX_VERSIONS) {
    const oldest = weightVersions.keys().next().value;
    weightVersions.delete(oldest);
  }

  // Track client contribution
  const clientId = metadata?.clientId ?? 'anonymous';
  const stats = clientStats.get(clientId) ?? { uploads: 0, downloads: 0, firstSeen: timestamp };
  stats.uploads++;
  stats.lastUpload = timestamp;
  clientStats.set(clientId, stats);

  persist(DATA_FILES.WEIGHTS);
  persist(DATA_FILES.STATS);

  return { version, timestamp };
}

/**
 * Get the current global merged weights.
 *
 * @returns {object|null}
 */
export function getGlobalWeights() {
  return currentGlobalWeights;
}

/**
 * Set the global merged weights after FedAvg.
 *
 * @param {object} weights
 */
export function setGlobalWeights(weights) {
  currentGlobalWeights = weights;
  persist(DATA_FILES.GLOBAL);
}

/**
 * Get the latest weight snapshot.
 *
 * @returns {{ weights: object, version: string, checksum: string }|null}
 */
export function getLatestWeights() {
  if (!currentGlobalWeights) return null;

  const checksum = createHash('sha256')
    .update(JSON.stringify(currentGlobalWeights))
    .digest('hex');

  return {
    weights: currentGlobalWeights,
    version: `v${versionCounter}`,
    checksum,
  };
}

/**
 * Compute a diff between two versions for delta download.
 *
 * @param {string} sinceVersion - Client's current version
 * @returns {{ weights: object, version: string, checksum: string, diff?: object }|null}
 */
export function getWeightsSince(sinceVersion) {
  const latest = getLatestWeights();
  if (!latest) return null;

  const sinceSnapshot = weightVersions.get(sinceVersion);
  if (!sinceSnapshot) {
    // Client version unknown - return full weights
    return latest;
  }

  // Compute diff: keys that changed
  const diff = computeDiff(sinceSnapshot.weights, latest.weights);

  return {
    ...latest,
    diff,
  };
}

/**
 * Get all stored weight snapshots for FedAvg computation.
 *
 * @param {number} [limit] - Max snapshots to return (most recent)
 * @returns {object[]}
 */
export function getRecentWeightSnapshots(limit = 50) {
  const all = Array.from(weightVersions.values());
  return limit ? all.slice(-limit) : all;
}

// ---------------------------------------------------------------------------
// Telemetry Storage
// ---------------------------------------------------------------------------

/**
 * Store a telemetry record.
 *
 * @param {object} stats - Anonymous usage statistics
 */
export function storeTelemetry(stats) {
  telemetryRecords.push({
    ...stats,
    receivedAt: new Date().toISOString(),
  });

  // Cap size
  if (telemetryRecords.length > MAX_TELEMETRY) {
    telemetryRecords.splice(0, telemetryRecords.length - MAX_TELEMETRY);
  }

  persist(DATA_FILES.TELEMETRY);
}

/**
 * Get telemetry summary.
 *
 * @returns {object}
 */
export function getTelemetrySummary() {
  return {
    totalRecords: telemetryRecords.length,
    recentRecords: telemetryRecords.slice(-10),
  };
}

// ---------------------------------------------------------------------------
// Client Stats
// ---------------------------------------------------------------------------

/**
 * Get contribution stats for a client.
 *
 * @param {string} clientId
 * @returns {{ uploads: number, downloads: number, rank: number|null }}
 */
export function getClientStats(clientId) {
  const stats = clientStats.get(clientId);
  if (!stats) return null;

  // Compute rank based on upload count
  const allUploads = Array.from(clientStats.values())
    .map((s) => s.uploads)
    .sort((a, b) => b - a);
  const rank = allUploads.indexOf(stats.uploads) + 1;

  return {
    uploads: stats.uploads,
    downloads: stats.downloads,
    rank,
    firstSeen: stats.firstSeen,
    lastUpload: stats.lastUpload,
  };
}

/**
 * Record a download for stats tracking.
 *
 * @param {string} clientId
 */
export function recordDownload(clientId) {
  if (!clientId) return;
  const stats = clientStats.get(clientId) ?? { uploads: 0, downloads: 0, firstSeen: new Date().toISOString() };
  stats.downloads++;
  stats.lastDownload = new Date().toISOString();
  clientStats.set(clientId, stats);
  persist(DATA_FILES.STATS);
}

// ---------------------------------------------------------------------------
// Health / Info
// ---------------------------------------------------------------------------

/**
 * Get server info for health check.
 *
 * @returns {object}
 */
export function getServerInfo() {
  return {
    totalClients: clientStats.size,
    totalVersions: weightVersions.size,
    currentVersion: versionCounter > 0 ? `v${versionCounter}` : null,
    totalTelemetry: telemetryRecords.length,
    memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

// ---------------------------------------------------------------------------
// Diff Computation
// ---------------------------------------------------------------------------

/**
 * Compute a shallow diff between old and new weight objects.
 *
 * @param {object} oldWeights
 * @param {object} newWeights
 * @returns {object} Diff object with added/changed/removed keys
 */
function computeDiff(oldWeights, newWeights) {
  const diff = { added: {}, changed: {}, removed: {} };

  for (const category of ['tools', 'errors', 'commands', 'teams']) {
    const oldCat = oldWeights?.[category] ?? {};
    const newCat = newWeights?.[category] ?? {};

    diff.added[category] = {};
    diff.changed[category] = {};
    diff.removed[category] = {};

    // Find added and changed
    for (const key of Object.keys(newCat)) {
      if (!(key in oldCat)) {
        diff.added[category][key] = newCat[key];
      } else if (JSON.stringify(oldCat[key]) !== JSON.stringify(newCat[key])) {
        diff.changed[category][key] = newCat[key];
      }
    }

    // Find removed
    for (const key of Object.keys(oldCat)) {
      if (!(key in newCat)) {
        diff.removed[category][key] = true;
      }
    }
  }

  return diff;
}
