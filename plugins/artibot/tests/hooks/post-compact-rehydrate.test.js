/**
 * `scripts/hooks/post-compact-rehydrate.js` — end-to-end as the harness runs
 * it: a child process with the PostCompact stdin payload
 * (per claude-code-guide, 2026-09-02: `session_id, cwd, permission_mode,
 * hook_event_name, compact_trigger, compact_summary`).
 *
 * `HOME`/`USERPROFILE` point at a temp dir so `~/.claude/*` writes land there;
 * the feature gate is opened through the documented env overlay
 * (`ARTIBOT_CONTEXT_LIFECYCLE_JSON`) because the real `artibot.config.json`
 * ships it OFF. A temp git repo plays the worktree.
 *
 * Not covered: the harness actually displaying `systemMessage`; the
 * SessionStart(compact) registration (not in hooks.json — leader's call);
 * the 8s budget under load.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectSplitEvidence, LIFECYCLE_DEFAULTS, openMissionStoreReadOnly, readMissionContext,
  resolveLifecycle, selectMissionForSession, sessionSuffix,
} from '../../scripts/hooks/post-compact-rehydrate.js';
import { assembleContextReceipt } from '../../lib/context/context-receipt.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'post-compact-rehydrate.js');

/** @type {string} */ let home = '';
/** @type {string} */ let repo = '';
/** @type {string} */ let head = '';

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

/**
 * Run the hook once. Returns stdout/stderr/status.
 * @param {object} payload - stdin JSON
 * @param {Record<string, string>} [envExtra]
 * @returns {{ stdout: string, stderr: string, status: number|null }}
 */
function runHook(payload, envExtra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ARTIBOT_CONTEXT_LIFECYCLE_JSON: JSON.stringify({ enabled: true }),
    ...envExtra,
  };
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo, env, input: JSON.stringify(payload), encoding: 'utf-8', windowsHide: true, timeout: 20000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/**
 * @param {object} gitState
 * @returns {void}
 */
function writeSnapshot(gitState) {
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'artibot-pre-compact.json'), JSON.stringify({
    savedAt: '2026-09-02T01:00:00.000Z',
    reason: 'pre-compact',
    summary: {
      scope: { user: 1, assistant: 1, tool: 0 },
      tools_mentioned: [],
      recent_requests: ['implement PR-CX01'],
      pending_work: ['TODO: hook tests'],
      key_files: ['lib/context/rehydration.js'],
      current_work: 'Writing the PostCompact hook',
      decisions: ['decided: systemMessage only'],
    },
    gitState,
    stateFilePath: path.join(home, 'state.md'),
  }, null, 2));
}

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pcr-home-'));
  repo = mkdtempSync(path.join(os.tmpdir(), 'pcr-repo-'));
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  head = git(['rev-parse', '--short=12', 'HEAD'], repo);
  mkdirSync(path.join(repo, '.artibot', 'split', 'lane-a'), { recursive: true });
  writeFileSync(path.join(repo, '.artibot', 'split', 'lane-a', 'brief.md'), '# lane-a\n소유 allowlist: src/a/\n완료: Split-Limb: done\n');
  writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: 'split-t1', stage: 'dispatched', limbs: ['lane-a'] }));
  writeFileSync(path.join(repo, '.artibot', 'HANDOFF.md'), '# HANDOFF\n다음 단계: finish tests\n');
});
afterAll(() => {
  for (const d of [home, repo]) rmSync(d, { recursive: true, force: true });
});

describe('resolveLifecycle (pure)', () => {
  it('defaults ship OFF; config and env overlay in that order; bad values fall back', () => {
    // `supervisorStoreDir` is additive (PR-CX02) and ships null; every other
    // default and every precedence rule below is unchanged.
    expect(LIFECYCLE_DEFAULTS).toEqual({ enabled: false, postCompactRehydrate: true, maxRehydrateBytes: 10240, supervisorStoreDir: null });
    expect(resolveLifecycle(null, {})).toEqual({ enabled: false, postCompactRehydrate: true, maxRehydrateBytes: 10240, supervisorStoreDir: null });
    expect(resolveLifecycle({ split: { contextLifecycle: { enabled: true, maxRehydrateBytes: 4096 } } }, {}))
      .toEqual({ enabled: true, postCompactRehydrate: true, maxRehydrateBytes: 4096, supervisorStoreDir: null });
    expect(resolveLifecycle({ split: { contextLifecycle: { enabled: true } } }, { ARTIBOT_CONTEXT_LIFECYCLE_JSON: '{"postCompactRehydrate":false}' }).postCompactRehydrate).toBe(false);
    expect(resolveLifecycle(null, { ARTIBOT_CONTEXT_LIFECYCLE_JSON: 'not json' }).enabled).toBe(false);
    expect(resolveLifecycle(null, { ARTIBOT_CONTEXT_LIFECYCLE_JSON: '{"enabled":true,"maxRehydrateBytes":"big"}' }).maxRehydrateBytes).toBe(10240);
  });
});

