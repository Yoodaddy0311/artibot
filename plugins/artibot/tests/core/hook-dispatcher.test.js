import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _resetDispatcherCache,
  dispatch,
  loadDispatchTable,
} from '../../lib/core/hook-dispatcher.js';

/**
 * Write a temporary ESM handler module and return its absolute path.
 * @param {string} dir - tmp dir
 * @param {string} name - file name (without ext)
 * @param {string} body - module source code
 * @returns {string}
 */
function writeHandler(dir, name, body) {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, body, 'utf-8');
  return file;
}

/**
 * Temporarily override the dispatch-table.json to point to given handler specs.
 * We patch the real plugin file then restore it in afterEach.
 */
import { readFileSync } from 'node:fs';
import { getPluginRoot } from '../../lib/core/platform.js';

const TABLE_PATH = path.join(getPluginRoot(), 'hooks', 'dispatch-table.json');

describe('hook-dispatcher', () => {
  let tmpDir;
  let originalTable;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'hook-dispatcher-test-'));
    originalTable = readFileSync(TABLE_PATH, 'utf-8');
    _resetDispatcherCache();
  });

  afterEach(() => {
    writeFileSync(TABLE_PATH, originalTable, 'utf-8');
    _resetDispatcherCache();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    delete process.env.ARTIBOT_HOOK_TIMEOUT_MS;
  });

  function setTable(slots) {
    writeFileSync(
      TABLE_PATH,
      JSON.stringify({ version: 1, description: 'test', slots }, null, 2),
      'utf-8',
    );
    _resetDispatcherCache();
  }

  it('returns empty results for a slot with no handlers', async () => {
    const result = await dispatch('SessionStart', {});
    expect(result.slot).toBe('SessionStart');
    expect(result.results).toEqual([]);
    expect(typeof result.duration_ms).toBe('number');
  });

  it('returns empty results for a nonexistent slot and never throws', async () => {
    const result = await dispatch('NonexistentSlot', { foo: 1 });
    expect(result.slot).toBe('NonexistentSlot');
    expect(result.results).toEqual([]);
  });

  it('loadDispatchTable returns object with 4 canonical slots', async () => {
    const table = await loadDispatchTable();
    expect(table.slots).toBeDefined();
    expect(table.slots.SessionStart).toBeDefined();
    expect(table.slots.UserPromptSubmit).toBeDefined();
    expect(table.slots.PostToolUse).toBeDefined();
    expect(table.slots.PreCompact).toBeDefined();
  });

  it('caches loadDispatchTable on repeat calls', async () => {
    const a = await loadDispatchTable();
    const b = await loadDispatchTable();
    expect(a).toBe(b);
  });

  it('runs a successful handler and marks success:true', async () => {
    const handlerPath = writeHandler(
      tmpDir,
      'ok',
      'export default async function (payload) { return { echoed: payload.msg }; }',
    );
    setTable({ TestSlot: { label: 't', handlers: [handlerPath] } });
    const result = await dispatch('TestSlot', { msg: 'hello' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].output).toEqual({ echoed: 'hello' });
  });

  it('isolates a throwing handler and continues the chain', async () => {
    const badPath = writeHandler(
      tmpDir,
      'bad',
      'export default async function () { throw new Error("boom"); }',
    );
    const goodPath = writeHandler(
      tmpDir,
      'good',
      'export default async function () { return "ok"; }',
    );
    setTable({ TestSlot: { label: 't', handlers: [badPath, goodPath] } });
    const result = await dispatch('TestSlot', {});
    expect(result.results).toHaveLength(2);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('boom');
    expect(result.results[1].success).toBe(true);
    expect(result.results[1].output).toBe('ok');
  });

  it('aborts a handler that exceeds the timeout', async () => {
    process.env.ARTIBOT_HOOK_TIMEOUT_MS = '50';
    const slowPath = writeHandler(
      tmpDir,
      'slow',
      'export default function () { return new Promise(r => setTimeout(() => r("late"), 500)); }',
    );
    setTable({ TestSlot: { label: 't', handlers: [slowPath] } });
    const result = await dispatch('TestSlot', {});
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toMatch(/timeout/);
  });

  it('executes multiple handlers in order', async () => {
    const h1 = writeHandler(tmpDir, 'h1', 'export default async () => 1;');
    const h2 = writeHandler(tmpDir, 'h2', 'export default async () => 2;');
    const h3 = writeHandler(tmpDir, 'h3', 'export default async () => 3;');
    setTable({ TestSlot: { label: 't', handlers: [h1, h2, h3] } });
    const result = await dispatch('TestSlot', {});
    expect(result.results.map((r) => r.output)).toEqual([1, 2, 3]);
  });

  it('records per-handler duration_ms', async () => {
    const handlerPath = writeHandler(
      tmpDir,
      'timed',
      'export default async () => { await new Promise(r => setTimeout(r, 10)); return "done"; };',
    );
    setTable({ TestSlot: { label: 't', handlers: [handlerPath] } });
    const result = await dispatch('TestSlot', {});
    expect(typeof result.results[0].duration_ms).toBe('number');
    expect(result.results[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records total duration_ms on the dispatch result', async () => {
    const result = await dispatch('SessionStart', {});
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('captures a handler return value in result.output', async () => {
    const handlerPath = writeHandler(
      tmpDir,
      'capture',
      'export default async () => ({ a: 1, b: [2, 3] });',
    );
    setTable({ TestSlot: { label: 't', handlers: [handlerPath] } });
    const result = await dispatch('TestSlot', {});
    expect(result.results[0].output).toEqual({ a: 1, b: [2, 3] });
  });

  it('_resetDispatcherCache forces a fresh load', async () => {
    const first = await loadDispatchTable();
    expect(first.slots.SessionStart).toBeDefined();
    setTable({ BrandNew: { label: 'x', handlers: [] } });
    const reloaded = await loadDispatchTable();
    expect(reloaded.slots.BrandNew).toBeDefined();
    expect(reloaded).not.toBe(first);
  });

  it('marks failure when handler module has no default export', async () => {
    const noDefault = writeHandler(tmpDir, 'nodef', 'export const x = 1;');
    setTable({ TestSlot: { label: 't', handlers: [noDefault] } });
    const result = await dispatch('TestSlot', {});
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toMatch(/default function/);
  });
});
