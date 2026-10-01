/**
 * Two plugin versions adopting the old store AT THE SAME TIME must not lose the
 * record of what they adopted (review of 6b410964, SHOULD 1).
 *
 * WHAT WENT WRONG. The first version kept "which ids have I dealt with" in ONE
 * ledger file: read at the start of a pass, rewritten at its end. Two processes
 * adopting concurrently each wrote the ledger they had built, the last writer won,
 * and every id only the other one had recorded was gone. Measured by the reviewer:
 * 40 ids lost across 15 of 15 concurrent runs of two versions, and a session the
 * user had deleted came back in 3 of 3. The sessions themselves were never lost —
 * their copy is an exclusive create — it was the memory of having copied them.
 * That is the failure that matters: a session the user deleted reappears.
 *
 * WHY THE ASSERTION IS BEHAVIOURAL. Nothing below reads the ledger. It runs real
 * processes against one store, deletes everything the first round adopted (the
 * user pruning the store), runs a second round, and counts what came back. That
 * holds for any bookkeeping that works — a file, a directory of markers, a
 * database — and fails for any that loses an update.
 *
 * WHAT MAKES IT A CONCURRENT TEST. Each child imports the module, then waits until
 * a shared wall-clock instant before it starts (`Atomics.wait`, not a busy loop),
 * so the four start within about a millisecond of each other instead of in spawn
 * order. The fixtures are large enough (280 sessions) that a pass lasts hundreds of
 * milliseconds: a window that short would hide the race.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - Interleavings the OS scheduler did not produce in these runs. A passing run
 *     is evidence, not a proof; the race it guards is narrow by construction and
 *     the per-id marker design removes the shared file rather than shrinking the
 *     window.
 *   - A crash between copying a session and recording it. The next pass sees the
 *     session present and records it, but a session deleted in that gap comes back.
 *   - Real-sized sessions. These are a few hundred bytes.
 */

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real processes, a synchronized start, two rounds: the budget buys headroom for load.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSION_STORE_URL = `file://${path.join(PLUGIN_ROOT, 'lib', 'autopilot', 'session-store.js').split(path.sep).join('/')}`;

/** Sessions only one version has, per version; and sessions both have. */
const PER_VERSION = 120;
const SHARED = 40;
const UNIQUE_IDS = PER_VERSION * 2 + SHARED;

let base;
let home;
let storeDir;
let childScript;
const roots = {};

const CHILD_SOURCE = `
const [, , storeUrl, goAt] = process.argv;
const store = await import(storeUrl);
const gate = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < Number(goAt)) Atomics.wait(gate, 0, 0, 2);
const report = store.migrateLegacyStore({ force: true });
process.stdout.write(JSON.stringify({
  sessions: report.sessions.length,
  present: report.present.length,
  errors: report.errors,
  skipped: report.skipped,
}) + '\\n');
`;

function versionRoot(version) {
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'artibot.config.json'), '{}', 'utf-8');
  return dir;
}

function seedLegacy(root, ids) {
  const dir = path.join(root, 'runtime', 'autopilot');
  mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ sessionId: id, phase: 'PAUSED', from: path.basename(root) }), 'utf-8');
  }
}

const pad = (n) => String(n).padStart(3, '0');

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-adopt-race-'));
  home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  storeDir = path.join(home, '.claude', 'artibot', 'runtime', 'autopilot');
  roots.a = versionRoot('4.70.0');
  roots.b = versionRoot('4.71.0');
  const shared = Array.from({ length: SHARED }, (_, i) => `ap-shared-${pad(i)}`);
  seedLegacy(roots.a, [...Array.from({ length: PER_VERSION }, (_, i) => `ap-a-${pad(i)}`), ...shared]);
  seedLegacy(roots.b, [...Array.from({ length: PER_VERSION }, (_, i) => `ap-b-${pad(i)}`), ...shared]);
  childScript = path.join(base, 'adopt-child.mjs');
  writeFileSync(childScript, CHILD_SOURCE, 'utf-8');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The four adopters: two processes per plugin version. */
const VERSIONS = ['a', 'b', 'a', 'b'];

function childEnv(root) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    CLAUDE_PLUGIN_ROOT: root,
  };
  for (const key of [
    'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME', 'ARTIBOT_AUTOPILOT_STORE_DIR', 'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT',
  ]) delete env[key];
  return env;
}

/**
 * One round: all four adopters released at the same instant.
 *
 * @returns {Promise<Array<{sessions: number, present: number, errors: number, skipped: string|null}>>}
 */
async function runRound() {
  const goAt = Date.now() + 4000;
  const runs = VERSIONS.map((v) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, SESSION_STORE_URL, String(goAt)], {
      env: childEnv(roots[v]), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`adopter exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim().split('\n').pop()));
    });
  }));
  return Promise.all(runs);
}

const sessionFiles = () => (existsSync(storeDir)
  ? readdirSync(storeDir).filter((n) => n.endsWith('.json'))
  : []);

describe('two plugin versions adopting at once', () => {
  it('adopts every session exactly once, and forgets none of them having done so', async () => {
    const first = await runRound();

    // Nothing lost, nothing half-copied: every id from both versions is in the store.
    expect(sessionFiles()).toHaveLength(UNIQUE_IDS);
    expect(first.every((r) => r.errors === 0)).toBe(true);

    // The user prunes the store: every adopted session is deleted.
    for (const name of readdirSync(storeDir)) {
      if (name.endsWith('.json')) rmSync(path.join(storeDir, name), { force: true });
    }
    expect(sessionFiles()).toHaveLength(0);

    // A later pass by the same two versions finds every session still sitting in
    // the old directories. None of them may come back.
    const second = await runRound();

    expect(second.reduce((n, r) => n + r.sessions, 0)).toBe(0);
    expect(sessionFiles()).toHaveLength(0);
  });
});
