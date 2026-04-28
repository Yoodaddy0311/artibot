import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Session,
  InMemorySession,
  JsonFileSession,
} from '../../../lib/learning/session.js';

describe('Session ABC', () => {
  it('requires id', () => {
    expect(() => new Session({})).toThrow(TypeError);
  });

  it('throws on calling abstract methods directly', async () => {
    const s = new Session({ id: 'x' });
    await expect(s.getItems()).rejects.toThrow(/getItems/);
    await expect(s.addItems([])).rejects.toThrow(/addItems/);
    await expect(s.popItem()).rejects.toThrow(/popItem/);
    await expect(s.clearSession()).rejects.toThrow(/clearSession/);
  });
});

describe('InMemorySession', () => {
  let session;

  beforeEach(() => {
    session = new InMemorySession({ id: 'mem-1' });
  });

  it('starts empty', async () => {
    expect(await session.getItems()).toEqual([]);
  });

  it('addItems appends and getItems returns all', async () => {
    await session.addItems([{ a: 1 }, { a: 2 }]);
    await session.addItems([{ a: 3 }]);
    expect(await session.getItems()).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('getItems(limit) returns last N', async () => {
    await session.addItems([1, 2, 3, 4, 5].map((n) => ({ n })));
    expect(await session.getItems(2)).toEqual([{ n: 4 }, { n: 5 }]);
  });

  it('popItem removes and returns last', async () => {
    await session.addItems([{ x: 1 }, { x: 2 }]);
    expect(await session.popItem()).toEqual({ x: 2 });
    expect(await session.getItems()).toEqual([{ x: 1 }]);
  });

  it('popItem on empty returns null', async () => {
    expect(await session.popItem()).toBeNull();
  });

  it('clearSession empties the store', async () => {
    await session.addItems([{ x: 1 }]);
    await session.clearSession();
    expect(await session.getItems()).toEqual([]);
  });

  it('addItems rejects non-array', async () => {
    await expect(session.addItems('nope')).rejects.toThrow(TypeError);
  });
});

describe('JsonFileSession', () => {
  let dir;
  let session;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artibot-sess-'));
    session = new JsonFileSession({ id: 'file-1', dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty when file missing', async () => {
    expect(await session.getItems()).toEqual([]);
  });

  it('persists across instances', async () => {
    await session.addItems([{ msg: 'hello' }]);
    const next = new JsonFileSession({ id: 'file-1', dir });
    expect(await next.getItems()).toEqual([{ msg: 'hello' }]);
  });

  it('popItem persists removal', async () => {
    await session.addItems([{ a: 1 }, { a: 2 }]);
    expect(await session.popItem()).toEqual({ a: 2 });
    const next = new JsonFileSession({ id: 'file-1', dir });
    expect(await next.getItems()).toEqual([{ a: 1 }]);
  });

  it('clearSession deletes the file', async () => {
    await session.addItems([{ a: 1 }]);
    await session.clearSession();
    expect(await session.getItems()).toEqual([]);
  });
});
