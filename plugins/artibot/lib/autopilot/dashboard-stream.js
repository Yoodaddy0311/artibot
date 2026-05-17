/**
 * Server-Sent Events stream for the autopilot dashboard (Track H).
 *
 * Pure module — provides a `createEventStream({sessionId, ...})` factory
 * returning `{ onConnection, broadcast, close, host, heartbeatMs }`.
 * Wiring into `bin/artibot-dashboard.mjs` is the orchestrator's job;
 * this module never touches the dashboard CLI directly.
 *
 * Security:
 *   - HOST is hardcoded to 127.0.0.1. There is NO opts.host override.
 *   - No CORS headers — assumes same-origin loopback access only.
 *   - No external HTTP, no webhook posts, no telemetry uploads.
 *
 * Public surface:
 *   - createEventStream(opts)
 *   - LOCAL_HOST   (the constant '127.0.0.1')
 *
 * @module lib/autopilot/dashboard-stream
 */

import { tailEventsStream as defaultTailEvents } from './telemetry.js';

/** Hardcoded loopback bind. Do NOT expose an override. */
export const LOCAL_HOST = '127.0.0.1';
const DEFAULT_HEARTBEAT_MS = 15_000;
const MIN_HEARTBEAT_MS = 500;

/**
 * Serialize a payload as SSE-framed `data:` lines.
 * Always ends with a blank line per the SSE spec.
 * @param {object} ev
 * @returns {string}
 */
function frameEvent(ev) {
  const json = JSON.stringify(ev);
  return `data: ${json}\n\n`;
}

/**
 * Build the SSE response headers (no CORS — loopback only).
 * @returns {Record<string,string>}
 */
function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

/**
 * Track a single SSE subscriber. Wraps an arbitrary write/close target
 * so tests can supply a plain object instead of an http.ServerResponse.
 * @param {{write:(chunk:string)=>void, end?:()=>void}} target
 * @returns {{send:(ev:object)=>void, heartbeat:()=>void, close:()=>void,
 *            isOpen:()=>boolean}}
 */
function makeSubscriber(target) {
  let open = true;
  const send = (ev) => {
    if (!open) return;
    try { target.write(frameEvent(ev)); }
    catch { open = false; }
  };
  const heartbeat = () => {
    if (!open) return;
    try { target.write(': heartbeat\n\n'); }
    catch { open = false; }
  };
  const close = () => {
    if (!open) return;
    open = false;
    try { if (typeof target.end === 'function') target.end(); }
    catch { /* ignore */ }
  };
  return { send, heartbeat, close, isOpen: () => open };
}

/**
 * Start the telemetry tail loop and fan events out to all subscribers.
 * Runs until the stream is closed.
 * @param {object} ctx
 */
async function pumpTail(ctx) {
  if (!ctx.sessionId) return;
  try {
    for await (const ev of ctx.tailEvents(ctx.sessionId, { signal: ctx.signal })) {
      if (ctx.signal.aborted) return;
      for (const sub of ctx.subs) {
        if (sub.isOpen()) sub.send(ev);
      }
    }
  } catch (err) {
    if (!ctx.signal.aborted && typeof ctx.onError === 'function') {
      try { ctx.onError(err); } catch { /* swallow */ }
    }
  }
}

/**
 * Start the heartbeat timer that pings every open subscriber at
 * `heartbeatMs` cadence.
 * @param {object} ctx
 * @returns {() => void} cancel function
 */
function startHeartbeat(ctx) {
  const handle = setInterval(() => {
    for (const sub of ctx.subs) {
      if (sub.isOpen()) sub.heartbeat();
    }
  }, ctx.heartbeatMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/**
 * Create a localhost-only SSE event stream factory.
 *
 * @param {{
 *   sessionId?: string,
 *   heartbeatMs?: number,
 *   tailEvents?: Function,
 *   onError?: (err:Error) => void,
 * }} [opts]
 * @returns {{
 *   onConnection: (target:{write:Function, end?:Function}) => {close:Function},
 *   broadcast: (ev:object) => void,
 *   close: () => void,
 *   host: '127.0.0.1',
 *   heartbeatMs: number,
 *   subscriberCount: () => number,
 *   sseHeaders: () => Record<string,string>,
 * }}
 */
export function createEventStream(opts = {}) {
  const subs = new Set();
  const ac = new AbortController();
  const heartbeatRaw = Number.isFinite(opts.heartbeatMs)
    ? Number(opts.heartbeatMs) : DEFAULT_HEARTBEAT_MS;
  const heartbeatMs = Math.max(MIN_HEARTBEAT_MS, heartbeatRaw);
  const tailEvents = typeof opts.tailEvents === 'function'
    ? opts.tailEvents : defaultTailEvents;
  const ctx = {
    sessionId: typeof opts.sessionId === 'string' ? opts.sessionId : '',
    signal: ac.signal,
    subs,
    tailEvents,
    onError: opts.onError,
    heartbeatMs,
  };
  const cancelHeartbeat = startHeartbeat(ctx);
  const tailPromise = pumpTail(ctx);
  // Prevent unhandled-rejection noise; pumpTail handles errors internally.
  tailPromise.catch(() => { /* already handled */ });

  return {
    onConnection(target) {
      if (!target || typeof target.write !== 'function') {
        throw new TypeError('target must expose a write(chunk) function');
      }
      const sub = makeSubscriber(target);
      subs.add(sub);
      try { target.write(': connected\n\n'); }
      catch { /* swallowed; subscriber will mark closed on next send */ }
      return {
        close() { sub.close(); subs.delete(sub); },
      };
    },
    broadcast(ev) {
      if (!ev || typeof ev !== 'object') return;
      for (const sub of subs) {
        if (sub.isOpen()) sub.send(ev);
      }
    },
    close() {
      ac.abort();
      cancelHeartbeat();
      for (const sub of subs) sub.close();
      subs.clear();
    },
    host: LOCAL_HOST,
    heartbeatMs,
    subscriberCount: () => subs.size,
    sseHeaders,
  };
}
