/**
 * `scripts/split/{dispatch,worktree-setup,restore-blob,suspend,resume-notices}.mjs`.
 *
 * Every script exports its planning/rendering core; the CLI `main` is driven
 * with injected stdout/stderr so no child process is spawned for the script
 * itself. `restore-blob` and `resume-notices` run real git in a temp repo
 * (that is the behaviour under test — autocrlf byte restore, branch sha).
 *
 * What this file cannot see (rules §9): no junction is ever created here —
 * `worktree-setup` is tested through its pure planners with a fake
 * filesystem; the junction/rmdir semantics were measured by hand on this host
 * (2026-09-02: `mklink /J` → `lstat().isSymbolicLink() === true`, `rmdirSync`
 * removes the link only). Whether a live window follows any notice is a
 * live observation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import * as dispatch from '../../scripts/split/dispatch.mjs';
import * as laneState from '../../scripts/split/lane-state.mjs';
import * as restore from '../../scripts/split/restore-blob.mjs';
import * as resume from '../../scripts/split/resume-notices.mjs';
import * as suspend from '../../scripts/split/suspend.mjs';
import * as wts from '../../scripts/split/worktree-setup.mjs';
import { readRunJson, writeRunJson } from '../../lib/git/split-run-file.js';
import { LANE_OPS_STATES } from '../../lib/supervisor/contracts.js';

const tmpDirs = [];
const mkTmp = (label = 'split-tools-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, timeout: 15000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitBuf = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, timeout: 15000, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const collect = () => {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
};

/** A parent root with plan.json, a limb brief, and run.json. */
function seedParent({ limbs = ['auth'], parentSession = 'demo-a1', windows = true } = {}) {
  const parent = mkTmp('split-parent-');
  const splitDir = path.join(parent, '.artibot', 'split');
  const rows = limbs.map((limb) => {
    const worktreePath = path.join(parent, '.claude', 'worktrees', `split-demo-${limb}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.join(splitDir, limb), { recursive: true });
    fs.writeFileSync(path.join(splitDir, limb, 'brief.md'), `# ${limb}\n\n## 소유 파일 allowlist\n- src/${limb}\n\n## 완료 기준\n- tests\n`);
    return { limb, worktreeName: `split-demo-${limb}`, worktreePath, branch: `worktree-split-demo-${limb}`, taskIds: [limb], affectedPaths: [`src/${limb}`] };
  });
  const plan = { runId: 'split-abc123', sid: 'abc123', parentRoot: parent, repoShort: 'demo', base: 'deadbeef', parentSession, limbs: rows };
  fs.writeFileSync(path.join(splitDir, 'plan.json'), JSON.stringify(plan, null, 2));
  if (windows) writeRunJson(parent, { runId: plan.runId, windowReuse: Object.fromEntries(limbs.map((l) => [l, `split-demo-${l}-3f @ ${path.join(parent, 'x')}`])) });
  return { parent, plan, rows };
}

// ── dispatch ────────────────────────────────────────────────────────────────

describe('dispatch.mjs parseArgs', () => {
  it('parses the positional limb and every option', () => {
    expect(dispatch.parseArgs(['auth', '--template', 't.md', '--window', 'w-1', '--gotchas', 'g.md', '--parent', 'p', '--budget', '1000', '--dry-run', '--json']))
      .toEqual({ limb: 'auth', template: 't.md', window: 'w-1', parent: 'p', gotchas: 'g.md', budget: 1000, dryRun: true, json: true, help: false });
  });
  it('defaults', () => {
    expect(dispatch.parseArgs([])).toEqual({ limb: null, template: null, window: null, parent: null, gotchas: null, budget: null, dryRun: false, json: false, help: false });
  });
  it('rejects unknown options, missing values, bad budget, and a second positional', () => {
    expect(() => dispatch.parseArgs(['auth', '--nope'])).toThrow(/unknown option/);
    expect(() => dispatch.parseArgs(['auth', '--window'])).toThrow(/requires a value/);
    expect(() => dispatch.parseArgs(['auth', '--budget', 'abc'])).toThrow(/positive integer/);
    expect(() => dispatch.parseArgs(['auth', 'extra'])).toThrow(/unexpected argument/);
  });
});

describe('dispatch.mjs resolveLimbRow', () => {
  it('returns the row as written by /split plan', () => {
    const plan = { limbs: [{ limb: 'auth', worktreePath: '/wt', branch: 'b' }] };
    expect(dispatch.resolveLimbRow(plan, 'auth', '/root', 'demo')).toEqual({ limb: 'auth', worktreePath: '/wt', branch: 'b' });
  });
  it('derives canonical names when the row lacks them', () => {
    const r = dispatch.resolveLimbRow({ limbs: [{ limb: 'auth' }] }, 'auth', '/root', 'demo');
    expect(r.branch).toBe('worktree-split-demo-auth');
    expect(r.worktreePath).toBe(path.join('/root', '.claude', 'worktrees', 'split-demo-auth'));
  });
  it('throws for an unknown limb, listing the known ones', () => {
    expect(() => dispatch.resolveLimbRow({ limbs: [{ limb: 'auth' }] }, 'nope', '/r', 'd')).toThrow(/known: auth/);
  });
});

describe('dispatch.mjs runDispatch (temp parent root, real template + real commands/split.md)', () => {
  it('materialises the brief, writes prompt.md, resolves the window from run.json, never leaves a placeholder', async () => {
    const { parent, rows } = seedParent();
    const r = await dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: parent });
    expect(r.to).toBe('split-demo-auth-3f');
    expect(r.copied).toBe(true);
    expect(r.briefPath).toBe(path.join(rows[0].worktreePath, '.artibot', 'split', 'auth', 'brief.md'));
    expect(fs.readFileSync(r.promptPath, 'utf-8')).toBe(r.prompt);
    expect(r.prompt).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
    expect(r.prompt).toContain('[보고 계약]');
    expect(r.prompt).toContain('SendMessage(to="demo-a1")');
    expect(r.prompt).not.toContain('{리더 이름}');
    expect(r.prompt).toContain('{측정시각}');
    expect(r.prompt).toContain('first-parent');
    expect(r.prompt).toContain('(없음)');
    expect(r.prompt).toContain('max_tokens=600000');
    expect(r.prompt).toContain('[모델 운용 정책');
    expect(r.pointer).toContain('[split:dispatch run=split-abc123 limb=auth]');
    expect(r.pointer).toContain(r.briefPath);
  });

  it('--window overrides run.json, --gotchas fills the delta, --budget fills BUDGET', async () => {
    const { parent } = seedParent();
    const g = path.join(parent, 'g.md');
    fs.writeFileSync(g, '- 새 함정 A\n');
    const r = await dispatch.runDispatch(dispatch.parseArgs(['auth', '--window', 'w-9', '--gotchas', g, '--budget', '42']), { cwd: parent, config: null });
    expect(r.to).toBe('w-9');
    expect(r.prompt).toContain('- 새 함정 A');
    expect(r.prompt).toContain('max_tokens=42');
  });

  it('reads <parentRoot>/.artibot/split/gotchas.md by default', async () => {
    const { parent } = seedParent();
    fs.writeFileSync(path.join(parent, '.artibot', 'split', 'gotchas.md'), '함정 B');
    const r = await dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: parent, config: null });
    expect(r.prompt).toContain('함정 B');
    expect(r.prompt).not.toContain('(없음)');
  });

  it('--dry-run renders but writes nothing', async () => {
    const { parent, rows } = seedParent();
    const r = await dispatch.runDispatch(dispatch.parseArgs(['auth', '--dry-run']), { cwd: parent, config: null });
    expect(r.dryRun).toBe(true);
    expect(r.copied).toBe(false);
    expect(fs.existsSync(path.join(rows[0].worktreePath, '.artibot'))).toBe(false);
    expect(r.prompt).toContain('[split limb] run=split-abc123 limb=auth');
  });

  it('to is null when no window is recorded (leader must pass --window)', async () => {
    const { parent } = seedParent({ windows: false });
    const r = await dispatch.runDispatch(dispatch.parseArgs(['auth', '--dry-run']), { cwd: parent, config: null });
    expect(r.to).toBeNull();
  });

  it('refuses when the parent brief is missing (fail-closed, nothing written)', async () => {
    const { parent, rows } = seedParent();
    fs.rmSync(path.join(parent, '.artibot', 'split', 'auth', 'brief.md'));
    await expect(dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: parent, config: null })).rejects.toThrow(/parent brief missing/);
    expect(fs.existsSync(path.join(rows[0].worktreePath, '.artibot'))).toBe(false);
  });

  it('refuses an unknown parent session, a missing plan, an unknown limb, a missing --gotchas file', async () => {
    const { parent } = seedParent({ parentSession: null, windows: false });
    await expect(dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: parent, config: null })).rejects.toThrow(/parent session unknown/);
    await expect(dispatch.runDispatch(dispatch.parseArgs(['nope', '--parent', 'p']), { cwd: parent, config: null })).rejects.toThrow(/not in plan.json/);
    await expect(dispatch.runDispatch(dispatch.parseArgs(['auth', '--parent', 'p', '--gotchas', path.join(parent, 'missing.md')]), { cwd: parent, config: null })).rejects.toThrow(/--gotchas file missing/);
    await expect(dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: mkTmp(), config: null })).rejects.toThrow(/plan.json missing/);
  });

  it('honours a custom --template and still fails closed on its unresolved placeholders', async () => {
    const { parent } = seedParent();
    const t = path.join(parent, 't.md');
    fs.writeFileSync(t, 'run={RUN} limb={LIMB} {REPORT_CONTRACT}');
    const ok = await dispatch.runDispatch(dispatch.parseArgs(['auth', '--dry-run', '--template', t]), { cwd: parent, config: null });
    expect(ok.prompt.startsWith('run=split-abc123 limb=auth [보고 계약]')).toBe(true);
    fs.writeFileSync(t, 'run={RUN} {WHATEVER}');
    await expect(dispatch.runDispatch(dispatch.parseArgs(['auth', '--dry-run', '--template', t]), { cwd: parent, config: null })).rejects.toThrow(/\{WHATEVER\}/);
  });

  it('main: --json prints { to, limb, pointer, promptPath, briefPath } and exit 0; errors exit 1 as JSON; --help says it never sends', async () => {
    const { parent } = seedParent();
    const c = collect();
    expect(await dispatch.main(['auth', '--json'], { cwd: parent, config: null, ...c.io })).toBe(0);
    const parsed = JSON.parse(c.stdout());
    expect(Object.keys(parsed).sort()).toEqual(['briefPath', 'copied', 'dryRun', 'limb', 'pointer', 'promptPath', 'to']);
    expect(parsed.to).toBe('split-demo-auth-3f');
    const e = collect();
    expect(await dispatch.main(['nope', '--json'], { cwd: parent, config: null, ...e.io })).toBe(1);
    expect(JSON.parse(e.stdout()).error).toMatch(/not in plan.json/);
    const h = collect();
    expect(await dispatch.main(['--help'], { ...h.io })).toBe(0);
    expect(h.stdout()).toMatch(/NEVER sends/);
    expect(h.stdout()).toMatch(/SendMessage\(to=<to>, message=<pointer>\)/);
    const bad = collect();
    expect(await dispatch.main(['--bogus'], { ...bad.io })).toBe(1);
    expect(bad.stderr()).toMatch(/unknown option/);
  });
});

