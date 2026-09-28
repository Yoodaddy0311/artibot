/**
 * `scripts/split/next-wave.mjs` — read-only remainder report for a run.
 *
 * The denominator pin (`requested === completed + remaining.length`) is
 * asserted on every fixture, AND `requested` is compared with an independent
 * per-fixture count, so a source dropped from both sides at once (which the
 * identity alone would not see) still goes red.
 *
 * `planWaveIndex` in the report is a 0-based index into `plan.plan.waves`,
 * never the campaign `wave` number a limb row carries.
 *
 * What this file cannot see (rules §9): live plans (the fixtures are the
 * Codex SP-04 shape, 3 tasks / cap 2, plus serial and legacy variants) and
 * whether a leader actually assigns what `nextWave` lists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeNextWave, main, parseArgs } from '../../scripts/split/next-wave.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'split', 'next-wave.mjs');

const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'next-wave-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const row = (limb, taskIds = [limb], extra = {}) => ({ limb, taskIds, affectedPaths: [`src/${limb}.js`], ...extra });
const lanes = (states) => ({ lanes: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { state: v }])) });

/** Codex SP-04 reproduction: 3 independent tasks, cap 2 → [[alpha,beta],[gamma]]; first wave became limbs. */
const SP04 = {
  runId: 'split-sp04',
  limbs: [row('alpha'), row('beta')],
  plan: { requestedTaskCount: 3, waves: [{ taskIds: ['alpha', 'beta'] }, { taskIds: ['gamma'] }], serial: [] },
};

/** Serial fixture: two waves plus one serial task. Independent total = 4. */
const SERIAL = {
  runId: 'split-serial',
  limbs: [row('alpha'), row('beta')],
  plan: {
    requestedTaskCount: 4,
    waves: [{ taskIds: ['alpha', 'beta'] }, { taskIds: ['gamma'] }],
    serial: [{ taskId: 'delta', reason: 'worktree-ineligible' }],
  },
};

/** Every fixture with its independently counted requested total. */
const FIXTURES = [
  ['sp04 nothing landed', SP04, null, 3],
  ['sp04 first wave landed', SP04, lanes({ alpha: 'done', beta: 'done' }), 3],
  ['serial nothing landed', SERIAL, null, 4],
  ['serial partly landed', SERIAL, lanes({ alpha: 'done' }), 4],
  ['rolling limb outside the saved plan', { ...SP04, limbs: [...SP04.limbs, row('extra', ['extra'], { wave: 25, rolling: true })] }, lanes({ extra: 'done' }), 4],
  ['legacy plan without plan key', { runId: 'old', limbs: [row('alpha'), row('beta')] }, lanes({ alpha: 'done' }), 2],
];

describe('denominator pin', () => {
  it.each(FIXTURES)('%s: requested === completed + remaining.length and equals the independent total', (_name, plan, run, total) => {
    const r = computeNextWave(plan, run);
    expect(r.requested).toBe(total);
    expect(r.requested).toBe(r.completed + r.remaining.length);
    expect(r.complete).toBe(r.remaining.length === 0 && !r.notes.some((n) => /unmeasured|mismatch/.test(n)));
  });
});

