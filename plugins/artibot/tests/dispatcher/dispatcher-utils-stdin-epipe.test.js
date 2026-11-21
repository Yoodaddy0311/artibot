import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFileUrl } from '../../scripts/utils/index.js';

/**
 * scripts/hooks/_dispatcher-utils.js#spawnHook — a child that exits without
 * reading its stdin (L1, review 2026-11-21).
 *
 * ── the defect this pins ─────────────────────────────────────────────────────
 * spawnHook wrote the payload with `child.stdin.end(json)` and attached no
 * 'error' listener to `child.stdin`. A hook that returns before reading stdin
 * (an opt-out check, an early `process.exit`) closes the read end of the pipe;
 * once the payload is larger than the pipe buffer (~64 KB), the pending write
 * fails with EPIPE, the stream emits 'error' with nobody listening, and Node
 * turns that into an uncaught exception — the DISPATCHER process dies with exit
 * 1 and the whole slot's merged output is lost. The try/catch around `end()`
 * cannot see it: the error is asynchronous.
 *
 * ── how this runs ────────────────────────────────────────────────────────────
 * In a separate node process (a driver script), because an uncaught exception in
 * the vitest worker would be reported as a stray error, not as this case's
 * failure. The driver awaits spawnHook ROUNDS times and prints one JSON line; the
 * assertions are on its exit code and that line.
 *
 * ── what this does NOT see ───────────────────────────────────────────────────
 * The real dispatchers' payload sizes (it uses 1 MB, far above any pipe buffer,
 * so the write is certain to be pending when the child exits) and an EPIPE raised
 * by a child that reads PART of stdin and then exits (same code path, not run).
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UTILS = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_dispatcher-utils.js');

/** Rounds per run — one EPIPE is enough to kill an unguarded driver. */
const ROUNDS = 5;

let dir;
let childPath;
let driverPath;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-epipe-'));
  childPath = path.join(dir, 'no-read-child.js');
  driverPath = path.join(dir, 'driver.mjs');
  // Never touches stdin; writes one stdout line so the result is observable.
  writeFileSync(childPath, "process.stdout.write('{\"ok\":1}');\nprocess.exit(0);\n");
  writeFileSync(driverPath, [
    'const { spawnHook } = await import(process.argv[2]);',
    'const payload = { blob: "x".repeat(1024 * 1024) };',
    'const statuses = [];',
    `for (let i = 0; i < ${ROUNDS}; i += 1) {`,
    '  const r = await spawnHook(process.argv[3], payload, { timeoutMs: 20000, name: "no-read", dispatcherName: "dtest" });',
    '  statuses.push(r.status + ":" + r.stdout);',
    '}',
    'process.stdout.write(JSON.stringify({ statuses }) + "\\n");',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spawnHook — child that never reads stdin, payload far above the pipe buffer', () => {
  it(`resolves every round and the dispatcher process survives (${ROUNDS} rounds, 1 MB payload)`, () => {
    const r = spawnSync(process.execPath, [driverPath, toFileUrl(UTILS), childPath], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(r.status, `exit ${r.status}\nstderr: ${r.stderr.slice(0, 2000)}`).toBe(0);
    const line = r.stdout.trim().split('\n').pop();
    const { statuses } = JSON.parse(line);
    expect(statuses).toHaveLength(ROUNDS);
    for (const s of statuses) expect(s).toBe('ok:{"ok":1}');
    expect(r.stderr).not.toMatch(/Unhandled|uncaught/i);
  }, 200_000);
});
