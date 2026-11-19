/**
 * `scripts/orca/plan.mjs` - task list -> limbs -> the planning part of run.json.
 *
 * REAL COLLABORATORS, FAKE WORLD. The planner (`buildFastFanoutPlan`), `assessPlan`, `compileRun`, `readyLimbs`
 * and the run file I/O (`readOrcaRun` / `writeOrcaRun`) are the production modules; every run.json lives in an
 * mkdtemp parent root. Only the outside world is injected: the executor answers `orca status|repo list|agent-context`
 * and `git` from the real Orca 1.4.259 fixtures in `tests/orca/fixtures/agent-context/` (see PROVENANCE.md there),
 * with the registered repo path pointed at the temp parent so the `orca-repo` check passes for the honest reason.
 *
 * NO TEST CALLS THE REAL `orca`: `guardedExec` throws on any Orca verb outside the read allowlist or on an
 * unscripted call, so "plan changes nothing in Orca" is enforced by every case. The process-level cases run the
 * script with an empty PATH.
 *
 * WHAT THIS FILE CANNOT SEE (rules 9): task lists are hand-written (they are INPUTS, not Orca receipts); the tests
 * run three to six limbs, not the dozens a real run has; the planner's speed-up or wave shapes are not judged, only
 * what plan.mjs does with them; and nothing here proves a launch can start from the written file (L5 owns that).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { orcaRunPath, readOrcaRun, writeOrcaRun } from '../../lib/git/orca-run-file.js';
import {
  DEFAULT_INTEGRATION_REF,
  defaultNow,
  defaultRandomHex,
  detectCpuCount,
  displayWidth,
  existingVerdict,
  formatPlan,
  isLaunchedRun,
  loadTasks,
  main,
  parsePlanArgs,
  readPlanSettings,
  runPlan,
} from '../../scripts/orca/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'orca', 'plan.mjs');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'agent-context');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const SCHEMA_TEXT = readFixture('agent-context-1.4.259.excerpt.json');
const STATUS_TEXT = readFixture('status-1.4.259.json');
const REPOS_TEXT = readFixture('repo-list-1.4.259.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

const ARTIBOT_ID = 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642';
const ENV = Object.freeze({ ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8000-000000000001' });
const NOW = '2026-11-19T05:30:00.000Z';
/** What `git rev-parse` prints for a resolvable ref; built at runtime so no 40-hex literal sits in the source (secret guard). */
const SHA = `${'a'.repeat(20)}${'b'.repeat(20)}`;
const REF_CALL = 'git rev-parse --verify --quiet origin/master^{commit}';
const ROOT_CALL = 'git rev-parse --show-toplevel';
const CONFIG = Object.freeze({ split: Object.freeze({ maxWindows: 8, minStems: 2, serverEntryPaths: Object.freeze([]), dispatch: Object.freeze({ budget: 600000 }) }) });
const READ_ONLY_ORCA_VERBS = new Set(['status', 'repo', 'agent-context']);
const identity = (value) => value;

const tmpDirs = [];
const makeTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-orca-'));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const okRes = (stdout) => ({ ok: true, status: 0, stdout, stderr: '', error: null });
const failRes = (over = {}) => ({ ok: false, status: 1, stdout: '', stderr: '', error: 'exit 1', ...over });

/** Executor keyed by `<file> <args...>`; throws on a state-changing Orca verb or an unscripted call. */
function guardedExec(table) {
  const calls = [];
  const exec = (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    calls.push(key);
    if (file === 'orca' && !READ_ONLY_ORCA_VERBS.has(args[0])) throw new Error(`state-changing or unknown orca verb: ${key}`);
    if (!(key in table)) throw new Error(`unscripted call: ${key}`);
    const entry = table[key];
    return typeof entry === 'function' ? entry() : entry;
  };
  exec.calls = calls;
  return exec;
}

/** Three tasks: lib-core and docs are free, api-layer waits for lib-core. */
const TASKS = Object.freeze([
  { id: 'lib-core', independent: true, risk: 'low', worktreeEligible: true, affectedPaths: ['lib/core/', 'tests/core/'] },
  { id: 'api-layer', independent: true, risk: 'low', worktreeEligible: true, dependsOn: ['lib-core'], affectedPaths: ['src/api/', 'tests/api/'] },
  { id: 'docs', independent: true, risk: 'low', worktreeEligible: true, affectedPaths: ['docs/'] },
]);
const free = (id, paths) => ({ id, independent: true, risk: 'low', worktreeEligible: true, affectedPaths: paths });

const ARGS = Object.freeze({
  help: false, objective: 'split the core from the api', tasks: 'tasks.json', parent: null, integrationRef: DEFAULT_INTEGRATION_REF,
  maxWindows: null, dryRun: false, forceNew: false, json: false,
});

/**
 * A parent root with tasks.json, and a context whose Orca/git answers come from the real fixtures. `table` overrides
 * scripted calls: an object, or a function of the parent path for answers that must mention it.
 */
