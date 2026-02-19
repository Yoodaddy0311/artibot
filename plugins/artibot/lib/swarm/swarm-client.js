/**
 * Swarm Client - HTTP client for Federated Swarm Intelligence server.
 *
 * Handles weight upload/download, telemetry reporting, health checks,
 * and contribution stats. Includes retry logic with exponential backoff,
 * offline queueing, delta downloads, and integrity verification.
 *
 * Zero external dependencies - uses node:crypto for checksums.
 *
 * @module lib/swarm/swarm-client
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';
import { scrubPattern as defaultScrubPii } from '../privacy/pii-scrubber.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFFLINE_QUEUE_PATH = path.join(ARTIBOT_DIR, 'swarm-offline-queue.json');

/** Maximum retry attempts for failed requests */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_DELAY_MS = 1000;

/** Request timeout (ms) */
const REQUEST_TIMEOUT_MS = 30000;

/** Maximum offline queue entries */
const MAX_QUEUE_SIZE = 100;

/** Maximum upload size in bytes (5MB default) */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Server URL Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the swarm server URL from environment or config.
 *
 * @param {object} [config] - Optional swarm config section
 * @returns {string} Server URL
 */
function resolveServerUrl(config) {
  return (
    process.env.ARTIBOT_SWARM_SERVER ||
    config?.serverUrl ||
    'https://artibot-swarm-249539591811.asia-northeast3.run.app'
  );
}

// ---------------------------------------------------------------------------
// HTTP Helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request with timeout using native fetch.
 *
 * @param {string} url - Full URL
 * @param {object} options - Fetch options
 * @param {number} [timeoutMs] - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a request with exponential backoff retry logic.
 *
 * @param {() => Promise<Response>} requestFn - Function that returns a fetch promise
 * @param {number} [maxRetries] - Maximum retries
 * @returns {Promise<object>} Parsed JSON response
 */
async function withRetry(requestFn, maxRetries = MAX_RETRIES) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await requestFn();

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        err.status = response.status;

        // Don't retry 4xx (client errors) except 429 (rate limit)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw err;
        }
        lastError = err;
      } else {
        return await response.json();
      }
    } catch (err) {
      lastError = err;

      // Don't retry non-retryable errors
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
    }

    if (attempt < maxRetries) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Request failed after retries');
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 checksum of data.
 *
 * @param {object|string} data - Data to hash
 * @returns {string} Hex-encoded SHA-256 hash
 */
function computeChecksum(data) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Verify data integrity against expected checksum.
 *
 * @param {object|string} data - Data to verify
 * @param {string} expectedChecksum - Expected SHA-256 hex
 * @returns {boolean}
 */
function verifyChecksum(data, expectedChecksum) {
  return computeChecksum(data) === expectedChecksum;
}

// ---------------------------------------------------------------------------
// Offline Queue
// ---------------------------------------------------------------------------

/**
 * Load the offline queue from disk.
 *
 * @returns {Promise<object[]>}
 */
async function loadOfflineQueue() {
  const data = await readJsonFile(OFFLINE_QUEUE_PATH);
  return Array.isArray(data) ? data : [];
}

/**
 * Save the offline queue to disk.
 *
 * @param {object[]} queue
 * @returns {Promise<void>}
 */
async function saveOfflineQueue(queue) {
  await ensureDir(ARTIBOT_DIR);
  const pruned = queue.length > MAX_QUEUE_SIZE
    ? queue.slice(queue.length - MAX_QUEUE_SIZE)
    : queue;
  await writeJsonFile(OFFLINE_QUEUE_PATH, pruned);
}

/**
 * Enqueue an upload for later when offline.
 *
 * @param {object} weights - Weight data
 * @param {object} metadata - Upload metadata
 * @returns {Promise<void>}
 */
