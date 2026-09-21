/**
 * `scripts/checkpoint/resume-report.mjs` — the report runs, and costs nothing.
 *
 * WHY A SPAWN TEST. The claim this file defends is not "the function returns
 * the right object" (`tests/firewall/resume-contract-report-only.test.js` owns
 * that, over fakes). It is the one an in-process test structurally cannot make:
 * that running the REAL command against a REAL store, with the real port
 * bindings and the real filesystem, leaves the store byte-identical. So every
 * case here spawns the CLI as its own process, exactly as a person or a command
 * surface would.
 *
 * WHY BYTES AND NOT mtime. An mtime assertion is a weak pin twice over: a write
 * that rewrites identical content still bumps it (false red), and a filesystem
 * with coarse timestamp granularity can miss a fast rewrite entirely (false
 * green — the direction that matters). The census below hashes the CONTENT of
 * every file under the project's `.artibot` tree before and after the run and
 * compares the maps whole, so a new file, a deleted file and an edited file are
 * three distinguishable failures. mtime is recorded too, but only as a
 * secondary signal in the failure message.
 *
 * THE FIXTURE IS A REAL STORE, not a hand-written one. It is seeded through
 * `createStateStore` and `createCheckpointService` so its journal, snapshot and
 * checkpoint line are whatever those modules actually produce; a hand-rolled
 * fixture would pin this test to a format the store could drift away from
 * silently.
 *
 * ── WHAT THIS FILE DOES NOT COVER (rules §9) ──────────────────────────────
 *   - THE LIVE STORE. The fixture holds 2 missions and 1 checkpoint. The live
 *     project store held 4 files and 0 checkpoints when this was written, and
 *     nothing here scales to it; the live run is a separate, reported
 *     measurement.
 *   - CONCURRENCY. One process at a time. A `/save` writing while this reads is
 *     not exercised.
 *   - GIT EVIDENCE QUALITY. The temp project is not a git repository, so every
 *     limb's completion reads `no-branch` and the lane rows assert the
 *     fail-closed reasons, not a true/false completion verdict.
 *   - THE `--mission` PATH against a mission that does not exist is asserted to
 *     produce a report, not to be useful.
 *
 * @module tests/scripts/resume-report-cli
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFileStoreAdapter } from '../../lib/checkpoint/adapters/file-store.js';
import { createCheckpointService } from '../../lib/checkpoint/checkpoint-service.js';
import { createCheckpointStore } from '../../lib/checkpoint/checkpoint-store.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'checkpoint', 'resume-report.mjs');

/** Mission that has a valid checkpoint. */
const MISSION_WITH = 'M-20260921-001';

/** Mission that has none — the `reconcile:checkpoint-missing` case. */
const MISSION_WITHOUT = 'M-20260921-002';

/** @type {string} */
let root;

/**
 * Run the CLI as a child process, no shell. `process.execPath` + the script
 * path is the spelling that works on Windows without a `.cmd` shim.
 *
 * @param {string[]} args - CLI arguments.
 * @returns {{status: number, stdout: string, stderr: string}} Outcome.
 */
function run(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', timeout: 60_000, windowsHide: true, cwd: PLUGIN_ROOT,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Content census of a directory tree: relative path -> size, hash and mtime.
 *
 * @param {string} dir - Tree root.
 * @returns {Record<string, {size: number, sha256: string, mtimeMs: number}>} Census.
 */
function census(dir) {
  /** @type {Record<string, {size: number, sha256: string, mtimeMs: number}>} */
  const out = {};
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(dir, full).split(path.sep).join('/');
      out[rel] = {
        size: stat.size,
        sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
        mtimeMs: stat.mtimeMs,
      };
    }
  };
  walk(dir);
  return out;
}

/**
 * Drop mtime, which is the secondary signal — the primary comparison is on
 * names, sizes and content hashes.
 *
 * @param {Record<string, {size: number, sha256: string, mtimeMs: number}>} snap - Census.
 * @returns {Record<string, {size: number, sha256: string}>} Census without mtime.
 */
function bytesOnly(snap) {
  return Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, { size: v.size, sha256: v.sha256 }]));
}

/**
 * The checkpoint body `/save` writes, mirrored from
 * `lib/checkpoint/save-checkpoint.js#buildContent` so the fixture validates for
 * the same reasons a real one does.
 *
 * @param {string} missionId - Mission id.
 * @returns {object} Checkpoint content.
 */
