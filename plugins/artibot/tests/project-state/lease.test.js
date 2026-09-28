import { describe, expect, it } from 'vitest';
import {
  createLease,
  DEFAULT_STALE_MS,
  isLeaseExpired,
  renewLease,
  toLandingLockRecord,
  toLease,
} from '../../lib/project-state/lease.js';
import { DEFAULT_STALE_MS as PRIOR_ART_STALE_MS } from '../../lib/git/landing-lock.js';

const T0 = Date.parse('2026-09-02T00:00:00.000Z');
const record = () => ({
  token: 'tok-1',
  pid: 4242,
  host: 'build-host',
  sessionId: 'sess-abc',
  acquiredAt: T0,
});

describe('the TTL is the prior art\'s, not a second constant', () => {
  it('re-exports landing-lock.js DEFAULT_STALE_MS unchanged', () => {
    expect(DEFAULT_STALE_MS).toBe(PRIOR_ART_STALE_MS);
    expect(DEFAULT_STALE_MS).toBe(30 * 60 * 1000);
  });
});

describe('toLease — camelCase/epoch to snake_case/ISO', () => {
  it('converts every axis at once', () => {
    const { lease } = toLease(record());
    expect(lease).toEqual({
      owner: 'sess-abc',
      acquired_at: '2026-09-02T00:00:00.000Z',
      expires_at: '2026-09-02T00:30:00.000Z',
      heartbeat_at: '2026-09-02T00:00:00.000Z',
      token: 'tok-1',
      pid: 4242,
      host: 'build-host',
      session_id: 'sess-abc',
    });
  });

  it('reports which required fields were derived rather than read', () => {
    const { derived } = toLease(record());
    expect(derived).toEqual({ owner: true, expires_at: true, heartbeat_at: true });
  });

  it('falls back to host:pid when the record has no sessionId', () => {
    const { lease, derived } = toLease({ ...record(), sessionId: null });
    expect(lease.owner).toBe('build-host:4242');
    expect(lease.session_id).toBeUndefined();
    expect(derived.owner).toBe(true);
  });

  it('refuses to invent an owner when no identity is available', () => {
    expect(() => toLease({ acquiredAt: T0 })).toThrow(/cannot derive owner/);
  });

  it('honours an explicit owner and heartbeat, and says they were not derived', () => {
    const { lease, derived } = toLease(record(), { owner: 'worker-1', heartbeatAt: T0 + 60_000 });
    expect(lease.owner).toBe('worker-1');
    expect(lease.heartbeat_at).toBe('2026-09-02T00:01:00.000Z');
    expect(derived).toEqual({ owner: false, expires_at: true, heartbeat_at: false });
  });

  it('honours a custom staleMs when deriving expiry', () => {
    const { lease } = toLease(record(), { staleMs: 60_000 });
    expect(lease.expires_at).toBe('2026-09-02T00:01:00.000Z');
  });

  it.each([
    ['a non-object record', null],
    ['a missing acquiredAt', { sessionId: 's' }],
    ['a non-numeric acquiredAt', { sessionId: 's', acquiredAt: '2026-09-02' }],
  ])('throws on %s', (_label, input) => {
    expect(() => toLease(input)).toThrow(TypeError);
  });

  it('rejects a non-positive staleMs', () => {
    expect(() => toLease(record(), { staleMs: 0 })).toThrow(/positive finite/);
  });
});

describe('toLandingLockRecord — snake_case/ISO back to camelCase/epoch', () => {
  it('round-trips the fields landing-lock.js has a slot for', () => {
    const { lease } = toLease(record());
    const { record: back, staleMs } = toLandingLockRecord(lease);
    expect(back).toEqual(record());
    expect(staleMs).toBe(DEFAULT_STALE_MS);
  });

  it('returns staleMs so expires_at is rebuildable, and names what is dropped', () => {
    const { lease } = toLease(record(), { heartbeatAt: T0 + 60_000 });
    const { staleMs, dropped } = toLandingLockRecord(lease);
    expect(staleMs).toBe(DEFAULT_STALE_MS);
    expect(dropped).toEqual(['heartbeat_at']);
  });

  it('reports owner as dropped when it is not the sessionId', () => {
    const { lease } = toLease(record(), { owner: 'worker-1' });
    expect(toLandingLockRecord(lease).dropped).toEqual(['owner', 'heartbeat_at']);
  });

  it('loses the renew instant — the documented lossy edge', () => {
    const renewed = renewLease(toLease(record()).lease, { now: T0 + 600_000 });
    const { record: back, staleMs } = toLandingLockRecord(renewed);
    const { lease: reborn } = toLease(back, { staleMs, owner: renewed.owner });
    expect(reborn.expires_at).toBe(renewed.expires_at);
    expect(reborn.heartbeat_at).not.toBe(renewed.heartbeat_at);
    expect(reborn.heartbeat_at).toBe(reborn.acquired_at);
  });

  it.each(['owner', 'acquired_at', 'expires_at', 'heartbeat_at'])(
    'refuses a lease missing the required field %s',
    (field) => {
      const { lease } = toLease(record());
      delete lease[field];
      expect(() => toLandingLockRecord(lease)).toThrow(new RegExp(`lease\\.${field} is required`));
    },
  );

  it('refuses a lease whose expiry is not after its acquisition', () => {
    const { lease } = toLease(record());
    lease.expires_at = lease.acquired_at;
    expect(() => toLandingLockRecord(lease)).toThrow(/is not after acquired_at/);
  });
});

