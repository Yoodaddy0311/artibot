/**
 * Local Observability Dashboard Server (v3.2.0 prototype).
 *
 * Zero-dep WebSocket server for hook-event-emitter envelopes.
 * - HTTP: serves the static dashboard bundle from ./public
 * - WebSocket: RFC 6455 handshake + minimal text frame codec
 * - Event source: tails runtime/events/*.jsonl (fs.watch) and broadcasts
 *
 * Data policy: 127.0.0.1 bind only (loopback). Any non-loopback host is
 * rejected. No external network. No auth beyond the loopback boundary.
 *
 * @module lib/runtime/dashboard/server
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { watch, existsSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(HERE, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const REPLAY_COUNT = 100;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Verify the host is loopback-only. Throws otherwise.
 * @param {string} host
 */
export function assertLoopback(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[artibot:dashboard] refused non-loopback host "${host}". Use 127.0.0.1.`
    );
  }
}

/**
 * Read last N lines of a text file without loading the whole file.
 * @param {string} file
 * @param {number} n
 * @returns {Promise<string[]>}
 */
export async function tailLines(file, n) {
  if (!existsSync(file)) return [];
  const lines = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.length === 0) continue;
    lines.push(line);
    if (lines.length > n * 2) lines.splice(0, lines.length - n);
  }
  return lines.slice(-n);
}

/**
 * Encode a WebSocket text frame (server→client, server frames are unmasked).
 * @param {string} text
 * @returns {Buffer}
 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Encode a close frame (opcode 0x8).
 * @param {number} code
 * @returns {Buffer}
 */
export function encodeCloseFrame(code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 0x02]), payload]);
}

/**
 * Compute the Sec-WebSocket-Accept response key.
 * @param {string} clientKey
 * @returns {string}
 */
export function computeAcceptKey(clientKey) {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/**
 * Resolve a URL path to an absolute file under publicDir, preventing traversal.
 * @param {string} urlPath
 * @param {string} publicDir
 * @returns {string | null}
 */
export function resolvePublicFile(urlPath, publicDir) {
  const safe = urlPath === '/' ? '/index.html' : urlPath.split('?')[0];
  const rel = safe.replace(/^\/+/, '');
  const abs = normalize(join(publicDir, rel));
  const rootWithSep = publicDir.endsWith(sep) ? publicDir : publicDir + sep;
  if (abs !== publicDir && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

/**
 * Serve a static file from the public directory.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} publicDir
 */
async function serveStatic(req, res, publicDir) {
  const abs = resolvePublicFile(req.url ?? '/', publicDir);
  if (!abs) {
    res.writeHead(400).end('bad request');
    return;
  }
  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/**
 * Minimal inbound frame parser for close detection. Text/ping are ignored
 * (the dashboard is read-only from the browser's perspective).
 * @param {Buffer} buf
 * @returns {{ opcode: number } | null}
 */
export function peekFrame(buf) {
  if (buf.length < 2) return null;
  return { opcode: buf[0] & 0x0f };
}

/**
 * Create the dashboard server factory.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=0] 0 = random
 * @param {string} [opts.host="127.0.0.1"] loopback only
 * @param {string} [opts.eventFile] absolute JSONL path
 * @param {string} [opts.publicDir] override static root
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   host: string,
 *   clientCount: () => number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function createDashboardServer(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  assertLoopback(host);
  const port = Number.isInteger(opts.port) ? opts.port : 0;
  const publicDir = opts.publicDir ?? DEFAULT_PUBLIC_DIR;
  const eventFile = opts.eventFile ?? defaultEventFile();

  const clients = new Set();

  const httpServer = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: clients.size }));
      return;
    }
    await serveStatic(req, res, publicDir);
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    await handleUpgrade(req, socket, head, { clients, eventFile });
  });

  // File-change broadcaster.
  const watcher = startEventWatcher(eventFile, (line) => {
    const frame = encodeTextFrame(line);
    for (const sock of clients) {
      if (!sock.writable) continue;
      try { sock.write(frame); } catch { /* drop */ }
    }
  });

  await new Promise((res, rej) => {
    httpServer.once('error', rej);
    httpServer.listen(port, host, () => res(undefined));
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}/`;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    watcher.close();
    for (const sock of clients) {
      try { sock.write(encodeCloseFrame(1001)); sock.destroy(); } catch { /* ignore */ }
    }
    clients.clear();
    await new Promise((r) => httpServer.close(() => r(undefined)));
  }

  return {
    url,
    port: actualPort,
    host,
    clientCount: () => clients.size,
    close,
  };
}

/**
 * Absolute path to the default daily event file (today, UTC).
 * @returns {string}
 */
export function defaultEventFile() {
  const day = new Date().toISOString().slice(0, 10);
  const pluginRoot = resolve(HERE, '..', '..', '..');
  return join(pluginRoot, 'runtime', 'events', `${day}.jsonl`);
}

/**
 * Perform the WebSocket handshake, replay recent envelopes, and track the
 * connection until close.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} _head
 * @param {{ clients: Set<import('node:net').Socket>, eventFile: string }} ctx
 */
async function handleUpgrade(req, socket, _head, ctx) {
  if (req.url !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers['upgrade'] ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const accept = computeAcceptKey(key);
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');
  socket.write(headers);

  ctx.clients.add(socket);
  socket.on('close', () => ctx.clients.delete(socket));
  socket.on('error', () => ctx.clients.delete(socket));
  socket.on('data', (buf) => {
    const f = peekFrame(buf);
    if (f && f.opcode === 0x8) {
      try { socket.write(encodeCloseFrame(1000)); } catch { /* ignore */ }
      socket.destroy();
    }
  });

  // Replay recent envelopes.
  try {
    const lines = await tailLines(ctx.eventFile, REPLAY_COUNT);
    for (const line of lines) {
      if (!socket.writable) break;
      socket.write(encodeTextFrame(line));
    }
  } catch { /* empty / missing is fine */ }
}

/**
 * Tail the event file. On each change event, emit newly appended lines.
 * @param {string} eventFile
 * @param {(line: string) => void} onLine
 * @returns {{ close: () => void }}
 */
function startEventWatcher(eventFile, onLine) {
  let offset = existsSync(eventFile) ? safeSize(eventFile) : 0;
  let watcher;
  const dir = dirname(eventFile);

  const dispatch = async () => {
    if (!existsSync(eventFile)) return;
    const size = safeSize(eventFile);
    if (size <= offset) {
      // File truncated/rotated — reset to read from the new head.
      if (size < offset) offset = 0;
      return;
    }
    try {
      const content = await readFile(eventFile, 'utf8');
      const slice = content.slice(offset);
      offset = content.length;
      for (const line of slice.split('\n')) {
        if (line.trim().length > 0) onLine(line);
      }
    } catch { /* ignore transient read errors */ }
  };

  try {
    // Watch the containing dir so we survive daily file rotation.
    watcher = watch(dir, { persistent: false }, (_ev, fname) => {
      if (!fname || join(dir, String(fname)) === eventFile) dispatch();
    });
  } catch {
    watcher = { close() {} };
  }

  return {
    close() {
      try { watcher.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * @param {string} file
 * @returns {number}
 */
function safeSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
