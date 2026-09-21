/**
 * Real-process contract for `scripts/ledger/topology-agreement.mjs` — the
 * post-hoc reader that divides "what the topology router RECOMMENDED" by "what
 * the session ACTUALLY spawned".
 *
 * WHY THE CASES SPAWN A PROCESS AND SEED REAL FILES. The question this script
 * answers is a JOIN across two stores written by two different hooks
 * (`.artibot/runtime/decisions/*.events.ndjson` and
 * `<git-common-dir>/artibot/spawns.ndjson`), and the join key is a hook
 * `session_id` that neither store validates. A pure unit test over two arrays
 * would prove the arithmetic and prove nothing about whether the two paths
 * resolve to the same project, which is the failure mode that actually bites:
 * `spawnLedgerPath` goes through `resolveGitCommonDir`, so a root without a
 * `.git` marker silently reads a DIFFERENT file than a root with one. Every
 * case here therefore builds a root shaped like the live one and spawns the
 * real script against it.
 *
 * THE FIXTURE MIRRORS LIVE LINE SHAPES ON PURPOSE. The seeded rows are copies
 * of real lines sampled from this machine's parent stores on 2026-09-21
 * (one `topology-recommended` envelope with its full `data` block, one spawn
 * row with all v5 routing columns), with ids and timestamps changed. A fixture
 * that is not shaped like reality proves nothing: the reader filters on
 * `type`, `event` and an `agentType` PREFIX, and a slimmed-down row would let a
 * reader that mis-reads the envelope stay green. The seeds also include
 * `routing-classified`, `workflow-planned` and `memory-injection-measured`
 * rows, so "the reader ignores the other three types" is measured rather than
 * assumed.
 *
 * READ-ONLY IS ASSERTED, NOT ASSUMED. "It does not import a writer" is a claim
 * about the source, not about the run. Two cases measure the filesystem: an
 * empty root must still hold no decisions store and no spawn ledger after a
 * run, and a seeded root's two files must have identical byte lengths before
 * and after. A measuring tool that appends to the stream it measures is its own
 * next data point, and that regression is invisible in every other assertion.
 *
 * `agreement_rate` IS `null`, NEVER `0`, WHEN NOTHING WAS MEASURED — asserted
 * with BOTH `toBeNull()` and `not.toBe(0)`. "No denominator yet" and "windows
 * were measured and none agreed" are different findings, and a `toBeFalsy()`
 * would pass for either. Same rule for the reverse direction: a team
 * recommendation count of 0 must print `structurally-unobservable`, never a
 * 0/0 that reads as perfect agreement.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *  Every case builds its own `mkdtempSync` root and passes it as `--cwd` AND as
 *  the child cwd, so nothing here can reach the repository's own stores.
 *  `resolveGitCommonDir` is pure `fs` (no `git` subprocess), so the path this
 *  file computes and the path the child computes come from one function over
 *  one root.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - THE LIVE DISTRIBUTION. Every row here is seeded. The live numbers belong
 *    in the run report, not in an assertion that would go red on new sessions.
 *  - WHETHER THE SPAWN LEDGER DROPS STARTS. The `stop`-only agent id seeded in
 *    S1 reproduces a loss measured 2026-09-04; this file asserts the reader
 *    COUNTS the loss, not that the loss rate is any particular number.
 *  - AUTOPILOT / SPLIT ACTUAL. Those live under the plugin's own runtime
 *    directories and are `unmeasured` in v1 by contract, so a seeded split row
 *    asserts the bucket, not a match rule.
 *
 * @module tests/ledger/topology-agreement
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPOLOGY_MODES } from '../../lib/topology/topology-router.js';
import { getDecisionStoreDir } from '../../lib/observability/decision-events.js';
import { spawnLedgerPath } from '../../lib/learning/ledger/spawn-ledger.js';
import { DEFAULT_SINCE, F04A_T0 } from '../../scripts/ledger/topology-agreement.mjs';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'topology-agreement.mjs');

/** The exact key set the script's header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'measured_at', 'project_root', 'decisions_dir', 'spawn_ledger_path', 'since', 't0',
  'modes', 'totals', 'agreement_rate', 'open_windows', 'excluded_files',
  'excluded_sessions', 'stop_only_ids', 'sessions_with_tr',
  'sessions_in_spawn_ledger', 'sessions_joined', 'reverse_direction',
  'non_uuid_sessions',
];

/** The footnote the human report prints for the synthetic-session counter. */
const NON_UUID_NOTE = 'non_uuid_sessions        1   (synthetic / test-fixture residue'
  + ' — still counted; prefixed classes are in excluded_files)';

