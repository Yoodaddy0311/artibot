import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toFileUrl } from '../../scripts/utils/index.js';

/**
 * scripts/bench/hook-latency.mjs#runOnce — a measured child that exits without reading stdin.
 *
 * ── the defect this pins ─────────────────────────────────────────────────────
 * The shape `_dispatcher-utils.js#guardChildStdin` closed in the dispatchers (review L1):
 * `child.stdin.end(json)` with no 'error' listener on `child.stdin`. When the child exits
 * before reading and the payload is above the pipe buffer, the pending write fails
 * ASYNCHRONOUSLY (EPIPE on POSIX, `write EOF` on Windows) — the try/catch around `end()`
 * cannot see it, and with no listener Node turns it into an uncaught exception that kills
 * the whole bench run and its report.
 *
 * LATENT, NOT LIVE, TODAY: the 19 registered slots build 194-328 byte payloads (measured
 * 2026-11-22 with short sandbox paths), far below any pipe buffer, and 30 rounds of the real
 * PreCompact payload against a child that never reads stdin all survived unguarded. The case
 * below registers a test-only slot with a 1 MB payload to reach the failure region; measured
 * unguarded, round 1 died with `Unhandled 'error' event ... write EOF`, exit 1.
 *
 * ── how this runs ────────────────────────────────────────────────────────────
 * In a separate node process (a driver script), so an uncaught exception shows up as that
 * process's exit code rather than a stray vitest worker error. The driver imports the runner
 * (its `isMainEntry` guard keeps `main()` from running), registers the test-only slot as a
 * copy of PreCompact with a 1 MB payload, and awaits `runOnce` ROUNDS times with
 * `NODE_OPTIONS=--import <preload>` where the preload is `process.exit(0)` — so the child
 * never reads stdin and the real hook script never runs. HOME, USERPROFILE and cwd are the
 * mkdtemp sandbox.
 *
 * ── what this does NOT see ───────────────────────────────────────────────────
 * A real hook that exits early on its own (the preload stands in for it), a child that reads
 * PART of stdin and then exits (same code path, not run), and any timing number.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(PLUGIN_ROOT, 'scripts', 'bench', 'hook-latency.mjs');

/** Rounds per run — one unhandled EPIPE is enough to kill an unguarded driver. */
const ROUNDS = 3;

/** Test-only slot name; never a real slot. */
const SLOT = '__unread_stdin';

let dir;
let driverPath;
let preloadUrl;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-bench-epipe-'));
  const preloadPath = path.join(dir, 'exit-before-stdin.mjs');
  writeFileSync(preloadPath, 'process.exit(0);\n');
  const href = pathToFileURL(preloadPath).href;
  preloadUrl = href.includes(' ') ? `"${href}"` : href;
  driverPath = path.join(dir, 'driver.mjs');
  writeFileSync(driverPath, [
    'const [runnerUrl, preload] = process.argv.slice(2);',
    'const { SLOTS, runOnce } = await import(runnerUrl);',
    `SLOTS[${JSON.stringify(SLOT)}] = { ...SLOTS.PreCompact, payload: () => ({ blob: "x".repeat(1024 * 1024) }) };`,
    'const sandbox = { home: process.cwd(), cwd: process.cwd() };',
    'let rounds = 0;',
    `for (let i = 0; i < ${ROUNDS}; i += 1) {`,
    `  const r = await runOnce(${JSON.stringify(SLOT)}, sandbox, { env: { NODE_OPTIONS: "--import " + preload } });`,
    '  if (r.exitCode !== 0) throw new Error("child exit " + r.exitCode);',
    '  rounds += 1;',
    '}',
    'process.stdout.write(JSON.stringify({ rounds }) + "\\n");',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runOnce — child that never reads stdin, payload far above the pipe buffer', () => {
  it(`settles every round and the bench process survives (${ROUNDS} rounds, 1 MB payload)`, () => {
    const r = spawnSync(process.execPath, [driverPath, toFileUrl(RUNNER), preloadUrl], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(r.status, `exit ${r.status}\nstderr: ${String(r.stderr).slice(0, 2000)}`).toBe(0);
    const line = r.stdout.trim().split('\n').pop();
    expect(JSON.parse(line)).toEqual({ rounds: ROUNDS });
    expect(r.stderr).not.toMatch(/Unhandled|uncaught/i);
    // The failure region was reached: the write did fail, and was only noted.
    expect(r.stderr).toMatch(new RegExp(`\\[artibot:hook-latency\\] ${SLOT} stdin closed early: `));
  }, 200_000);
});