async function enqueueOfflineUpload(weights, metadata) {
  const queue = await loadOfflineQueue();
  queue.push({
    type: 'upload',
    weights,
    metadata,
    queuedAt: new Date().toISOString(),
  });
  await saveOfflineQueue(queue);
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Upload processed weights to the swarm server.
 *
 * Applies PII scrubbing and differential privacy noise before upload.
 * Falls back to offline queue when network is unavailable.
 *
 * @param {object} weights - Normalized weight data
 * @param {object} [metadata] - Upload metadata
 * @param {string} [metadata.clientId] - Anonymous client identifier
 * @param {string} [metadata.version] - Current local version
 * @param {number} [metadata.sampleSize] - Number of experiences used
 * @param {object} [options] - Upload options
 * @param {object} [options.config] - Swarm config section
 * @param {function} [options.scrubPii] - PII scrubber function
 * @param {function} [options.addNoise] - Differential privacy noise function
 * @returns {Promise<{ success: boolean, version?: string, timestamp?: string, queued?: boolean, error?: string }>}
 */
export async function uploadWeights(weights, metadata = {}, options = {}) {
  if (!weights || typeof weights !== 'object') {
    return { success: false, error: 'Invalid weights data' };
  }

  const serialized = JSON.stringify(weights);
  if (serialized.length > MAX_UPLOAD_BYTES) {
    return { success: false, error: `Payload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` };
  }

  // Step 1: PII scrubbing (default-on: always applied unless caller overrides)
  const scrubber = typeof options.scrubPii === 'function' ? options.scrubPii : defaultScrubPii;
  let processedWeights = scrubber(weights);

  // Step 2: Differential privacy noise
  if (typeof options.addNoise === 'function') {
    processedWeights = options.addNoise(processedWeights);
  }

  const checksum = computeChecksum(processedWeights);
  const serverUrl = resolveServerUrl(options.config);

  const payload = {
    weights: processedWeights,
    metadata: {
      ...metadata,
      checksum,
      uploadedAt: new Date().toISOString(),
    },
  };

  try {
    const result = await withRetry(() =>
      fetchWithTimeout(`${serverUrl}/api/v1/weights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    return {
      success: true,
      version: result.version ?? null,
      timestamp: result.timestamp ?? new Date().toISOString(),
    };
  } catch (err) {
    // Network unavailable - queue for later
    if (err.name === 'AbortError' || err.message?.includes('fetch')) {
      await enqueueOfflineUpload(processedWeights, { ...metadata, checksum });
      return { success: false, queued: true, error: 'Offline - queued for later upload' };
    }

    return { success: false, error: err.message };
  }
}

/**
 * Download the latest global weights from the swarm server.
 *
 * Supports delta downloads when a current version is provided.
 * Verifies integrity via checksum before returning.
 *
 * @param {string} [currentVersion] - Current local version for delta download
 * @param {object} [options] - Download options
 * @param {object} [options.config] - Swarm config section
 * @returns {Promise<{ success: boolean, weights?: object, version?: string, diff?: object, error?: string }>}
 */
export async function downloadLatestWeights(currentVersion, options = {}) {
  const serverUrl = resolveServerUrl(options.config);
  const params = new URLSearchParams();
  if (currentVersion) {
    params.set('since', currentVersion);
  }

  const url = `${serverUrl}/api/v1/weights/latest${params.toString() ? '?' + params.toString() : ''}`;

  try {
    const result = await withRetry(() =>
      fetchWithTimeout(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }),
    );

    // Verify integrity
    if (result.checksum && result.weights) {
      if (!verifyChecksum(result.weights, result.checksum)) {
        return { success: false, error: 'Checksum verification failed' };
      }
    }

    return {
      success: true,
      weights: result.weights ?? null,
      version: result.version ?? null,
      ...(result.diff && { diff: result.diff }),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Report anonymous usage telemetry to the swarm server.
 *
 * @param {object} stats - Anonymous usage statistics
 * @param {number} [stats.sessionsCompleted] - Number of sessions
 * @param {number} [stats.tasksCompleted] - Number of tasks
 * @param {number} [stats.avgConfidence] - Average pattern confidence
 * @param {string} [stats.platformOs] - OS platform
 * @param {object} [options] - Options
 * @param {object} [options.config] - Swarm config section
 * @returns {Promise<void>}
 */
export async function reportTelemetry(stats, options = {}) {
  if (!stats || typeof stats !== 'object') return;

  const serverUrl = resolveServerUrl(options.config);

  try {
    await withRetry(() =>
      fetchWithTimeout(`${serverUrl}/api/v1/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stats,
          reportedAt: new Date().toISOString(),
        }),
      }),
    );
  } catch {
    // Telemetry is best-effort, silently ignore failures
  }
}

/**
 * Check swarm server health and latency.
 *
 * @param {object} [options] - Options
 * @param {object} [options.config] - Swarm config section
 * @returns {Promise<{ status: string, latency: number }>}
 */
export async function checkHealth(options = {}) {
  const serverUrl = resolveServerUrl(options.config);
  const start = performance.now();

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/v1/health`,
      { method: 'GET' },
      10000,
    );

    const latency = Math.round(performance.now() - start);

    if (response.ok) {
      return { status: 'healthy', latency };
    }

    return { status: 'degraded', latency };
  } catch {
    const latency = Math.round(performance.now() - start);
    return { status: 'unreachable', latency };
  }
}

/**
 * Get contribution statistics for the current client.
 *
 * @param {string} [clientId] - Anonymous client identifier
 * @param {object} [options] - Options
 * @param {object} [options.config] - Swarm config section
 * @returns {Promise<{ success: boolean, uploads?: number, downloads?: number, rank?: number, error?: string }>}
 */
export async function getContributionStats(clientId, options = {}) {
  if (!clientId) {
    return { success: false, error: 'Client ID required' };
  }

  const serverUrl = resolveServerUrl(options.config);

  try {
    const result = await withRetry(() =>
      fetchWithTimeout(`${serverUrl}/api/v1/stats/${clientId}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }),
    );

    return {
      success: true,
      uploads: result.uploads ?? 0,
      downloads: result.downloads ?? 0,
      rank: result.rank ?? null,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Flush the offline queue by re-attempting queued uploads.
 *
 * @param {object} [options] - Options
 * @param {object} [options.config] - Swarm config section
 * @returns {Promise<{ flushed: number, remaining: number, errors: string[] }>}
 */
export async function flushOfflineQueue(options = {}) {
  const queue = await loadOfflineQueue();
  if (queue.length === 0) {
    return { flushed: 0, remaining: 0, errors: [] };
  }

  const remaining = [];
  const errors = [];
  let flushed = 0;

  for (const item of queue) {
    if (item.type === 'upload') {
      const result = await uploadWeights(item.weights, item.metadata, options);
      if (result.success) {
        flushed++;
      } else if (result.queued) {
        // Still offline, keep in queue but don't re-add
        remaining.push(item);
      } else {
        errors.push(result.error ?? 'Unknown upload error');
      }
    }
  }

  await saveOfflineQueue(remaining);

  return { flushed, remaining: remaining.length, errors };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { computeChecksum, verifyChecksum };