describe('collectSplitEvidence', () => {
  it('reads run.json/plan.json from the project root and briefs from the cwd', () => {
    const ev = collectSplitEvidence(repo, repo);
    expect(ev.runJson.runId).toBe('split-t1');
    expect(ev.planJson).toBe(null);
    expect(ev.briefs).toHaveLength(1);
    expect(ev.briefs[0]).toMatchObject({ limb: 'lane-a' });
    expect(ev.briefs[0].text).toContain('소유 allowlist');
    expect(collectSplitEvidence(path.join(repo, 'nope'), path.join(repo, 'nope'))).toEqual({ runJson: null, planJson: null, briefs: [] });
  });
});

describe('hook process', () => {
  const payload = (over = {}) => ({
    session_id: 'sess-1', cwd: repo, permission_mode: 'default', hook_event_name: 'PostCompact',
    compact_trigger: 'auto', compact_summary: 'The harness compacted 40 turns; last topic: PR-CX01.', ...over,
  });

  it('disabled by default: exit 0, zero bytes on stdout AND stderr, nothing written', () => {
    const r = runHook(payload(), { ARTIBOT_CONTEXT_LIFECYCLE_JSON: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(existsSync(path.join(home, '.claude', 'artibot-post-compact.json'))).toBe(false);
  });

  it('matching snapshot: systemMessage carries the bundle, both files are written, compact_summary saved verbatim', () => {
    writeSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false });
    const r = runHook(payload());
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('identity=ok');
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(['systemMessage']);
    const msg = out.systemMessage;
    expect(Buffer.byteLength(msg, 'utf8')).toBeLessThanOrEqual(10240);
    expect(msg).toContain('identity: OK');
    expect(msg).toContain('Writing the PostCompact hook');
    expect(msg).toContain('/split run split-t1 stage=dispatched limbs=lane-a');
    expect(msg).toContain('### lane brief lane-a');
    expect(msg).toContain('다음 단계: finish tests');
    expect(msg).toContain('last topic: PR-CX01');
    expect(msg).toContain('restate the next action in ONE line');

    const json = JSON.parse(readFileSync(path.join(home, '.claude', 'artibot-post-compact.json'), 'utf-8'));
    expect(json).toMatchObject({ event: 'PostCompact', sessionId: 'sess-1', trigger: 'auto', cwd: repo, truncated: false });
    expect(json.identity.ok).toBe(true);
    expect(json.compactSummary).toBe('The harness compacted 40 turns; last topic: PR-CX01.');
    expect(existsSync(json.bundlePath)).toBe(true);
    const md = readFileSync(json.bundlePath, 'utf-8');
    expect(md).toContain('## compact_summary (verbatim from the harness)');
    expect(md).toContain('The harness compacted 40 turns');
    expect(readdirSync(path.join(home, '.claude', 'artibot', 'post-compact')).length).toBeGreaterThanOrEqual(1);
  });

  it('snapshot from another branch is refused: no snapshot text injected, reason stated, current-tree sections kept', () => {
    writeSnapshot({ cwd: repo, branch: 'feature/other', head, hasStatus: true });
    const r = runHook(payload());
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('identity=refused');
    const msg = JSON.parse(r.stdout).systemMessage;
    expect(msg).toContain('identity: REFUSED');
    expect(msg).toContain('branch mismatch: snapshot feature/other ≠ current master');
    expect(msg).not.toContain('Writing the PostCompact hook');
    expect(msg).not.toContain('artibot-pre-compact.json');
    expect(msg).not.toContain(path.join(home, 'state.md'));
    expect(msg).toContain('Do NOT read the pre-compact snapshot/state files');
    expect(msg).toContain('### lane brief lane-a');
    const json = JSON.parse(readFileSync(path.join(home, '.claude', 'artibot-post-compact.json'), 'utf-8'));
    expect(json.sections.find((s) => s.name === 'snapshot-work').status).toBe('refused');
  });

  it('snapshot from another worktree (cwd) is refused too', () => {
    writeSnapshot({ cwd: path.join(repo, '..', 'some-other-worktree'), branch: 'master', head, hasStatus: false });
    const msg = JSON.parse(runHook(payload()).stdout).systemMessage;
    expect(msg).toContain('cwd mismatch');
    expect(msg).not.toContain('Writing the PostCompact hook');
  });

  it('maxRehydrateBytes is honoured and truncation is announced', () => {
    writeSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false });
    const r = runHook(payload({ compact_summary: 's'.repeat(3000) }), { ARTIBOT_CONTEXT_LIFECYCLE_JSON: JSON.stringify({ enabled: true, maxRehydrateBytes: 1500 }) });
    const msg = JSON.parse(r.stdout).systemMessage;
    expect(Buffer.byteLength(msg, 'utf8')).toBeLessThanOrEqual(1500);
    expect(msg).toContain('TRUNCATED');
    const json = JSON.parse(readFileSync(path.join(home, '.claude', 'artibot-post-compact.json'), 'utf-8'));
    expect(json.truncated).toBe(true);
    expect(json.maxBytes).toBe(1500);
  });

  it('garbage / empty stdin never throws: exit 0, valid JSON out', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_CONTEXT_LIFECYCLE_JSON: '{"enabled":true}' },
      input: 'not json', encoding: 'utf-8', windowsHide: true, timeout: 20000,
    });
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout).systemMessage).toContain('[artibot:post-compact]');
  });

  it('behaviour change 0: the PR-CX02 fields never leak into systemMessage', () => {
    writeSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false });
    const msg = JSON.parse(runHook(payload()).stdout).systemMessage;
    for (const token of ['pressure=', 'context-pressure', 'contextReceipt', 'capacitySource']) {
      expect(msg, token).not.toContain(token);
    }
  });

  it('SessionStart with a non-compact source stays silent; source=compact prints the bundle as plain text', () => {
    writeSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false });
    const quiet = runHook(payload({ hook_event_name: 'SessionStart', source: 'startup' }));
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe('');
    const compact = runHook(payload({ hook_event_name: 'SessionStart', source: 'compact' }));
    expect(compact.status).toBe(0);
    expect(compact.stdout.startsWith('[artibot:post-compact]')).toBe(true);
    expect(() => JSON.parse(compact.stdout)).toThrow(); // plain text, not JSON
  });
});