describe('SP-04 reproduction (0-based wave index)', () => {
  it('first wave assigned, nothing landed → nextWave is plan.waves[1] = [gamma]', () => {
    const r = computeNextWave(SP04, null);
    expect(r.nextWave).toEqual({ planWaveIndex: 1, taskIds: ['gamma'] });
    expect(r.remaining).toEqual([
      { taskId: 'alpha', status: 'in-flight', planWaveIndex: 0, limb: 'alpha' },
      { taskId: 'beta', status: 'in-flight', planWaveIndex: 0, limb: 'beta' },
      { taskId: 'gamma', status: 'unassigned', planWaveIndex: 1, limb: null },
    ]);
    expect(r.complete).toBe(false);
  });

  it('alpha, beta lane-done → completed 2, remaining 1, complete false', () => {
    const r = computeNextWave(SP04, lanes({ alpha: 'done', beta: 'done' }));
    expect(r).toMatchObject({ runId: 'split-sp04', requested: 3, completed: 2, complete: false });
    expect(r.remaining).toEqual([{ taskId: 'gamma', status: 'unassigned', planWaveIndex: 1, limb: null }]);
  });

  it('all done → complete true, nextWave null', () => {
    const plan = { ...SP04, limbs: [...SP04.limbs, row('gamma')] };
    const r = computeNextWave(plan, lanes({ alpha: 'done', beta: 'done', gamma: 'done' }));
    expect(r).toMatchObject({ requested: 3, completed: 3, remaining: [], nextWave: null, complete: true });
  });

  it('a lane state other than done (or outside the allowlist) is not landed', () => {
    const r = computeNextWave(SP04, lanes({ alpha: 'active', beta: 'dispatched' }));
    expect(r.completed).toBe(0);
  });
});

describe('serial', () => {
  it('reports serial tasks as remaining serial, never schedules them, and notes it', () => {
    const r = computeNextWave(SERIAL, lanes({ alpha: 'done', beta: 'done' }));
    expect(r.remaining).toEqual([
      { taskId: 'gamma', status: 'unassigned', planWaveIndex: 1, limb: null },
      { taskId: 'delta', status: 'serial', planWaveIndex: null, limb: null },
    ]);
    expect(r.nextWave).toEqual({ planWaveIndex: 1, taskIds: ['gamma'] });
    expect(r.notes.join('\n')).toMatch(/serial tasks are never auto-scheduled/);
  });

  it('a serial task assigned to a limb is in-flight', () => {
    const plan = { ...SERIAL, limbs: [...SERIAL.limbs, row('delta')] };
    const r = computeNextWave(plan, null);
    expect(r.remaining.find((x) => x.taskId === 'delta')).toEqual({ taskId: 'delta', status: 'in-flight', planWaveIndex: null, limb: 'delta' });
  });
});

describe('earlier-wave warning', () => {
  it('notes unfinished earlier-wave tasks without changing nextWave', () => {
    const r = computeNextWave(SP04, lanes({ alpha: 'done' }));
    expect(r.nextWave).toEqual({ planWaveIndex: 1, taskIds: ['gamma'] });
    const note = r.notes.find((n) => n.startsWith('earlier plan wave(s)'));
    expect(note).toMatch(/1 unfinished task\(s\) \(beta\).*no dependency data.*capacity or for a dependency/);
  });
  it('is absent once every earlier-wave task is landed', () => {
    const r = computeNextWave(SP04, lanes({ alpha: 'done', beta: 'done' }));
    expect(r.notes.some((n) => n.startsWith('earlier plan wave(s)'))).toBe(false);
  });
});

describe('planWaveIndex is not the row campaign wave', () => {
  it('a rolling row with wave 25 outside the saved plan reports planWaveIndex null', () => {
    const plan = { ...SP04, limbs: [...SP04.limbs, row('extra', ['extra'], { wave: 25, rolling: true })] };
    const r = computeNextWave(plan, null);
    expect(r.remaining.find((x) => x.taskId === 'extra')).toEqual({ taskId: 'extra', status: 'in-flight', planWaveIndex: null, limb: 'extra' });
    expect(r.remaining.every((x) => !Object.hasOwn(x, 'wave'))).toBe(true);
    expect(Object.keys(r.nextWave)).toEqual(['planWaveIndex', 'taskIds']);
  });
});

