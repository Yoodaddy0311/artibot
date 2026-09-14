import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { buildDevVerifyOutput } from '../../lib/core/dev-verify-output.js';

/**
 * dev-verify-gate.js — the "unmeasured denominator" ledger wiring (OB-07).
 *
 * WHY A SEPARATE FILE FROM `dev-verify-gate.test.js`. That suite mocks
 * `node:child_process` with an `execSync`-only factory, so `spawnSync` is not
 * importable inside it and no child process can be started from it. The cases
 * below need a REAL process (the hook's own stdout bytes and the ledger file it
 * leaves behind are the measurement), so they live here. Per the repo's
 * Stop-gate stem rule, `<stem>-<suffix>.test.js` still counts as coverage of
 * `dev-verify-gate.js`.
 *
 * WHICH CASE IS MEASURED HOW:
 *   - case 1 (ledger contents)      REAL SPAWN
 *   - case 2a (normal stdout)       REAL SPAWN
 *   - case 2b (ledger unwritable)   REAL SPAWN
 *   - case 2c (lib import fails)    NOT HERE — the hook resolves `lib/` relative
 *     to its own file, so no sandbox can remove it. It is unit-tested with
 *     `vi.doMock` in `dev-verify-gate.test.js`.
 *   - case 3 (idempotency)          REAL SPAWN
 *   - case 4 (no session_id)        REAL SPAWN
 *
 * WHAT THESE TESTS CANNOT SEE (rules §9, stated next to the gate): the ledger
 * that PRODUCTION writes (this is a throwaway repo), concurrency with the five
 * sibling Stop hooks, and any line appended after the read below.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '../../scripts/hooks/dev-verify-gate.js');
const SESSION = 'sessVGW00001';

/**
 * PINNED COPY of `dev-verify-gate.js#DEV_VERIFY_REASON` (module-private, so it
 * cannot be imported). If the hook's string changes, this test fails and BOTH
 * must be updated together — that is the point of pinning it.
 */
const DEV_VERIFY_REASON =
  'DEV verify (CLAUDE.md DEV Protocol): report per-item evidence (file:line); ' +
  "flag anything unproven as 'Pending verification'.";

/** The exact bytes the hook must print on the fire path, in every case. */
const EXPECTED_STDOUT = JSON.stringify(
  buildDevVerifyOutput(DEV_VERIFY_REASON, { mode: 'enforce', hookEventName: 'Stop' }),
);

/** @type {string[]} */
const created = [];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

/**
 * A throwaway repo `isArtibotRepo()` accepts, with a dirty tracked file, plus a
 * throwaway plugin root carrying ONLY the main-agent-edit marker (no
 * `runtime/last-dev-verify-sha.txt`), so the gate fires on the first run.
 *
 * @returns {{ repo: string, pluginRoot: string, ledger: string, cache: string }}
 */