describe('expiry is a judgement, not a stored boolean', () => {
  const lease = createLease({ owner: 'w1', now: T0, ttlMs: 1000 });

  it('is not expired before expires_at', () => {
    expect(isLeaseExpired(lease, T0 + 999)).toBe(false);
    expect(isLeaseExpired(lease, T0 + 1000)).toBe(false);
  });

  it('is expired after expires_at', () => {
    expect(isLeaseExpired(lease, T0 + 1001)).toBe(true);
  });

  it('accepts a Date as well as epoch ms', () => {
    expect(isLeaseExpired(lease, new Date(T0 + 5000))).toBe(true);
  });

  it('stores no expired flag anywhere', () => {
    expect(Object.keys(lease)).not.toContain('expired');
  });
});

describe('createLease / renewLease', () => {
  it('starts heartbeat_at equal to acquired_at', () => {
    const lease = createLease({ owner: 'w1', now: T0 });
    expect(lease.heartbeat_at).toBe(lease.acquired_at);
    expect(lease.expires_at).toBe(new Date(T0 + DEFAULT_STALE_MS).toISOString());
  });

  it('requires a non-empty owner', () => {
    expect(() => createLease({ owner: '', now: T0 })).toThrow(/owner must be/);
  });

  it('moves both heartbeat and expiry forward without mutating the input', () => {
    const lease = createLease({ owner: 'w1', now: T0, ttlMs: 1000 });
    const renewed = renewLease(lease, { now: T0 + 500 });
    expect(renewed.heartbeat_at).toBe(new Date(T0 + 500).toISOString());
    expect(renewed.expires_at).toBe(new Date(T0 + 1500).toISOString());
    expect(lease.expires_at).toBe(new Date(T0 + 1000).toISOString());
  });

  it('keeps the lease\'s own span when no ttl is given', () => {
    const lease = createLease({ owner: 'w1', now: T0, ttlMs: 7000 });
    expect(renewLease(lease, { now: T0 }).expires_at).toBe(lease.expires_at);
  });
});

describe('renewLease — the default lifetime is fixed, not cumulative', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const iso = (ms) => new Date(ms).toISOString();

  it('grants exactly the original 24h at every link of a renewal chain', () => {
    let lease = createLease({ owner: 'w1', now: T0, ttlMs: DAY });
    for (const at of [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]) {
      lease = renewLease(lease, { now: at });
      expect(lease.expires_at).toBe(iso(at + DAY));
      expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at)).toBe(DAY);
    }
    expect(lease.acquired_at).toBe(iso(T0));
  });

  it('honours an explicit ttlMs, and later default renewals keep that grant', () => {
    const lease = createLease({ owner: 'w1', now: T0, ttlMs: DAY });
    const shortened = renewLease(lease, { now: T0 + HOUR, ttlMs: 5 * 60_000 });
    expect(shortened.expires_at).toBe(iso(T0 + HOUR + 5 * 60_000));
    expect(renewLease(shortened, { now: T0 + 2 * HOUR }).expires_at).toBe(iso(T0 + 2 * HOUR + 5 * 60_000));
  });

  it('renews an old lease with no heartbeat_at by its original lifetime', () => {
    const { heartbeat_at: _dropped, ...old } = createLease({ owner: 'w1', now: T0, ttlMs: DAY });
    expect(renewLease(old, { now: T0 + HOUR }).expires_at).toBe(iso(T0 + HOUR + DAY));
  });

  it('renews a never-renewed lease (heartbeat_at == acquired_at) by its original lifetime', () => {
    const lease = createLease({ owner: 'w1', now: T0, ttlMs: DAY });
    expect(lease.heartbeat_at).toBe(lease.acquired_at);
    expect(renewLease(lease, { now: T0 + HOUR }).expires_at).toBe(iso(T0 + HOUR + DAY));
  });

  it.each([
    ['heartbeat_at at expires_at', iso(T0 + DAY)],
    ['heartbeat_at after expires_at', iso(T0 + 2 * DAY)],
    ['an unparseable heartbeat_at', 'not-a-date'],
  ])('falls back to expires_at - acquired_at on %s, and the renewal heals the record', (_label, beat) => {
    const damaged = { ...createLease({ owner: 'w1', now: T0, ttlMs: DAY }), heartbeat_at: beat };
    const renewed = renewLease(damaged, { now: T0 + HOUR });
    expect(renewed.expires_at).toBe(iso(T0 + HOUR + DAY));
    expect(renewLease(renewed, { now: T0 + 2 * HOUR }).expires_at).toBe(iso(T0 + 2 * HOUR + DAY));
  });

  it('still throws on an unparseable acquired_at, as before', () => {
    const lease = { ...createLease({ owner: 'w1', now: T0, ttlMs: DAY }), acquired_at: 'nope' };
    expect(() => renewLease(lease, { now: T0 + HOUR })).toThrow(/acquired_at is not a parseable/);
  });
});