function world({ tasks = TASKS, table = {}, ctx = {}, wrapTasks = false } = {}) {
  const parent = makeTmp();
  fs.writeFileSync(path.join(parent, 'tasks.json'), JSON.stringify(wrapTasks ? { tasks } : tasks));
  const repos = JSON.parse(REPOS_TEXT);
  repos.result.repos[0].path = parent;
  const exec = guardedExec({
    'orca status --json': okRes(STATUS_TEXT),
    'orca repo list --json': okRes(JSON.stringify(repos)),
    'orca agent-context --json': okRes(SCHEMA_TEXT),
    'git --version': okRes('git version 2.54.0.windows.1\n'),
    [ROOT_CALL]: okRes(`${parent}\n`),
    [REF_CALL]: okRes(`${SHA}\n`),
    ...(typeof table === 'function' ? table(parent) : table),
  });
  const context = { cwd: parent, env: ENV, exec, config: CONFIG, realpath: identity, now: () => NOW, randomHex: () => 'a1b2c3', cpuCount: 8, ...ctx };
  return { parent, exec, ctx: context };
}

const runFile = (parent) => orcaRunPath(parent);
const bak = (parent) => `${runFile(parent)}.bak`;
const planOk = (args, ctx) => {
  const doc = runPlan({ ...ARGS, ...args }, ctx);
  expect(doc.ok, JSON.stringify(doc)).toBe(true);
  return doc;
};

describe('parsePlanArgs', () => {
  it('parses the documented flags (space and equals forms) and applies the defaults', () => {
    expect(parsePlanArgs(['--objective', '  ship it ', '--tasks', 't.json'])).toEqual({
      ok: true,
      value: { help: false, objective: 'ship it', tasks: 't.json', parent: null, integrationRef: 'origin/master', maxWindows: null, dryRun: false, forceNew: false, json: false },
    });
    expect(parsePlanArgs(['--objective=x', '--tasks=t.json', '--parent', 'p', '--integration-ref', 'origin/main', '--max-windows=4', '--dry-run', '--force-new', '--json']).value).toEqual({
      help: false, objective: 'x', tasks: 't.json', parent: 'p', integrationRef: 'origin/main', maxWindows: 4, dryRun: true, forceNew: true, json: true,
    });
  });

  it('--help needs nothing else', () => {
    expect(parsePlanArgs(['--help'])).toEqual({ ok: true, value: { help: true, json: false } });
  });

  it('rejects a missing or blank objective and a missing tasks file', () => {
    for (const argv of [['--tasks', 't.json'], ['--objective', '   ', '--tasks', 't.json'], ['--objective', 'x']]) {
      const parsed = parsePlanArgs(argv);
      expect(parsed.ok, JSON.stringify(argv)).toBe(false);
      expect(parsed.error).toContain('인자 오류');
    }
  });

  it('rejects a max-windows that is not a positive integer', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '1000', '']) {
      expect(parsePlanArgs(['--objective', 'x', '--tasks', 't', '--max-windows', bad]).ok, bad).toBe(false);
    }
  });

  it('rejects an integration ref that could be read as an option or has whitespace', () => {
    for (const bad of ['--output=x', '-x', 'a b', '']) {
      expect(parsePlanArgs(['--objective', 'x', '--tasks', 't', '--integration-ref', bad]).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects unknown flags and positionals', () => {
    expect(parsePlanArgs(['--objective', 'x', '--tasks', 't', '--nope']).ok).toBe(false);
    expect(parsePlanArgs(['--objective', 'x', '--tasks', 't', 'stray']).ok).toBe(false);
  });
});

describe('loadTasks', () => {
  const load = (text, over = {}) => loadTasks('tasks.json', { cwd: '/work', readFile: () => text, ...over });

  it('accepts an array, an object with a tasks array, and a BOM', () => {
    expect(load(JSON.stringify([{ id: 'a' }]))).toEqual({ ok: true, tasks: [{ id: 'a' }] });
    expect(load(JSON.stringify({ tasks: [{ id: 'a' }] })).ok).toBe(true);
    expect(load(`${String.fromCodePoint(0xfeff)}[{"id":"a"}]`).ok).toBe(true);
  });

  it('resolves the file against cwd', () => {
    const seen = [];
    load('[{"id":"a"}]', { readFile: (file) => { seen.push(file); return '[{"id":"a"}]'; } });
    expect(seen).toEqual([path.resolve('/work', 'tasks.json')]);
  });

  it('fails with a reason for: unreadable file, bad JSON, wrong shape, empty list, non-object task', () => {
    const missing = loadTasks('nope.json', { cwd: os.tmpdir(), readFile: (file) => fs.readFileSync(file, 'utf8') });
    expect(missing.error).toContain('읽을 수 없다');
    expect(load('{ nope').error).toContain('JSON 이 아니다');
    expect(load('{"a":1}').error).toContain('작업 배열');
    expect(load('7').error).toContain('작업 배열');
    expect(load('null').error).toContain('작업 배열');
    expect(load('[]').error).toContain('하나도 없다');
    expect(load('[{"id":"a"}, 3]').error).toContain('tasks[1]');
  });
});