/**
 * vNext PR-CX02 — context pressure scoring + the Context Receipt gap.
 *
 * RECORD ONLY. The score lands in the JSON record and, when a `/split` run is
 * in scope, as one supervisor `context-pressure` envelope. Nothing reads
 * either back and nothing rotates a worker; that decision is deliberately a
 * separate, later change.
 *
 * The receipt is assembled and NOT published: the real ledger writer refuses
 * `context.compiled` from `source: 'hook'` (measured 2026-09-12, pinned in
 * `tests/context/rehydration.test.js`). So the hook injects no writer port and
 * records the eleven schema leaves it cannot fill.
 */
describe('pressure + receipt (PR-CX02)', () => {
  /** @type {string} */ let store = '';
  const ORIGINAL_RUN_JSON = JSON.stringify({ runId: 'split-t1', stage: 'dispatched', limbs: ['lane-a'] });

  // `repo` is assigned in beforeAll, so the path cannot be a describe-body const.
  /** @returns {string} */
  const runJsonPath = () => path.join(repo, '.artibot', 'split', 'run.json');

  const payload = (over = {}) => ({
    session_id: 'sess-cx02', cwd: repo, permission_mode: 'default', hook_event_name: 'PostCompact',
    compact_trigger: 'auto', compact_summary: 'compacted; last topic: PR-CX02.', ...over,
  });

  /**
   * The snapshot the PreCompact hook writes, plus the PR-CX02 pressure inputs.
   * @param {object} gitState
   * @param {object} [extra] - tokenEstimate / transcriptBytes / contextWindow
   * @returns {void}
   */
  function writePressureSnapshot(gitState, extra = {}) {
    writeSnapshot(gitState);
    const file = path.join(home, '.claude', 'artibot-pre-compact.json');
    const snap = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...snap, ...extra }, null, 2));
  }

  /** @returns {object} the machine-readable record the hook just wrote */
  function readRecord() {
    return JSON.parse(readFileSync(path.join(home, '.claude', 'artibot-post-compact.json'), 'utf-8'));
  }

  /**
   * @param {object} [over] - lifecycle overlay on top of enabled + storeDir
   * @returns {Record<string, string>}
   */
  function lifecycleEnv(over = {}) {
    return { ARTIBOT_CONTEXT_LIFECYCLE_JSON: JSON.stringify({ enabled: true, supervisorStoreDir: store, ...over }) };
  }

  /**
   * @param {string} runId
   * @returns {object[]}
   */
  function supervisorLines(runId) {
    const file = path.join(store, `${runId}.supervisor.ndjson`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  beforeEach(() => {
    store = mkdtempSync(path.join(os.tmpdir(), 'pcr-store-'));
    writeFileSync(runJsonPath(), JSON.stringify({ runId: 'split-cx02test', stage: 'dispatched', limbs: ['lane-a'] }));
  });

  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
    writeFileSync(runJsonPath(), ORIGINAL_RUN_JSON); // restore the shared fixture
  });

  it('scores a measured context_window and appends exactly one context-pressure envelope', () => {
    writePressureSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false },
      { tokenEstimate: 1234, contextWindow: { current_tokens: 150_000, max_tokens: 200_000 } });
    const r = runHook(payload(), lifecycleEnv());
    expect(r.status).toBe(0);

    const lines = supervisorLines('split-cx02test');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'context-pressure', source: 'hook', runId: 'split-cx02test', laneId: 'lane-a',
    });
    expect(lines[0].data).toMatchObject({
      score: 0.75, level: 'warn', recommendation: 'none', session_id: 'sess-cx02',
    });
    expect(lines[0].data.inputs.tokenSource).toBe('currentTokens');

    const rec = readRecord();
    expect(rec.pressure.score).toBe(0.75);
    expect(rec.pressure.level).toBe('warn');
    expect(rec.capacitySource).toBe('context_window.max_tokens');
    expect(rec.pressureEvent).toMatchObject({ appended: true, runId: 'split-cx02test' });
    expect(rec.contextReceipt).toMatchObject({ emitted: false, reason: 'no-writer-port' });
    expect(rec.contextReceipt.missing).toHaveLength(11);
    expect(rec.contextReceipt.missing).toContain('mission_id');
    expect(rec.contextReceipt.missing).toContain('cache.provider');
    expect(rec.contextReceipt.missing).not.toContain('input_tokens');
    expect(r.stderr).toContain('pressure=0.75 level=warn event=appended receipt=no-writer-port missing=11');
  });

  it('leaves input_tokens missing when the snapshot carries only the degenerate tokenEstimate', () => {
    // The live PreCompact payload carries no `messages`, so the snapshot is
    // written with `tokenEstimate: 1` (`scripts/hooks/pre-compact.js:328-330`).
    // That 1 is not a measurement and may not be reported as one.
    writePressureSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false }, { tokenEstimate: 1 });
    const r = runHook(payload(), lifecycleEnv());
    expect(r.status).toBe(0);

    const rec = readRecord();
    expect(rec.identity.ok).toBe(true); // the snapshot was ACCEPTED; only the number is unusable
    expect(rec.contextReceipt.missing).toContain('input_tokens');
    expect(rec.contextReceipt.missing).toHaveLength(12);
  });

  it('the emission path never moves systemMessage, whether the append lands or fails', () => {
    writePressureSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false },
      { tokenEstimate: 1234, contextWindow: { current_tokens: 150_000, max_tokens: 200_000 } });
    const ok = runHook(payload(), lifecycleEnv());
    // A FILE where the store dir should be: appendEvent cannot create it.
    const blocked = path.join(store, 'blocked');
    writeFileSync(blocked, 'not a directory\n');
    const bad = runHook(payload(), lifecycleEnv({ supervisorStoreDir: blocked }));

    // The bundle names its own output file, whose stamp is a clock reading;
    // that one field is the only legitimate difference between two runs.
    const stripStamp = (s) => s.replace(/post-compact-[0-9TZ-]+\.md/g, 'post-compact-STAMP.md');
    expect(stripStamp(JSON.parse(ok.stdout).systemMessage))
      .toBe(stripStamp(JSON.parse(bad.stdout).systemMessage));
    expect(readRecord().pressureEvent.appended).toBe(false);
    expect(readRecord().pressure.score).toBe(0.75); // scoring survives a failed append
  });

  it('no /split run in scope: the score is still recorded, nothing is appended', () => {
    rmSync(runJsonPath(), { force: true });
    writePressureSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false },
      { tokenEstimate: 1234, contextWindow: { current_tokens: 150_000, max_tokens: 200_000 } });
    const r = runHook(payload(), lifecycleEnv());
    expect(r.status).toBe(0);
    expect(readdirSync(store)).toEqual([]);
    const rec = readRecord();
    expect(rec.pressureEvent).toEqual({ appended: false, reason: 'no-split-run' });
    expect(rec.pressure.score).toBe(0.75);
    expect(r.stderr).toContain('event=skipped:no-split-run');
  });

  it('no context_window: the capacity is unknown, so there is no score and no substituted denominator', () => {
    // A PostCompact payload names no model (`session_id`, `cwd`,
    // `permission_mode`, `hook_event_name`, `compact_trigger`,
    // `compact_summary`) and the PreCompact snapshot carries no tier either,
    // so this hook cannot know which `MODELS[tier].ctxLimit` applies. It
    // reports the gap instead of borrowing a number.
    writePressureSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false },
      { transcriptBytes: 2_000_000 });
    const r = runHook(payload(), lifecycleEnv());
    const rec = readRecord();
    expect(rec.pressure.inputs.tokenSource).toBe('transcriptBytes');
    expect(rec.pressure.inputs.overstates).toBe(true);
    expect(rec.pressure.score).toBe(null);
    expect(rec.pressure.level).toBe(null);
    expect(rec.pressure.reason).toBe('capacity-unknown');
    expect(rec.capacitySource).toBe(null);
    expect(rec.pressure.inputs.maxTokens).toBe(null);
    // No catalog capacity anywhere in the record or on stderr: 200k and 1M are
    // the two the catalog could have supplied, 128k is context-tracker's.
    const recorded = JSON.stringify(rec);
    for (const n of ['1000000', '200000', '128000']) {
      expect(recorded, n).not.toContain(n);
      expect(r.stderr, n).not.toContain(n);
    }
    expect(r.stderr).toContain('pressure=null level=null event=skipped:not-scored:capacity-unknown');
    expect(supervisorLines('split-cx02test')).toHaveLength(0);
    expect(r.status).toBe(0);
  });

  it('a refused snapshot is never scored: no number, no event, reason stated', () => {
    writePressureSnapshot({ cwd: repo, branch: 'feature/other', head, hasStatus: false },
      { tokenEstimate: 1234, contextWindow: { current_tokens: 150_000, max_tokens: 200_000 } });
    const r = runHook(payload(), lifecycleEnv());
    const rec = readRecord();
    expect(rec.identity.ok).toBe(false);
    expect(rec.pressure).toEqual({ score: null, level: null, recommendation: 'none', reason: 'snapshot-refused' });
    expect(rec.capacitySource).toBe(null);
    expect(supervisorLines('split-cx02test')).toHaveLength(0);
    expect(r.stderr).toContain('pressure=null level=null');
  });

  it('supervisorStoreDir is absent from the shipped defaults and defaults to null', () => {
    expect(LIFECYCLE_DEFAULTS.supervisorStoreDir).toBe(null);
    expect(resolveLifecycle(null, {}).supervisorStoreDir).toBe(null);
    expect(resolveLifecycle(null, { ARTIBOT_CONTEXT_LIFECYCLE_JSON: '{"supervisorStoreDir":42}' }).supervisorStoreDir).toBe(null);
    expect(resolveLifecycle(null, { ARTIBOT_CONTEXT_LIFECYCLE_JSON: '{"supervisorStoreDir":"/tmp/x"}' }).supervisorStoreDir).toBe('/tmp/x');
  });
});

