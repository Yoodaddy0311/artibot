/**
 * Artibot Federated Swarm Server
 *
 * Lightweight HTTP server for federated weight sharing.
 * Designed for GCP Cloud Run free tier (zero external deps).
 *
 * Endpoints:
 *   POST   /api/v1/weights           - Upload client weights
 *   GET    /api/v1/weights/latest     - Download global weights (?since=v1 for delta)
 *   POST   /api/v1/telemetry         - Report anonymous telemetry
 *   GET    /api/v1/health             - Health check
 *   GET    /api/v1/stats/:clientId    - Contribution stats
 *
 * Environment:
 *   PORT              - Listen port (default: 8080, Cloud Run standard)
 *   MAX_UPLOAD_BYTES  - Upload size limit (default: 5MB)
 *   FEDAVG_WINDOW     - Snapshots for FedAvg (default: 50)
 *
 * @module server
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  storeWeights,
  getLatestWeights,
  getWeightsSince,
  getRecentWeightSnapshots,
  setGlobalWeights,
  storeTelemetry,
  getClientStats,
  recordDownload,
  getServerInfo,
} from './store.js';
import { federatedAverage } from './merge.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES ?? String(5 * 1024 * 1024), 10);
const FEDAVG_WINDOW = parseInt(process.env.FEDAVG_WINDOW ?? '50', 10);

// Sliding window rate limiter: max requests per window per IP
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT ?? '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const rateLimitStore = new Map(); // IP -> { timestamps: number[] }

// CORS: restrict to allowed origins (comma-separated) or localhost-only fallback
const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

// Authentication: shared-secret bearer token. If not set, only localhost connections are allowed.
const AUTH_TOKEN = process.env.ARTIBOT_SERVER_TOKEN ?? null;

// ---------------------------------------------------------------------------
// HTTP Helpers
// ---------------------------------------------------------------------------

/**
 * Read request body as JSON.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        reject(new Error(`Payload exceeds ${MAX_UPLOAD_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Send JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} data
 * @param {import('node:http').IncomingMessage} [req] - Used to resolve CORS origin
 */
function json(res, status, data, req) {
  const origin = req ? resolveAllowedOrigin(req.headers['origin']) : resolveAllowedOrigin(undefined);
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Extract path parameters from URL pattern.
 *
 * @param {string} pattern - e.g., '/api/v1/stats/:clientId'
 * @param {string} pathname - e.g., '/api/v1/stats/abc123'
 * @returns {object|null} Matched params or null
 */
function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return params;
}

/**
 * Sliding window rate limiter per IP.
 *
 * Maintains an array of request timestamps per IP.
 * On each request, expired timestamps (older than the window) are pruned.
 * If the remaining count exceeds the limit, the request is denied.
 *
 * @param {string} ip - Client IP address
 * @param {number} [limit] - Per-endpoint override (defaults to RATE_LIMIT)
 * @returns {boolean} true if allowed, false if rate limited
 */
function checkRateLimit(ip, limit = RATE_LIMIT) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { timestamps: [] };

  // Remove expired timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (entry.timestamps.length >= limit) {
    rateLimitStore.set(ip, entry);
    return false; // Rate limited
  }

  entry.timestamps.push(now);
  rateLimitStore.set(ip, entry);
  return true;
}

// Periodically clean stale entries from the rate limit store
const _rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    // Remove entries with no recent timestamps
    if (entry.timestamps.length === 0 || now - entry.timestamps[entry.timestamps.length - 1] > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(ip);
    }
  }
}, 60000);
// Allow the process to exit without waiting for the cleanup timer
if (_rateLimitCleanupInterval.unref) _rateLimitCleanupInterval.unref();

/**
 * Resolve the CORS origin for the given request.
 * Returns the matched origin or null if not allowed.
 *
 * @param {string|undefined} origin - Request Origin header
 * @returns {string} Allowed origin value
 */
function resolveAllowedOrigin(origin) {
  // If an explicit allowlist is configured, check against it
  if (CORS_ALLOWED_ORIGINS) {
    if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) return origin;
    return CORS_ALLOWED_ORIGINS[0]; // fallback to first configured origin
  }
  // Default: allow only localhost origins
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return origin;
  }
  return 'http://localhost';
}

/**
 * Check whether the request is from localhost.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isLocalhost(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Authenticate the request via Bearer token or localhost check.
 * When AUTH_TOKEN is set, a matching Authorization header is required.
 * When AUTH_TOKEN is not set, only localhost connections are permitted.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function authenticate(req) {
  if (AUTH_TOKEN) {
    const authHeader = req.headers['authorization'] ?? '';
    return authHeader === `Bearer ${AUTH_TOKEN}`;
  }
  // No token configured: restrict to localhost only
  return isLocalhost(req);
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/weights - Upload weights from a client.
 */
