import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SessionEnd dispatcher integration tests.
 *
 * These spawn the REAL dispatcher, which runs the real SessionEnd pipeline —
 * including the learning stage that appends to `<home>/.claude/artibot/`.
 * The home directory is therefore redirected to a throwaway temp dir for the
 * whole file. Without it the suite writes its fixtures into the developer's
 * own learning store: a measured 244 of 500 rows in `evaluations.json` were
 * `end-test` / `end-stdout` fixtures, i.e. half the corpus that per-model
 * analysis reads. Disabling checkpoint/memory/swarm/network (below) is not
 * enough — the learning writes go through a different path.
 *
 * TWO redirections, for two different blast radii — the second one matches
 * `sessionstart-dispatcher.test.js`, which had to add it after a measured
 * incident. `spawnHook` passes no `cwd`
 * (`scripts/hooks/_dispatcher-utils.js#spawnHook`), so every grand-child inherits
 * whatever cwd this file hands the dispatcher: the cwd below is load-bearing,
 * not incidental.
 *
 *  - HOME/USERPROFILE -> throwaway dir (above).
 *
 *  - cwd -> throwaway NON-git dir. None of the 6 SessionEnd hooks is a
 *    git-autopilot hook (measured 2026-09-04T05:03Z: `HOOKS` = session-end /
 *    swarm-sync / rotation-runner / memory-tracker / http-notify /
 *    session-ledger), so unlike SessionStart there is no `checkout -b` to
 *    prevent here. Three of them do read `process.cwd()`, and all three
 *    reads end in the home sandbox rather than the repo:
 *      * `session-end.js:89` and `memory-tracker.js:134` copy the string into
 *        a state/summary record written under `<home>/.claude/artibot/`.
 *      * `session-ledger.mjs:46` resolves from the PAYLOAD `cwd` key, not
 *        from the process, and skips when it is absent — no payload in this
 *        file carries `cwd`.
 *    MEASURED, baseline run 2026-09-04T05:03:18Z (31/31 pass across the three
 *    dispatcher suites): no repo artifact moved — worktree `autopilot.json`
 *    absent before and after, HEAD/branch/reflog/`artibot/*` identical,
 *    `git status --porcelain` 0 lines both sides.
 *
 *    The redirection is therefore defense in depth plus uniformity, not a
 *    repair of an observed leak: it makes the cwd of every dispatcher suite
 *    structurally incapable of reaching a repository, which is what
 *    `tests/firewall/dispatcher-cwd-sandbox-required.test.js` enforces.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_sessionend-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-sessionend-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-sessionend-cwd-'));
});

afterAll(() => {
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  if (sandboxCwd) rmSync(sandboxCwd, { recursive: true, force: true });
});

/**
 * Spawn options for the dispatcher, in ONE place so the isolation self-check
 * at the bottom reads the same `cwd` the real spawns use. Inlining `cwd:` at
 * the call site instead lets the two drift, and the self-check then passes
 * vacuously: measured 2026-09-04T05:13Z, the first draft of this file kept
 * asserting on the sandbox while the spawn had been pointed back at the
 * checkout, and reported green. The indirection is the detector.
 *
 * @param {Record<string,string>} [env] extra environment for this spawn
 * @returns {import('node:child_process').ExecFileSyncOptions}
 */
function spawnOptions(env = {}) {
  return {
    cwd: sandboxCwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      // getHomeDir() reads USERPROFILE then HOME — both must point at the
      // sandbox or the real learning store gets the fixtures.
      USERPROFILE: sandboxHome,
      HOME: sandboxHome,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
      ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      // Disable outbound network from swarm-sync / http-notify in test runs.
      ARTIBOT_SWARM_DISABLE: '1',
      ARTIBOT_HTTP_NOTIFY_DISABLE: '1',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 45000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function runDispatcher(payload, env = {}) {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH],
      { ...spawnOptions(env), input: JSON.stringify(payload) },
    );
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout?.toString('utf-8') || '';
  }
  return { stdout: stdout.trim(), status };
}