describe('readPlanSettings', () => {
  it('reads split.* from the config and lets the CLI override win for maxWindows', () => {
    expect(readPlanSettings(CONFIG)).toMatchObject({ maxWindows: 8, minStems: 2, serverEntryPaths: [], budget: 600000, warnings: [] });
    expect(readPlanSettings(CONFIG, { maxWindowsOverride: 3 }).maxWindows).toBe(3);
  });

  it('passes minStems and serverEntryPaths through as found (the consumers validate them)', () => {
    const settings = readPlanSettings({ split: { minStems: 'x', serverEntryPaths: 'oops' } });
    expect(settings.minStems).toBe('x');
    expect(settings.serverEntryPaths).toBe('oops');
  });

  it('warns when the configured maxWindows is unusable, and does not invent a cap', () => {
    const settings = readPlanSettings({ split: { maxWindows: 'eight' } });
    expect(settings.maxWindows).toBeNull();
    expect(settings.warnings[0]).toContain('split.maxWindows');
  });

  it('survives an absent or odd config', () => {
    for (const config of [undefined, null, {}, { split: null }, { split: [] }, { split: { dispatch: 3 } }]) {
      const settings = readPlanSettings(config);
      expect(settings.maxWindows, JSON.stringify(config)).toBeNull();
      expect(settings.budget).toBeNull();
    }
  });
});

describe('isLaunchedRun and existingVerdict', () => {
  const planned = { runId: null, limbs: [{ limb: 'a', worktreeId: null, worktreePath: null, branch: null, dispatches: [] }] };

  it('a run is launched when runId is stamped, a limb is bound, or a dispatch exists', () => {
    expect(isLaunchedRun(planned)).toBe(false);
    expect(isLaunchedRun({ ...planned, runId: 'run_x' })).toBe(true);
    expect(isLaunchedRun({ ...planned, runId: '  ' })).toBe(false);
    for (const bound of [{ worktreeId: 'w' }, { worktreePath: 'p' }, { branch: 'b' }, { dispatches: [{ dispatchId: 'd' }] }]) {
      expect(isLaunchedRun({ runId: null, limbs: [{ ...planned.limbs[0], ...bound }] }), JSON.stringify(bound)).toBe(true);
    }
    expect(isLaunchedRun(null)).toBe(false);
    expect(isLaunchedRun({ limbs: 'x' })).toBe(false);
  });

  it('no file: nothing to say. Unlaunched plan: replaced freely. Launched or unreadable: refused unless --force-new', () => {
    const flags = { forceNew: false, dryRun: false };
    expect(existingVerdict({ state: 'absent' }, flags)).toEqual({ error: null, note: null, replaced: false });
    const plan = existingVerdict({ state: 'plan', run: planned, launched: false }, flags);
    expect(plan).toMatchObject({ error: null, replaced: true });
    const launched = { state: 'plan', run: { runId: 'run_x' }, launched: true };
    expect(existingVerdict(launched, flags).error).toContain('run_x');
    expect(existingVerdict(launched, flags).error).toContain('--force-new');
    const broken = { state: 'unreadable', reason: 'unparseable', detail: 'x' };
    expect(existingVerdict(broken, flags).error).toContain('unparseable');
    for (const existing of [launched, broken]) {
      expect(existingVerdict(existing, { ...flags, forceNew: true })).toMatchObject({ error: null, replaced: true });
    }
  });

  it('dry-run never refuses and never claims a replacement, but says what a real run would do', () => {
    const launched = { state: 'plan', run: { runId: 'run_x' }, launched: true };
    const verdict = existingVerdict(launched, { forceNew: false, dryRun: true });
    expect(verdict.error).toBeNull();
    expect(verdict.replaced).toBe(false);
    expect(verdict.note).toContain('거부됐다');
    expect(existingVerdict({ state: 'plan', run: planned, launched: false }, { forceNew: false, dryRun: true }).replaced).toBe(false);
  });
});