describe('old-run compatibility', () => {
  it('plan without the plan key: counts limbs only, never complete, notes the gap', () => {
    const plan = { runId: 'old', limbs: [row('alpha'), row('beta')] };
    const r = computeNextWave(plan, lanes({ alpha: 'done', beta: 'done' }));
    expect(r).toMatchObject({ requested: 2, completed: 2, remaining: [], nextWave: null, complete: false });
    expect(r.notes.join('\n')).toMatch(/no saved plan\.waves.*unmeasured/);
  });

  it('plan.plan without waves or serial is unmeasured', () => {
    expect(computeNextWave({ limbs: [], plan: { serial: [] } }, null).complete).toBe(false);
    expect(computeNextWave({ limbs: [], plan: { waves: [] } }, null).complete).toBe(false);
  });

  it('requestedTaskCount larger than waves+serial (planner dropped tasks) is unmeasured', () => {
    const plan = { ...SP04, limbs: [row('alpha'), row('beta')], plan: { requestedTaskCount: 3, waves: [{ taskIds: ['alpha', 'beta'] }], serial: [] } };
    const r = computeNextWave(plan, lanes({ alpha: 'done', beta: 'done' }));
    expect(r.remaining).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.notes.join('\n')).toMatch(/requestedTaskCount is 3 but waves\+serial hold 2/);
  });

  it('rows without wave/rolling/taskIds and a run.json without lanes do not throw', () => {
    const plan = { limbs: [{ limb: 'alpha' }, null, { nope: 1 }], plan: { waves: [{ taskIds: ['alpha'] }], serial: [] } };
    const r = computeNextWave(plan, { runId: 'x', stage: 'dispatched' });
    expect(r).toMatchObject({ runId: null, requested: 1, completed: 0 });
    expect(r.notes.join('\n')).toMatch(/alpha has no taskIds/);
  });

  it('tolerates garbage input without throwing', () => {
    expect(() => computeNextWave({}, null)).not.toThrow();
    expect(() => computeNextWave({ limbs: 'x', plan: { waves: [null, { taskIds: 'y' }], serial: [null, 3] } }, [])).not.toThrow();
  });
});

describe('CLI', () => {
  const seed = (plan, run) => {
    const parent = mkTmp();
    const dir = path.join(parent, '.artibot', 'split');
    fs.mkdirSync(dir, { recursive: true });
    if (plan !== undefined) fs.writeFileSync(path.join(dir, 'plan.json'), typeof plan === 'string' ? plan : JSON.stringify(plan));
    if (run !== undefined) fs.writeFileSync(path.join(dir, 'run.json'), typeof run === 'string' ? run : JSON.stringify(run));
    return parent;
  };
  const spawn = (argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf-8', windowsHide: true, timeout: 30000 });

  it('parseArgs rejects unknown flags (no write option exists)', () => {
    expect(() => parseArgs(['--write'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--parent'])).toThrow(/requires a value/);
  });

  it('spawned: exit 0 + JSON, and plan/run bytes are unchanged', () => {
    const parent = seed(SP04, lanes({ alpha: 'done', beta: 'done' }));
    const dir = path.join(parent, '.artibot', 'split');
    const before = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]);
    const r = spawn(['--parent', parent]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ runId: 'split-sp04', requested: 3, completed: 2, nextWave: { planWaveIndex: 1, taskIds: ['gamma'] }, complete: false });
    expect(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')])).toEqual(before);
  });

  it('spawned: missing plan.json → exit 1 with reason', () => {
    const r = spawn(['--parent', seed()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/next-wave: plan\.json missing/);
  });

  it('malformed plan.json / run.json → exit 1 with reason', () => {
    const c1 = { out: [], err: [] };
    expect(main(['--parent', seed('{bad')], { stdout: (s) => c1.out.push(s), stderr: (s) => c1.err.push(s) })).toBe(1);
    expect(c1.err.join('')).toMatch(/plan\.json malformed/);
    const c2 = { out: [], err: [] };
    expect(main(['--parent', seed(SP04, '{bad')], { stdout: (s) => c2.out.push(s), stderr: (s) => c2.err.push(s) })).toBe(1);
    expect(c2.err.join('')).toMatch(/run\.json malformed/);
  });

  it('run.json absent → exit 0, nothing landed', () => {
    const out = [];
    expect(main(['--parent', seed(SP04)], { stdout: (s) => out.push(s), stderr: () => {} })).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ completed: 0, requested: 3 });
  });
});
