/**
 * Tests for lib/learning/memory/working-compaction.js — hook integration.
 *
 * Covers:
 *   - onCompactionStart() flushes and writes survival log
 *   - onCompactionStart() no-op when store absent
 *   - onBeforeExit() flushes non-empty store
 *   - onBeforeExit() no-op when empty
 *   - registerProcessHandlers() wires + disposer cleans up
 *   - log append lines are JSONL (tmpdir — no real plugin root)
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkingStore } from '../../../lib/learning/memory/working.js';
import {
  onCompactionStart,
  onBeforeExit,
  registerProcessHandlers,
} from '../../../lib/learning/memory/working-compaction.js';

let tmpRoot;
let logPath;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-wc-'));
  logPath = path.join(tmpRoot, 'compaction-survival.log');
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// onCompactionStart
// ---------------------------------------------------------------------------

describe('onCompactionStart', () => {
  it('flushes working store and writes survival log line', async () => {
    const appendEpisode = vi.fn(async (ep) => ({ id: 'ep1', ...ep }));
    const workingStore = createWorkingStore({
      tokenBudget: 1000,
      episodicStore: { appendEpisode },
    });
    workingStore.append({ kind: 'user_correction', body: 'fix', tokens: 10 });
    workingStore.append({ kind: 'success', body: 'done', tokens: 10 });

    const result = await onCompactionStart({ workingStore, logPath });

    expect(result.flushedCount).toBe(2);
    expect(result.promoted).toBe(true);
    expect(appendEpisode).toHaveBeenCalledTimes(1);
    expect(workingStore.snapshot().entries.length).toBe(0);

    const logContent = await fs.readFile(logPath, 'utf-8');
    const lines = logContent.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.reason).toBe('compaction');
    expect(parsed.flushedCount).toBe(2);
    expect(parsed.promoted).toBe(true);
    expect(typeof parsed.ts).toBe('string');
  });

  it('is a no-op when workingStore is missing', async () => {
    const result = await onCompactionStart({ logPath });
    expect(result.flushedCount).toBe(0);
    expect(result.skipReason).toBe('no-store');
    // log should not be written
    await expect(fs.access(logPath)).rejects.toBeTruthy();
  });

  it('writes log even when flush had nothing to promote', async () => {
    const workingStore = createWorkingStore({ tokenBudget: 1000 });
    const result = await onCompactionStart({ workingStore, logPath });
    expect(result.flushedCount).toBe(0);
    expect(result.promoted).toBe(false);
    const logContent = await fs.readFile(logPath, 'utf-8');
    expect(logContent.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// onBeforeExit
// ---------------------------------------------------------------------------

describe('onBeforeExit', () => {
  it('flushes when entries are present', async () => {
    const appendEpisode = vi.fn(async () => ({ id: 'ep' }));
    const workingStore = createWorkingStore({
      tokenBudget: 1000,
      episodicStore: { appendEpisode },
    });
    workingStore.append({ kind: 'user_correction', body: 'x', tokens: 10 });
    workingStore.append({ kind: 'success', body: 'y', tokens: 10 });

    const result = await onBeforeExit({ workingStore, logPath });

    expect(result.flushedCount).toBe(2);
    expect(result.promoted).toBe(true);
    const logContent = await fs.readFile(logPath, 'utf-8');
    const parsed = JSON.parse(logContent.trim().split('\n')[0]);
    expect(parsed.reason).toBe('beforeExit');
  });

  it('is a no-op when store is empty (no log line)', async () => {
    const workingStore = createWorkingStore({ tokenBudget: 1000 });
    const result = await onBeforeExit({ workingStore, logPath });
    expect(result.flushedCount).toBe(0);
    expect(result.promoted).toBe(false);
    await expect(fs.access(logPath)).rejects.toBeTruthy();
  });

  it('is a no-op when workingStore is missing', async () => {
    const result = await onBeforeExit({ logPath });
    expect(result.flushedCount).toBe(0);
    expect(result.promoted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerProcessHandlers
// ---------------------------------------------------------------------------

describe('registerProcessHandlers', () => {
  it('wires beforeExit / SIGINT / SIGTERM and disposes cleanly', async () => {
    const proc = new EventEmitter();
    // spies
    const onSpy = vi.spyOn(proc, 'on');
    const offSpy = vi.spyOn(proc, 'removeListener');

    const workingStore = createWorkingStore({ tokenBudget: 1000 });
    const dispose = registerProcessHandlers({ workingStore, logPath, proc });

    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('beforeExit');
    expect(events).toContain('SIGINT');
    expect(events).toContain('SIGTERM');

    dispose();
    const removed = offSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('beforeExit');
    expect(removed).toContain('SIGINT');
    expect(removed).toContain('SIGTERM');
  });

  it('returns a no-op disposer when workingStore missing', () => {
    const proc = new EventEmitter();
    const onSpy = vi.spyOn(proc, 'on');
    const dispose = registerProcessHandlers({ proc });
    expect(onSpy).not.toHaveBeenCalled();
    // disposer should not throw
    expect(() => dispose()).not.toThrow();
  });

  it('fires exactly once across repeated signals', async () => {
    const proc = new EventEmitter();
    const appendEpisode = vi.fn(async () => ({ id: 'ep' }));
    const workingStore = createWorkingStore({
      tokenBudget: 1000,
      episodicStore: { appendEpisode },
    });
    workingStore.append({ kind: 'user_correction', body: 'x', tokens: 10 });
    workingStore.append({ kind: 'success', body: 'y', tokens: 10 });

    registerProcessHandlers({ workingStore, logPath, proc });

    // Await the handler's returned promise by listening for resolution.
    const fireAndWait = () => new Promise((resolve) => {
      proc.emit('beforeExit');
      // give microtasks a tick to complete
      setImmediate(resolve);
    });

    await fireAndWait();
    await fireAndWait();
    // Allow any pending async flush to settle
    await new Promise((r) => setImmediate(r));

    expect(appendEpisode).toHaveBeenCalledTimes(1);
  });
});
