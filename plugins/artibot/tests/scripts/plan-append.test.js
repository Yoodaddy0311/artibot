/**
 * `scripts/split/plan-append.mjs` — rolling limb append to an existing run.
 *
 * Every fixture lives in an mkdtemp parent root; no test touches a real run.
 * The pure core (`appendLimbs`) is driven directly for the ownership rules;
 * `runAppend` / `main` are driven with an injected writer to prove the write
 * order (`.bak` first, atomic replace second) and the byte-for-byte refusal
 * guarantee; one CLI smoke spawns the script through `process.execPath`.
 *
 * What this file cannot see (rules §9): a real crash between the `.bak` copy
 * and the rename (the seam throws instead), a concurrent writer racing the
 * read, and whether a limb name is short enough for the harness to keep the
 * worktree name intact (the 33-char warning is a single 2026-09-28 observation).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLimbs, main, parseArgs, runAppend } from '../../scripts/split/plan-append.mjs';
import { computeNextWave } from '../../scripts/split/next-wave.mjs';
import { normalizeTaskId } from '../../lib/autopilot/fast-profile.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'split', 'plan-append.mjs');

const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-append-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const splitDir = (parent) => path.join(parent, '.artibot', 'split');
const planFile = (parent) => path.join(splitDir(parent), 'plan.json');
const bakFile = (parent) => `${planFile(parent)}.bak`;
const collect = () => {
  const out = [];
  const err = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
};

/** An old-format row (no wave / rolling keys). */
const oldRow = (limb, affectedPaths) => ({
  limb,
  worktreeName: `split-demo-${limb}`,
  worktreePath: `/repo/.claude/worktrees/split-demo-${limb}`,
  branch: `worktree-split-demo-${limb}`,
  taskIds: [limb],
  affectedPaths,
});

/** Parent root with plan.json (raw text, so byte checks are exact) and optional run.json. */
function seed({ planText, lanes } = {}) {
  const parent = mkTmp();
  fs.mkdirSync(splitDir(parent), { recursive: true });
  const plan = {
    runId: 'split-demo',
    repoShort: 'demo',
    base: 'a'.repeat(40),
    limbs: [oldRow('alpha', ['src/alpha/']), oldRow('beta', ['src/beta.js'])],
  };
  fs.writeFileSync(planFile(parent), planText ?? `${JSON.stringify(plan, null, 2)}\n`);
  if (lanes) fs.writeFileSync(path.join(splitDir(parent), 'run.json'), JSON.stringify({ runId: 'split-demo', lanes }));
  return parent;
}

const args = (parent, extra = []) => parseArgs(['--parent', parent, '--limb', 'gamma', '--path', 'src/gamma.js', '--wave', '25', ...extra]);

describe('parseArgs', () => {
  it('collects repeatable --task/--path and the rolling flag', () => {
    const a = parseArgs(['--limb', 'x1', '--task', 't1', '--task', 't2', '--path', 'a', '--path', 'b', '--wave', '3', '--rolling']);
    expect(a).toMatchObject({ limb: 'x1', tasks: ['t1', 't2'], paths: ['a', 'b'], wave: 3, rolling: true, dryRun: false });
  });
  it('rejects unknown flags, missing values and a non-positive wave', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--limb'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--wave', '0'])).toThrow(/integer >= 1/);
    expect(() => parseArgs(['--wave', '1.5'])).toThrow(/integer >= 1/);
  });
});