function buildSandbox() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'dvg-it-repo-'));
  created.push(repo);
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  mkdirSync(path.join(repo, 'plugins', 'artibot'), { recursive: true });
  writeFileSync(path.join(repo, 'plugins', 'artibot', 'CLAUDE.md'), '# stub\n');
  writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  git(['add', 'plugins/artibot/CLAUDE.md', 'tracked.txt'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  writeFileSync(path.join(repo, 'tracked.txt'), `dirty ${Date.now()}\n`);

  const pluginRoot = mkdtempSync(path.join(os.tmpdir(), 'dvg-it-plugin-'));
  created.push(pluginRoot);
  mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
  writeFileSync(path.join(pluginRoot, 'runtime', 'last-main-agent-edit.timestamp'), 'x');

  return {
    repo,
    pluginRoot,
    ledger: ledgerFilePath(repo),
    cache: path.join(pluginRoot, 'runtime', 'last-dev-verify-sha.txt'),
  };
}

/**
 * Spawn the hook exactly the way the Stop dispatcher does.
 *
 * @param {{repo: string, pluginRoot: string}} box
 * @param {object} [payload] stdin JSON; `null` sends a payload with no session_id
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runHook(box, payload) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: box.pluginRoot };
  delete env.ARTIBOT_DEV_VERIFY_MODE;
  const stdin = JSON.stringify(
    payload ?? { session_id: SESSION, hook_event_name: 'Stop', stop_hook_active: false },
  );
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: box.repo,
    input: stdin,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Every non-blank line of the sandbox ledger, parsed. Read RAW (not through
 * `readAllEvents`) because the reader hides `ledger.rejected` by default and
 * those lines are part of what case 1 asserts.
 *
 * @param {string} ledger
 * @returns {object[]}
 */
function readLedgerLines(ledger) {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('dev-verify-gate — unmeasured denominator (real spawn)', () => {
  it('writes 3 layer lines + 1 overall line, all unmeasured, and nothing rejected', () => {
    const box = buildSandbox();
    const run = runHook(box);
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    const where = `sandbox ledger: ${box.ledger}`;
    expect(lines.length, `${where} — stderr: ${run.stderr}`).toBe(4);

    const verifyLines = lines.filter((e) => e.event === 'verify.completed');
    expect(verifyLines.length, where).toBe(4);
    expect(lines.filter((e) => e.event === 'ledger.rejected').length, where).toBe(0);

    for (const e of verifyLines) {
      expect(e.session_id, where).toBe(SESSION);
      expect(e.source, where).toBe('gate');
      expect(e.data.result, where).toBe('unmeasured');
      expect(typeof e.data.verification_id, where).toBe('string');
    }

    const layered = verifyLines.filter((e) => 'layer' in e.data);
    expect(layered.map((e) => e.data.layer).sort(), where)
      .toEqual(['behavioral', 'deterministic', 'operational']);

    const overall = verifyLines.filter((e) => !('layer' in e.data));
    expect(overall.length, `${where} — the overall line must carry NO layer`).toBe(1);

    // One verdict, so one join key across all four lines.
    const ids = new Set(verifyLines.map((e) => e.data.verification_id));
    expect(ids.size, where).toBe(1);
  }, 60_000);

  it('prints byte-identical stdout when the ledger cannot be written (case 2b)', () => {
    const normal = runHook(buildSandbox());
    expect(normal.stdout).toBe(EXPECTED_STDOUT);

    const box = buildSandbox();
    // Occupy the ledger DIRECTORY path with a regular file, so the writer's
    // mkdir fails. `appendLedgerEvent` never throws, so the hook must be
    // unaffected; the ledger simply stays absent.
    const ledgerDir = path.dirname(box.ledger);
    rmSync(ledgerDir, { recursive: true, force: true });
    writeFileSync(ledgerDir, 'not a directory\n');

    const blocked = runHook(box);
    expect(
      Buffer.from(blocked.stdout, 'utf-8').equals(Buffer.from(normal.stdout, 'utf-8')),
      `normal=${JSON.stringify(normal.stdout)} blocked=${JSON.stringify(blocked.stdout)} `
      + `stderr=${blocked.stderr}`,
    ).toBe(true);
    expect(readLedgerLines(box.ledger)).toEqual([]);
  }, 60_000);

  it('records nothing and prints the same stdout when stdin carries no session_id', () => {
    const box = buildSandbox();
    const run = runHook(box, { hook_event_name: 'Stop', stop_hook_active: false });
    expect(run.stdout, `hook stderr: ${run.stderr}`).toBe(EXPECTED_STDOUT);
    expect(readLedgerLines(box.ledger), `sandbox ledger: ${box.ledger}`).toEqual([]);
  }, 60_000);

  /**
   * IDEMPOTENCY, STATED PRECISELY: the fingerprint cache
   * (`runtime/last-dev-verify-sha.txt`) is the EFFECTIVE dedupe — a second Stop
   * over the same working-tree state returns before any ledger work. The
   * writer's idempotency key only dedupes SAME-SECOND retries, because
   * `verification_id` embeds `measured_at` at second resolution
   * (`unified-verifier.js#buildVerificationId`, stamp `YYYYMMDDTHHMMSSZ`). This
   * test forces a >= 1100ms gap so the second fire is provably in a different
   * second and must append four MORE lines.
   */
  it('does not re-append while the fingerprint is cached, and appends a fresh verdict once it is cleared', async () => {
    const box = buildSandbox();
    expect(runHook(box).stdout).toBe(EXPECTED_STDOUT);
    expect(readLedgerLines(box.ledger).length, `sandbox ledger: ${box.ledger}`).toBe(4);
    expect(existsSync(box.cache)).toBe(true);

    // Same state again: the fingerprint cache short-circuits before the ledger.
    const second = runHook(box);
    expect(second.stdout, 'a cached fingerprint must produce NO stdout').toBe('');
    expect(readLedgerLines(box.ledger).length).toBe(4);

    await new Promise((resolve) => { setTimeout(resolve, 1100); });
    rmSync(box.cache, { force: true });
    expect(runHook(box).stdout).toBe(EXPECTED_STDOUT);

    const lines = readLedgerLines(box.ledger);
    expect(lines.length, `sandbox ledger: ${box.ledger}`).toBe(8);
    const ids = new Set(lines.map((e) => e.data.verification_id));
    expect(ids.size, 'two fires a second apart are two verdicts, not one').toBe(2);
  }, 60_000);
});