/**
 * EVERY session id this suite feeds the dispatcher. A leak into the real
 * project ledger can only be attributed to this file through one of these, so
 * an id that is sent but not listed is a blind spot, not a saving.
 *
 * Enumerated from the `runDispatcher` call sites rather than remembered —
 * reproduce with `grep -n "session_id: '" tests/dispatcher/sessionend-dispatcher.test.js`
 * (5 sent ids, measured 2026-09-10; line numbers are deliberately not cited
 * here because they rot). The first draft listed only 3 and silently dropped the two
 * DISABLE-path ids, which is the worst pair to miss: a write from a run that
 * was supposed to be switched off entirely is a more serious defect than a
 * write from an enabled one, so those are exactly the ids whose absence must
 * be provable.
 *
 * The sixth call site (the one posting `{}` with no id at all) is deliberately
 * NOT represented here: `safeSession(undefined)` returns the generic
 * `'session'` (`store.js:56-59`), and pinning that string would fire on any
 * real session the host ever names `session.jsonl` — the flake this detector
 * was narrowed to remove.
 */
const FIXTURE_SESSION_IDS = [
  'end-test',
  'end-disable',
  'end-global-disable',
  'end-stdout',
  'end-no-side-effects',
];

/**
 * Fixture traces in a ledger directory, by the two shapes a real leak takes.
 *
 * NOT SUBSTRING MATCHING — that is what this replaced, and it was a false
 * positive generator. The previous form joined every `*.jsonl` in the real
 * `.artibot/ledger/` and asserted the raw text did not CONTAIN 'end-test' /
 * 'end-stdout' / 'end-no-side-effects'. But that directory also holds real
 * session transcripts, and prose in a transcript may QUOTE the fixture name —
 * a teammate message discussing this very test does exactly that. Measured
 * 2026-09-10 on this checkout: 7 rows across
 * `81202b00-…jsonl` and `bda9c5e5-…jsonl` matched the substrings, and 0 of
 * them were a fixture envelope — 6 carried a top-level `session_id` holding
 * the real session uuid, 1 had none. The suite went red while the repository
 * was in fact untouched. A detector that fires on discussion of itself is
 * noise, and noise is what gets a real detector deleted.
 *
 * The two signatures below are what a genuine leak actually produces:
 *
 *  1. FILENAME. `session-ledger.mjs:46` resolves the project root and
 *     `store.js:66` names the file `<safeSession(session_id)>.jsonl`, so a
 *     leaked fixture run creates `end-test.jsonl` itself. This is the PRIMARY
 *     signature: `appendKept` (`store.js:141`) copies denoised TRANSCRIPT
 *     lines verbatim, and those rows carry the transcript's own session id,
 *     not the fixture id — so a row-only check would be fail-open against the
 *     exact leak this test exists to catch.
 *
 *  2. ROW ENVELOPE. Any row whose parsed top-level `session_id` IS a fixture
 *     id, for a writer that stamps the id into the row rather than the name.
 *     Compared by VALUE, never by presence: real transcript rows carry a
 *     `session_id` key too.
 *
 * Unparseable lines are ignored — a corrupt ledger line is someone else's
 * concern, and treating it as a hit would reintroduce the flake.
 *
 * NOT COVERED: the cursor file `.cursor.json` also gains a key per session id
 * (`store.js:255`), and is neither `.jsonl` nor `.ndjson`, so a leak that
 * wrote a cursor entry but no rows is invisible here.
 *
 * @param {string} dir ledger directory to scan
 * @returns {string[]} one finding per trace; empty means clean
 */