/**
 * SH-16 — the three leaves the project-state store can honestly supply.
 *
 * Of the eleven the receipt was missing, `mission_id` and the two
 * `based_on.*` revisions have a source on disk. The other eight
 * (`transforms.*` ×5, `cache.*` ×3) have none in a PostCompact payload and are
 * asserted here to STAY missing — a pin on the gap, not a TODO.
 *
 * The selection rule is fail-closed on purpose: a session id gives eight
 * characters of mission suffix and nothing more, so two missions sharing one
 * session are indistinguishable and neither is reported.
 */

/** Session id whose first 8 alphanumerics are `sesscx16`. */
const SID = 'sess-cx16-9f2b';
const SID8 = 'sesscx16';
/** Two ids that differ only in their issue date — both end in `-Ssesscx16`. */
const MISSION = `M-20260921-S${SID8}`;
const MISSION_TWIN = `M-20260920-S${SID8}`;
/** The eight leaves no hook-sourced caller can ever fill. */
const PERMANENT_GAP = [
  'transforms.dedup', 'transforms.tool_compression', 'transforms.history_trim',
  'transforms.memory_add', 'transforms.project_knowledge_add',
  'cache.provider', 'cache.hit_tokens', 'cache.created_tokens',
];

/** @param {object} [over] - Mission field overrides. @returns {object} A schema-valid mission. */
function missionRecord(over = {}) {
  return {
    title: 'receipt-supply',
    status: 'executing',
    intent: { path: 'missions/intent.md', revision: 2 },
    plan: { path: 'missions/plan.md', revision: 5 },
    ...over,
  };
}

