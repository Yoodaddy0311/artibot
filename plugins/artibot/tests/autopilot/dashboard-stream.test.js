/**
 * Unit tests for lib/autopilot/dashboard-stream.js
 *
 * Covers:
 *   - LOCAL_HOST is always '127.0.0.1' — no opts.host override
 *   - heartbeatMs default = 15_000, clamps min 500
 *   - onConnection writes initial ": connected" SSE comment
 *   - broadcast frames event as `data: {json}\n\n`
 *   - broadcast skips closed subscribers (write throws)
 *   - close() aborts pump + clears subs
 *   - heartbeat ping fires at interval
 *   - tail integration delivers events to subscribers
 *   - sseHeaders has Content-Type text/event-stream
 *   - sseHeaders does NOT include CORS (loopback-only)
 *   - subscriberCount tracking
 *   - target.write missing throws TypeError
 *   - per-subscriber close()
 */
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  createEventStream,
  LOCAL_HOST,
} from '../../lib/autopilot/dashboard-stream.js';

function makeTarget() {
  const writes = [];
  let ended = false;
  return {
    writes,
    write: vi.fn((chunk) => { writes.push(chunk); return true; }),
    end: vi.fn(() => { ended = true; }),
    isEnded: () => ended,
  };
}

async function flushAsync() {
  await new Promise((r) => setImmediate(r));
}

describe('LOCAL_HOST constant', () => {
  it('is hardcoded to 127.0.0.1', () => {
    expect(LOCAL_HOST).toBe('127.0.0.1');
  });
});

describe('createEventStream — host policy', () => {
  let stream;
  afterEach(() => { if (stream) stream.close(); });

  it('always exposes host=127.0.0.1', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    expect(stream.host).toBe('127.0.0.1');
  });

  it('ignores any opts.host override (no host field accepted)', () => {
    // Even if a caller tries to pass host, the public surface only exposes 127.0.0.1.
    stream = createEventStream({
      host: '0.0.0.0',
      tailEvents: async function* () {},
    });
    expect(stream.host).toBe('127.0.0.1');
  });
});

describe('createEventStream — heartbeat configuration', () => {
  let stream;
  afterEach(() => { if (stream) stream.close(); });

  it('defaults heartbeatMs to 15000', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    expect(stream.heartbeatMs).toBe(15_000);
  });

  it('clamps heartbeatMs below 500 up to 500', () => {
    stream = createEventStream({
      heartbeatMs: 10, tailEvents: async function* () {},
    });
    expect(stream.heartbeatMs).toBe(500);
  });

  it('accepts custom heartbeatMs within bounds', () => {
    stream = createEventStream({
      heartbeatMs: 2000, tailEvents: async function* () {},
    });
    expect(stream.heartbeatMs).toBe(2000);
  });
});

describe('createEventStream — onConnection', () => {
  let stream;
  afterEach(() => { if (stream) stream.close(); });

  it('writes ": connected" SSE comment on connection', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const target = makeTarget();
    stream.onConnection(target);
    expect(target.writes[0]).toBe(': connected\n\n');
    expect(stream.subscriberCount()).toBe(1);
  });

  it('throws TypeError when target has no write()', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    expect(() => stream.onConnection({})).toThrow(TypeError);
  });

  it('per-subscriber close() removes from set', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const t = makeTarget();
    const conn = stream.onConnection(t);
    expect(stream.subscriberCount()).toBe(1);
    conn.close();
    expect(stream.subscriberCount()).toBe(0);
    expect(t.end).toHaveBeenCalled();
  });
});

describe('createEventStream — broadcast', () => {
  let stream;
  afterEach(() => { if (stream) stream.close(); });

  it('frames event as "data: <json>\\n\\n"', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const t = makeTarget();
    stream.onConnection(t);
    stream.broadcast({ phase: 'EXECUTE', type: 'tick' });
    const last = t.writes[t.writes.length - 1];
    expect(last.startsWith('data: ')).toBe(true);
    expect(last.endsWith('\n\n')).toBe(true);
    const parsed = JSON.parse(last.slice('data: '.length).trim());
    expect(parsed).toEqual({ phase: 'EXECUTE', type: 'tick' });
  });

  it('ignores non-object payloads', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const t = makeTarget();
    stream.onConnection(t);
    const before = t.writes.length;
    stream.broadcast(null);
    stream.broadcast('plain string');
    expect(t.writes.length).toBe(before);
  });

  it('skips subscribers whose write() throws (marked closed)', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const ok = makeTarget();
    const bad = {
      write: vi.fn(() => { throw new Error('socket closed'); }),
      end: vi.fn(),
    };
    stream.onConnection(ok);
    stream.onConnection(bad);
    stream.broadcast({ x: 1 });
    // second broadcast: bad sub should be skipped silently
    stream.broadcast({ x: 2 });
    const okPayloads = ok.writes.filter((w) => w.startsWith('data: '));
    expect(okPayloads).toHaveLength(2);
  });
});

describe('createEventStream — heartbeat timer', () => {
  let stream;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    if (stream) stream.close();
    vi.useRealTimers();
  });

  it('pings every open subscriber at heartbeatMs cadence', () => {
    stream = createEventStream({
      heartbeatMs: 1000, tailEvents: async function* () {},
    });
    const t = makeTarget();
    stream.onConnection(t);
    vi.advanceTimersByTime(3500);
    const heartbeats = t.writes.filter((w) => w === ': heartbeat\n\n');
    expect(heartbeats.length).toBe(3);
  });
});

describe('createEventStream — tail integration', () => {
  let stream;
  afterEach(() => { if (stream) stream.close(); });

  it('delivers events from tailEvents to all subscribers', async () => {
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    async function* fakeTail() {
      yield { ts: 't1', phase: 'INTAKE', type: 'phase-start' };
      yield { ts: 't2', phase: 'INTAKE', type: 'phase-end' };
      resolveReady();
      // hang forever until aborted
      await new Promise(() => {});
    }
    stream = createEventStream({
      sessionId: 'ap-test',
      tailEvents: fakeTail,
    });
    const t = makeTarget();
    stream.onConnection(t);
    await ready;
    await flushAsync();
    const dataLines = t.writes.filter((w) => w.startsWith('data: '));
    expect(dataLines).toHaveLength(2);
  });
});

describe('createEventStream — sseHeaders', () => {
  let stream;
  afterEach(() => { if (stream) stream.close(); });

  it('sets Content-Type text/event-stream', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const h = stream.sseHeaders();
    expect(h['Content-Type']).toBe('text/event-stream');
    expect(h['Cache-Control']).toContain('no-cache');
    expect(h.Connection).toBe('keep-alive');
  });

  it('does NOT include CORS headers (loopback-only)', () => {
    stream = createEventStream({ tailEvents: async function* () {} });
    const h = stream.sseHeaders();
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
    expect(h['Access-Control-Allow-Methods']).toBeUndefined();
  });
});