/** The line the human report must print when no team row exists in range. */
const REVERSE_LINE = 'reverse direction (team recommended -> 0 spawns): structurally unobservable'
  + ' — tasks.js#createTasksMiddleware attaches workflowPlan only for agentTeam,'
  + ' so routeTopology can only say team after the caller already chose team';

const S1 = '65de3647-f05d-4c97-8c9a-10b31313e060';
const S2 = '7a1c0b92-2d44-4f18-9a70-1c2b3d4e5f60';
const S3 = '9b2d1ca3-3e55-4028-8b81-2d3c4e5f6071';

const roots = [];

/**
 * Build a temp project root shaped like a live one: an `artibot.config.json`
 * (Artibot guards drop out entirely outside an Artibot repo), a plain `.git`
 * DIRECTORY so `resolveGitCommonDir` resolves and the spawn ledger lands at
 * `<root>/.git/artibot/spawns.ndjson` rather than the non-repo fallback, and
 * the decisions store directory.
 *
 * @returns {string} absolute root
 */
function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'topo-agree-'));
  roots.push(root);
  writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify({ version: 5 }), 'utf8');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(getDecisionStoreDir({ projectRoot: root }), { recursive: true });
  return root;
}

/**
 * One `topology-recommended` envelope, copied from a live line sampled
 * 2026-09-21T01:13:58Z and re-stamped. The whole `data` block is kept: the
 * reader must find `mode` inside a realistic envelope, not a two-key stub.
 *
 * @param {{ts: string, sessionId: string, mode: string}} row
 * @returns {object}
 */
function trRow({ ts, sessionId, mode }) {
  return {
    ts,
    sessionId,
    phase: 'ROUTE',
    type: 'topology-recommended',
    level: 'info',
    message: `topology ${mode} (observe-only, routed nothing)`,
    data: {
      observe_only: true,
      mode,
      exception: null,
      confidence: 0.25,
      reason: ['runner:inline', 'recommendation:none', 'subs:0', 'domains:0', 'human-gates:unavailable'],
      parallelGain: {
        work: 0, coordination: 0, contextDup: 0, mergeRisk: 0, startup: 0, tokenDup: 0, net: 0,
      },
      parallelGainMeasured: {
        work: false, coordination: false, contextDup: false, mergeRisk: false, startup: false, tokenDup: false,
      },
      humanGateHits: { advisory: true, hits: [] },
    },
  };
}

/**
 * A decoy envelope of one of the three OTHER types this store carries. Seeded
 * in every session file so "the reader ignores them" is measured.
 *
 * @param {{ts: string, sessionId: string, type: string}} row
 * @returns {object}
 */
function otherRow({ ts, sessionId, type }) {
  return {
    ts,
    sessionId,
    phase: 'ROUTE',
    type,
    level: 'info',
    message: `${type} decoy`,
    // `mode` is present on purpose: a reader that filters on `data.mode`
    // instead of on `type` would count these and go red here.
    data: { mode: 'team', observe_only: true },
  };
}

/**
 * One spawn ledger row, copied from a live line sampled 2026-09-21T01:03:16Z.
 *
 * @param {{ts: string, sessionId: string, agentId: string, agentType: string,
 *          event: 'start'|'stop'}} row
 * @returns {object}
 */