function fixtureLedgerTraces(dir) {
  if (!existsSync(dir)) return [];
  const findings = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = entry.name;
    if (!file.endsWith('.jsonl') && !file.endsWith('.ndjson')) continue;
    const stem = file.replace(/\.(?:jsonl|ndjson)$/, '');
    if (FIXTURE_SESSION_IDS.includes(stem)) findings.push(`file:${file}`);
    // Read only real files: `readFileSync` on a directory that happens to be
    // named `*.jsonl` throws EISDIR (reproduced 2026-09-10), and a detector
    // that dies on a malformed neighbour reports nothing about the leak it
    // was watching for. The NAME check above still runs for such an entry —
    // skipping it entirely would trade a crash for a fail-open.
    if (!entry.isFile()) continue;
    for (const line of readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // unparseable line — not this assertion's business
      }
      if (row && typeof row === 'object' && FIXTURE_SESSION_IDS.includes(row.session_id)) {
        findings.push(`row:${file}:${row.session_id}`);
      }
    }
  }
  return findings;
}

describe('_sessionend-dispatcher (integration)', () => {
  it('exits 0 with empty payload', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('exits 0 with typical SessionEnd payload', () => {
    const { status } = runDispatcher({
      session_id: 'end-test',
      reason: 'user-quit',
    });
    expect(status).toBe(0);
  });

  it('respects ARTIBOT_DISABLE_SESSIONEND_DISPATCHER=1', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'end-disable' },
      { ARTIBOT_DISABLE_SESSIONEND_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global)', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'end-global-disable' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits at most one valid JSON document', () => {
    const { stdout, status } = runDispatcher({ session_id: 'end-stdout' });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('registers all 6 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_sessionend-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(6);
    const names = mod.HOOKS.map((h) => h.name);
    expect(names).toContain('session-end');
    expect(names).toContain('swarm-sync');
    expect(names).toContain('rotation-runner');
    expect(names).toContain('memory-tracker');
    expect(names).toContain('http-notify');
    expect(names).toContain('session-ledger');
  });

  it('passes "SessionEnd" arg to memory-tracker', async () => {
    const mod = await import('../../scripts/hooks/_sessionend-dispatcher.js');
    const memoryTracker = mod.HOOKS.find((h) => h.name === 'memory-tracker');
    expect(memoryTracker).toBeTruthy();
    expect(memoryTracker.args).toEqual(['SessionEnd']);
  });

  /**
   * Isolation self-check — asserted, not assumed.
   *
   * Two independent statements, because either one alone can be true while
   * the suite still leaks:
   *
   *  1. STRUCTURAL: the cwd handed to the dispatcher is not inside any git
   *     repository, so every `git rev-parse --show-toplevel` a grand-child
   *     runs from it fails and the hook returns before reading or writing.
   *     This is isolation by TOPOLOGY, not by DATA — see
   *     `sessionstart-dispatcher.test.js`, where gating on a mutable
   *     `enabled` flag was the bug.
   *
   *  2. BEHAVIOURAL: no artifact this suite could have produced exists in the
   *     project-local session ledger `session-ledger.mjs:46` would target.
   *     Pinned by fixture session id rather than by file hash on purpose —
   *     the live session appends real rows to the same directory, so a hash
   *     comparison would be a flake, not a detector. Pinned by PARSED
   *     `session_id` and by FILENAME rather than by substring for the same
   *     reason in the other direction: the live session may also quote a
   *     fixture name in prose. See `fixtureLedgerTraces` for the measurement
   *     that forced the narrowing, and for what it still cannot see.
   *
   * WHAT THIS DOES NOT COVER: writes a hook reaches by absolute path rather
   * than through HOME or cwd. `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo;
   * they are gitignored (`plugins/artibot/.gitignore:10`) and cannot dirty
   * git, which is why they are left alone.
   */
  it('leaves the real repository untouched (non-git cwd, no fixture row in the project ledger)', () => {
    // Read through spawnOptions(), never from `sandboxCwd` directly — that is
    // what makes this assertion go red if the spawn cwd is pointed back at
    // the checkout.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: spawnOptions().cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    const { status } = runDispatcher({
      session_id: 'end-no-side-effects',
      reason: 'user-quit',
    });
    expect(status).toBe(0);

    const ledgerDir = path.join(PLUGIN_ROOT, '..', '..', '.artibot', 'ledger');
    expect(fixtureLedgerTraces(ledgerDir)).toEqual([]);
  });

  /**
   * Detector self-check — both directions, on a throwaway directory.
   *
   * Without this the assertion above is indistinguishable from one that can
   * never fire: after the narrowing it passes on a clean repo either way. The
   * negative control is the exact row shape measured in the real ledger on
   * 2026-09-10 (transcript row, fixture name inside `message`, top-level
   * `session_id` holding the real session uuid) — the input that made the old
   * substring form go red.
   *
   * mkdtemp, never the real `.artibot/ledger/`: a detector that plants its own
   * positive control in the directory it watches is the flake it is testing
   * for.
   */
  it('flags a fixture row by session_id but not prose that quotes the id (detector self-check)', () => {
    const probeDir = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-probe-'));
    try {
      // NEGATIVE — a real transcript that merely QUOTES the fixture names.
      const real = 'bda9c5e5-e827-4957-a29b-485721b43ae2';
      writeFileSync(path.join(probeDir, `${real}.jsonl`), [
        JSON.stringify({
          type: 'assistant',
          session_id: real,
          sessionId: real,
          message: { role: 'assistant', content: "the 'end-test' and 'end-stdout' fixtures" },
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'why did end-no-side-effects fail?' },
        }),
        'not json at all — ignored, not a hit',
        '',
      ].join('\n'), 'utf-8');
      expect(fixtureLedgerTraces(probeDir)).toEqual([]);

      // POSITIVE (a) — a row that really carries the fixture id.
      writeFileSync(
        path.join(probeDir, `${real}.jsonl`),
        `${JSON.stringify({ type: 'assistant', session_id: 'end-test' })}\n`,
        'utf-8',
      );
      expect(fixtureLedgerTraces(probeDir)).toEqual([`row:${real}.jsonl:end-test`]);

      // POSITIVE (b) — the shape store.js:66 actually writes: the fixture id
      // is the FILENAME and the rows carry the transcript's own session id.
      rmSync(path.join(probeDir, `${real}.jsonl`));
      writeFileSync(
        path.join(probeDir, 'end-test.jsonl'),
        `${JSON.stringify({ type: 'assistant', session_id: real })}\n`,
        'utf-8',
      );
      expect(fixtureLedgerTraces(probeDir)).toEqual(['file:end-test.jsonl']);

      // POSITIVE (c) — a DISABLE-path id. The dispatcher is switched off on
      // those two runs, so a write there is a worse defect than a write from
      // an enabled run, not a lesser one. Covered explicitly because the id
      // list silently omitted `end-disable` / `end-global-disable` until
      // review caught it: the list and the detector must be tested together,
      // or a future deletion from the list is green.
      rmSync(path.join(probeDir, 'end-test.jsonl'));
      writeFileSync(
        path.join(probeDir, `${real}.jsonl`),
        `${JSON.stringify({ type: 'assistant', session_id: 'end-global-disable' })}\n`,
        'utf-8',
      );
      expect(fixtureLedgerTraces(probeDir)).toEqual([`row:${real}.jsonl:end-global-disable`]);

      // POSITIVE (d) — a DIRECTORY named `*.jsonl`. `readFileSync` on one
      // throws EISDIR (reproduced 2026-09-10), which would abort the scan and
      // report nothing about the leak. The name signature must still fire, so
      // `isFile()` gates only the READ: filtering it out of the loop entirely
      // would trade the crash for a fail-open. `trap.jsonl` is the control —
      // a stray directory that is not a fixture id must stay silent.
      rmSync(path.join(probeDir, `${real}.jsonl`));
      mkdirSync(path.join(probeDir, 'trap.jsonl'));
      mkdirSync(path.join(probeDir, 'end-test.jsonl'));
      expect(() => fixtureLedgerTraces(probeDir)).not.toThrow();
      expect(fixtureLedgerTraces(probeDir)).toEqual(['file:end-test.jsonl']);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