function checkpointContent(missionId) {
  return {
    mission_id: missionId,
    session_id: 'seed-session',
    intent_revision: 1,
    plan_revision: 1,
    active_tasks: [],
    completed_action_results: [],
    routing_epoch: null,
    current_model: null,
    artifact_versions: {},
    replay_cursor: null,
    ledger_cursor: null,
    resumable: true,
  };
}

/**
 * Seed a temp project with a real store: two missions, one checkpoint.
 *
 * @param {string} projectRoot - Temp project root.
 * @returns {Promise<void>} When seeded.
 */
async function seed(projectRoot) {
  const store = createStateStore({
    projectRoot,
    sessionId: 'seed-session',
    appendEvent: () => ({ ok: true }),
  });
  for (const missionId of [MISSION_WITH, MISSION_WITHOUT]) {
    const result = store.updateMission(
      missionId,
      () => ({
        status: 'executing',
        intent: { path: 'intent.md', revision: 1 },
        plan: { path: 'plan.md', revision: 1 },
      }),
      { reason: 'fixture seed', graph: { schema_version: 1, mission_id: missionId, tasks: [] } },
    );
    // Fail loudly here rather than letting an unseeded fixture produce a
    // vacuously green "no writes" assertion later.
    expect(result.ok, `seed ${missionId}: ${JSON.stringify(result.errors ?? [])}`).toBe(true);
  }

  const checkpoints = createCheckpointStore({ adapter: createFileStoreAdapter({ dir: store.location.dir }) });
  const service = createCheckpointService({ store: checkpoints, appendEvent: null });
  const saved = await service.checkpoint(checkpointContent(MISSION_WITH), { trigger: '/save' });
  expect(saved.ok, `checkpoint seed: ${JSON.stringify(saved.errors ?? [])}`).toBe(true);
}

beforeAll(async () => {
  // `.native` collapses Windows 8.3 short names, which would otherwise make the
  // path the CLI prints differ from the one asserted here.
  const canonicalise = realpathSync.native || realpathSync;
  root = canonicalise(mkdtempSync(path.join(tmpdir(), 'artibot-resume-report-')));
  await seed(root);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('the run writes nothing', () => {
  it('leaves every file under .artibot byte-identical and creates none (--all)', () => {
    const tree = path.join(root, '.artibot');
    const before = census(tree);
    // The fixture must be non-trivial, or "unchanged" is a statement about an
    // empty directory.
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(3);

    const res = run(['--all', '--cwd', root]);
    expect(res.status, res.stderr).toBe(0);

    const after = census(tree);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(bytesOnly(after)).toEqual(bytesOnly(before));

    const touched = Object.keys(before).filter((k) => after[k].mtimeMs !== before[k].mtimeMs);
    expect(touched, 'mtime moved though content matched — secondary signal').toEqual([]);
  });

  it('reports the fallback store location it actually read', () => {
    const { stdout } = run(['--all', '--cwd', root]);
    expect(stdout).toContain(path.join(root, '.artibot', 'runtime'));
    expect(stdout).toContain('project-root-fallback');
  });
});

describe('the Resume Contract block', () => {
  it('reports reconcile:checkpoint-missing for the mission with no checkpoint', () => {
    const { stdout, status } = run(['--all', '--cwd', root]);
    expect(status).toBe(0);
    const row = stdout.split('\n').find((l) => l.includes(MISSION_WITHOUT));
    expect(row).toBeDefined();
    expect(row).toContain('reconcile:checkpoint-missing');
  });

  it('reports the mission that has one with its checkpoint id, blocked only on the absent model port', () => {
    const { stdout } = run(['--all', '--cwd', root]);
    const row = stdout.split('\n').find((l) => l.includes(MISSION_WITH));
    expect(row).toBeDefined();
    expect(row).not.toContain('reconcile:checkpoint-missing');
    // Step 9 has no port by design (see the CLI header), so this is the honest
    // value, not a defect. Pinned so binding a model port becomes a decision.
    expect(row).toContain('reconcile:model-unknown');
  });

  it('never renders a table cell reading "통과" — resume.md:66 forbids that reading', () => {
    // Scoped to table rows on purpose: the document's closing note uses the
    // word to say `-` is NOT it, and asserting over the whole document would
    // make this test red for the sentence that states the rule.
    const { stdout } = run(['--all', '--cwd', root]);
    const rows = stdout.split('\n').filter((l) => l.startsWith('| '));
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.filter((l) => l.includes('통과'))).toEqual([]);
    expect(stdout).toContain('"검증 통과"가 아니다');
  });

  it('produces a report for a mission id that does not exist, and still exits 0', () => {
    const { status, stdout } = run(['--mission', 'M-20260921-999', '--cwd', root]);
    expect(status).toBe(0);
    expect(stdout).toContain('M-20260921-999');
    expect(stdout).toContain('reconcile:checkpoint-missing');
  });
});

describe('--json', () => {
  it('emits ONE parseable document', () => {
    const { stdout, status } = run(['--all', '--cwd', root, '--json']);
    expect(status).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.schema).toBe('resume-report/1');
    expect(doc.project_root).toBe(root);
    expect(doc.contract.missions.map((m) => m.mission_id).sort()).toEqual([MISSION_WITH, MISSION_WITHOUT]);
    const missing = doc.contract.missions.find((m) => m.mission_id === MISSION_WITHOUT);
    expect(missing.blocked_by).toContain('reconcile:checkpoint-missing');
    expect(missing.resumable).toBe(false);
  });
});

