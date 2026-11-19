#!/usr/bin/env node
/**
 * `orca plan` - turn a task list into limbs and write the PLANNING part of run.json (DESIGN 4.4 plan, 11.5 / IC-3).
 *
 *   node scripts/orca/plan.mjs --objective <text> --tasks <tasks.json> [--parent <root>]
 *       [--integration-ref <ref>] [--max-windows <n>] [--dry-run] [--force-new] [--json]
 *
 * Steps, in order; the first one that fails stops the run and nothing is written:
 *   1. preflight (`./preflight.mjs`, all seven checks - a failed one is reported, not skipped)
 *   2. `--parent` (default: the current directory) is the git checkout ROOT, not a subdirectory of it
 *   3. `--integration-ref` (default origin/master) resolves to a commit in the parent repo
 *   4. `lib/autopilot/fast-profile.js#buildFastFanoutPlan` over the tasks file. `split.maxWindows` is mapped onto the
 *      EXISTING four-key limits (`maxWorktrees` and `hardMaxAgents`; `normalizeFastProfile` silently drops a new key,
 *      so `limits: { maxWindows }` would cap nothing), `split.serverEntryPaths` goes in as the top-level conflict seed
 *   5. `assessPlan` (a fallbackReason or fewer than `split.minStems` parallel stems refuses the plan)
 *   6. `compileRun` - one limb per task (not only the first wave), edges = declared `dependsOn` plus ownership conflicts
 *   7. `writeOrcaRun` -> `<parentRoot>/.artibot/orca/run.json` (the previous file is kept as `run.json.bak`)
 *
 * The tasks file is the autopilot Phase 1 task shape (`id`, `dependsOn`, `independent`, `affectedPaths`, `risk`,
 * `worktreeEligible`): a JSON array, or an object with a `tasks` array.
 *
 * READ-ONLY toward Orca: the only calls are the preflight reads and `git rev-parse`, all through one injectable
 * executor that never uses a shell. The only thing written is run.json.
 *
 * AN EXISTING run.json is never replaced silently. It is refused when it carries a run (a stamped `runId`, a bound
 * worktree or a dispatch) or cannot be read; `--force-new` replaces it (old bytes go to `.bak`). A plan that was never
 * launched is replaced without the flag. `--dry-run` writes nothing and reports what would have been refused.
 *
 * WHAT THIS CANNOT SEE: shared databases or ports (only `split.serverEntryPaths` is a seed - nothing detects a shared
 * DB); whether a task's `affectedPaths` is complete (an unusable list is ordered after every other limb, never
 * repaired); the live state (the "starts now" column is a function of the plan alone - nothing has landed yet); and
 * Orca going away between this reading and the launch (preflight is a point-in-time check).
 *
 * @module scripts/orca/plan
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildFastFanoutPlan } from '../../lib/autopilot/fast-profile.js';
import { assessPlan, compileRun, readyLimbs } from '../../lib/git/orca-plan.js';
import { orcaRunPath, readOrcaRun, writeOrcaRun } from '../../lib/git/orca-run-file.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import { defaultExec, describeFailure, formatPreflight, loadConfigSafe, normalizeRepoPath, parseJsonText, runPreflight } from './preflight.mjs';

/** The CLI default; `compileRun` has the same default, but the ref is verified here BEFORE compiling. */
export const DEFAULT_INTEGRATION_REF = 'origin/master';

const TAG_BYTES = 3;
const MAX_WINDOWS_PATTERN = /^[1-9]\d{0,2}$/;
const PATHS_SHOWN = 2;

const USAGE = [
  'usage: node scripts/orca/plan.mjs --objective <text> --tasks <tasks.json> [options]',
  '',
  '  --objective <text>       the run objective (required)',
  '  --tasks <tasks.json>     task list: an array, or { "tasks": [...] } (required)',
  '  --parent <root>          repo root (default: the current directory); run.json is written under it',
  '  --integration-ref <ref>  branch the limbs start from and land on (default: origin/master)',
  '  --max-windows <n>        concurrent limb cap for this plan (default: artibot.config.json split.maxWindows)',
  '  --dry-run                show the plan, write nothing',
  '  --force-new              replace an existing run.json that carries a run (the old file is kept as .bak)',
  '  --json                   print one JSON document',
  '',
  'exit 0 when the plan was made (and written unless --dry-run), 1 otherwise.',
].join('\n');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonBlank = (value) => typeof value === 'string' && value.trim() !== '';
const positiveInt = (value) => (Number.isInteger(value) && value >= 1 ? value : null);
const asText = (value) => (typeof value === 'string' ? value : '');