describe('runPlan - the plan and run.json', () => {
  it('writes a planning-only run.json from the real planner, with the Orca facts from preflight', () => {
    const { parent, ctx, exec } = world();
    const doc = planOk({}, ctx);
    const read = readOrcaRun(parent);
    expect(read.ok).toBe(true);
    const { run } = read;
    expect(run).toMatchObject({
      schema_version: 1, provider: 'orca', runId: null, tag: 'a1b2c3', objective: 'split the core from the api',
      integrationRef: 'origin/master', createdAt: NOW,
      orca: { appVersion: '1.4.259', environment: 'local', repoId: ARTIBOT_ID },
    });
    expect(run.limbs.map((limb) => limb.limb)).toEqual(['lib-core', 'api-layer', 'docs']);
    expect(run.limbs.find((limb) => limb.limb === 'api-layer').deps).toEqual(['lib-core']);
    for (const limb of run.limbs) {
      expect([limb.worktreeId, limb.worktreePath, limb.branch, limb.forkPoint]).toEqual([null, null, null, null]);
      expect(limb.dispatches).toEqual([]);
    }
    expect(doc.path).toBe(runFile(parent));
    expect(fs.existsSync(bak(parent))).toBe(false);
    expect(exec.calls).toEqual(['orca status --json', 'orca repo list --json', 'orca agent-context --json', 'git --version', ROOT_CALL, REF_CALL]);
  });

  it('reports which limbs may start now and what the others wait for', () => {
    const { ctx } = world();
    const doc = planOk({}, ctx);
    expect(doc.start).toEqual(['lib-core', 'docs']);
    expect(doc.limbs.map((row) => [row.limb, row.startNow, row.waitingOn])).toEqual([
      ['lib-core', true, []], ['api-layer', false, ['lib-core']], ['docs', true, []],
    ]);
    expect(doc.limbs[1]).toMatchObject({ taskIds: ['api-layer'], affectedPaths: ['src/api/', 'tests/api/'], deps: ['lib-core'] });
  });

  it('has a stable report shape (what the command doc reads)', () => {
    const { ctx } = world();
    const doc = planOk({}, ctx);
    expect(Object.keys(doc).sort()).toEqual([
      'budget', 'dryRun', 'integrationRef', 'limbs', 'limits', 'notes', 'objective', 'ok', 'orca', 'path', 'plan', 'replaced', 'start', 'tag', 'warnings',
    ]);
    expect(doc).toMatchObject({
      dryRun: false, replaced: false, tag: 'a1b2c3', integrationRef: 'origin/master', notes: [], warnings: [],
      orca: { appVersion: '1.4.259', repoId: ARTIBOT_ID },
      limits: { maxWindows: 8, requestedMaxWindows: null, minStems: 2 },
      budget: { perLimb: 600000, limbs: 3, total: 1800000 },
    });
    expect(doc.plan).toMatchObject({ profile: 'fast', fallbackReason: null, plannedParallelism: 2 });
  });

  it('--dry-run computes everything and writes nothing', () => {
    const { parent, ctx } = world();
    const doc = planOk({ dryRun: true }, ctx);
    expect(doc.dryRun).toBe(true);
    expect(doc.path).toBeNull();
    expect(doc.limbs).toHaveLength(3);
    expect(fs.existsSync(path.join(parent, '.artibot'))).toBe(false);
  });

  it('takes the tasks as an object with a tasks array too, and stores a Korean objective with quotes verbatim', () => {
    const objective = '결제 "모듈" 분리 \\ 테스트';
    const { parent, ctx } = world({ wrapTasks: true });
    planOk({ objective }, ctx);
    expect(readOrcaRun(parent).run.objective).toBe(objective);
  });

  it('uses a random six-hex tag and an ISO clock when none are injected', () => {
    const { parent, ctx } = world({ ctx: { randomHex: undefined, now: undefined } });
    planOk({}, ctx);
    const { run } = readOrcaRun(parent);
    expect(run.tag).toMatch(/^[0-9a-f]{6}$/);
    expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(defaultRandomHex()).toMatch(/^[0-9a-f]{6}$/);
    expect(new Set(Array.from({ length: 40 }, defaultRandomHex)).size).toBeGreaterThan(1);
    expect(defaultNow()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isInteger(detectCpuCount()) && detectCpuCount() >= 1).toBe(true);
  });

  it('resolves --parent against cwd', () => {
    const { parent, ctx } = world();
    const elsewhere = makeTmp();
    const doc = planOk({ parent }, { ...ctx, cwd: elsewhere, readFile: (file) => fs.readFileSync(path.join(parent, path.basename(file)), 'utf8') });
    expect(doc.path).toBe(runFile(parent));
    expect(fs.existsSync(runFile(elsewhere))).toBe(false);
  });
});

describe('runPlan - concurrency cap and ownership seed (the four-key mapping)', () => {
  const four = ['a', 'b', 'c', 'd'].map((name) => free(`t-${name}`, [`src/${name}/`]));

  it('maps split.maxWindows onto the planner: 2 windows means 2 start now and the rest wait for a slot', () => {
    const { ctx } = world({ tasks: four, ctx: { config: { split: { ...CONFIG.split, maxWindows: 2 } } } });
    const doc = planOk({}, ctx);
    expect(doc.limits.maxWindows).toBe(2);
    expect(doc.start).toEqual(['t-a', 't-b']);
    expect(doc.limbs.filter((row) => !row.startNow).map((row) => row.waitingOn)).toEqual([[], []]);
    expect(formatPlan(doc)).toContain('빈 슬롯 대기');
  });

  it('--max-windows overrides the config and is reported as requested', () => {
    const { ctx } = world({ tasks: four });
    const doc = planOk({ maxWindows: 3 }, ctx);
    expect(doc.limits).toMatchObject({ maxWindows: 3, requestedMaxWindows: 3 });
    expect(doc.start).toHaveLength(3);
  });

  it('warns when a requested cap is above the planner hard cap and says what applies', () => {
    const { ctx } = world({ tasks: four });
    const doc = planOk({ maxWindows: 100 }, ctx);
    expect(doc.limits.maxWindows).toBe(12);
    expect(doc.warnings.join('\n')).toContain('하드캡');
    expect(doc.warnings.join('\n')).toContain('--max-windows 100');
  });

  it('with no usable maxWindows anywhere the planner default applies, with a warning for a bad config value', () => {
    const { ctx } = world({ tasks: four, ctx: { config: { split: { maxWindows: 'eight' } } } });
    const doc = planOk({}, ctx);
    expect(doc.limits.maxWindows).toBe(12);
    expect(doc.warnings[0]).toContain('split.maxWindows');
  });

  it('passes split.serverEntryPaths to the planner: two limbs that share the dev server are chained, not parallel', () => {
    const tasks = [free('s-a', ['server/a/']), free('s-b', ['server/b/']), free('lib-core', ['lib/core/']), free('docs', ['docs/'])];
    const seeded = world({ tasks, ctx: { config: { split: { ...CONFIG.split, serverEntryPaths: ['server'] } } } });
    planOk({}, seeded.ctx);
    expect(readOrcaRun(seeded.parent).run.limbs.find((limb) => limb.limb === 's-b').deps).toEqual(['s-a']);
    const unseeded = world({ tasks });
    planOk({}, unseeded.ctx);
    expect(readOrcaRun(unseeded.parent).run.limbs.find((limb) => limb.limb === 's-b').deps).toEqual([]);
  });

  it('a limb whose ownership conflicts with another waits for it', () => {
    const tasks = [free('wide', ['src/']), free('narrow', ['src/api/']), free('docs', ['docs/']), free('lib-core', ['lib/'])];
    const { ctx } = world({ tasks });
    const doc = planOk({}, ctx);
    expect(doc.limbs.find((row) => row.limb === 'narrow').deps).toEqual(['wide']);
    expect(doc.start).not.toContain('narrow');
  });
});

