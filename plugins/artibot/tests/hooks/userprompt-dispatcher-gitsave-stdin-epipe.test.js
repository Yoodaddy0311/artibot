import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFileUrl } from '../../scripts/utils/index.js';

/**
 * scripts/hooks/_userprompt-dispatcher.js#runGitAutopilotSave — a child that
 * exits without reading its stdin (review 2026-11-21, xcC MED).
 *
 * ── the defect this pins ─────────────────────────────────────────────────────
 * The same shape as `_dispatcher-utils.js#spawnHook` before its L1 fix:
 * `child.stdin.end(json)` with no 'error' listener on `child.stdin`. When
 * git-autopilot-save returns before reading stdin and the payload is larger
 * than the pipe buffer, the pending write fails ASYNCHRONOUSLY (EPIPE on POSIX,
 * `write EOF` on Windows) — the surrounding try/catch cannot see it, and with
 * no listener Node makes it an uncaught exception that kills the WHOLE
 * UserPromptSubmit dispatcher, losing every contributor's additionalContext.
 *
 * ── how this runs ────────────────────────────────────────────────────────────
 * In a separate node process (a driver script), so an uncaught exception shows
 * up as that process's exit code rather than a stray vitest worker error. The
 * driver imports the dispatcher module (its `isMainEntry` guard keeps `main()`
 * from running), awaits `runGitAutopilotSave` ROUNDS times against a stand-in
 * child that never reads stdin, and prints one JSON line.
 *
 * ── what this does NOT see ───────────────────────────────────────────────────
 * The real git-autopilot-save script (the `scriptPath` override replaces it),
 * real UserPromptSubmit payload sizes (1 MB here, far above any pipe buffer, so
 * the write is certain to be pending at child exit), and a child that reads
 * PART of stdin and then exits (same code path, not run).
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DISPATCHER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

/** Rounds per run — one unhandled EPIPE is enough to kill an unguarded driver. */
const ROUNDS = 5;

let dir;
let childPath;
let driverPath;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-ups-epipe-'));
  childPath = path.join(dir, 'no-read-child.js');
  driverPath = path.join(dir, 'driver.mjs');
  // Never touches stdin.
  writeFileSync(childPath, 'process.exit(0);\n');
  writeFileSync(driverPath, [
    'const { runGitAutopilotSave } = await import(process.argv[2]);',
    'const payload = { blob: "x".repeat(1024 * 1024) };',
    'let rounds = 0;',
    `for (let i = 0; i < ${ROUNDS}; i += 1) {`,
    '  await runGitAutopilotSave(payload, { scriptPath: process.argv[3], timeoutMs: 20000 });',
    '  rounds += 1;',
    '}',
    'process.stdout.write(JSON.stringify({ rounds }) + "\\n");',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runGitAutopilotSave — child that never reads stdin, payload far above the pipe buffer', () => {
  it(`resolves every round and the dispatcher process survives (${ROUNDS} rounds, 1 MB payload)`, () => {
    // cwd is the mkdtemp sandbox (tests/firewall/dispatcher-cwd-sandbox-required.test.js):
    // the driver imports the dispatcher module, and nothing it loads may resolve a
    // repository from the checkout. Every path handed over is absolute.
    const r = spawnSync(process.execPath, [driverPath, toFileUrl(DISPATCHER), childPath], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(r.status, `exit ${r.status}\nstderr: ${String(r.stderr).slice(0, 2000)}`).toBe(0);
    const line = r.stdout.trim().split('\n').pop();
    expect(JSON.parse(line)).toEqual({ rounds: ROUNDS });
    expect(r.stderr).not.toMatch(/Unhandled|uncaught/i);
  }, 200_000);
});