function spawnRow({ ts, sessionId, agentId, agentType, event }) {
  const rec = {
    ts,
    sessionId,
    agentId,
    agentName: null,
    agentType,
    requestedModel: null,
    canonicalModel: null,
    modelMismatch: false,
    event,
    recommendedModel: null,
    actionClass: null,
    routing_epoch_id: agentId,
    depth: null,
    mission_id: `M-20260921-S${sessionId.slice(0, 8)}`,
  };
  if (event === 'stop') rec.durationMs = 19137;
  return rec;
}

/**
 * Write rows as NDJSON, creating parent directories. Deliberately NOT through
 * a recorder: this file measures the reader, and routing the seed through the
 * writer would make a writer regression look like a reader regression.
 *
 * @param {string} file
 * @param {object[]} rows
 * @returns {void}
 */
function writeNdjson(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/**
 * Path of one session's decisions file.
 *
 * @param {string} root
 * @param {string} stem
 * @returns {string}
 */
function decisionsFile(root, stem) {
  return path.join(getDecisionStoreDir({ projectRoot: root }), `${stem}.events.ndjson`);
}

/**
 * Seed the full fixture: three sessions, three excluded files, one `stop`-only
 * agent id, and one pre-`--since` row.
 *
 * S1 — three TR rows, so two CLOSED windows and one OPEN one:
 *   w1 [10:00,10:10) solo  + 2 `team-*` starts  -> mismatch, explicit_slash
 *                                                 -> input_deficit
 *   w2 [10:10,10:20) subagent + 1 `Explore` start -> match
 *   w3 [10:20,inf)   solo  + no starts            -> match, open
 * S2 — one `split` TR row + a `split-*` start -> unmeasured, open
 * S3 — one `team` TR row + two `team-*` starts -> match, open
 *
 * @param {string} root
 * @returns {void}
 */
function seedFull(root) {
  writeNdjson(decisionsFile(root, S1), [
    // BEFORE the default `--since`: must not open a window, and must not shift
    // the boundaries of the ones that follow.
    trRow({ ts: '2026-09-10T00:00:00.000Z', sessionId: S1, mode: 'team' }),
    trRow({ ts: '2026-09-20T10:00:00.000Z', sessionId: S1, mode: 'solo' }),
    otherRow({ ts: '2026-09-20T10:00:01.000Z', sessionId: S1, type: 'routing-classified' }),
    trRow({ ts: '2026-09-20T10:10:00.000Z', sessionId: S1, mode: 'subagent' }),
    otherRow({ ts: '2026-09-20T10:10:01.000Z', sessionId: S1, type: 'workflow-planned' }),
    trRow({ ts: '2026-09-20T10:20:00.000Z', sessionId: S1, mode: 'solo' }),
    otherRow({ ts: '2026-09-20T10:20:01.000Z', sessionId: S1, type: 'memory-injection-measured' }),
  ]);
  writeNdjson(decisionsFile(root, S2), [
    trRow({ ts: '2026-09-20T11:00:00.000Z', sessionId: S2, mode: 'split' }),
  ]);
  writeNdjson(decisionsFile(root, S3), [
    trRow({ ts: '2026-09-20T12:00:00.000Z', sessionId: S3, mode: 'team' }),
  ]);

  for (const stem of ['diag-abc', 'cron-xyz', '_unattributed']) {
    writeNdjson(decisionsFile(root, stem), [
      trRow({ ts: '2026-09-20T13:00:00.000Z', sessionId: `sess-${stem}`, mode: 'solo' }),
    ]);
  }

  writeNdjson(spawnLedgerPath(root), [
    spawnRow({
      ts: '2026-09-20T10:01:00.000Z', sessionId: S1, agentId: 'ateam-wave-x-planner-aaa1', agentType: 'team-wave-x-planner', event: 'start',
    }),
    spawnRow({
      ts: '2026-09-20T10:02:00.000Z', sessionId: S1, agentId: 'ateam-wave-x-reviewer-aaa2', agentType: 'team-wave-x-reviewer', event: 'start',
    }),
    // A `stop` with no `start` anywhere in the session — the measured ledger
    // loss. It must land in `stop_only_ids` and NOT in the spawn count.
    spawnRow({
      ts: '2026-09-20T10:03:00.000Z', sessionId: S1, agentId: 'aexplore-ghost-aaa3', agentType: 'Explore', event: 'stop',
    }),
    spawnRow({
      ts: '2026-09-20T10:11:00.000Z', sessionId: S1, agentId: 'aexplore-aaa4', agentType: 'Explore', event: 'start',
    }),
    spawnRow({
      ts: '2026-09-20T10:11:30.000Z', sessionId: S1, agentId: 'aexplore-aaa4', agentType: 'Explore', event: 'stop',
    }),
    spawnRow({
      ts: '2026-09-20T11:01:00.000Z', sessionId: S2, agentId: 'asplit-foo-bar-bbb1', agentType: 'split-foo-bar', event: 'start',
    }),
    spawnRow({
      ts: '2026-09-20T12:01:00.000Z', sessionId: S3, agentId: 'ateam-a-ccc1', agentType: 'team-a', event: 'start',
    }),
    spawnRow({
      ts: '2026-09-20T12:02:00.000Z', sessionId: S3, agentId: 'ateam-b-ccc2', agentType: 'team-b', event: 'start',
    }),
  ]);
}

/**
 * Run the CLI as a real child process.
 *
 * @param {string} root child cwd, also passed as `--cwd`
 * @param {string[]} [args]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function run(root, args = []) {
  const res = spawnSync(process.execPath, [CLI, '--cwd', root, ...args], {
    cwd: root, encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Run with `--json` and parse the single line.
 *
 * @param {string} root
 * @param {string[]} [args]
 * @returns {object}
 */
function runJson(root, args = []) {
  const res = run(root, ['--json', ...args]);
  expect(res.status, res.stderr).toBe(0);
  const lines = res.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

/**
 * Byte length of a path, or null when it does not exist.
 *
 * @param {string} p
 * @returns {number|null}
 */
function sizeOf(p) {
  return existsSync(p) ? statSync(p).size : null;
}

describe('topology-agreement CLI', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    while (roots.length > 0) {
      const dir = roots.pop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A locked temp dir on Windows is not a finding about this script.
      }
    }
  });

  describe('constants', () => {
    it('exports the two candidate denominators as frozen ISO instants', () => {
      expect(DEFAULT_SINCE).toBe('2026-09-17T00:48:41Z');
      expect(F04A_T0).toBe('2026-09-14T05:21:00Z');
      expect(Number.isFinite(Date.parse(DEFAULT_SINCE))).toBe(true);
      expect(Number.isFinite(Date.parse(F04A_T0))).toBe(true);
    });
  });

  describe('usage errors', () => {
    it('exits 2 with an empty stdout for --help', () => {
      const res = run(root, ['--help']);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('usage:');
    });

    it('exits 2 with an empty stdout for -h', () => {
      const res = run(root, ['-h']);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
    });

    it('exits 2 for an unknown flag', () => {
      const res = run(root, ['--sesion', 'S1']);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('unknown argument');
    });

    it('exits 2 for a --since that is not a time', () => {
      const res = run(root, ['--since', 'yesterday']);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
    });

    it('exits 2 for a value flag with no value', () => {
      const res = run(root, ['--since']);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
    });
  });

  describe('empty root', () => {
    it('exits 0 and reports a null rate, never 0', () => {
      const out = runJson(root);
      expect(out.agreement_rate).toBeNull();
      expect(out.agreement_rate).not.toBe(0);
      expect(out.totals.windows).toBe(0);
      expect(out.sessions_with_tr).toBe(0);
    });

    it('prints every key of the fixed set', () => {
      const out = runJson(root);
      expect(Object.keys(out).sort()).toEqual([...STDOUT_KEYS].sort());
    });

    it('carries all six topology modes with zeroed rows', () => {
      const out = runJson(root);
      expect(Object.keys(out.modes)).toEqual([...TOPOLOGY_MODES]);
      for (const mode of TOPOLOGY_MODES) {
        expect(out.modes[mode].windows).toBe(0);
      }
    });

    it('defaults --since to the v4.63.0 tag instant', () => {
      const out = runJson(root);
      expect(out.since).toBe(new Date(DEFAULT_SINCE).toISOString());
      expect(out.t0.default_since).toBe(new Date(DEFAULT_SINCE).toISOString());
      expect(out.t0.f04a).toBe(new Date(F04A_T0).toISOString());
    });

    it('creates no decisions store and no spawn ledger', () => {
      const bare = mkdtempSync(path.join(os.tmpdir(), 'topo-agree-bare-'));
      roots.push(bare);
      const res = run(bare);
      expect(res.status).toBe(0);
      expect(existsSync(path.join(bare, '.artibot'))).toBe(false);
      expect(existsSync(spawnLedgerPath(bare))).toBe(false);
    });

    it('reports the reverse direction as structurally unobservable', () => {
      const out = runJson(root);
      expect(out.reverse_direction).toBe('structurally-unobservable');
      expect(run(root).stdout).toContain(REVERSE_LINE);
    });
  });

  describe('seeded fixture', () => {
    beforeEach(() => {
      seedFull(root);
    });

    it('opens one window per TR row in range and flags the open ones', () => {
      const out = runJson(root);
      expect(out.totals.windows).toBe(5);
      expect(out.open_windows).toBe(3);
    });

    it('classifies a solo recommendation with two team-* starts as input_deficit', () => {
      const out = runJson(root);
      expect(out.modes.solo.windows).toBe(2);
      expect(out.modes.solo.match).toBe(1);
      expect(out.modes.solo.input_deficit).toBe(1);
      expect(out.modes.solo.mismatch).toBe(0);
      expect(out.modes.solo['spawns_2plus']).toBe(1);
      expect(out.modes.solo['spawns_0']).toBe(1);
    });

    it('counts a subagent recommendation with one non-team start as a match', () => {
      const out = runJson(root);
      expect(out.modes.subagent.windows).toBe(1);
      expect(out.modes.subagent.match).toBe(1);
      expect(out.modes.subagent['spawns_1']).toBe(1);
    });

    it('counts a team recommendation with two team-* starts as a match', () => {
      const out = runJson(root);
      expect(out.modes.team.windows).toBe(1);
      expect(out.modes.team.match).toBe(1);
    });

    it('leaves split unmeasured rather than calling it a mismatch', () => {
      const out = runJson(root);
      expect(out.modes.split.windows).toBe(1);
      expect(out.modes.split.unmeasured).toBe(1);
      expect(out.modes.split.match).toBe(0);
      expect(out.modes.split.mismatch).toBe(0);
    });

    it('divides matches by measured windows only', () => {
      const out = runJson(root);
      expect(out.totals.measured_windows).toBe(4);
      expect(out.totals.unmeasured).toBe(1);
      expect(out.agreement_rate).toBeCloseTo(0.75, 10);
    });

    it('counts a stop without a start as a loss, not as a spawn', () => {
      const out = runJson(root);
      expect(out.stop_only_ids).toBe(1);
      // The ghost id must not have pushed window 1 to three spawns.
      expect(out.modes.solo['spawns_2plus']).toBe(1);
    });

    it('excludes diag-, cron- and _unattributed files and counts them', () => {
      const out = runJson(root);
      expect(out.excluded_files).toEqual({ diag: 1, cron: 1, unattributed: 1 });
      expect(out.excluded_sessions).toBe(3);
      expect(out.sessions_with_tr).toBe(3);
    });

    it('joins the two stores on sessionId', () => {
      const out = runJson(root);
      expect(out.sessions_in_spawn_ledger).toBe(3);
      expect(out.sessions_joined).toBe(3);
    });

    it('ignores rows before --since', () => {
      // The pre-since `team` row in S1 is the only TR row before the default
      // cutoff; widening the window must add exactly one solo-side window.
      const wide = runJson(root, ['--since', '2026-01-01T00:00:00Z']);
      expect(wide.totals.windows).toBe(6);
      expect(wide.modes.team.windows).toBe(2);
    });

    it('says the reverse direction is measured when a team row exists', () => {
      const out = runJson(root);
      expect(out.reverse_direction).not.toBe('structurally-unobservable');
      expect(out.modes.team.windows).toBeGreaterThan(0);
    });

    it('prints a human table with all six modes and the caveat block', () => {
      const res = run(root);
      expect(res.status).toBe(0);
      for (const mode of TOPOLOGY_MODES) {
        expect(res.stdout).toContain(mode);
      }
      expect(res.stdout).toContain('what this cannot see:');
      expect(res.stdout).toContain('open_windows');
      expect(res.stdout).toContain('stop_only_ids');
      expect(res.stdout).toContain(new Date(F04A_T0).toISOString());
    });

    it('changes nothing on disk', () => {
      const decisions = decisionsFile(root, S1);
      const spawns = spawnLedgerPath(root);
      const before = [sizeOf(decisions), sizeOf(spawns)];
      run(root);
      run(root, ['--json']);
      expect([sizeOf(decisions), sizeOf(spawns)]).toEqual(before);
    });
  });

  describe('synthetic sessions', () => {
    // The live store carries `sess-cmd-*` files written by a vitest run: real
    // rows, but not a real session. They are NOT excluded — a filename prefix
    // rule would have to guess, and these fall into `split` -> unmeasured on
    // their own — so the reader flags them instead of dropping them, and the
    // flag is what lets a reader discount the denominator by hand.
    it('counts a non-UUID sessionId without excluding its rows', () => {
      writeNdjson(decisionsFile(root, 'sess-cmd-x'), [
        trRow({ ts: '2026-09-20T14:00:00.000Z', sessionId: 'sess-cmd-x', mode: 'split' }),
      ]);
      const out = runJson(root);
      expect(out.non_uuid_sessions).toBe(1);
      // Counted, not dropped: the row still opens a window and still lands in
      // `unmeasured`, so the two counters cannot double-subtract it.
      expect(out.modes.split.windows).toBe(1);
      expect(out.modes.split.unmeasured).toBe(1);
      expect(out.excluded_files).toEqual({ diag: 0, cron: 0, unattributed: 0 });
      expect(out.sessions_with_tr).toBe(1);
      expect(run(root).stdout).toContain(NON_UUID_NOTE);
    });

    it('counts a UUID-shaped sessionId as zero', () => {
      writeNdjson(decisionsFile(root, S1), [
        trRow({ ts: '2026-09-20T10:00:00.000Z', sessionId: S1, mode: 'solo' }),
      ]);
      expect(runJson(root).non_uuid_sessions).toBe(0);
    });
  });

  describe('match-rule boundaries', () => {
    // These two cases exist because a mutation probe (2026-09-21) showed the
    // main fixture could not tell `teamTypes >= 2` from `>= 1`, nor the
    // subagent rule's "no team-* agentType" clause from a bare "spawns >= 1".
    // A rule no case can falsify is not covered by a green run.
    it('does not call a team recommendation with ONE team-* spawn a match', () => {
      writeNdjson(decisionsFile(root, S3), [
        trRow({ ts: '2026-09-20T12:00:00.000Z', sessionId: S3, mode: 'team' }),
      ]);
      writeNdjson(spawnLedgerPath(root), [
        spawnRow({
          ts: '2026-09-20T12:01:00.000Z', sessionId: S3, agentId: 'ateam-a-eee1', agentType: 'team-a', event: 'start',
        }),
      ]);
      const out = runJson(root);
      expect(out.modes.team.match).toBe(0);
      // The `team-` prefix proves the human typed the command, so the router
      // never saw the choice: this is an input deficit, not a router error.
      expect(out.modes.team.input_deficit).toBe(1);
      expect(out.modes.team.mismatch).toBe(0);
      expect(out.agreement_rate).toBe(0);
    });

    it('counts one orphan agentId once even with two stop rows', () => {
      // The live ledger holds more `stop` rows than `start` rows, so a
      // re-delivered stop is an expected shape. `stop_only_ids` is a count of
      // IDS; counting rows would inflate the loss signal.
      writeNdjson(decisionsFile(root, S1), [
        trRow({ ts: '2026-09-20T10:00:00.000Z', sessionId: S1, mode: 'solo' }),
      ]);
      writeNdjson(spawnLedgerPath(root), [
        spawnRow({
          ts: '2026-09-20T10:01:00.000Z', sessionId: S1, agentId: 'aghost-iii1', agentType: 'Explore', event: 'stop',
        }),
        spawnRow({
          ts: '2026-09-20T10:02:00.000Z', sessionId: S1, agentId: 'aghost-iii1', agentType: 'Explore', event: 'stop',
        }),
      ]);
      const out = runJson(root);
      expect(out.stop_only_ids).toBe(1);
    });

    it('counts two same-agentType team spawns as two, not one', () => {
      // The rule is "two team AGENTS", and a real team routinely spawns two
      // agents of the SAME type (two reviewers over different files). Counting
      // distinct agentType STRINGS would fail that run as a mismatch, so the
      // count is over agentId.
      writeNdjson(decisionsFile(root, S3), [
        trRow({ ts: '2026-09-20T12:00:00.000Z', sessionId: S3, mode: 'team' }),
      ]);
      writeNdjson(spawnLedgerPath(root), [
        spawnRow({
          ts: '2026-09-20T12:01:00.000Z', sessionId: S3, agentId: 'ateam-x-reviewer-hhh1', agentType: 'team-x-reviewer', event: 'start',
        }),
        spawnRow({
          ts: '2026-09-20T12:02:00.000Z', sessionId: S3, agentId: 'ateam-x-reviewer-hhh2', agentType: 'team-x-reviewer', event: 'start',
        }),
      ]);
      const out = runJson(root);
      expect(out.modes.team.match).toBe(1);
      expect(out.modes.team.input_deficit).toBe(0);
      expect(out.modes.team['spawns_2plus']).toBe(1);
    });

    it('does not call a subagent recommendation answered by team-* spawns a match', () => {
      writeNdjson(decisionsFile(root, S1), [
        trRow({ ts: '2026-09-20T10:00:00.000Z', sessionId: S1, mode: 'subagent' }),
      ]);
      writeNdjson(spawnLedgerPath(root), [
        spawnRow({
          ts: '2026-09-20T10:01:00.000Z', sessionId: S1, agentId: 'ateam-a-fff1', agentType: 'team-a', event: 'start',
        }),
      ]);
      const out = runJson(root);
      expect(out.modes.subagent.match).toBe(0);
      expect(out.modes.subagent.input_deficit).toBe(1);
    });

    it('calls a plain mismatch a mismatch when no slash prefix is present', () => {
      writeNdjson(decisionsFile(root, S1), [
        trRow({ ts: '2026-09-20T10:00:00.000Z', sessionId: S1, mode: 'solo' }),
      ]);
      writeNdjson(spawnLedgerPath(root), [
        spawnRow({
          ts: '2026-09-20T10:01:00.000Z', sessionId: S1, agentId: 'aexplore-ggg1', agentType: 'Explore', event: 'start',
        }),
      ]);
      const out = runJson(root);
      expect(out.modes.solo.mismatch).toBe(1);
      expect(out.modes.solo.input_deficit).toBe(0);
      expect(out.agreement_rate).toBe(0);
      expect(out.agreement_rate).not.toBeNull();
    });
  });

  describe('a fixture with no team recommendation at all', () => {
    it('prints structurally-unobservable rather than a 0/0 agreement', () => {
      writeNdjson(decisionsFile(root, S1), [
        trRow({ ts: '2026-09-20T10:00:00.000Z', sessionId: S1, mode: 'solo' }),
        trRow({ ts: '2026-09-20T10:10:00.000Z', sessionId: S1, mode: 'subagent' }),
      ]);
      writeNdjson(spawnLedgerPath(root), [
        spawnRow({
          ts: '2026-09-20T10:11:00.000Z', sessionId: S1, agentId: 'aexplore-ddd1', agentType: 'Explore', event: 'start',
        }),
      ]);
      const out = runJson(root);
      expect(out.modes.team.windows).toBe(0);
      expect(out.reverse_direction).toBe('structurally-unobservable');
      expect(run(root).stdout).toContain(REVERSE_LINE);
    });
  });
});