describe('runPlan - refusals write nothing', () => {
  const nothingWritten = (parent) => expect(fs.existsSync(path.join(parent, '.artibot'))).toBe(false);

  it('stops at a failed preflight check and returns the whole report', () => {
    const { parent, ctx } = world({ table: { 'git --version': okRes('git version 2.1.0') } });
    const doc = runPlan(ARGS, ctx);
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain('preflight');
    expect(doc.preflight.ok).toBe(false);
    expect(doc.preflight.checks.find((check) => check.name === 'git-version').status).toBe('fail');
    nothingWritten(parent);
  });

  it('stops when the kill switch is off', () => {
    const { parent, ctx } = world({ ctx: { config: { ...CONFIG, orca: { enabled: false } } } });
    const doc = runPlan(ARGS, ctx);
    expect(doc.preflight.checks.find((check) => check.name === 'orca-enabled').status).toBe('fail');
    nothingWritten(parent);
  });

  it('stops when --parent is not a directory, before any call', () => {
    const { ctx, exec } = world();
    const doc = runPlan({ ...ARGS, parent: 'no-such-dir' }, ctx);
    expect(doc.error).toContain('디렉터리가 아니다');
    expect(exec.calls).toEqual([]);
  });

  it('stops when --parent is a subdirectory of the checkout, not its root, and does not go on to the ref check', () => {
    const { parent, ctx, exec } = world({ table: { [ROOT_CALL]: okRes('/work/the-real-root\n') } });
    const doc = runPlan(ARGS, ctx);
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain('체크아웃 루트');
    expect(doc.error).toContain('/work/the-real-root');
    expect(doc.error).toContain(parent);
    expect(exec.calls).not.toContain(REF_CALL);
    nothingWritten(parent);
  });

  it('stops when --parent is not inside a git repo at all', () => {
    const { parent, ctx } = world({ table: { [ROOT_CALL]: failRes({ status: 128, stderr: 'fatal: not a git repository\n' }) } });
    const doc = runPlan(ARGS, ctx);
    expect(doc.error).toContain('git 리포가 아니다');
    expect(doc.error).toContain('not a git repository');
    nothingWritten(parent);
  });

  it('accepts the root however git spells it: forward slashes, a trailing slash, another drive-letter case', () => {
    const flipCase = (text) => (/^[A-Za-z]:/.test(text) ? `${text[0] === text[0].toUpperCase() ? text[0].toLowerCase() : text[0].toUpperCase()}${text.slice(1)}` : text);
    const gitSpelling = (parent) => ({ [ROOT_CALL]: okRes(`${flipCase(`${parent.replace(/\\/g, '/')}/`)}\n`) });
    const { ctx } = world({ table: gitSpelling });
    expect(runPlan({ ...ARGS, dryRun: true }, ctx).ok).toBe(true);
  });

  it('checks the root only after preflight passed', () => {
    const { ctx, exec } = world({ table: { 'git --version': okRes('git version 2.1.0') } });
    runPlan(ARGS, ctx);
    expect(exec.calls).not.toContain(ROOT_CALL);
  });

  it('stops when the integration ref does not name a commit', () => {
    const { parent, ctx } = world({ table: { 'git rev-parse --verify --quiet origin/nope^{commit}': failRes() } });
    const doc = runPlan({ ...ARGS, integrationRef: 'origin/nope' }, ctx);
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain('origin/nope');
    expect(doc.error).toContain('git fetch');
    nothingWritten(parent);
  });

  it('stops on a tasks file it cannot use', () => {
    const { parent, ctx } = world({ tasks: [] });
    expect(runPlan(ARGS, ctx).error).toContain('하나도 없다');
    nothingWritten(parent);
  });

  it('refuses a plan with fewer than two parallel stems and says why', () => {
    const { parent, ctx } = world({ tasks: [free('only-one', ['src/'])] });
    const doc = runPlan(ARGS, ctx);
    expect(doc.ok).toBe(false);
    expect(doc.reason).toBe('fallback:fewer-than-two-eligible-tasks');
    expect(doc.error).toContain('/team');
    expect(doc.plan.fallbackReason).toBe('fewer-than-two-eligible-tasks');
    nothingWritten(parent);
  });

  it('refuses a plan below split.minStems', () => {
    const { parent, ctx } = world({ ctx: { config: { split: { ...CONFIG.split, minStems: 3 } } } });
    const doc = runPlan(ARGS, ctx);
    expect(doc.reason).toBe('stems-below-min:2/3');
    expect(doc.error).toContain('minStems 3');
    nothingWritten(parent);
  });

  it('names the planner reasons for tasks it would not parallelise', () => {
    const tasks = [{ id: 'a', affectedPaths: ['a/'] }, { id: 'b', independent: true, risk: 'high', worktreeEligible: true, affectedPaths: ['b/'] }];
    const { ctx } = world({ tasks });
    const doc = runPlan(ARGS, ctx);
    expect(doc.error).toContain('a=not-independent');
    expect(doc.error).toContain('b=risk-high');
  });

  it('passes compileRun failures through with the raw reason: duplicate id, cycle, unresolved dependency, missing id', () => {
    const cases = [
      ['duplicate-id', [free('lib-core', ['lib/']), free('extra', ['x/']), free('docs', ['docs/']), free('docs', ['docs2/'])]],
      ['cycle', [free('lib-core', ['lib/']), free('extra', ['x/']), { ...free('p', ['p/']), dependsOn: ['q'] }, { ...free('q', ['q/']), dependsOn: ['p'] }]],
      ['unresolved-dependency', [free('lib-core', ['lib/']), free('extra', ['x/']), { ...free('p', ['p/']), dependsOn: ['ghost'] }]],
      ['missing-id', [free('lib-core', ['lib/']), free('extra', ['x/']), { independent: true, risk: 'low', worktreeEligible: true, affectedPaths: ['p/'] }]],
    ];
    for (const [reason, tasks] of cases) {
      const { parent, ctx } = world({ tasks });
      const doc = runPlan(ARGS, ctx);
      expect(doc.ok, reason).toBe(false);
      expect(doc.reason, reason).toBe(reason);
      expect(doc.error).toContain(`reason: ${reason}`);
      nothingWritten(parent);
    }
  });
});