/** Plan-time tag: six lower-case hex digits (the Orca run id does not exist yet, so it cannot supply one). */
export const defaultRandomHex = () => randomBytes(TAG_BYTES).toString('hex');
export const defaultNow = () => new Date().toISOString();

export function detectCpuCount() {
  const count = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Number.isInteger(count) && count >= 1 ? count : 1;
}

// ---------------------------------------------------------------------------------------------------------
// Arguments and inputs
// ---------------------------------------------------------------------------------------------------------

const CLI_OPTIONS = {
  objective: { type: 'string' },
  tasks: { type: 'string' },
  parent: { type: 'string' },
  'integration-ref': { type: 'string' },
  'max-windows': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'force-new': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
};

const usageError = (message) => ({ ok: false, error: `인자 오류: ${message}` });

function validatePlanArgs(values) {
  const objective = asText(values.objective).trim();
  if (objective === '') return usageError('--objective 가 필요하다(비어 있지 않은 목표 문장)');
  if (!isNonBlank(values.tasks)) return usageError('--tasks <tasks.json> 이 필요하다');
  const integrationRef = values['integration-ref'] ?? DEFAULT_INTEGRATION_REF;
  if (!/^[^\s-]\S*$/.test(integrationRef)) return usageError('--integration-ref 는 공백이 없고 "-" 로 시작하지 않는 ref 여야 한다');
  const maxWindows = values['max-windows'];
  if (maxWindows !== undefined && !MAX_WINDOWS_PATTERN.test(maxWindows)) return usageError('--max-windows 는 양의 정수여야 한다');
  return {
    ok: true,
    value: {
      help: false,
      objective,
      tasks: values.tasks,
      parent: values.parent ?? null,
      integrationRef,
      maxWindows: maxWindows === undefined ? null : Number(maxWindows),
      dryRun: values['dry-run'] === true,
      forceNew: values['force-new'] === true,
      json: values.json === true,
    },
  };
}

/** @param {string[]} argv @returns {{ ok: true, value: object } | { ok: false, error: string }} */
export function parsePlanArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    return usageError(err.message);
  }
  if (values.help === true) return { ok: true, value: { help: true, json: values.json === true } };
  return validatePlanArgs(values);
}

/**
 * Reads the tasks file: a JSON array of task objects, or `{ tasks: [...] }`. Task fields are not judged here - the
 * planner and `compileRun` own that (a task without an id, a duplicate id, a dependency on nothing).
 */
export function loadTasks(file, { cwd, readFile }) {
  let text;
  try {
    text = readFile(path.resolve(cwd, file));
  } catch (err) {
    return { ok: false, error: `tasks 파일을 읽을 수 없다(${file}): ${err.code ?? err.message}` };
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok) return { ok: false, error: `tasks 파일이 JSON 이 아니다(${file}): ${parsed.error}` };
  const list = Array.isArray(parsed.value) ? parsed.value : parsed.value?.tasks;
  if (!Array.isArray(list)) return { ok: false, error: 'tasks 파일은 작업 배열이거나 { "tasks": [...] } 여야 한다' };
  if (list.length === 0) return { ok: false, error: 'tasks 파일에 작업이 하나도 없다' };
  const bad = list.findIndex((task) => !isRecord(task));
  return bad >= 0 ? { ok: false, error: `tasks[${bad}] 가 객체가 아니다` } : { ok: true, tasks: list };
}

/**
 * `split.*` values the planner takes, read the way `commands/split.md` plan step 3 says. `maxWindows` is the CLI
 * override, else the config value; either is `null` when absent or not a positive integer (the planner's own default
 * cap then applies and `warnings` says so). `minStems`, `serverEntryPaths` and `budget` are passed as found: the
 * consumers validate them (`assessPlan` falls back to 2; a malformed `serverEntryPaths` collapses the plan to one
 * stem, which is the fail-closed direction).
 */
