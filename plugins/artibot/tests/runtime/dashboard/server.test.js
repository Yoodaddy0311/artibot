/**
 * Dashboard server (v3.2.0) — unit + integration tests.
 * Zero external deps: raw node:net client exercises the HTTP + WS surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import {
  createDashboardServer,
  assertLoopback,
  computeAcceptKey,
  encodeTextFrame,
  resolvePublicFile,
  tailLines,
} from '../../../lib/runtime/dashboard/server.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'artibot-dash-'));
}

function httpRequest(port, path) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', (b) => chunks.push(b));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

function wsHandshake(port) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET /ws HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let resolved = false;
    sock.on('data', (b) => {
      buf = Buffer.concat([buf, b]);
      if (!resolved && buf.includes(Buffer.from('\r\n\r\n'))) {
        resolved = true;
        resolve({ sock, headerBuf: buf, key });
      }
    });
    sock.on('error', reject);
  });
}

function decodeFrame(buf, at = 0) {
  if (buf.length - at < 2) return null;
  const b2 = buf[at + 1];
  const masked = (b2 & 0x80) !== 0;
  let len = b2 & 0x7f;
  let offset = at + 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset)); offset += 8;
  }
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = buf.slice(offset, offset + len).toString('utf8');
  return { text: payload, next: offset + len };
}

describe('assertLoopback', () => {
  it('accepts 127.0.0.1', () => { expect(() => assertLoopback('127.0.0.1')).not.toThrow(); });
  it('accepts ::1 and localhost', () => {
    expect(() => assertLoopback('::1')).not.toThrow();
    expect(() => assertLoopback('localhost')).not.toThrow();
  });
  it('rejects 0.0.0.0', () => { expect(() => assertLoopback('0.0.0.0')).toThrow(/loopback/); });
  it('rejects LAN IPs', () => { expect(() => assertLoopback('192.168.1.42')).toThrow(/loopback/); });
});

describe('computeAcceptKey', () => {
  it('matches RFC 6455 SHA1+Base64', () => {
    const k = 'dGhlIHNhbXBsZSBub25jZQ==';
    const expected = createHash('sha1').update(k + WS_GUID).digest('base64');
    expect(computeAcceptKey(k)).toBe(expected);
  });
});

describe('encodeTextFrame', () => {
  it('encodes a short payload with FIN+text opcode', () => {
    const f = encodeTextFrame('hi');
    expect(f[0]).toBe(0x81);
    expect(f[1]).toBe(2);
    expect(f.slice(2).toString()).toBe('hi');
  });
  it('uses 2-byte length for medium payload', () => {
    const msg = 'x'.repeat(200);
    const f = encodeTextFrame(msg);
    expect(f[1]).toBe(126);
    expect(f.readUInt16BE(2)).toBe(200);
  });
});

describe('resolvePublicFile', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('maps / to index.html', () => {
    const resolved = resolvePublicFile('/', dir);
    expect(typeof resolved).toBe('string');
    expect(resolved).toMatch(/index\.html$/);
  });
  it('rejects path traversal', () => {
    expect(resolvePublicFile('/../../etc/passwd', dir)).toBeNull();
  });
});

describe('tailLines', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns [] for missing file', async () => {
    expect(await tailLines(join(dir, 'nope.jsonl'), 10)).toEqual([]);
  });

  it('returns last N lines', async () => {
    const f = join(dir, 'x.jsonl');
    writeFileSync(f, ['a', 'b', 'c', 'd'].join('\n') + '\n');
    expect(await tailLines(f, 2)).toEqual(['c', 'd']);
  });
});

describe('createDashboardServer (integration)', () => {
  let dir;
  let eventFile;
  let server;

  beforeEach(() => {
    dir = tmp();
    mkdirSync(join(dir, 'events'), { recursive: true });
    eventFile = join(dir, 'events', 'today.jsonl');
  });

  afterEach(async () => {
    if (server) { try { await server.close(); } catch { /* ignore */ } server = null; }
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds to 127.0.0.1 on a random port', async () => {
    server = await createDashboardServer({ port: 0, eventFile });
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('refuses 0.0.0.0', async () => {
    await expect(
      createDashboardServer({ port: 0, host: '0.0.0.0', eventFile })
    ).rejects.toThrow(/loopback/);
  });

  it('serves HTML on GET /', async () => {
    server = await createDashboardServer({ port: 0, eventFile });
    const resp = await httpRequest(server.port, '/');
    expect(resp).toMatch(/^HTTP\/1\.1 200/);
    expect(resp).toMatch(/content-type: text\/html/i);
    expect(resp).toMatch(/Artibot/);
  });

  it('exposes /healthz', async () => {
    server = await createDashboardServer({ port: 0, eventFile });
    const resp = await httpRequest(server.port, '/healthz');
    expect(resp).toMatch(/200/);
    expect(resp).toMatch(/"ok":true/);
  });

  it('completes the WebSocket handshake with a valid accept key', async () => {
    server = await createDashboardServer({ port: 0, eventFile });
    const { sock, headerBuf, key } = await wsHandshake(server.port);
    const headerText = headerBuf.toString('utf8').split('\r\n\r\n')[0];
    expect(headerText).toMatch(/101 Switching Protocols/);
    const expected = computeAcceptKey(key);
    expect(headerText).toMatch(new RegExp('Sec-WebSocket-Accept: ' + expected.replace(/[+/]/g, '.')));
    sock.destroy();
  });

  it('replays recent envelopes to new clients', async () => {
    const envelope = { v: 1, timestamp: '2026-04-23T00:00:00.000Z', event: 'SessionStart',
      sessionId: 'sess_x', payload: { cwd: 'X', model: 'opus' }, meta: { emitter: 'artibot' } };
    writeFileSync(eventFile, JSON.stringify(envelope) + '\n');
    server = await createDashboardServer({ port: 0, eventFile });

    const { sock, headerBuf } = await wsHandshake(server.port);
    const bodyStart = headerBuf.indexOf(Buffer.from('\r\n\r\n')) + 4;
    const rest = headerBuf.slice(bodyStart);

    const received = await new Promise((resolve) => {
      let acc = rest;
      function tryDecode() {
        const frame = decodeFrame(acc, 0);
        if (frame) { resolve(frame.text); sock.destroy(); return true; }
        return false;
      }
      if (tryDecode()) return;
      sock.on('data', (b) => { acc = Buffer.concat([acc, b]); tryDecode(); });
    });
    expect(JSON.parse(received).event).toBe('SessionStart');
  });

  it('broadcasts new lines appended to the event file', async () => {
    writeFileSync(eventFile, '');
    server = await createDashboardServer({ port: 0, eventFile });
    const { sock, headerBuf } = await wsHandshake(server.port);
    const bodyStart = headerBuf.indexOf(Buffer.from('\r\n\r\n')) + 4;
    let acc = headerBuf.slice(bodyStart);

    const incoming = new Promise((resolve) => {
      function tryDecode() {
        const frame = decodeFrame(acc, 0);
        if (frame) { resolve(frame.text); sock.destroy(); return true; }
        return false;
      }
      if (tryDecode()) return;
      sock.on('data', (b) => { acc = Buffer.concat([acc, b]); tryDecode(); });
    });

    const envelope = { v: 1, timestamp: new Date().toISOString(), event: 'PostToolUse',
      sessionId: 'sess_live', tool: 'Read', payload: { ok: true, durationMs: 3 },
      meta: { emitter: 'artibot' } };

    // Allow watcher to settle before write.
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(eventFile, JSON.stringify(envelope) + '\n');

    const got = await Promise.race([
      incoming,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    expect(JSON.parse(got).event).toBe('PostToolUse');
  });

  it('close() shuts down cleanly and frees the port', async () => {
    server = await createDashboardServer({ port: 0, eventFile });
    const port = server.port;
    await server.close();
    server = null;
    // Re-binding to the same port should now succeed.
    const again = await createDashboardServer({ port, eventFile });
    expect(again.port).toBe(port);
    await again.close();
  });
});