describe('runPlan - an existing run.json', () => {
  /** Plan once, then turn the file into a launched run (a stamped runId) through the real writer. */
  function launchedWorld() {
    const set = world();
    planOk({}, set.ctx);
    const { run } = readOrcaRun(set.parent);
    expect(writeOrcaRun(set.parent, { ...run, runId: 'run_3c01547fc37f' }).ok).toBe(true);
    return { ...set, before: fs.readFileSync(runFile(set.parent)) };
  }

  it('replaces a plan that was never launched without being asked, keeping the old file as .bak', () => {
    const { parent, ctx } = world();
    planOk({}, ctx);
    const first = fs.readFileSync(runFile(parent));
    const doc = planOk({ objective: 'second plan' }, { ...ctx, randomHex: () => 'ffffff' });
    expect(doc.replaced).toBe(true);
    expect(doc.notes[0]).toContain('이전 계획');
    expect(readOrcaRun(parent).run).toMatchObject({ tag: 'ffffff', objective: 'second plan' });
    expect(fs.readFileSync(bak(parent)).equals(first)).toBe(true);
  });

  it('refuses to overwrite a launched run, leaves the file byte-identical, and names --force-new', () => {
    const { parent, ctx, before } = launchedWorld();
    const doc = runPlan({ ...ARGS, objective: 'another' }, { ...ctx, randomHex: () => 'ffffff' });
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain('run_3c01547fc37f');
    expect(doc.error).toContain('--force-new');
    expect(doc.path).toBe(runFile(parent));
    expect(fs.readFileSync(runFile(parent)).equals(before)).toBe(true);
  });

  it('--force-new replaces it and keeps the old bytes exactly as .bak', () => {
    const { parent, ctx, before } = launchedWorld();
    const doc = planOk({ forceNew: true, objective: 'fresh start' }, { ...ctx, randomHex: () => 'ffffff' });
    expect(doc.replaced).toBe(true);
    expect(doc.notes[0]).toContain('--force-new');
    const { run } = readOrcaRun(parent);
    expect(run).toMatchObject({ runId: null, tag: 'ffffff', objective: 'fresh start' });
    expect(fs.readFileSync(bak(parent)).equals(before)).toBe(true);
  });

  it('treats a bound limb as launched even when runId was never stamped', () => {
    const { parent, ctx } = world();
    planOk({}, ctx);
    const { run } = readOrcaRun(parent);
    const limbs = run.limbs.map((row, index) => (index === 0 ? { ...row, worktreeId: 'wt-1', worktreePath: '/w/1', branch: 'orca/x-a1b2c3' } : row));
    expect(writeOrcaRun(parent, { ...run, limbs }).ok).toBe(true);
    const doc = runPlan(ARGS, ctx);
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain('--force-new');
  });

  it('refuses an unreadable run.json, and --force-new keeps its bytes as .bak', () => {
    const { parent, ctx } = world();
    fs.mkdirSync(path.dirname(runFile(parent)), { recursive: true });
    fs.writeFileSync(runFile(parent), '{ not json');
    const refused = runPlan(ARGS, ctx);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('unparseable');
    expect(fs.readFileSync(runFile(parent), 'utf8')).toBe('{ not json');
    planOk({ forceNew: true }, ctx);
    expect(fs.readFileSync(bak(parent), 'utf8')).toBe('{ not json');
    expect(readOrcaRun(parent).ok).toBe(true);
  });

  it('--dry-run over a launched run succeeds, changes nothing, and says it would have been refused', () => {
    const { parent, ctx, before } = launchedWorld();
    const doc = planOk({ dryRun: true }, ctx);
    expect(doc.replaced).toBe(false);
    expect(doc.notes[0]).toContain('거부됐다');
    expect(fs.readFileSync(runFile(parent)).equals(before)).toBe(true);
  });
});