async function handleUploadWeights(req, res) {
  const body = await readBody(req);

  if (!body.weights || typeof body.weights !== 'object') {
    return json(res, 400, { error: 'Missing or invalid weights field' }, req);
  }

  const metadata = body.metadata ?? {};

  // Verify checksum if provided
  if (metadata.checksum) {
    const computed = createHash('sha256')
      .update(JSON.stringify(body.weights))
      .digest('hex');
    if (computed !== metadata.checksum) {
      return json(res, 400, { error: 'Checksum verification failed' }, req);
    }
  }

  // Store the uploaded weights
  const { version, timestamp } = storeWeights(body.weights, metadata);

  // Re-compute global weights via FedAvg
  const snapshots = getRecentWeightSnapshots(FEDAVG_WINDOW);
  if (snapshots.length > 0) {
    const merged = federatedAverage(snapshots);
    setGlobalWeights(merged);
  }

  return json(res, 200, { success: true, version, timestamp }, req);
}

/**
 * GET /api/v1/weights/latest - Download latest global weights.
 * Query: ?since=v1 for delta download
 */
function handleDownloadWeights(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const since = url.searchParams.get('since');

  // Track download
  const clientId = url.searchParams.get('clientId');
  if (clientId) recordDownload(clientId);

  const result = since ? getWeightsSince(since) : getLatestWeights();

  if (!result) {
    return json(res, 200, {
      weights: null,
      version: null,
      message: 'No weights available yet',
    }, req);
  }

  return json(res, 200, result, req);
}

/**
 * POST /api/v1/telemetry - Report anonymous telemetry.
 */
async function handleTelemetry(req, res) {
  const body = await readBody(req);

  if (!body.stats || typeof body.stats !== 'object') {
    return json(res, 400, { error: 'Missing or invalid stats field' }, req);
  }

  storeTelemetry(body.stats);
  return json(res, 200, { success: true }, req);
}

/**
 * GET /api/v1/health - Server health check.
 */
function handleHealth(req, res) {
  const info = getServerInfo();
  json(res, 200, {
    status: 'healthy',
    uptime: Math.round(process.uptime()),
    ...info,
  }, req);
}

/**
 * GET /api/v1/stats/:clientId - Contribution stats.
 */
function handleStats(req, res, params) {
  const { clientId } = params;

  if (!clientId) {
    return json(res, 400, { error: 'Client ID required' }, req);
  }

  const stats = getClientStats(clientId);

  if (!stats) {
    return json(res, 200, {
      uploads: 0,
      downloads: 0,
      rank: null,
      message: 'No contributions found for this client',
    }, req);
  }

  return json(res, 200, stats, req);
}

// ---------------------------------------------------------------------------
// Request Router
// ---------------------------------------------------------------------------

/**
 * Main request handler.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    const origin = resolveAllowedOrigin(req.headers['origin']);
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // Authentication
  if (!authenticate(req)) {
    return json(res, 401, { error: 'Unauthorized' }, req);
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return json(res, 429, { error: 'Rate limit exceeded' }, req);
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // POST /api/v1/weights
    if (req.method === 'POST' && pathname === '/api/v1/weights') {
      return await handleUploadWeights(req, res);
    }

    // GET /api/v1/weights/latest
    if (req.method === 'GET' && pathname === '/api/v1/weights/latest') {
      return handleDownloadWeights(req, res);
    }

    // POST /api/v1/telemetry
    if (req.method === 'POST' && pathname === '/api/v1/telemetry') {
      return await handleTelemetry(req, res);
    }

    // GET /api/v1/health
    if (req.method === 'GET' && pathname === '/api/v1/health') {
      return handleHealth(req, res);
    }

    // GET /api/v1/stats/:clientId
    const statsMatch = matchRoute('/api/v1/stats/:clientId', pathname);
    if (req.method === 'GET' && statsMatch) {
      return handleStats(req, res, statsMatch);
    }

    // Root - redirect to health
    if (pathname === '/' || pathname === '') {
      return handleHealth(req, res);
    }

    // 404
    return json(res, 404, { error: 'Not found' }, req);
  } catch (err) {
    console.error(`[ERROR] ${req.method} ${pathname}:`, err.message);

    if (err.message === 'Invalid JSON') {
      return json(res, 400, { error: 'Invalid JSON in request body' }, req);
    }

    if (err.message?.includes('exceeds')) {
      return json(res, 413, { error: err.message }, req);
    }

    return json(res, 500, { error: 'Internal server error' }, req);
  }
}

// ---------------------------------------------------------------------------
// Server Startup
// ---------------------------------------------------------------------------

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`[Artibot Swarm Server] Listening on port ${PORT}`);
  console.log(`[Artibot Swarm Server] FedAvg window: ${FEDAVG_WINDOW} snapshots`);
  console.log(`[Artibot Swarm Server] Max upload: ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(1)}MB`);
  console.log(`[Artibot Swarm Server] Rate limit: ${RATE_LIMIT} req/min per IP`);
  console.log(`[Artibot Swarm Server] Auth: ${AUTH_TOKEN ? 'Bearer token' : 'localhost-only'}`);
  console.log(`[Artibot Swarm Server] CORS: ${CORS_ALLOWED_ORIGINS ? CORS_ALLOWED_ORIGINS.join(', ') : 'localhost-only'}`);
});

// Graceful shutdown for Cloud Run
process.on('SIGTERM', () => {
  console.log('[Artibot Swarm Server] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[Artibot Swarm Server] Server closed');
    process.exit(0);
  });
});

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  handleRequest,
  checkRateLimit,
  rateLimitStore,
  authenticate,
  resolveAllowedOrigin,
  isLocalhost,
  readBody,
  matchRoute,
  RATE_LIMIT_WINDOW_MS,
};