describe('runAppend write order', () => {
  it('writes plan.json.bak equal to the original bytes, then the appended plan', () => {
    const parent = seed();
    const original = fs.readFileSync(planFile(parent));
    const r = runAppend(args(parent, ['--rolling']));
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(bakFile(parent)).equals(original)).toBe(true);
    const written = JSON.parse(fs.readFileSync(planFile(parent), 'utf-8'));
    expect(written.limbs.map((l) => l.limb)).toEqual(['alpha', 'beta', 'gamma']);
    expect(written.schema_version).toBe(1);
  });

  it('creates the .bak BEFORE the write, and a failed write leaves plan.json byte-identical', () => {
    const parent = seed();
    const original = fs.readFileSync(planFile(parent));
    let bakAtWrite = null;
    const failingWriter = (filePath) => {
      bakAtWrite = fs.existsSync(bakFile(parent)) ? fs.readFileSync(bakFile(parent)) : null;
      fs.writeFileSync(`${filePath}.tmp-sim`, '{"partial":');
      throw new Error('simulated disk failure');
    };
    expect(() => runAppend(args(parent), { writeJson: failingWriter })).toThrow(/write failed.*simulated disk failure.*unchanged/);
    expect(bakAtWrite && bakAtWrite.equals(original)).toBe(true);
    expect(fs.readFileSync(planFile(parent)).equals(original)).toBe(true);
    expect(fs.readFileSync(bakFile(parent)).equals(original)).toBe(true);
  });

  it('--dry-run validates and writes nothing', () => {
    const parent = seed();
    const original = fs.readFileSync(planFile(parent));
    const r = runAppend(args(parent, ['--dry-run']));
    expect(r).toMatchObject({ ok: true, dryRun: true, backupPath: null });
    expect(r.added[0].limb).toBe('gamma');
    expect(fs.readFileSync(planFile(parent)).equals(original)).toBe(true);
    expect(fs.existsSync(bakFile(parent))).toBe(false);
  });
});

