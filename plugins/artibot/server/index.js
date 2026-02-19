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

// Simple rate limiter: max requests per minute per IP
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT ?? '60', 10);
const rateLimitMap = new Map();

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
      } catch (err) {
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
 */
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
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
 * Simple per-IP rate limiter.
 *
 * @param {string} ip
 * @returns {boolean} true if allowed
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const window = rateLimitMap.get(ip);

  if (!window || now - window.start > 60000) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }

  window.count++;
  return window.count <= RATE_LIMIT;
}

// Periodically clean rate limit map
setInterval(() => {
  const now = Date.now();
  for (const [ip, window] of rateLimitMap) {
    if (now - window.start > 120000) rateLimitMap.delete(ip);
  }
}, 60000);

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/weights - Upload weights from a client.
 */
async function handleUploadWeights(req, res) {
  const body = await readBody(req);

  if (!body.weights || typeof body.weights !== 'object') {
    return json(res, 400, { error: 'Missing or invalid weights field' });
  }

  const metadata = body.metadata ?? {};

  // Verify checksum if provided
  if (metadata.checksum) {
    const computed = createHash('sha256')
      .update(JSON.stringify(body.weights))
      .digest('hex');
    if (computed !== metadata.checksum) {
      return json(res, 400, { error: 'Checksum verification failed' });
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

  json(res, 200, { success: true, version, timestamp });
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
    });
  }

  json(res, 200, result);
}

/**
 * POST /api/v1/telemetry - Report anonymous telemetry.
 */
async function handleTelemetry(req, res) {
  const body = await readBody(req);

  if (!body.stats || typeof body.stats !== 'object') {
    return json(res, 400, { error: 'Missing or invalid stats field' });
  }

  storeTelemetry(body.stats);
  json(res, 200, { success: true });
}

/**
 * GET /api/v1/health - Server health check.
 */
function handleHealth(_req, res) {
  const info = getServerInfo();
  json(res, 200, {
    status: 'healthy',
    uptime: Math.round(process.uptime()),
    ...info,
  });
}

/**
 * GET /api/v1/stats/:clientId - Contribution stats.
 */
function handleStats(req, res, params) {
  const { clientId } = params;

  if (!clientId) {
    return json(res, 400, { error: 'Client ID required' });
  }

  const stats = getClientStats(clientId);

  if (!stats) {
    return json(res, 200, {
      uploads: 0,
      downloads: 0,
      rank: null,
      message: 'No contributions found for this client',
    });
  }

  json(res, 200, stats);
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
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return json(res, 429, { error: 'Rate limit exceeded' });
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
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(`[ERROR] ${req.method} ${pathname}:`, err.message);

    if (err.message === 'Invalid JSON') {
      return json(res, 400, { error: 'Invalid JSON in request body' });
    }

    if (err.message?.includes('exceeds')) {
      return json(res, 413, { error: err.message });
    }

    json(res, 500, { error: 'Internal server error' });
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
});

// Graceful shutdown for Cloud Run
process.on('SIGTERM', () => {
  console.log('[Artibot Swarm Server] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[Artibot Swarm Server] Server closed');
    process.exit(0);
  });
});