export function readPlanSettings(config, { maxWindowsOverride = null } = {}) {
  const split = isRecord(config?.split) ? config.split : {};
  const configured = positiveInt(split.maxWindows);
  const warnings = [];
  if (split.maxWindows !== undefined && configured === null) {
    warnings.push(`split.maxWindows(${JSON.stringify(split.maxWindows)})가 양의 정수가 아니다 - fast-profile 기본 상한을 쓴다`);
  }
  return {
    maxWindows: maxWindowsOverride ?? configured,
    minStems: split.minStems,
    serverEntryPaths: split.serverEntryPaths,
    budget: positiveInt(isRecord(split.dispatch) ? split.dispatch.budget : undefined),
    warnings,
  };
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `<parentRoot>` is the checkout root (DESIGN 11.2): every later script finds run.json under it. A leader whose shell sits
 * in a subdirectory (this repo has a second `.artibot` directory under plugins/artibot) would otherwise write the state
 * file where nothing else looks for it, and preflight cannot tell - the caller's workspace id would still match the repo.
 */
function checkParentIsRoot(exec, parentRoot, realpath) {
  const res = exec('git', ['rev-parse', '--show-toplevel'], { cwd: parentRoot });
  if (!res.ok) return { ok: false, error: `--parent 가 git 리포가 아니다(${describeFailure(res, null, 'git')}): ${parentRoot}` };
  const top = asText(res.stdout).trim();
  if (normalizeRepoPath(top, realpath) === normalizeRepoPath(parentRoot, realpath)) return { ok: true };
  return { ok: false, error: `--parent 는 git 체크아웃 루트여야 한다 - ${parentRoot} 는 ${top} 의 하위다. 루트에서 실행하거나 --parent 로 루트를 주라` };
}

/** The integration ref must name a commit NOW: a typo found here costs nothing, found at `worktree create` it costs an approved launch. */
function checkIntegrationRef(exec, parentRoot, ref) {
  const res = exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: parentRoot });
  if (res.ok) return { ok: true };
  const why = describeFailure(res, null, 'git');
  return { ok: false, error: `integrationRef "${ref}" 를 커밋으로 해석할 수 없다(${why}) - git fetch 뒤 다시 하거나 --integration-ref 를 확인하라` };
}

// ---------------------------------------------------------------------------------------------------------
// An existing run.json
// ---------------------------------------------------------------------------------------------------------

const isFilledString = (value) => typeof value === 'string' && value !== '';

/** True when the file records a run: a stamped runId, or any limb with a worktree binding or a dispatch. */
export function isLaunchedRun(run) {
  if (!isRecord(run)) return false;
  if (isNonBlank(run.runId)) return true;
  const limbs = Array.isArray(run.limbs) ? run.limbs : [];
  return limbs.some((row) => isRecord(row)
    && ([row.worktreeId, row.worktreePath, row.branch].some(isFilledString) || (Array.isArray(row.dispatches) && row.dispatches.length > 0)));
}

function inspectExisting(parentRoot) {
  const current = readOrcaRun(parentRoot);
  if (current.ok) return { state: 'plan', run: current.run, launched: isLaunchedRun(current.run) };
  if (current.reason === 'absent') return { state: 'absent' };
  return { state: 'unreadable', reason: current.reason, detail: current.detail ?? '' };
}

function describeExisting(existing) {
  if (existing.state === 'unreadable') return `읽을 수 없음(${existing.reason}${existing.detail ? `: ${existing.detail}` : ''})`;
  return `시작된 run(runId=${existing.run.runId ?? 'null'})`;
}

/**
 * What to do about the file that is already there. `error` set = refuse; `note` = a line for the report; `replaced` =
 * an older file will be overwritten (the writer keeps it as `.bak`). Only a never-launched plan is replaced freely.
 */
export function existingVerdict(existing, { forceNew, dryRun }) {
  if (existing.state === 'absent') return { error: null, note: null, replaced: false };
  if (existing.state === 'plan' && !existing.launched) {
    return { error: null, note: '시작 전 이전 계획을 새 계획으로 교체한다 - 옛 파일은 run.json.bak 로 보존', replaced: !dryRun };
  }
  const what = describeExisting(existing);
  if (forceNew) return { error: null, note: `기존 run.json(${what})을 --force-new 로 교체한다 - 옛 파일은 run.json.bak 로 보존`, replaced: !dryRun };
  const message = `기존 run.json 이 있다 - ${what}. 덮어쓰지 않는다. 새 계획이 맞으면 --force-new (옛 파일은 run.json.bak 로 보존)`;
  return dryRun
    ? { error: null, note: `dry-run 이 아니었다면 거부됐다: ${message}`, replaced: false }
    : { error: message, note: null, replaced: false };
}