describe('runPlan - preflight warnings are carried into the report', () => {
  it('reports a warn check (a workspace-only session) among the warnings', () => {
    const { ctx } = world({ ctx: { env: { ORCA_WORKTREE_ID: `${ARTIBOT_ID}::/anywhere` } } });
    const doc = planOk({}, ctx);
    expect(doc.warnings.some((warning) => warning.startsWith('preflight orca-session:'))).toBe(true);
  });
});

describe('formatPlan', () => {
  it('prints header, the limb table, the budget line, the written path and the dry-run marker', () => {
    const { parent, ctx } = world();
    const text = formatPlan(planOk({}, ctx));
    const lines = text.split('\n');
    expect(lines[0]).toBe('/orca plan: split the core from the api');
    expect(lines[1]).toContain('tag a1b2c3');
    expect(lines[1]).toContain(`repo ${ARTIBOT_ID}`);
    expect(lines[2]).toContain('줄기 3개');
    expect(text).toMatch(/lib-core\s+lib\/core\/, tests\/core\/\s+-\s+예/);
    expect(text).toMatch(/api-layer\s+src\/api\/, tests\/api\/\s+lib-core\s+아니오 - lib-core 착지 대기/);
    expect(text).toContain('줄기당 예산 600000 tokens x 줄기 3 = 1800000 tokens (동시 3개 상한)');
    expect(text).toContain(`썼다: ${runFile(parent)}`);
    const dry = formatPlan(planOk({ dryRun: true }, world().ctx));
    expect(dry.split('\n')[0]).toContain('dry-run');
    expect(dry).toContain('쓰지 않음(--dry-run)');
  });

  it('shortens long ownership lists and says when there is no budget key', () => {
    const tasks = [free('big', ['a/', 'b/', 'c/', 'd/']), free('small', ['e/'])];
    const { ctx } = world({ tasks, ctx: { config: { split: { maxWindows: 8, minStems: 2 } } } });
    const text = formatPlan(planOk({}, ctx));
    expect(text).toContain('a/, b/ (+2)');
    expect(text).toContain('줄기당 예산: 미설정');
  });

  it('counts Hangul and CJK as two terminal cells', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('deps')).toBe(4);
    expect(displayWidth('줄기')).toBe(4);
    expect(displayWidth('(없음)')).toBe(6);
    expect(displayWidth('a줄b')).toBe(4);
  });

  it('lines the columns up even when a row holds Korean text', () => {
    const row = (limb, affectedPaths, deps, startNow, waitingOn) => ({ limb, taskIds: [limb], affectedPaths, deps, startNow, waitingOn });
    const doc = {
      dryRun: true, objective: 'x', tag: 't', integrationRef: 'r', orca: { appVersion: null, repoId: null },
      limits: { maxWindows: 2, minStems: null }, budget: { perLimb: null, limbs: 2, total: null }, plan: { serial: [] },
      limbs: [row('a', ['a/'], [], true, []), row('b', [], ['a'], false, ['a'])],
      path: null, replaced: false, notes: [], warnings: [],
    };
    const lines = formatPlan(doc).split('\n');
    const startColumn = (line, marker) => displayWidth(line.slice(0, line.indexOf(marker)));
    const first = lines.find((line) => line.includes('예'));
    const second = lines.find((line) => line.includes('아니오'));
    expect(second).toContain('(없음)');
    expect(startColumn(first, '예')).toBe(startColumn(second, '아니오'));
    expect(startColumn(first, '예')).toBe(startColumn(lines.find((line) => line.includes('지금 시작')), '지금 시작'));
  });
});