/** @param {string[]} ids - Mission ids. @returns {object} A snapshot-shaped state. */
function stateWith(ids) {
  return { active_missions: Object.fromEntries(ids.map((id) => [id, missionRecord()])) };
}

describe('selectMissionForSession (pure)', () => {
  it('takes the first 8 alphanumerics as sid8 and refuses fewer than 8', () => {
    // Same extraction as `lib/mission/mission-id.js#sessionFallbackMissionId`.
    expect(sessionSuffix(SID)).toBe(SID8);
    expect(sessionSuffix('--a1b2c3d4--ee')).toBe('a1b2c3d4');
    expect(sessionSuffix('a1b2c3d4')).toBe('a1b2c3d4'); // the boundary: exactly 8
    expect(sessionSuffix('ab-cd-ef')).toBe(null); // 6 alphanumerics — padding would forge identity
    expect(sessionSuffix(null)).toBe(null);
    expect(sessionSuffix(12345678)).toBe(null);
  });

  it('supplies the mission and its NESTED revisions when exactly one id ends in -S<sid8>', () => {
    expect(selectMissionForSession(stateWith([MISSION, 'M-20260921-001']), SID))
      .toEqual({ missionId: MISSION, basedOn: { intentRevision: 2, planRevision: 5 } });
  });

  it('fails closed on zero matches and on two, and on a session too short to match', () => {
    expect(selectMissionForSession(stateWith(['M-20260921-001']), SID)).toEqual({ missionId: null });
    expect(selectMissionForSession(stateWith([MISSION, MISSION_TWIN]), SID)).toEqual({ missionId: null });
    expect(selectMissionForSession(stateWith([MISSION]), 'ab-cd')).toEqual({ missionId: null });
    // A suffix that merely CONTAINS sid8 is not a match.
    expect(selectMissionForSession(stateWith([`M-20260921-S${SID8}x`]), SID)).toEqual({ missionId: null });
  });

  it('is total: garbage never throws and never invents a mission', () => {
    for (const state of [null, undefined, 42, 'x', {}, { active_missions: null }, { active_missions: [] }]) {
      expect(selectMissionForSession(state, SID), JSON.stringify(state)).toEqual({ missionId: null });
    }
    expect(selectMissionForSession(stateWith([MISSION]), null)).toEqual({ missionId: null });
    expect(selectMissionForSession(stateWith([MISSION]), undefined)).toEqual({ missionId: null });
  });

  it('passes revisions through verbatim — the assembler alone decides what counts', () => {
    for (const revision of [0, '2', 1.5, null, undefined]) {
      const state = { active_missions: { [MISSION]: missionRecord({ intent: { path: 'i.md', revision } }) } };
      const sel = selectMissionForSession(state, SID);
      expect(sel.missionId).toBe(MISSION);
      expect(sel.basedOn.intentRevision, String(revision)).toBe(revision);
    }
    // A mission missing `intent`/`plan` altogether yields undefined, not a forged 1.
    const bare = { active_missions: { [MISSION]: { status: 'executing' } } };
    expect(selectMissionForSession(bare, SID).basedOn).toEqual({ intentRevision: undefined, planRevision: undefined });
  });

  it('takes the assembled gap from 11 to 8, and no further', () => {
    const base = { receiptId: 'ctx-x', inputTokens: 10, outputTokens: 20, protectedSections: [] };
    expect(assembleContextReceipt(base).missing).toHaveLength(11);

    const sel = selectMissionForSession(stateWith([MISSION]), SID);
    const supplied = assembleContextReceipt({ ...base, missionId: sel.missionId, basedOn: sel.basedOn });
    expect(supplied.missing).toEqual(PERMANENT_GAP);
    expect(supplied.ok).toBe(false); // still incomplete — nothing may be published
    expect(supplied.partial.mission_id).toBe(MISSION);
    expect(supplied.partial.based_on).toEqual({ intent_revision: 2, plan_revision: 5 });

    // `isCounter` takes integers >= 1 only: 0 is below the schema minimum and a
    // string is not a number, so both leave the leaf missing rather than coerced.
    // Each side is judged on its own — one bad revision costs ONE leaf, and a
    // valid sibling is never used to fill it in.
    for (const [intent, plan, expected] of [[0, 5, 9], ['2', 5.5, 10], [1, 1, 8]]) {
      const state = {
        active_missions: {
          [MISSION]: missionRecord({ intent: { path: 'i.md', revision: intent }, plan: { path: 'p.md', revision: plan } }),
        },
      };
      const s = selectMissionForSession(state, SID);
      const r = assembleContextReceipt({ ...base, missionId: s.missionId, basedOn: s.basedOn });
      expect(r.missing, `${intent}/${plan}`).toHaveLength(expected);
      expect(r.partial.mission_id).toBe(MISSION); // the id is supplied either way
    }
  });
});

