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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectSplitEvidence, LIFECYCLE_DEFAULTS, resolveLifecycle } from '../../scripts/hooks/post-compact-rehydrate.js';

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

  it('no context_window: falls back to transcriptBytes over the catalog capacity, and says so', () => {
    writePressureSnapshot({ cwd: repo, branch: 'master', head, hasStatus: false },
      { transcriptBytes: 2_000_000 });
    const r = runHook(payload(), lifecycleEnv());
    const rec = readRecord();
    expect(rec.pressure.inputs.tokenSource).toBe('transcriptBytes');
    expect(rec.pressure.inputs.overstates).toBe(true);
    expect(rec.capacitySource).toBe('catalog:opus.ctxLimit');
    expect(rec.pressure.inputs.maxTokens).toBe(1_000_000);
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