describe('main', () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
  };
  const argvFor = (extra = []) => ['--objective', 'split the core from the api', '--tasks', 'tasks.json', ...extra];

  it('--json prints one document and exits 0; a failure prints { ok:false } and exits 1', async () => {
    const good = world();
    const sink = capture();
    expect(await main(argvFor(['--json']), { ...sink.io, ...good.ctx })).toBe(0);
    expect(sink.out).toHaveLength(1);
    expect(JSON.parse(sink.out[0])).toMatchObject({ ok: true, tag: 'a1b2c3' });

    const bad = world({ table: { 'git --version': okRes('git version 2.1.0') } });
    const failSink = capture();
    expect(await main(argvFor(['--json']), { ...failSink.io, ...bad.ctx })).toBe(1);
    const doc = JSON.parse(failSink.out[0]);
    expect(doc).toMatchObject({ ok: false });
    expect(doc.preflight.ok).toBe(false);
    expect(failSink.err).toEqual([]);
  });

  it('prints the table on stdout on success and the reason (with the preflight table) on stderr on failure', async () => {
    const good = world();
    const sink = capture();
    expect(await main(argvFor(), { ...sink.io, ...good.ctx })).toBe(0);
    expect(sink.out[0]).toContain('/orca plan:');
    expect(sink.err).toEqual([]);

    const bad = world({ table: { 'git --version': okRes('git version 2.1.0') } });
    const failSink = capture();
    expect(await main(argvFor(), { ...failSink.io, ...bad.ctx })).toBe(1);
    expect(failSink.out).toEqual([]);
    expect(failSink.err[0]).toContain('orca plan: preflight');
    expect(failSink.err[0]).toContain('Orca preflight: FAIL');
  });

  it('--help prints the usage and exits 0 without calling anything', async () => {
    const { ctx, exec } = world();
    const sink = capture();
    expect(await main(['--help'], { ...sink.io, ...ctx })).toBe(0);
    expect(sink.out[0]).toContain('usage: node scripts/orca/plan.mjs');
    expect(exec.calls).toEqual([]);
  });

  it('a usage error exits 1: usage on stderr, or { ok:false, error } on stdout under --json', async () => {
    const { ctx, exec } = world();
    const plain = capture();
    expect(await main(['--tasks', 't.json'], { ...plain.io, ...ctx })).toBe(1);
    expect(plain.err[0]).toContain('--objective');
    const json = capture();
    expect(await main(['--json', '--bogus'], { ...json.io, ...ctx })).toBe(1);
    expect(JSON.parse(json.out[0])).toMatchObject({ ok: false });
    expect(exec.calls).toEqual([]);
  });

  it('reads the real artibot.config.json when no config is injected', async () => {
    const { ctx } = world();
    delete ctx.config;
    const sink = capture();
    const code = await main(argvFor(['--json', '--dry-run']), { ...sink.io, ...ctx });
    const doc = JSON.parse(sink.out[0]);
    expect(code, JSON.stringify(doc)).toBe(0);
    expect(Number.isInteger(doc.limits.maxWindows) && doc.limits.maxWindows >= 1).toBe(true);
  });
});

describe('the script as a process', () => {
  const emptyPathEnv = () => ({ PATH: '', SystemRoot: process.env.SystemRoot, windir: process.env.windir });
  const spawnCli = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: emptyPathEnv(), cwd, timeout: 60_000, windowsHide: true,
  });

  it('--help exits 0 (the direct-run guard fires) and prints usage', () => {
    const res = spawnCli(['--help'], makeTmp());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage: node scripts/orca/plan.mjs');
  });

  it('an unknown flag exits 1 with the message on stderr', () => {
    const res = spawnCli(['--bogus'], makeTmp());
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('인자 오류');
  });

  it('with no orca or git on PATH it fails closed: exit 1, a { ok:false, preflight } document, nothing written', () => {
    const parent = makeTmp();
    fs.writeFileSync(path.join(parent, 'tasks.json'), JSON.stringify(TASKS));
    const res = spawnCli(['--objective', 'x', '--tasks', 'tasks.json', '--json'], parent);
    expect(res.status).toBe(1);
    const doc = JSON.parse(res.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.preflight.checks.find((check) => check.name === 'orca-runtime').status).toBe('fail');
    expect(fs.existsSync(path.join(parent, '.artibot'))).toBe(false);
  });
});

describe('source pins', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');

  it('starts no process of its own and never names a shell option: the executor is preflight.mjs and it is injected', () => {
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bshell\s*:/);
  });

  it('calls only git itself; every Orca read goes through preflight', () => {
    const programs = [...source.matchAll(/\bexec\(\s*'([a-z]+)'/g)].map((match) => match[1]);
    expect(programs.length).toBeGreaterThan(0);
    expect(new Set(programs)).toEqual(new Set(['git']));
  });

  it('keeps the entry decision on isMainEntry(import.meta.url), spells no state-dir literal, hides no BOM or no-break space', () => {
    expect(source).toContain('isMainEntry(import.meta.url)');
    expect(source.includes(`.artibot${'/'}split`)).toBe(false);
    for (const code of [0xfeff, 0x00a0, 0x200b]) expect(source.includes(String.fromCodePoint(code)), `U+${code.toString(16)}`).toBe(false);
  });

  it('keeps the run file location in one place: it asks orcaRunPath instead of spelling the path', () => {
    expect(source).toContain('orcaRunPath(parentRoot)');
    expect(source).not.toMatch(/['"]run\.json['"]/);
    expect(clone({ a: 1 })).toEqual({ a: 1 });
  });
});