// ---------------------------------------------------------------------------------------------------------
// Plan, compile, report
// ---------------------------------------------------------------------------------------------------------

const COMPILE_REASONS = Object.freeze({
  cycle: '의존이 순환한다(소유 경로가 불완전한 작업을 완전한 작업의 선행으로 선언한 경우도 순환이다)',
  'unresolved-dependency': 'dependsOn 이 계획에 없는 작업 id 를 가리킨다',
  'duplicate-id': '작업 id 가 중복된다',
  'missing-id': 'id 가 없는 작업이 있다',
  'invalid-tasks': '작업 목록이 비었거나 객체가 아닌 항목이 있다',
  'missing-objective': '목표 문장이 비어 있다',
  'bad-tag': '계획 tag 형태가 맞지 않는다',
  'bad-integration-ref': 'integrationRef 가 비었거나 공백을 포함한다',
  'bad-now': '생성 시각을 읽을 수 없다',
});

function describeRejection(reason, plan) {
  const serial = (plan.serial ?? []).slice(0, 5).map((entry) => `${entry.taskId}=${entry.reason}`).join(', ');
  const hint = serial === '' ? '' : ` (플래너 직렬 판정: ${serial})`;
  if (reason.startsWith('fallback:')) {
    return `계획을 거부한다 - fallbackReason=${reason.slice('fallback:'.length)}${hint}. 표준 경로로 조용히 폴백하지 않는다(창 1개는 /team 이 낫다)`;
  }
  if (reason.startsWith('stems-below-min:')) {
    const [planned, floor] = reason.slice('stems-below-min:'.length).split('/');
    return `줄기 수 미달 - 병렬 ${planned} < minStems ${floor}${hint}. 창 1개는 /team 이 낫다`;
  }
  return `계획을 거부한다 - ${reason}${hint}`;
}

const planSummary = (plan) => ({
  profile: plan.profile,
  fallbackReason: plan.fallbackReason ?? null,
  plannedParallelism: plan.plannedParallelism,
  estimatedSpeedup: plan.estimatedSpeedup,
  waves: plan.waves,
  serial: plan.serial,
  conflictGroups: plan.conflictGroups,
});

function buildPlan(tasks, settings, cpuCount) {
  const limits = settings.maxWindows === null
    ? {}
    : { limits: { maxWorktrees: settings.maxWindows, hardMaxAgents: settings.maxWindows } };
  return buildFastFanoutPlan({ fast: true, tasks, cpuCount, serverEntryPaths: settings.serverEntryPaths, ...limits });
}

function limbReport(run, ready) {
  return run.limbs.map((row) => ({
    limb: row.limb,
    taskIds: row.taskIds,
    affectedPaths: row.affectedPaths,
    deps: row.deps,
    startNow: ready.start.includes(row.limb),
    waitingOn: ready.waiting[row.limb] ?? [],
  }));
}

function collectWarnings({ pre, settings, plan, args }) {
  const effective = plan.limits.maxWorktrees;
  const warnings = pre.checks.filter((check) => check.status === 'warn').map((check) => `preflight ${check.name}: ${check.detail}`);
  warnings.push(...settings.warnings);
  if (settings.maxWindows !== null && settings.maxWindows !== effective) {
    const source = args.maxWindows === null ? 'split.maxWindows' : '--max-windows';
    warnings.push(`${source} ${settings.maxWindows} 는 fast-profile 하드캡 때문에 ${effective} 로 적용된다`);
  }
  return warnings;
}

function planDocument({ args, run, plan, ready, settings, pre, written, verdict }) {
  const perLimb = settings.budget;
  return {
    ok: true,
    dryRun: args.dryRun,
    path: written.path ?? null,
    replaced: verdict.replaced,
    objective: run.objective,
    tag: run.tag,
    integrationRef: run.integrationRef,
    orca: { appVersion: run.orca.appVersion, repoId: run.orca.repoId },
    limits: { maxWindows: plan.limits.maxWorktrees, requestedMaxWindows: args.maxWindows, minStems: positiveInt(settings.minStems) },
    budget: { perLimb, limbs: run.limbs.length, total: perLimb === null ? null : perLimb * run.limbs.length },
    plan: planSummary(plan),
    limbs: limbReport(run, ready),
    start: ready.start,
    notes: verdict.note === null ? [] : [verdict.note],
    warnings: collectWarnings({ pre, settings, plan, args }),
  };
}

