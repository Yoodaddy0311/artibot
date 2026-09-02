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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    expect(LIFECYCLE_DEFAULTS).toEqual({ enabled: false, postCompactRehydrate: true, maxRehydrateBytes: 10240 });
    expect(resolveLifecycle(null, {})).toEqual({ enabled: false, postCompactRehydrate: true, maxRehydrateBytes: 10240 });
    expect(resolveLifecycle({ split: { contextLifecycle: { enabled: true, maxRehydrateBytes: 4096 } } }, {}))
      .toEqual({ enabled: true, postCompactRehydrate: true, maxRehydrateBytes: 4096 });
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