// ── worktree-setup ──────────────────────────────────────────────────────────

describe('worktree-setup.mjs config + planners (fake fs — no junction is created)', () => {
  const fakeFs = (present) => {
    const set = new Set(present.map((p) => path.resolve(p)));
    return (p) => set.has(path.resolve(p));
  };

  it('normalizeSetupConfig: defaults, overrides, string/array installCmd, envPerLane filtering', () => {
    expect(wts.normalizeSetupConfig(undefined)).toEqual({ linkDirs: ['plugins/artibot/node_modules'], copyFiles: ['.env.local'], installCmd: null, envPerLane: {} });
    expect(wts.normalizeSetupConfig({ linkDirs: ['node_modules', ' packages/x/node_modules '], copyFiles: [], installCmd: 'npm ci', envPerLane: { E2E_DB_NAME: 'app_e2e_{limb}', 'bad-key': 'x', N: 3 } }))
      .toEqual({ linkDirs: ['node_modules', 'packages/x/node_modules'], copyFiles: [], installCmd: ['npm', 'ci'], envPerLane: { E2E_DB_NAME: 'app_e2e_{limb}', N: '3' } });
    expect(wts.normalizeSetupConfig({ installCmd: ['npm', '--prefix', 'packages/x', 'ci'] }).installCmd).toEqual(['npm', '--prefix', 'packages/x', 'ci']);
    expect(wts.normalizeSetupConfig({ linkDirs: 'not-a-list' }).linkDirs).toEqual(['plugins/artibot/node_modules']);
  });

  it('renderLaneEnv substitutes {limb} and {limb_}', () => {
    expect(wts.renderLaneEnv({ E2E_DB_NAME: 'app_e2e_{limb_}', LANE: '{limb}' }, 'w2a-ports')).toBe('E2E_DB_NAME=app_e2e_w2a_ports\nLANE=w2a-ports\n');
  });

  it('parseArgs', () => {
    expect(wts.parseArgs(['/wt', '--limb', 'auth', '--teardown', '--json', '--dry-run', '--parent', '/p']))
      .toEqual({ worktreePath: '/wt', limb: 'auth', parent: '/p', teardown: true, json: true, dryRun: true, help: false });
    expect(() => wts.parseArgs(['--x'])).toThrow(/unknown option/);
    expect(() => wts.parseArgs(['/a', '/b'])).toThrow(/unexpected argument/);
  });

  it('planWorktreeSetup: links what the parent has and the worktree lacks; skips present/absent; copies only when absent', () => {
    const setup = wts.normalizeSetupConfig({ linkDirs: ['plugins/artibot/node_modules', 'packages/x/node_modules'], copyFiles: ['.env.local', '.env.test'] });
    const exists = fakeFs(['/p/plugins/artibot/node_modules', '/p/.env.local', '/p/.env.test', '/wt/.env.test']);
    const actions = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', setup, exists });
    expect(actions.map((a) => [a.kind, path.basename(a.target)])).toEqual([
      ['link', 'node_modules'], ['skip', 'node_modules'], ['copy', '.env.local'], ['skip', '.env.test'],
    ]);
    expect(actions[0].source).toBe(path.join('/p', 'plugins/artibot/node_modules'));
    expect(actions[1].reason).toMatch(/parent lacks it/);
    expect(actions[3].reason).toMatch(/already present/);
  });

  it('planWorktreeSetup is idempotent: everything present → all skip', () => {
    const setup = wts.normalizeSetupConfig(undefined);
    const exists = fakeFs(['/p/plugins/artibot/node_modules', '/p/.env.local', '/wt/plugins/artibot/node_modules', '/wt/.env.local']);
    const actions = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', setup, exists });
    expect(actions.every((a) => a.kind === 'skip')).toBe(true);
  });

  it('installCmd runs only when no linkDir covers node_modules', () => {
    const setup = wts.normalizeSetupConfig({ linkDirs: ['plugins/artibot/node_modules'], copyFiles: [], installCmd: 'npm ci' });
    const covered = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', setup, exists: fakeFs(['/p/plugins/artibot/node_modules']) });
    expect(covered.find((a) => a.target === 'installCmd')).toMatchObject({ kind: 'skip' });
    const uncovered = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', setup, exists: fakeFs([]) });
    expect(uncovered.find((a) => a.kind === 'install')).toMatchObject({ cmd: ['npm', 'ci'], target: '/wt' });
    const alreadyThere = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', setup, exists: fakeFs(['/wt/plugins/artibot/node_modules']) });
    expect(alreadyThere.find((a) => a.target === 'installCmd')).toMatchObject({ kind: 'skip' });
  });

  it('envPerLane writes lane.env under the limb dir, and refuses without --limb', () => {
    const setup = wts.normalizeSetupConfig({ linkDirs: [], copyFiles: [], envPerLane: { E2E_DB_NAME: 'app_e2e_{limb_}' } });
    const withLimb = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', limb: 'w2a-ports', setup, exists: fakeFs([]) });
    expect(withLimb).toEqual([{ kind: 'env', target: path.join('/wt', '.artibot', 'split', 'w2a-ports', 'lane.env'), content: 'E2E_DB_NAME=app_e2e_w2a_ports\n' }]);
    const noLimb = wts.planWorktreeSetup({ parentRoot: '/p', worktreePath: '/wt', setup, exists: fakeFs([]) });
    expect(noLimb).toEqual([{ kind: 'refuse', target: 'lane.env', reason: expect.stringMatching(/--limb/) }]);
  });

  it('planWorktreeTeardown: unlink only reparse points; refuse real directories; skip absent', () => {
    const setup = wts.normalizeSetupConfig({ linkDirs: ['a', 'b', 'c'] });
    const exists = fakeFs(['/wt/a', '/wt/b']);
    const isLink = (p) => path.resolve(p) === path.resolve('/wt/a');
    const actions = wts.planWorktreeTeardown({ worktreePath: '/wt', setup, exists, isLink });
    expect(actions.map((a) => a.kind)).toEqual(['unlink', 'refuse', 'skip']);
    expect(actions[1].reason).toMatch(/never deletes recursively/);
  });

  it('applyActions: refuse/skip never touch io; failures are reported not thrown', () => {
    const calls = [];
    const io = {
      link: (s, t) => { calls.push(['link', s, t]); return 'junction'; },
      copy: (s, t) => { calls.push(['copy', s, t]); return 'copied'; },
      install: (cmd, cwd) => { calls.push(['install', cmd, cwd]); throw new Error('npm exploded'); },
      writeEnv: (t, c) => { calls.push(['env', t, c]); return 'written'; },
      unlink: (t) => { calls.push(['unlink', t]); return 'unlinked'; },
    };
    const rows = wts.applyActions([
      { kind: 'link', target: '/wt/nm', source: '/p/nm' },
      { kind: 'refuse', target: '/wt/x', reason: 'not a link' },
      { kind: 'skip', target: '/wt/y', reason: 'present' },
      { kind: 'install', target: '/wt', cmd: ['npm', 'ci'] },
      { kind: 'env', target: '/wt/lane.env', content: 'A=1\n' },
      { kind: 'unlink', target: '/wt/nm' },
    ], io);
    expect(rows.map((r) => r.status)).toEqual(['done', 'refused', 'skipped', 'failed', 'done', 'done']);
    expect(rows[3].detail).toMatch(/npm exploded/);
    expect(calls.map((c) => c[0])).toEqual(['link', 'install', 'env', 'unlink']);
  });

  it('main: applies through injected io against a temp worktree, prints a table, exit 1 on refuse', async () => {
    const parent = mkTmp('wts-parent-');
    const wt = mkTmp('wts-wt-');
    fs.mkdirSync(path.join(parent, 'plugins', 'artibot', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(parent, '.env.local'), 'X=1\n');
    const calls = [];
    const io = { ...wts.realIo, link: (s, t) => { calls.push([s, t]); return 'fake-junction'; } };
    const c = collect();
    const config = { split: { worktreeSetup: { envPerLane: { E2E_DB_NAME: 'app_e2e_{limb_}' } } } };
    expect(await wts.main([wt, '--limb', 'auth-v2', '--parent', parent], { config, io, ...c.io })).toBe(0);
    expect(calls).toEqual([[path.join(parent, 'plugins/artibot/node_modules'), path.join(wt, 'plugins/artibot/node_modules')]]);
    expect(fs.readFileSync(path.join(wt, '.env.local'), 'utf-8')).toBe('X=1\n');
    expect(fs.readFileSync(path.join(wt, '.artibot', 'split', 'auth-v2', 'lane.env'), 'utf-8')).toBe('E2E_DB_NAME=app_e2e_auth_v2\n');
    expect(c.stdout()).toMatch(/kind\s+status\s+target/);
    expect(c.stdout()).toMatch(/fake-junction/);
    // second run: copy is skipped (idempotent), link is attempted again only because the fake never created it
    const c2 = collect();
    expect(await wts.main([wt, '--limb', 'auth-v2', '--parent', parent, '--json'], { config, io, ...c2.io })).toBe(0);
    const j = JSON.parse(c2.stdout());
    expect(j.rows.find((r) => r.target.endsWith('.env.local')).status).toBe('skipped');
    // refuse path: envPerLane without --limb
    const c3 = collect();
    expect(await wts.main([wt, '--parent', parent, '--json'], { config, io, ...c3.io })).toBe(1);
    expect(JSON.parse(c3.stdout()).ok).toBe(false);
    // missing worktree
    const c4 = collect();
    expect(await wts.main([path.join(wt, 'nope'), '--parent', parent], { config, io, ...c4.io })).toBe(1);
    expect(c4.stderr()).toMatch(/worktree missing/);
  });

  it('main --teardown refuses a real directory in the link slot and never deletes it', async () => {
    const parent = mkTmp('wts-parent-');
    const wt = mkTmp('wts-wt-');
    const realDir = path.join(wt, 'plugins', 'artibot', 'node_modules');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'keep.txt'), 'keep');
    const c = collect();
    expect(await wts.main([wt, '--teardown', '--parent', parent, '--json'], { config: null, ...c.io })).toBe(1);
    const j = JSON.parse(c.stdout());
    expect(j.rows[0]).toMatchObject({ kind: 'refuse', status: 'refused' });
    expect(fs.existsSync(path.join(realDir, 'keep.txt'))).toBe(true);
  });
});