describe('refusals leave no trace', () => {
  /** Run main, expect exit 1 + reason on stderr + untouched bytes + no .bak. */
  const expectRefused = (parent, argv, reason) => {
    const before = fs.existsSync(planFile(parent)) ? fs.readFileSync(planFile(parent)) : null;
    const c = collect();
    expect(main(['--parent', parent, ...argv], c.io)).toBe(1);
    expect(c.stderr()).toMatch(reason);
    expect(c.stderr().split('\n').filter(Boolean)).toHaveLength(1);
    if (before) expect(fs.readFileSync(planFile(parent)).equals(before)).toBe(true);
    expect(fs.existsSync(bakFile(parent))).toBe(false);
  };

  it('duplicate limb name', () => {
    expectRefused(seed(), ['--limb', 'alpha', '--path', 'src/other.js', '--wave', '2'], /alpha already exists/);
  });
  it('invalid limb name (existing naming validator)', () => {
    expectRefused(seed(), ['--limb', 'Bad_Name', '--path', 'src/other.js', '--wave', '2'], /invalid limb name/);
  });
  it('missing plan.json', () => {
    const parent = mkTmp();
    expectRefused(parent, ['--limb', 'gamma', '--path', 'src/g.js', '--wave', '2'], /plan\.json missing/);
  });
  it('malformed plan.json', () => {
    expectRefused(seed({ planText: '{"limbs": [' }), ['--limb', 'gamma', '--path', 'src/g.js', '--wave', '2'], /plan\.json malformed/);
  });
  it('malformed run.json (landed state unknown)', () => {
    const parent = seed();
    fs.writeFileSync(path.join(splitDir(parent), 'run.json'), '{oops');
    expectRefused(parent, ['--limb', 'gamma', '--path', 'src/g.js', '--wave', '2'], /run\.json malformed/);
  });
  it('no --path (ownership cannot be checked)', () => {
    expectRefused(seed(), ['--limb', 'gamma', '--wave', '2'], /at least one affected path/);
  });
  it('overlap with an un-landed limb (directory ownership covers the file)', () => {
    expectRefused(seed({ lanes: { alpha: { state: 'active' } } }), ['--limb', 'gamma', '--path', 'src/alpha/x.js', '--wave', '2'], /overlaps owned paths of limb alpha \(lane state active/);
  });
  it('trailer-done is not landed: no lane record → still rejected', () => {
    // No git here on purpose — the landed rule reads run.json lanes only, so a
    // limb whose branch might carry `Split-Limb: done` but has no lane record
    // is indistinguishable from an active one and must still block.
    expectRefused(seed(), ['--limb', 'gamma', '--path', 'src/beta.js', '--wave', '2'], /overlaps owned paths of limb beta \(lane state unknown/);
  });
});

describe('ownership rule (pure core)', () => {
  const ctx = { parentRoot: '/repo', repoShort: 'demo' };
  const plan = { limbs: [oldRow('alpha', ['src/alpha/']), oldRow('beta', ['src/beta.js'])] };
  const spec = (over = {}) => ({ limb: 'gamma', taskIds: ['gamma'], affectedPaths: ['src/beta.js'], wave: 25, rolling: true, ...over });

  it('accepts an overlap with a limb whose lane state is done', () => {
    const r = appendLimbs(plan, { lanes: { beta: { state: 'done' } } }, [spec()], ctx);
    expect(r.ok).toBe(true);
  });
  it('accepts the string lane form too', () => {
    expect(appendLimbs(plan, { lanes: { beta: 'done' } }, [spec()], ctx).ok).toBe(true);
  });
  it('rejects when the lane state is outside the allowlist (reads as unknown)', () => {
    const r = appendLimbs(plan, { lanes: { beta: { state: 'dispatched' } } }, [spec()], ctx);
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/beta \(lane state unknown/);
  });
  it('rejects an un-landed existing limb with no affectedPaths (fail-closed)', () => {
    const legacy = { limbs: [{ limb: 'legacy', taskIds: ['legacy'] }] };
    const r = appendLimbs(legacy, null, [spec({ affectedPaths: ['src/new.js'] })], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/legacy .*no affectedPaths/);
  });
  it('rejects two new specs that overlap each other', () => {
    const r = appendLimbs({ limbs: [] }, null, [spec({ affectedPaths: ['src/x/'] }), spec({ limb: 'delta', affectedPaths: ['src/x/y.js'] })], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/delta overlaps owned paths of limb gamma/);
  });
  it('does not mutate its inputs', () => {
    const frozen = JSON.parse(JSON.stringify(plan));
    appendLimbs(plan, null, [spec({ affectedPaths: ['src/new.js'] })], ctx);
    expect(plan).toEqual(frozen);
  });
  it('warns (does not refuse) when the worktree name is longer than 33 chars', () => {
    const r = appendLimbs({ limbs: [] }, null, [spec({ limb: 'a-rather-long-limb-name-x', affectedPaths: ['src/n.js'] })], ctx);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/observed truncated/);
  });
});

describe('unusable paths are refused, never dropped (fast-profile drops them from the overlap check)', () => {
  const ctx = { parentRoot: '/repo', repoShort: 'demo' };
  const active = { limbs: [oldRow('alpha', ['plugins/artibot/lib/'])] };
  const run = { lanes: { alpha: { state: 'active' } } };
  const spec = (affectedPaths) => ({ limb: 'gamma', taskIds: ['gamma'], affectedPaths, wave: 25, rolling: true });

  it.each([['.'], ['./'], ['../x'], ['/abs'], ['C:/repo/x'], ['~/x']])('new --path %s is refused even next to an active limb', (bad) => {
    const r = appendLimbs(active, run, [spec([bad])], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`unusable affectedPaths ${JSON.stringify([bad])}`);
  });

  it('a mixed list (one good, one root-only) is refused, naming only the bad entry', () => {
    const r = appendLimbs({ limbs: [] }, null, [spec(['src/ok.js', '.'])], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unusable affectedPaths ["."]');
  });

  it.each([[['.']], [['../x']], [[null]]])('existing un-landed row with affectedPaths %j is ownership unknown', (paths) => {
    const plan = { limbs: [{ ...oldRow('legacy', []), affectedPaths: paths }] };
    const r = appendLimbs(plan, { lanes: { legacy: 'active' } }, [spec(['src/new.js'])], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/limb legacy \(lane state active\) has unusable affectedPaths .* ownership unknown/);
  });

  it('a landed row with an unusable claim no longer blocks', () => {
    const plan = { limbs: [{ ...oldRow('legacy', []), affectedPaths: ['.'] }] };
    expect(appendLimbs(plan, { lanes: { legacy: 'done' } }, [spec(['src/new.js'])], ctx).ok).toBe(true);
  });

  it('regression: a concrete path next to an unrelated active limb is still accepted', () => {
    expect(appendLimbs(active, run, [spec(['plugins/artibot/scripts/x.mjs'])], ctx).ok).toBe(true);
  });

  it('CLI: --path . against an active limb exits 1 and writes nothing', () => {
    const parent = seed({ lanes: { alpha: { state: 'active' } } });
    const before = fs.readFileSync(planFile(parent));
    const c = collect();
    expect(main(['--parent', parent, '--limb', 'gamma', '--path', '.', '--wave', '25'], c.io)).toBe(1);
    expect(c.stderr()).toMatch(/plan-append refused: limb gamma: unusable affectedPaths \["\."\]/);
    expect(fs.readFileSync(planFile(parent)).equals(before)).toBe(true);
    expect(fs.existsSync(bakFile(parent))).toBe(false);
  });
});

describe('task ids are not assigned twice', () => {
  const ctx = { parentRoot: '/repo', repoShort: 'demo' };
  const plan = { limbs: [oldRow('alpha', ['src/alpha/'])] };
  const spec = { limb: 'gamma', taskIds: ['alpha'], affectedPaths: ['src/gamma.js'], wave: 25, rolling: true };

  it('refuses a task id already carried by an un-landed limb', () => {
    const r = appendLimbs(plan, { lanes: { alpha: 'active' } }, [spec], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/task alpha is already assigned to limb alpha \(lane state active/);
  });
  it('allows re-using the task id of a landed limb', () => {
    expect(appendLimbs(plan, { lanes: { alpha: 'done' } }, [spec], ctx).ok).toBe(true);
  });
});

describe('task ids are compared and stored normalised (normalizeTaskId)', () => {
  const ctx = { parentRoot: '/repo', repoShort: 'demo' };
  const t1Row = (taskIds) => ({ ...oldRow('alpha', ['src/alpha/']), taskIds });
  const spec = (taskIds, over = {}) => ({ limb: 'gamma', taskIds, affectedPaths: ['src/gamma.js'], wave: 25, rolling: true, ...over });
  const active = { lanes: { alpha: 'active' } };

  it.each([[' T1'], ['T1 '], ['\tT1\n']])('refuses %j when an un-landed limb holds T1', (padded) => {
    const r = appendLimbs({ limbs: [t1Row(['T1'])] }, active, [spec([padded])], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/task T1 is already assigned to limb alpha \(lane state active/);
  });

  it('old plan: an un-landed row holding " T1" blocks a new "T1"', () => {
    const r = appendLimbs({ limbs: [t1Row([' T1'])] }, active, [spec(['T1'])], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/task T1 is already assigned to limb alpha/);
  });

  it('old plan: a row whose taskIds are all blank counts as its limb name (next-wave rule)', () => {
    const r = appendLimbs({ limbs: [t1Row(['  '])] }, active, [spec(['alpha'])], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/task alpha is already assigned to limb alpha/);
  });

  it('stores the trimmed id on the new row', () => {
    const r = appendLimbs({ limbs: [] }, null, [spec([' g1 ', 'g2'])], ctx);
    expect(r.ok).toBe(true);
    expect(r.added[0].taskIds).toEqual(['g1', 'g2']);
  });

  it('two new specs in one call collide on a padded id', () => {
    const r = appendLimbs({ limbs: [] }, null, [spec(['T1']), spec([' T1'], { limb: 'delta', affectedPaths: ['src/delta.js'] })], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/limb delta task T1 is already assigned to limb gamma/);
  });

  it('a landed row holding " T1" does not block "T1"', () => {
    expect(appendLimbs({ limbs: [t1Row([' T1'])] }, { lanes: { alpha: 'done' } }, [spec(['T1'])], ctx).ok).toBe(true);
  });

  it('CLI: --task " T1" / "T1 " against an active T1 exits 1, plan.json byte-identical, no .bak', () => {
    const plan = { runId: 'split-demo', repoShort: 'demo', limbs: [t1Row(['T1'])] };
    for (const padded of [' T1', 'T1 ']) {
      const parent = seed({ planText: `${JSON.stringify(plan, null, 2)}\n`, lanes: { alpha: { state: 'active' } } });
      const before = fs.readFileSync(planFile(parent));
      const c = collect();
      expect(main(['--parent', parent, '--limb', 'gamma', '--task', padded, '--path', 'src/gamma.js', '--wave', '27'], c.io)).toBe(1);
      expect(c.stderr()).toMatch(/^plan-append refused: limb gamma task T1 is already assigned to limb alpha \(lane state active/);
      expect(fs.readFileSync(planFile(parent)).equals(before)).toBe(true);
      expect(fs.existsSync(bakFile(parent))).toBe(false);
    }
  });

  it('existing rows are not rewritten: an unrelated append keeps " T1" byte-for-byte', () => {
    const plan = { runId: 'split-demo', repoShort: 'demo', limbs: [t1Row([' T1'])] };
    const parent = seed({ planText: JSON.stringify(plan), lanes: { alpha: { state: 'active' } } });
    runAppend(args(parent, ['--task', ' g1']));
    const after = JSON.parse(fs.readFileSync(planFile(parent), 'utf-8'));
    expect(after.limbs[0].taskIds).toEqual([' T1']);
    expect(after.limbs[1].taskIds).toEqual(['g1']);
  });
});

describe('Windows name aliases are the same owned file (fast-profile inspectPath)', () => {
  const ctx = { parentRoot: '/repo', repoShort: 'demo' };
  const plan = { limbs: [oldRow('alpha', ['src/foo.js'])] };
  const spec = (p) => ({ limb: 'gamma', taskIds: ['gamma'], affectedPaths: [p], wave: 27, rolling: true });

  it.each([['src/foo.js.'], ['src/foo.js '], ['SRC/Foo.JS'], ['src./foo.js'], ['src /foo.js']])('%j overlaps an active limb owning src/foo.js', (alias) => {
    const r = appendLimbs(plan, { lanes: { alpha: 'active' } }, [spec(alias)], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gamma overlaps owned paths of limb alpha \(lane state active/);
  });

  it('a segment of only dots is an unusable claim, not a dropped one', () => {
    const r = appendLimbs(plan, { lanes: { alpha: 'active' } }, [spec('src/.../x.js')], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unusable affectedPaths ["src/.../x.js"]');
  });
});

describe('one normalisation for both scripts', () => {
  const RAW = [' T1', 'T1 ', '\tT2\n', 'T 3', 'T4'];

  it('plan-append stores and next-wave counts exactly normalizeTaskId(raw)', () => {
    const expected = RAW.map(normalizeTaskId);
    const stored = RAW.map((raw, i) => appendLimbs({ limbs: [] }, null, [{ limb: `l${i}`, taskIds: [raw], affectedPaths: [`src/l${i}.js`], wave: 1, rolling: false }], { parentRoot: '/repo', repoShort: 'demo' }).added[0].taskIds[0]);
    const counted = computeNextWave({ limbs: RAW.map((raw, i) => ({ limb: `l${i}`, taskIds: [raw] })) }, null).remaining.map((r) => r.taskId);
    expect(stored).toEqual(expected);
    expect(counted).toEqual(['T1', 'T2', 'T 3', 'T4']);
    expect(new Set(stored)).toEqual(new Set(counted));
  });
});

describe('single read of plan.json', () => {
  it('parses the same bytes it backs up (BOM kept in .bak, tolerated by the parse)', () => {
    const plan = { runId: 'r', repoShort: 'demo', limbs: [] };
    const parent = seed({ planText: `\uFEFF${JSON.stringify(plan)}` });
    const original = fs.readFileSync(planFile(parent));
    runAppend(args(parent));
    expect(fs.readFileSync(bakFile(parent)).equals(original)).toBe(true);
    expect(JSON.parse(fs.readFileSync(planFile(parent), 'utf-8')).limbs.map((l) => l.limb)).toEqual(['gamma']);
  });
  it('a non-object plan.json is refused as malformed', () => {
    const c = collect();
    expect(main(['--parent', seed({ planText: '[]' }), '--limb', 'gamma', '--path', 'src/g.js', '--wave', '2'], c.io)).toBe(1);
    expect(c.stderr()).toMatch(/plan\.json malformed: .*is not a JSON object/);
  });
});

describe('old-run compatibility', () => {
  it('appends to a plan without wave/rolling/schema_version; old rows keep their content', () => {
    const parent = seed();
    const before = JSON.parse(fs.readFileSync(planFile(parent), 'utf-8'));
    expect(before.limbs.every((l) => !('wave' in l) && !('rolling' in l))).toBe(true);
    runAppend(args(parent, ['--task', 'g1', '--task', 'g2']));
    const after = JSON.parse(fs.readFileSync(planFile(parent), 'utf-8'));
    expect(after.limbs.slice(0, 2)).toEqual(before.limbs);
    expect(after.runId).toBe(before.runId);
    expect(after.base).toBe(before.base);
    const row = after.limbs[2];
    expect(row).toEqual({
      limb: 'gamma',
      worktreeName: 'split-demo-gamma',
      worktreePath: path.join(path.resolve(parent), '.claude', 'worktrees', 'split-demo-gamma'),
      branch: 'worktree-split-demo-gamma',
      taskIds: ['g1', 'g2'],
      affectedPaths: ['src/gamma.js'],
      wave: 25,
      rolling: false,
    });
    expect(row).not.toHaveProperty('forkPoint');
  });

  it('keeps an existing schema_version as-is', () => {
    const plan = { runId: 'r', repoShort: 'demo', schema_version: 7, limbs: [] };
    const parent = seed({ planText: JSON.stringify(plan) });
    runAppend(args(parent));
    expect(JSON.parse(fs.readFileSync(planFile(parent), 'utf-8')).schema_version).toBe(7);
  });

  it('defaults taskIds to the limb name', () => {
    const parent = seed();
    const r = runAppend(args(parent, ['--dry-run']));
    expect(r.added[0].taskIds).toEqual(['gamma']);
  });
});

describe('CLI smoke (spawned)', () => {
  const run = (argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf-8', windowsHide: true, timeout: 30000 });

  it('exit 0 with JSON on success', () => {
    const parent = seed();
    const r = run(['--parent', parent, '--limb', 'gamma', '--path', 'src/gamma.js', '--wave', '25', '--rolling', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, dryRun: false });
    expect(out.added[0]).toMatchObject({ limb: 'gamma', wave: 25, rolling: true });
    expect(fs.existsSync(bakFile(parent))).toBe(true);
  });

  it('exit 1 with a one-line reason on stderr when refused', () => {
    const parent = seed();
    const before = fs.readFileSync(planFile(parent));
    const r = run(['--parent', parent, '--limb', 'alpha', '--path', 'src/zz.js', '--wave', '2']);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toMatch(/^plan-append refused: limb alpha already exists/);
    expect(r.stdout).toBe('');
    expect(fs.readFileSync(planFile(parent)).equals(before)).toBe(true);
    expect(fs.existsSync(bakFile(parent))).toBe(false);
  });
});