/**
 * The store binding, end to end as the harness runs it.
 *
 * A second temp repo is used so the census below measures a store nobody else
 * writes; the shared `repo` above has no store and must keep having none.
 */
describe('mission store binding (SH-16)', () => {
  /** @type {string} */ let shome = '';
  /** @type {string} */ let sroot = '';
  /** @type {string} */ let shead = '';

  /** @returns {string} The store directory `createStateStore` resolves to. */
  const storeDir = () => path.join(sroot, '.git', 'artibot');

  /**
   * Seed a mission through the store's OWN api, with an ACCEPTING ledger stub,
   * so the journal and snapshot are whatever the store really writes.
   *
   * @param {string} missionId - Mission to write.
   * @param {object} [over] - Mission field overrides.
   * @returns {void}
   */
  function seedMission(missionId, over = {}) {
    const store = createStateStore({
      projectRoot: sroot,
      sessionId: 'sh16-fixture',
      renderProjectionFile: false,
      resolveGitCommonDir: () => resolveGitCommonDir(sroot),
      appendEvent: () => ({ ok: true, path: '<stub>', seq: 1, bytes: 0 }),
    });
    const res = store.updateMission(missionId, () => missionRecord(over), { reason: 'sh16-fixture' });
    if (!res.ok) throw new Error(`fixture seed failed: ${JSON.stringify(res)}`);
  }

  /**
   * Content census of a tree: relative path → sha256 of the bytes. Content, not
   * mtime: a rewrite of identical bytes bumps mtime (false red) and a coarse
   * timestamp can miss a fast rewrite (false green, the direction that matters).
   *
   * @param {string} dir - Tree root; absent is the empty census.
   * @returns {Record<string, string>} The census.
   */
  function census(dir) {
    /** @type {Record<string, string>} */ const out = {};
    if (!existsSync(dir)) return out;
    const walk = (cur, prefix) => {
      for (const entry of readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(cur, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, rel);
        else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    };
    walk(dir, '');
    return out;
  }

  /**
   * @param {object} [over] - Payload overrides.
   * @returns {object} A PostCompact payload for the store repo.
   */
  const payload = (over = {}) => ({
    session_id: SID, cwd: sroot, permission_mode: 'default', hook_event_name: 'PostCompact',
    compact_trigger: 'auto', compact_summary: 'compacted; last topic: SH-16.', ...over,
  });

  /**
   * @param {object} body - stdin payload.
   * @returns {{ stdout: string, stderr: string, status: number|null }} Outcome.
   */
  function run(body) {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: sroot,
      env: {
        ...process.env,
        HOME: shome,
        USERPROFILE: shome,
        ARTIBOT_CONTEXT_LIFECYCLE_JSON: JSON.stringify({ enabled: true }),
      },
      input: JSON.stringify(body),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 20000,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }

  /** @returns {object} The machine-readable record the hook just wrote. */
  const record = () => JSON.parse(readFileSync(path.join(shome, '.claude', 'artibot-post-compact.json'), 'utf-8'));

  beforeEach(() => {
    shome = mkdtempSync(path.join(os.tmpdir(), 'pcr-shome-'));
    sroot = mkdtempSync(path.join(os.tmpdir(), 'pcr-sroot-'));
    git(['init', '-q', '-b', 'master'], sroot);
    git(['config', 'user.email', 't@example.com'], sroot);
    git(['config', 'user.name', 't'], sroot);
    git(['config', 'commit.gpgsign', 'false'], sroot);
    writeFileSync(path.join(sroot, 'a.txt'), 'a\n');
    git(['add', 'a.txt'], sroot);
    git(['commit', '-q', '-m', 'base'], sroot);
    shead = git(['rev-parse', '--short=12', 'HEAD'], sroot);
    // An ACCEPTED snapshot with a measured window, so `input_tokens` is
    // supplied and the missing count moves only for the SH-16 leaves.
    mkdirSync(path.join(shome, '.claude'), { recursive: true });
    writeFileSync(path.join(shome, '.claude', 'artibot-pre-compact.json'), JSON.stringify({
      savedAt: '2026-09-21T01:00:00.000Z',
      summary: { current_work: 'wiring the receipt' },
      gitState: { cwd: sroot, branch: 'master', head: shead, hasStatus: false },
      contextWindow: { current_tokens: 150_000, max_tokens: 200_000 },
    }, null, 2));
  });

  afterEach(() => {
    for (const d of [shome, sroot]) rmSync(d, { recursive: true, force: true });
  });

  it('one mission for this session: the gap falls to 8 and names only the permanent axis', () => {
    seedMission(MISSION);
    const r = run(payload());
    expect(r.status).toBe(0);
    const rec = record();
    expect(rec.identity.ok).toBe(true);
    expect(rec.contextReceipt.missing).toEqual(PERMANENT_GAP);
    expect(rec.contextReceipt).toMatchObject({ emitted: false, reason: 'no-writer-port' });
    expect(r.stderr).toContain('receipt=no-writer-port missing=8');
  });

  it('zero and two matches both leave all eleven missing', () => {
    seedMission('M-20260921-001');
    run(payload());
    expect(record().contextReceipt.missing).toHaveLength(11);
    expect(record().contextReceipt.missing).toContain('mission_id');

    seedMission(MISSION);
    seedMission(MISSION_TWIN);
    run(payload());
    expect(record().contextReceipt.missing).toHaveLength(11);
    expect(record().contextReceipt.missing).toContain('mission_id');
  });

  it('a mission whose revisions are not counters supplies the id and nothing else', () => {
    // The store's own validator refuses such a mission on write
    // (`lib/project-state/validate.js` — `revision must be an integer >= 1`),
    // so this state can only arise from drift or corruption on disk. The hook
    // must survive it without coercing: patch the snapshot the store wrote.
    seedMission(MISSION);
    const snapshotFile = path.join(storeDir(), 'project-state.json');
    const snap = JSON.parse(readFileSync(snapshotFile, 'utf-8'));
    snap.active_missions[MISSION].intent.revision = '2';
    snap.active_missions[MISSION].plan.revision = 5.5;
    writeFileSync(snapshotFile, JSON.stringify(snap, null, 2));

    run(payload());
    const missing = record().contextReceipt.missing;
    expect(missing).toHaveLength(10);
    expect(missing).not.toContain('mission_id');
    expect(missing).toContain('based_on.intent_revision');
    expect(missing).toContain('based_on.plan_revision');
  });

  it('writes 0: the store is byte-identical across a run and no ledger port is called', () => {
    seedMission(MISSION);
    const before = census(storeDir());
    expect(Object.keys(before).length).toBeGreaterThan(0);
    const r = run(payload());
    expect(r.status).toBe(0);
    expect(census(storeDir())).toEqual(before);
    // No projection either: `renderProjectionFile: false` means the repo tree
    // gains no `.artibot/state.yaml`.
    expect(existsSync(path.join(sroot, '.artibot', 'state.yaml'))).toBe(false);

    // The refusing port, counted. `readMissionContext` is the whole store
    // interaction the hook has, so a 0 here is a 0 for the run.
    let calls = 0;
    const ctx = readMissionContext(sroot, SID, (root) => openMissionStoreReadOnly(root, {
      appendEvent: (event) => { calls += 1; return { ok: false, reason: 'counted', event }; },
    }));
    expect(ctx.missionId).toBe(MISSION);
    expect(calls).toBe(0);
  });

  it('no store on disk: the gap stays at eleven and no store directory is created', () => {
    expect(existsSync(storeDir())).toBe(false);
    const r = run(payload());
    expect(r.status).toBe(0);
    expect(existsSync(storeDir())).toBe(false);
    expect(record().contextReceipt.missing).toHaveLength(11);
  });

  it('stdout is byte-identical with and without a store: the receipt never reaches the user', () => {
    const stripStamp = (s) => s.replace(/post-compact-[0-9TZ-]+\.md/g, 'post-compact-STAMP.md');
    const without = run(payload());
    seedMission(MISSION);
    const withStore = run(payload());
    expect(stripStamp(JSON.parse(withStore.stdout).systemMessage))
      .toBe(stripStamp(JSON.parse(without.stdout).systemMessage));
    for (const token of [MISSION, 'mission_id', 'based_on', 'intentRevision']) {
      expect(JSON.parse(withStore.stdout).systemMessage, token).not.toContain(token);
    }
  });

  it('degrades to the old behaviour when the store cannot be opened, and never throws', () => {
    // A store whose open throws: `readMissionContext` swallows it.
    const thrower = () => { throw new Error('store unavailable'); };
    expect(readMissionContext(sroot, SID, thrower)).toEqual({ missionId: null });
    // A store whose `getState` throws.
    expect(readMissionContext(sroot, SID, () => ({ getState: thrower }))).toEqual({ missionId: null });
    // No project root at all.
    expect(readMissionContext('', SID)).toEqual({ missionId: null });
    expect(readMissionContext(null, SID)).toEqual({ missionId: null });
    // A directory that is not a project: the store opens, reads an empty state.
    const empty = mkdtempSync(path.join(os.tmpdir(), 'pcr-empty-'));
    try {
      expect(readMissionContext(empty, SID)).toEqual({ missionId: null });
      expect(existsSync(path.join(empty, '.artibot'))).toBe(false);
      expect(statSync(empty).isDirectory()).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