describe('the lane reconcile block', () => {
  it('says 측정 불가 and still exits 0 when the run state file is absent', () => {
    const { stdout, status } = run(['--all', '--cwd', root]);
    expect(status).toBe(0);
    const lines = stdout.split('\n').filter((l) => l.startsWith('측정 불가:'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/run\.json/);
  });

  it('says 측정 불가 with a parse reason for unreadable JSON, and exits 0', () => {
    const bad = path.join(root, 'broken-run.json');
    writeFileSync(bad, '{ not json', 'utf-8');
    const { stdout, status } = run(['--all', '--cwd', root, '--run-json', bad]);
    expect(status).toBe(0);
    expect(stdout).toContain('측정 불가: JSON 파싱 실패');
  });

  it('reconciles the lanes of a real run state file, fail-closed on an off-allowlist ops word', () => {
    const dir = path.join(root, 'runstate');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'run.json');
    // `dispatched` is the word the leader actually writes and it is NOT in
    // LANE_OPS_STATES — the drift lane-reconcile.js documents and reports.
    writeFileSync(file, JSON.stringify({
      runId: 'split-fixture', base: 'master',
      lanes: { 'limb-a': { state: 'dispatched' }, 'limb-b': { state: 'active' } },
    }), 'utf-8');

    const { stdout, status } = run(['--all', '--cwd', root, '--run-json', file]);
    expect(status).toBe(0);
    const rowA = stdout.split('\n').find((l) => l.includes('limb-a'));
    expect(rowA).toContain('reconcile:ops-state-unknown');
    // limb-b's word IS allowlisted, so it must NOT carry that reason — without
    // this the assertion above would pass on a CLI that flagged everything.
    const rowB = stdout.split('\n').find((l) => l.includes('limb-b'));
    expect(rowB).toBeDefined();
    expect(rowB).not.toContain('reconcile:ops-state-unknown');
  });
});

describe('usage errors exit 2 and read nothing', () => {
  const cases = [
    { name: 'no arguments at all', args: [] },
    { name: 'an unknown flag', args: ['--all', '--nope'] },
    { name: '--mission with no value', args: ['--mission'] },
    { name: '--mission together with --all', args: ['--mission', MISSION_WITH, '--all'] },
  ];
  for (const { name, args } of cases) {
    it(`exits 2 on ${name}`, () => {
      const res = run(args);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('usage: resume-report.mjs');
    });
  }
});

describe('source pins', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('never mentions the runtime ledger writer, comments included', () => {
    // A report that can append is not a report. The import is the only way this
    // CLI could write to the ledger, and the identifier is pinned at zero
    // occurrences so the reuse route through openMissionStore (which binds it)
    // cannot be taken back by a later edit without going red here.
    const needle = ['append', 'Ledger', 'Event'].join('');
    expect(source.split(needle).length - 1).toBe(0);
  });

  it('binds no write port of the StateStore', () => {
    for (const port of ['updateMission', 'claimTask', 'releaseTask', 'heartbeatWorker']) {
      expect(source, `${port} must not appear in a report-only CLI`).not.toContain(port);
    }
  });

  it('never asks reconcile to apply', () => {
    expect(source).toContain('apply: false');
    expect(source).not.toContain('apply: true');
  });
});