// ── restore-blob ────────────────────────────────────────────────────────────

describe('restore-blob.mjs (temp git repo, core.autocrlf=true)', () => {
  function makeRepo() {
    const repo = mkTmp('restore-repo-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'split@test');
    git(repo, 'config', 'user.name', 'split');
    git(repo, 'config', 'core.autocrlf', 'true');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'line1\nline2\n');
    git(repo, 'add', 'f.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    return repo;
  }

  it('parseArgs', () => {
    expect(restore.parseArgs(['a', 'b', '--ref', 'HEAD~1', '--json'])).toEqual({ files: ['a', 'b'], ref: 'HEAD~1', json: true, help: false });
    expect(() => restore.parseArgs(['--ref'])).toThrow(/requires a value/);
    expect(() => restore.parseArgs(['--x'])).toThrow(/unknown option/);
  });

  it('writes the blob bytes exactly (LF, not the autocrlf CRLF checkout) and reports sha256 before/after', () => {
    const repo = makeRepo();
    const file = path.join(repo, 'f.txt');
    fs.writeFileSync(file, 'line1\r\nINJECTED\r\nline2\r\n');
    const before = sha256(fs.readFileSync(file));
    const blob = gitBuf(repo, 'cat-file', '-p', 'HEAD:f.txt');
    expect(blob.toString()).toBe('line1\nline2\n');
    const r = restore.restoreAll({ cwd: repo, files: ['f.txt'] });
    expect(r.refreshed).toBe(true);
    expect(r.rows[0]).toMatchObject({ status: 'restored', repoPath: 'f.txt', before, blob: sha256(blob), changed: true });
    expect(r.rows[0].after).toBe(sha256(blob));
    expect(fs.readFileSync(file)).toEqual(blob);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('\r');
    expect(git(repo, 'status', '--porcelain', '--', 'f.txt').trim()).toBe('');
  });

  it('is a no-op on an already-exact file (changed=false) and works from a subdirectory', () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'g.txt'), 'g\n');
    git(repo, 'add', 'sub/g.txt');
    git(repo, 'commit', '-q', '-m', 'g');
    fs.writeFileSync(path.join(repo, 'sub', 'g.txt'), 'g\n');
    const r = restore.restoreAll({ cwd: path.join(repo, 'sub'), files: ['g.txt'] });
    expect(r.rows[0]).toMatchObject({ status: 'restored', repoPath: 'sub/g.txt', changed: false });
  });

  it('refuses untracked files without writing, and fails cleanly on a bad ref', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u');
    const r = restore.restoreAll({ cwd: repo, files: ['untracked.txt'] });
    expect(r.rows[0]).toMatchObject({ status: 'refused', repoPath: null });
    expect(r.refreshed).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf-8')).toBe('u');
    const bad = restore.restoreAll({ cwd: repo, files: ['f.txt'], ref: 'no-such-ref' });
    expect(bad.rows[0]).toMatchObject({ status: 'failed' });
    expect(bad.rows[0].reason).toMatch(/cat-file/);
  });

  it('main: exit 0 with JSON on success, exit 1 when any file is refused, help/usage on bad args', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
    const c = collect();
    expect(restore.main(['f.txt', '--json'], { cwd: repo, ...c.io })).toBe(0);
    expect(JSON.parse(c.stdout()).ok).toBe(true);
    const d = collect();
    expect(restore.main(['f.txt', 'nope.txt'], { cwd: repo, ...d.io })).toBe(1);
    expect(d.stdout()).toMatch(/refused\s+nope.txt/);
    const e = collect();
    expect(restore.main([], { cwd: repo, ...e.io })).toBe(1);
    expect(e.stderr()).toMatch(/at least one file/);
  });
});