const failure = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Everything before the plan itself: the parent directory, preflight, the checkout root, the integration ref, the tasks file. */
function gather(args, ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  const parentRoot = path.resolve(cwd, args.parent ?? '.');
  if (!isDirectory(parentRoot)) return failure(`--parent 가 디렉터리가 아니다: ${parentRoot}`);
  const exec = ctx.exec ?? defaultExec;
  const pre = runPreflight({
    parentRoot,
    env: ctx.env ?? process.env,
    exec,
    config: ctx.config ?? null,
    configError: ctx.configError ?? null,
    cwd,
    ...(ctx.realpath ? { realpath: ctx.realpath } : {}),
  });
  if (!pre.ok) return failure('preflight 실패 - 실패한 점검을 고친 뒤 다시 실행하라', { preflight: pre });
  const root = checkParentIsRoot(exec, parentRoot, ctx.realpath);
  if (!root.ok) return failure(root.error);
  const ref = checkIntegrationRef(exec, parentRoot, args.integrationRef);
  if (!ref.ok) return failure(ref.error);
  const loaded = loadTasks(args.tasks, { cwd, readFile: ctx.readFile ?? ((file) => fs.readFileSync(file, 'utf8')) });
  return loaded.ok ? { ok: true, parentRoot, pre, tasks: loaded.tasks } : failure(loaded.error);
}

/**
 * The whole planning step, minus printing. Returns the report document (`{ ok: true, ... }`) or `{ ok: false, error }`.
 * `ctx` carries the injectable world: `cwd`, `env`, `exec`, `config`, `configError`, `readFile`, `realpath`, `now`,
 * `randomHex`, `cpuCount`.
 *
 * @param {object} args parsed by {@link parsePlanArgs}
 * @param {object} [ctx]
 * @returns {object}
 */
export function runPlan(args, ctx = {}) {
  const gathered = gather(args, ctx);
  if (!gathered.ok) return gathered;
  const { parentRoot, pre, tasks } = gathered;
  const settings = readPlanSettings(ctx.config, { maxWindowsOverride: args.maxWindows });
  const plan = buildPlan(tasks, settings, ctx.cpuCount ?? detectCpuCount());
  const accepted = assessPlan(plan, { minStems: settings.minStems });
  if (!accepted.ok) return failure(describeRejection(accepted.reason, plan), { reason: accepted.reason, plan: planSummary(plan) });
  const verdict = existingVerdict(inspectExisting(parentRoot), args);
  if (verdict.error !== null) return failure(verdict.error, { path: orcaRunPath(parentRoot) });
  const compiled = compileRun({
    runId: null,
    objective: args.objective,
    integrationRef: args.integrationRef,
    appVersion: pre.orca.appVersion,
    repoId: pre.orca.repoId,
    tasks,
    plan,
    tag: (ctx.randomHex ?? defaultRandomHex)(),
    now: (ctx.now ?? defaultNow)(),
  });
  if (!compiled.ok) return failure(`${COMPILE_REASONS[compiled.reason] ?? '계획을 만들지 못했다'} (reason: ${compiled.reason})`, { reason: compiled.reason });
  const ready = readyLimbs(compiled.run, { landed: [], inFlight: [], capacity: plan.limits.maxWorktrees });
  const written = args.dryRun ? { ok: true, path: null } : writeOrcaRun(parentRoot, compiled.run);
  if (!written.ok) return failure(`run.json 을 쓰지 못했다(${written.reason}${written.detail ? `: ${written.detail}` : ''})`, { reason: written.reason });
  return planDocument({ args, run: compiled.run, plan, ready, settings, pre, written, verdict });
}

// ---------------------------------------------------------------------------------------------------------
// Report text and CLI
// ---------------------------------------------------------------------------------------------------------

function ownershipText(paths) {
  if (paths.length === 0) return '(없음)';
  const shown = paths.slice(0, PATHS_SHOWN).join(', ');
  return paths.length > PATHS_SHOWN ? `${shown} (+${paths.length - PATHS_SHOWN})` : shown;
}

function startText(row) {
  if (row.startNow) return '예';
  return row.waitingOn.length > 0 ? `아니오 - ${row.waitingOn.join(', ')} 착지 대기` : '아니오 - 빈 슬롯 대기';
}

const isWideCodePoint = (code) => (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
  || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);

/** Terminal cells a string occupies: Hangul, CJK and full-width forms take two, so a Korean table still lines up. */
export function displayWidth(text) {
  let cells = 0;
  for (const char of text) cells += isWideCodePoint(char.codePointAt(0)) ? 2 : 1;
  return cells;
}

const padCells = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

function tableLines(limbs) {
  const rows = limbs.map((row) => [row.limb, ownershipText(row.affectedPaths), row.deps.length > 0 ? row.deps.join(', ') : '-', startText(row)]);
  const header = ['줄기', '소유 경로', 'deps', '지금 시작'];
  const widths = header.map((title, column) => Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[column]))));
  const render = (cells) => `  ${cells.map((cell, column) => (column === cells.length - 1 ? cell : padCells(cell, widths[column]))).join('  ')}`;
  return [render(header), ...rows.map(render)];
}

const tokens = (value) => `${value} tokens`;

/** Human-readable plan: header, the limb table, the budget line, what was written, notes and warnings. */
export function formatPlan(doc) {
  const { limits, budget } = doc;
  const lines = [
    `/orca plan${doc.dryRun ? ' (dry-run - 쓰지 않음)' : ''}: ${doc.objective}`,
    `  tag ${doc.tag} - integrationRef ${doc.integrationRef} - Orca ${doc.orca.appVersion ?? '미확인'} - repo ${doc.orca.repoId ?? '미확인'}`,
    `  줄기 ${budget.limbs}개 - 동시 상한 maxWindows=${limits.maxWindows} - minStems=${limits.minStems ?? '기본'}`,
    '',
    ...tableLines(doc.limbs),
    '',
    budget.perLimb === null
      ? '  줄기당 예산: 미설정(split.dispatch.budget)'
      : `  줄기당 예산 ${tokens(budget.perLimb)} x 줄기 ${budget.limbs} = ${tokens(budget.total)} (동시 ${Math.min(limits.maxWindows, budget.limbs)}개 상한)`,
  ];
  const serial = doc.plan.serial ?? [];
  if (serial.length > 0) {
    lines.push(`  플래너 직렬 판정(참고): ${serial.map((entry) => `${entry.taskId}=${entry.reason}`).join(', ')}`);
  }
  lines.push(doc.path === null ? '  쓰지 않음(--dry-run)' : `  썼다: ${doc.path}${doc.replaced ? ' (이전 파일은 .bak 로 보존)' : ''}`);
  for (const note of doc.notes) lines.push(`  참고: ${note}`);
  for (const warning of doc.warnings) lines.push(`  경고: ${warning}`);
  return lines.join('\n');
}

function failureText(doc) {
  const lines = [`orca plan: ${doc.error}`];
  if (doc.preflight) lines.push(formatPreflight(doc.preflight));
  return lines.join('\n');
}

/**
 * CLI body. Returns the exit code instead of exiting, so callers (and tests) own the process.
 *
 * @param {string[]} argv
 * @param {object} [io] `stdout`, `stderr` and everything {@link runPlan} takes in `ctx`
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const parsed = parsePlanArgs(argv);
  const json = parsed.ok ? parsed.value.json : argv.includes('--json');
  if (!parsed.ok) {
    if (json) stdout(JSON.stringify(failure(parsed.error), null, 2));
    else stderr(`${parsed.error}\n${USAGE}`);
    return 1;
  }
  if (parsed.value.help) {
    stdout(USAGE);
    return 0;
  }
  const loaded = io.config === undefined ? await loadConfigSafe() : { config: io.config, configError: null };
  const doc = runPlan(parsed.value, { ...io, config: loaded.config, configError: loaded.configError });
  if (json) stdout(JSON.stringify(doc, null, 2));
  else if (doc.ok) stdout(formatPlan(doc));
  else stderr(failureText(doc));
  return doc.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`orca plan: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