// ── suspend / resume-notices ────────────────────────────────────────────────

describe('suspend.mjs', () => {
  it('parseArgs', () => {
    expect(suspend.parseArgs(['--reason', 'reboot 18:00', '--limbs', 'a, b', '--parent', 'p', '--json'])).toEqual({ reason: 'reboot 18:00', limbs: ['a', 'b'], parent: 'p', json: true, help: false });
    expect(suspend.parseArgs([])).toEqual({ reason: 'reboot', limbs: null, parent: null, json: false, help: false });
    expect(() => suspend.parseArgs(['--limbs', ','])).toThrow(/empty/);
    expect(() => suspend.parseArgs(['stray'])).toThrow(/unknown argument/);
  });

  it('buildSuspendNotice carries the five steps in order and the reply line', () => {
    const body = suspend.buildSuspendNotice({ runId: 'r1', limb: 'auth', branch: 'worktree-split-demo-auth', worktreePath: 'C:\\wt', reason: 'reboot', parent: 'demo-a1' });
    const idx = ['1. 팀원 정지', '2. `Split-Limb: wip` 커밋', '3. DEVIATIONS/재개 절 기록', '4. /save', '5. 회신'].map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(body).toContain('SendMessage(to="demo-a1")');
    expect(body).toContain('SUSPENDED limb=auth sha=<git rev-parse --short HEAD>');
    expect(body).toContain('C:/wt/.artibot/split/auth/DEVIATIONS.md');
    expect(body).toContain('worktree-split-demo-auth');
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('runSuspend records run.json.suspend for every limb with to from the window map and acked=false', () => {
    const { parent } = seedParent({ limbs: ['auth', 'billing'] });
    const now = () => new Date('2026-09-02T09:00:00.000Z');
    const r = suspend.runSuspend(suspend.parseArgs(['--reason', 'reboot']), { cwd: parent, now });
    expect(r.at).toBe('2026-09-02T09:00:00.000Z');
    expect(r.notices.map((n) => [n.limb, n.to])).toEqual([['auth', 'split-demo-auth-3f'], ['billing', 'split-demo-billing-3f']]);
    const run = readRunJson(parent);
    expect(run.runId).toBe('split-abc123');
    expect(run.suspend.at).toBe('2026-09-02T09:00:00.000Z');
    expect(run.suspend.reason).toBe('reboot');
    expect(run.suspend.limbs.auth).toEqual({ notice: r.notices[0].body, to: 'split-demo-auth-3f', acked: false });
    expect(Object.keys(run.suspend.limbs)).toEqual(['auth', 'billing']);
  });

  it('--limbs filters, unknown limbs are refused, missing run.json is tolerated', () => {
    const { parent } = seedParent({ limbs: ['auth', 'billing'], windows: false });
    const r = suspend.runSuspend(suspend.parseArgs(['--limbs', 'billing']), { cwd: parent });
    expect(r.notices.map((n) => n.limb)).toEqual(['billing']);
    expect(r.notices[0].to).toBeNull();
    expect(Object.keys(readRunJson(parent).suspend.limbs)).toEqual(['billing']);
    expect(() => suspend.runSuspend(suspend.parseArgs(['--limbs', 'nope']), { cwd: parent })).toThrow(/not in plan.json: nope/);
  });

  it('main: --json prints [{ limb, to, body }], exit 1 without a plan', () => {
    const { parent } = seedParent();
    const c = collect();
    expect(suspend.main(['--json'], { cwd: parent, ...c.io })).toBe(0);
    const arr = JSON.parse(c.stdout());
    expect(arr).toHaveLength(1);
    expect(Object.keys(arr[0]).sort()).toEqual(['body', 'limb', 'to']);
    const e = collect();
    expect(suspend.main([], { cwd: mkTmp(), ...e.io })).toBe(1);
    expect(e.stderr()).toMatch(/plan.json missing/);
    const h = collect();
    expect(suspend.main(['--help'], { ...h.io })).toBe(0);
    expect(h.stdout()).toMatch(/NEVER sends/);
  });
});

describe('resume-notices.mjs', () => {
  it('parseArgs', () => {
    expect(resume.parseArgs(['--clear', '--json'])).toEqual({ clear: true, json: true, help: false });
    expect(() => resume.parseArgs(['--x'])).toThrow(/unknown argument/);
  });

  it('returns null / prints nothing-to-resume when there is no suspend block', () => {
    const { parent } = seedParent();
    expect(resume.runResumeNotices(resume.parseArgs([]), { cwd: parent })).toBeNull();
    const c = collect();
    expect(resume.main(['--json'], { cwd: parent, ...c.io })).toBe(0);
    expect(JSON.parse(c.stdout())).toEqual([]);
  });

  it('emits one notice per suspended limb with branch, sha, window, and the three steps; --clear removes the block once', () => {
    const { parent } = seedParent({ limbs: ['auth', 'billing'] });
    suspend.runSuspend(suspend.parseArgs(['--reason', 'reboot']), { cwd: parent, now: () => new Date('2026-09-02T09:00:00.000Z') });
    const shaOf = (branch) => (branch === 'worktree-split-demo-auth' ? 'abc1234' : null);
    const r = resume.runResumeNotices(resume.parseArgs(['--clear']), { cwd: parent, shaOf });
    expect(r.suspendedAt).toBe('2026-09-02T09:00:00.000Z');
    expect(r.cleared).toBe(true);
    expect(r.notices.map((n) => [n.limb, n.to, n.sha])).toEqual([['auth', 'split-demo-auth-3f', 'abc1234'], ['billing', 'split-demo-billing-3f', null]]);
    const auth = r.notices[0].body;
    for (const s of ['1. 브리프 재독', '2. 재개 절', '3. 계속']) expect(auth).toContain(s);
    expect(auth).toContain('worktree-split-demo-auth 의 마지막 커밋: abc1234');
    expect(auth).toContain('RESUMED limb=auth');
    expect(auth).toContain('SendMessage(to="demo-a1")');
    expect(r.notices[1].body).toContain('(미확인');
    const run = readRunJson(parent);
    expect(run.suspend).toBeUndefined();
    expect(run.lastResume).toMatchObject({ suspendedAt: '2026-09-02T09:00:00.000Z', limbs: ['auth', 'billing'] });
    expect(run.runId).toBe('split-abc123');
    expect(resume.runResumeNotices(resume.parseArgs([]), { cwd: parent, shaOf })).toBeNull();
  });

  it('without --clear the block survives, and main prints the notices', () => {
    const { parent } = seedParent();
    suspend.runSuspend(suspend.parseArgs([]), { cwd: parent });
    const c = collect();
    expect(resume.main(['--json'], { cwd: parent, shaOf: () => 'f00d', ...c.io })).toBe(0);
    expect(JSON.parse(c.stdout())[0]).toMatchObject({ limb: 'auth', sha: 'f00d' });
    expect(readRunJson(parent).suspend).toBeDefined();
  });

  it('readBranchSha reads a real branch tip and returns null for a missing branch', () => {
    const repo = mkTmp('resume-repo-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'split@test');
    git(repo, 'config', 'user.name', 'split');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'branch', 'worktree-split-demo-auth');
    const expected = git(repo, 'rev-parse', '--short', 'worktree-split-demo-auth').trim();
    expect(resume.readBranchSha('worktree-split-demo-auth', repo)).toBe(expected);
    expect(resume.readBranchSha('worktree-split-demo-none', repo)).toBeNull();
    expect(resume.readBranchSha('', repo)).toBeNull();
  });
});

// ── lane-state ──────────────────────────────────────────────────────────────

describe('lane-state.mjs (writer for run.json.lanes[limb] — the reader is lib/supervisor/lane-monitor.js#readLaneOpsState)', () => {
  it('parseArgs', () => {
    expect(laneState.parseArgs(['auth', 'active', '--window', 'w-1', '--note', 'n', '--json'])).toEqual({ limb: 'auth', state: 'active', window: 'w-1', note: 'n', list: false, json: true, help: false });
    expect(laneState.parseArgs(['--list'])).toMatchObject({ list: true, limb: null, state: null });
    expect(() => laneState.parseArgs(['a', 'b', 'c'])).toThrow(/unexpected argument/);
    expect(() => laneState.parseArgs(['--nope'])).toThrow(/unknown option/);
  });

  it('refuses a state outside LANE_OPS_STATES and prints the allowlist; run.json untouched', () => {
    const { parent } = seedParent();
    const before = fs.readFileSync(path.join(parent, '.artibot', 'split', 'run.json'), 'utf-8');
    expect(() => laneState.setLaneState({ limb: 'auth', state: 'running' }, { cwd: parent })).toThrow(/allowlist: pending, active/);
    const c = collect();
    expect(laneState.main(['auth', 'running', '--json'], { cwd: parent, ...c.io })).toBe(1);
    expect(JSON.parse(c.stdout()).allowlist).toEqual([...LANE_OPS_STATES]);
    expect(fs.readFileSync(path.join(parent, '.artibot', 'split', 'run.json'), 'utf-8')).toBe(before);
  });

  it('refuses a limb not in plan.json (no --force) without touching run.json', () => {
    const { parent } = seedParent();
    expect(() => laneState.setLaneState({ limb: 'auht', state: 'active' }, { cwd: parent })).toThrow(/not in plan.json \(known: auth\)/);
    expect(readRunJson(parent).lanes).toBeUndefined();
    const c = collect();
    expect(laneState.main(['auht', 'active'], { cwd: parent, ...c.io })).toBe(1);
    expect(c.stderr()).toMatch(/lane-state refused/);
  });

  it('writes { state, since, window, note } atomically, preserves every other key and other lanes, and the reader sees it', async () => {
    const { parent } = seedParent({ limbs: ['auth', 'billing'] });
    writeRunJson(parent, {
      runId: 'split-abc123',
      windowReuse: { auth: 'split-demo-auth-3f @ x', billing: 'split-demo-billing-3f @ y' },
      metrics: { lanes: { auth: { files: 3 } } },
      rebootShutdown_20260902: { at: 't', ok: true },
      lanes: { billing: 'review' },
    });
    const now = () => new Date('2026-09-02T10:00:00.000Z');
    const r = laneState.setLaneState({ limb: 'auth', state: 'active', note: 'wave 1' }, { cwd: parent, now });
    expect(r).toEqual({ limb: 'auth', state: 'active', previous: null, since: '2026-09-02T10:00:00.000Z', window: 'split-demo-auth-3f', note: 'wave 1', changed: true });
    const run = readRunJson(parent);
    expect(run.lanes.auth).toEqual({ state: 'active', since: '2026-09-02T10:00:00.000Z', window: 'split-demo-auth-3f', note: 'wave 1' });
    expect(run.lanes.billing).toBe('review');
    expect(run.metrics).toEqual({ lanes: { auth: { files: 3 } } });
    expect(run.rebootShutdown_20260902).toEqual({ at: 't', ok: true });
    expect(run.windowReuse.billing).toBe('split-demo-billing-3f @ y');
    expect(fs.readdirSync(path.join(parent, '.artibot', 'split')).filter((f) => f.includes('.tmp'))).toEqual([]);
    const { readLaneOpsState } = await import('../../lib/supervisor/lane-monitor.js');
    expect(readLaneOpsState(run, 'auth')).toBe('active');
    expect(readLaneOpsState(run, 'billing')).toBe('review');
  });

  it('re-asserting the same state keeps since; a state change resets it; --window overrides', () => {
    const { parent } = seedParent();
    const t1 = () => new Date('2026-09-02T10:00:00.000Z');
    const t2 = () => new Date('2026-09-02T11:00:00.000Z');
    laneState.setLaneState({ limb: 'auth', state: 'active' }, { cwd: parent, now: t1 });
    const same = laneState.setLaneState({ limb: 'auth', state: 'active' }, { cwd: parent, now: t2 });
    expect(same).toMatchObject({ changed: false, since: '2026-09-02T10:00:00.000Z', previous: 'active' });
    const moved = laneState.setLaneState({ limb: 'auth', state: 'review', window: 'w-new' }, { cwd: parent, now: t2 });
    expect(moved).toMatchObject({ changed: true, since: '2026-09-02T11:00:00.000Z', previous: 'active', window: 'w-new' });
    expect(readRunJson(parent).lanes.auth).toEqual({ state: 'review', since: '2026-09-02T11:00:00.000Z', window: 'w-new' });
  });

  it('preserves hand-added keys of lanes[limb] (pr, inspector) and promotes a string entry to the object form', () => {
    const { parent } = seedParent({ limbs: ['auth', 'billing'] });
    writeRunJson(parent, { runId: 'split-abc123', lanes: { auth: { state: 'review', since: '2026-09-02T08:00:00.000Z', pr: 220, inspector: 'team-r2-inspector' }, billing: 'active' } });
    const now = () => new Date('2026-09-02T12:00:00.000Z');
    laneState.setLaneState({ limb: 'auth', state: 'done', note: 'landed' }, { cwd: parent, now });
    laneState.setLaneState({ limb: 'billing', state: 'active', window: 'w-b' }, { cwd: parent, now });
    const run = readRunJson(parent);
    expect(run.lanes.auth).toEqual({ state: 'done', since: '2026-09-02T12:00:00.000Z', pr: 220, inspector: 'team-r2-inspector', note: 'landed' });
    expect(run.lanes.billing).toEqual({ state: 'active', since: '2026-09-02T12:00:00.000Z', window: 'w-b' });
  });

  it('--list shows every plan limb, unknown for unset or out-of-allowlist entries', () => {
    const { parent } = seedParent({ limbs: ['auth', 'billing', 'search'] });
    laneState.setLaneState({ limb: 'auth', state: 'done' }, { cwd: parent });
    writeRunJson(parent, { ...readRunJson(parent), lanes: { ...readRunJson(parent).lanes, billing: { state: 'bogus' } } });
    const rows = laneState.listLaneStates({ cwd: parent });
    expect(rows.map((r) => [r.limb, r.state])).toEqual([['auth', 'done'], ['billing', 'unknown'], ['search', 'unknown']]);
    const c = collect();
    expect(laneState.main(['--list', '--json'], { cwd: parent, ...c.io })).toBe(0);
    expect(JSON.parse(c.stdout())).toHaveLength(3);
    const t = collect();
    expect(laneState.main(['--list'], { cwd: parent, ...t.io })).toBe(0);
    expect(t.stdout()).toMatch(/limb\s+state\s+since/);
  });

  it('main: missing plan → exit 1; help lists the allowlist', () => {
    const c = collect();
    expect(laneState.main(['auth', 'active'], { cwd: mkTmp(), ...c.io })).toBe(1);
    expect(c.stderr()).toMatch(/plan.json missing/);
    const h = collect();
    expect(laneState.main(['--help'], { ...h.io })).toBe(0);
    for (const s of LANE_OPS_STATES) expect(h.stdout()).toContain(s);
  });
});
