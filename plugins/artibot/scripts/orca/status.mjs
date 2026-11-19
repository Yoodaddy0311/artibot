#!/usr/bin/env node
/**
 * `orca status` — one table of where every limb of the run stands, plus the
 * next action (DESIGN §4.3 "what is read where", §4.4 wake-up table, §11.6).
 *
 *   node scripts/orca/status.mjs [--parent <root>] [--json] [--next] [--fetch] [--limb <l>] [--stall]
 *   node scripts/orca/status.mjs mail --file <check-output.json|-> [--parent <root>] [--json]
 *
 * READ-ONLY. Orca is asked only through {@link callOrcaJson}, which refuses
 * every verb outside {@link READ_ONLY_ORCA_VERBS} (the §11.2 allowlist) and
 * refuses `orchestration check` without `--peek` — a bare `check` takes the
 * leader's mail and nothing would wake it again. Everything that changes Orca
 * (worker-start, send, worktree rm ...) is only ever PRINTED as a command line
 * for the leader to type. git is read through `readLimbCompletion` and
 * `rev-parse` / `merge-base`; `--fetch` adds one `git fetch origin` (it moves
 * remote-tracking refs, nothing else) and `--stall` writes one small local
 * snapshot file.
 *
 * One question, one source (§4.3): Task/worker state from Orca, "is it done"
 * from the git trailer, "has it landed" from git (trailer `done` AND commits > 0
 * AND the tip is an ancestor of the integration ref — an empty limb is an
 * ancestor of everything and must not read as landed, `landingState`). The
 * plugin writes no lane vocabulary of its own.
 *
 * `mail` classifies the output of `orca orchestration check --json`. A limb is
 * found through `payload.dispatchId` → `run.json` dispatches, never through
 * `from`: `question.from` is a dispatch id but `worker_done.from` is a terminal
 * handle (P0 receipts 2026-11-19). `worker_done` succeeded without a trailer is
 * "not done — send it back".
 *
 * `--stall` (the §4.4 "bounded check" criterion, partly): compares the in-flight
 * limbs with the snapshot the previous `--stall` run left in
 * `<parent>/.artibot/orca/stall.json` — no new commit on the branch AND the Task
 * and worker state unchanged = "no change". The third criterion of the design
 * (the worker's output position, `worker-read`) is NOT evaluated: that verb is
 * outside the §11.2 read allowlist, so this verdict is weaker than the design's.
 *
 * Exit codes: 0 ok · 1 usage / run.json unreadable / mail file unreadable.
 * `--json` prints one JSON document; a failure is `{ ok:false, error }`.
 *
 * @module scripts/orca/status
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../hooks/_main-entry.js';
import { loadConfig } from '../../lib/core/config.js';
import { atomicWriteJsonSync, renameWithRetry } from '../../lib/core/file.js';
import { readLimbCompletion } from '../../lib/git/limb-completion.js';
import { landingState, nextActions } from '../../lib/git/orca-plan.js';
import { orcaRunPath, readOrcaRun } from '../../lib/git/orca-run-file.js';
import { readSplitEvents, summarizeWallClock } from '../../lib/observability/split-telemetry.js';
import { closedConfirmLaunchPairs } from './mark.mjs';

/** Plugin root — scripts printed in hints are absolute so they run from the parent root. */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_CAPACITY = 4;
const STALL_SCHEMA_VERSION = 1;

const asText = (value) => (typeof value === 'string' ? value : '');
const isFilled = (value) => typeof value === 'string' && value.trim() !== '';

// ── process execution (injectable) ───────────────────────────────────────────

/**
 * Production executor: shell-free, never throws — a failure is `{ ok:false, ... }`.
 * Tests inject their own with the same signature and never reach the real Orca.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, error: string|null }}
 */
export function defaultExec(file, args, options = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8', cwd: options.cwd, timeout: options.timeoutMs ?? EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '', error: null };
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : null;
    return { ok: false, status, stdout: asText(err?.stdout), stderr: asText(err?.stderr), error: typeof err?.code === 'string' ? err.code : `exit ${status ?? '?'}` };
  }
}

// ── the read-only Orca guard (DESIGN §11.2) ──────────────────────────────────

/** Orca verbs these scripts may EXECUTE. Anything else is only printed for the leader. */
export const READ_ONLY_ORCA_VERBS = Object.freeze([
  'status', 'repo list', 'agent-context', 'worktree show', 'worktree list', 'worktree ps',
  'orchestration worker-list', 'orchestration task-list', 'orchestration worker-show', 'orchestration inbox',
  'orchestration check', 'terminal read',
]);

/** The leading non-flag words of an argv (at most two): the verb path. */
export function orcaVerbOf(argv) {
  const words = [];
  for (const token of argv) {
    if (typeof token !== 'string' || token.startsWith('-')) break;
    words.push(token);
    if (words.length === 2) break;
  }
  return words.join(' ');
}

/** Throws for any argv that is not a read verb (a programming error, not a runtime condition). */
export function assertReadOnlyOrcaArgv(argv) {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) throw new TypeError('orca argv must be an array of strings');
  const verb = orcaVerbOf(argv);
  if (!READ_ONLY_ORCA_VERBS.includes(verb)) throw new Error(`refused: "orca ${verb || argv.join(' ')}" is not a read-only verb`);
  if (verb === 'orchestration check' && !argv.includes('--peek')) throw new Error('refused: "orca orchestration check" without --peek would consume the leader mail');
}

const envelopeMessage = (doc) => (typeof doc?.error === 'string' ? doc.error : asText(doc?.error?.message));

/** One Orca read verb → `{ ok:true, doc, result }` or `{ ok:false, error }`. */
export function callOrcaJson(exec, argv, options = {}) {
  assertReadOnlyOrcaArgv(argv);
  const res = exec('orca', argv, options);
  let doc = null;
  try { doc = JSON.parse(asText(res.stdout).replace(/^\u{FEFF}/u, '')); } catch { /* reported below */ }
  if (!res.ok) return { ok: false, error: envelopeMessage(doc) || asText(res.stderr).trim().split(/\r?\n/)[0] || res.error || `exit ${res.status ?? '?'}` };
  if (doc === null) return { ok: false, error: 'orca answered with something that is not JSON' };
  if (doc.ok === false) return { ok: false, error: envelopeMessage(doc) || 'orca answered ok:false' };
  return { ok: true, doc, result: doc.result ?? null };
}

// ── command lines the leader types (printed, never run) ──────────────────────

const BARE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one token for bash / PowerShell; refuses a token it cannot quote safely. */
export function shellQuote(token) {
  const text = String(token);
  if (text !== '' && BARE_TOKEN.test(text)) return text;
  if (!/["$`\\]/.test(text)) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  throw new Error(`cannot quote a token for a command line: ${JSON.stringify(text)}`);
}

export const cmdLine = (...tokens) => tokens.map(shellQuote).join(' ');
export const toPosix = (p) => String(p).replaceAll('\\', '/');
const scriptPath = (...parts) => toPosix(path.join(PLUGIN_ROOT, 'scripts', ...parts));

// ── atomic file write (brief / prompt in bind, report in close) ──────────────

/** Byte-exact write through a tmp sibling + rename (the rename retries a transient Windows lock). */
export function atomicWriteBytes(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, bytes);
    renameWithRetry(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// ── worktree-setup as a child process (junction up in bind, down in close) ───

const WORKTREE_SETUP = path.join(PLUGIN_ROOT, 'scripts', 'split', 'worktree-setup.mjs');

/**
 * Run `scripts/split/worktree-setup.mjs` (which owns junction creation and the
 * reparse-point-only teardown) and read its `--json` document. This suite calls it,
 * never reimplements it. A refusal or failure is `{ ok:false }` — callers fail closed.
 *
 * @returns {{ ok: boolean, rows: Array<{ kind: string, status: string, target: string, detail: string }>, error: string|null }}
 */
export function runWorktreeSetup(worktreePath, { parentRoot, limb = null, teardown = false, timeoutMs = 120_000 }) {
  const args = [WORKTREE_SETUP, worktreePath, '--parent', parentRoot, '--json', ...(limb ? ['--limb', limb] : []), ...(teardown ? ['--teardown'] : [])];
  let stdout;
  let exited = true;
  try {
    stdout = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    exited = false;
    stdout = asText(err?.stdout);
  }
  try {
    const doc = JSON.parse(stdout);
    const rows = Array.isArray(doc?.rows) ? doc.rows : [];
    const bad = rows.filter((r) => r.status === 'refused' || r.status === 'failed');
    const ok = exited && doc?.ok === true && bad.length === 0;
    return { ok, rows, error: ok ? null : (bad.map((r) => `${r.kind} ${r.target}: ${r.detail}`).join('; ') || 'worktree-setup 가 실패로 끝났다') };
  } catch {
    return { ok: false, rows: [], error: 'worktree-setup 출력을 해석하지 못했다' };
  }
}

// ── run file ─────────────────────────────────────────────────────────────────

const RUN_FILE_WHY = {
  absent: 'run.json 이 없다 — plan 먼저(또는 --parent 확인)',
  unparseable: 'run.json 을 읽을 수 없다(JSON 손상)',
  schema: 'run.json 형태가 계약과 다르다',
};

/** `readOrcaRun` with a sentence for the failure. */
export function loadRun(parentRoot) {
  const read = readOrcaRun(parentRoot);
  if (read.ok) return { ok: true, run: read.run };
  const detail = read.detail ? ` — ${read.detail}` : '';
  return { ok: false, error: `${RUN_FILE_WHY[read.reason] ?? read.reason}: ${orcaRunPath(parentRoot)}${detail}` };
}

/** Comparable form of a checkout path: real path (8.3 short names expanded), forward slashes, no trailing slash, lower case for a drive path. */
function repoPathKey(target) {
  let real;
  try { real = fs.realpathSync.native(target); } catch { real = path.resolve(target); }
  const unified = real.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/**
 * `<parentRoot>` is the checkout root (DESIGN 11.2): run.json lives under it and every script looks there. A shell whose cwd
 * drifted into a subdirectory (this repo has a second `.artibot` under plugins/artibot) would read or write the state file
 * where nothing else looks. Same judgement as `plan.mjs`: `git rev-parse --show-toplevel` against `--parent`. Checked BEFORE
 * run.json is touched. `mark.mjs` has no `--parent` (it writes the telemetry store only), so it has nothing to guard.
 */
export function checkParentIsRoot(exec, parentRoot) {
  const res = exec('git', ['rev-parse', '--show-toplevel'], { cwd: parentRoot });
  if (!res.ok) return { ok: false, error: `--parent 가 git 리포가 아니다(${res.error ?? `exit ${res.status ?? '?'}`}): ${parentRoot}` };
  const top = res.stdout.trim();
  if (repoPathKey(top) === repoPathKey(parentRoot)) return { ok: true };
  return { ok: false, error: `--parent 는 git 체크아웃 루트여야 한다 - ${parentRoot} 는 ${top} 의 하위다. 루트에서 실행하거나 --parent 로 루트를 주라` };
}

// ── git evidence (shared with close.mjs) ─────────────────────────────────────

const FULL_SHA = /^[0-9a-f]{40}$/;

function revParse(exec, cwd, spec) {
  const res = exec('git', ['rev-parse', '--verify', '--quiet', spec], { cwd });
  const sha = res.ok ? res.stdout.trim() : '';
  return FULL_SHA.test(sha) ? sha : null;
}

/** `git merge-base --is-ancestor`: true / false, or null when git could not answer. */
export function isAncestor(exec, cwd, ancestor, ref) {
  const res = exec('git', ['merge-base', '--is-ancestor', ancestor, ref], { cwd });
  if (res.ok) return true;
  return res.status === 1 ? false : null;
}

/**
 * Trailer completion + tip + ancestry + the landing word for one bound limb.
 * `base` of the trailer range is the recorded `forkPoint` (the integration ref
 * moves on, the fork point does not).
 */
export function observeLimbGit({ parentRoot, row, integrationRef, exec = defaultExec }) {
  const completion = readLimbCompletion({ cwd: parentRoot, branch: row.branch, ...(isFilled(row.forkPoint) ? { base: row.forkPoint } : {}) });
  const tip = revParse(exec, parentRoot, `refs/heads/${row.branch}^{commit}`);
  const ancestor = tip === null ? null : isAncestor(exec, parentRoot, tip, integrationRef);
  const landing = landingState({ completion, commitCount: completion.commitCount, tipIsAncestorOfIntegration: ancestor === true });
  return { completion, tip, ancestor, landing };
}

// ── Orca facts ───────────────────────────────────────────────────────────────

/** Worker and Task rows of the run, or nulls plus the reasons they are missing. */
export function fetchOrcaFacts(exec, runId) {
  if (!isFilled(runId)) return { workers: null, tasks: null, warnings: ['Orca runId 미바인딩 — Orca 조회 생략 (bind.mjs run 전)'] };
  const warnings = [];
  const workerCall = callOrcaJson(exec, ['orchestration', 'worker-list', '--run', runId, '--json']);
  const taskCall = callOrcaJson(exec, ['orchestration', 'task-list', '--run', runId, '--json']);
  if (!workerCall.ok) warnings.push(`worker-list 실패: ${workerCall.error}`);
  if (!taskCall.ok) warnings.push(`task-list 실패: ${taskCall.error}`);
  if (workerCall.ok && workerCall.result?.nextCursor) warnings.push('worker-list 가 잘렸다(nextCursor) — 일부 줄기의 worker 행이 없을 수 있다');
  const workers = workerCall.ok && Array.isArray(workerCall.result?.workers) ? workerCall.result.workers : null;
  const tasks = taskCall.ok && Array.isArray(taskCall.result?.tasks) ? taskCall.result.tasks : null;
  return { workers, tasks, warnings };
}

// ── one limb row ─────────────────────────────────────────────────────────────

const SETTLED_WORKER = new Set(['succeeded', 'failed']);
const SETTLED_TASK = new Set(['completed', 'failed']);

const latestDispatch = (row) => (Array.isArray(row.dispatches) && row.dispatches.length > 0 ? row.dispatches[row.dispatches.length - 1] : null);

function workerView(facts, dispatch) {
  const worker = dispatch ? facts.workers?.find((w) => w.dispatchId === dispatch.dispatchId) : null;
  if (!worker) return null;
  const { state = null, outcome = null, liveness = null, terminalState = null, attention = [] } = worker;
  return { state, outcome, liveness, terminalState, attention };
}

function failedDispatches(row, facts) {
  const ids = new Set((row.dispatches ?? []).map((d) => d.dispatchId));
  return (facts.workers ?? []).filter((w) => ids.has(w.dispatchId) && w.state === 'failed').length;
}

function baseRow(row) {
  return {
    limb: row.limb, deps: row.deps ?? [], bound: isFilled(row.worktreeId) && isFilled(row.branch),
    worktreeId: row.worktreeId ?? null, worktreePath: row.worktreePath ?? null, branch: row.branch ?? null, forkPoint: row.forkPoint ?? null,
    dispatches: row.dispatches ?? [],
  };
}

/** Everything measured about one limb, without the next-action text (that needs the landed set). */
export function observeLimb(row, ctx) {
  const base = baseRow(row);
  const latest = latestDispatch(row);
  const worker = workerView(ctx.facts, latest);
  const task = latest ? ctx.facts.tasks?.find((t) => t.id === latest.taskId) ?? null : null;
  const out = {
    ...base, latest, worker, taskStatus: task?.status ?? null, failedDispatches: failedDispatches(row, ctx.facts),
    landing: base.bound ? null : 'unbound', trailer: null, commits: 0, tip: null, closed: false, notes: [],
  };
  if (!base.bound) return out;
  const git = observeLimbGit({ parentRoot: ctx.parentRoot, row, integrationRef: ctx.integrationRef, exec: ctx.exec });
  const worktreeGone = !fs.existsSync(row.worktreePath);
  const closed = git.completion.reason === 'no-branch' && worktreeGone && out.taskStatus !== 'failed';
  const { complete, reason, lastTrailer, commitCount } = git.completion;
  const notes = [
    ...(git.ancestor === null && git.tip !== null ? [`${ctx.integrationRef} 와의 조상 관계를 읽지 못했다 — 착지로 세지 않는다(--fetch 로 참조를 갱신해 보라)`] : []),
    ...(closed ? ['브랜치·worktree 모두 없음 — close 를 거친 것으로 보고 착지로 센다(사용자가 UI 에서 직접 지웠다면 이 가정이 틀린다 — 미확인)'] : []),
  ];
  return { ...out, closed, landing: closed ? 'closed' : git.landing, trailer: { complete, reason, lastTrailer }, commits: commitCount, tip: git.tip, notes };
}

const isSettled = (row) => (row.worker ? SETTLED_WORKER.has(row.worker.state) : false) || (row.taskStatus ? SETTLED_TASK.has(row.taskStatus) : false);

/** A dispatch exists and nothing in Orca says it has settled (a missing worker row counts as unsettled). */
const isInFlight = (row) => row.latest !== null && !isSettled(row) && row.landing !== 'closed' && row.landing !== 'landed';

function nextForDispatched(row, runFile) {
  const workerFailed = row.worker?.state === 'failed' || row.taskStatus === 'failed';
  if (workerFailed && row.landing === 'done-unlanded') {
    return { kind: 'conflict', text: `worker 는 failed 로 정산됐는데 브랜치에 트레일러 done 이 있다 — git 이 진실원이다. 보고 본문을 읽고 land 체크(node ${scriptPath('split', 'land.mjs')} ${row.limb} --plan ${toPosix(runFile)}) 여부를 정한다` };
  }
  if (workerFailed) {
    return row.failedDispatches >= 2
      ? { kind: 'owner', text: `실패 ${row.failedDispatches}회 — 재시도하지 않고 오너에게 올린다` }
      : { kind: 'retry', text: `실패 — 원인을 보고 같은 Task(${row.latest.taskId})로 worker-start --retry-of ${row.latest.dispatchId}, 또는 계획 수정` };
  }
  if (row.landing === 'done-unlanded') return { kind: 'land-check', text: `트레일러 done · 미착지 — land 체크: node ${scriptPath('split', 'land.mjs')} ${row.limb} --plan ${toPosix(runFile)}` };
  if (isSettled(row)) return { kind: 'return-incomplete', text: `보고는 끝났는데 트레일러 done 이 없다(${row.trailer.reason}) — 완료 아님: send --to dispatch:${row.latest.dispatchId} 로 반송` };
  if (!row.worker) return { kind: 'unknown', text: 'Orca worker 행이 없다 — worker-list 누락(잘림)이거나 다른 Run. worker-show --dispatch 로 확인' };
  if (row.worker.liveness !== 'live') return { kind: 'investigate', text: `worker liveness=${row.worker.liveness} 인데 정산 전 — worker-show 확인, lost escalation 을 기다린다(침묵만으로 죽었다고 단정하지 않는다)` };
  return { kind: 'wait', text: '진행 중 — Orca 가 깨운다(폴링 금지)' };
}

/** The per-limb next action: a decision table over the measured facts and the landed set. */
export function nextForRow(row, ctx) {
  if (row.landing === 'closed') return { kind: 'closed', text: '닫힘 — 할 일 없음' };
  if (row.landing === 'landed') return { kind: 'close', text: `착지됨 — node ${scriptPath('orca', 'close.mjs')} ${row.limb}` };
  if (!row.bound) {
    const blocked = row.deps.filter((dep) => !ctx.landed.has(dep));
    return blocked.length > 0
      ? { kind: 'wait-deps', text: `대기 — 선행 미착지: ${blocked.join(', ')}` }
      : { kind: 'ready-to-start', text: '시작 가능 — worktree create → bind worktree → task-create → worker-start → bind dispatch' };
  }
  if (row.latest === null) return { kind: 'finish-start', text: '바인딩됨 · 워커 미시작 — task-create → worker-start → bind dispatch 로 이어서 시작' };
  return nextForDispatched(row, ctx.runFile);
}

// ── launch approval (E1) ─────────────────────────────────────────────────────

/** Whether the launch approval pair is closed in the wall-clock store, and the human-wait numbers (null stays null). */
export function launchApproval(run, storeDir) {
  const started = run.limbs.some((row) => Array.isArray(row.dispatches) && row.dispatches.length > 0);
  if (!isFilled(run.runId)) return { status: 'no-run-id', closedPairs: 0, totalMs: null, humanWaitMs: null, humanWaitPct: null };
  const summary = summarizeWallClock(readSplitEvents(run.runId, { storeDir }));
  const closedPairs = closedConfirmLaunchPairs(summary).length;
  return {
    status: closedPairs > 0 ? 'recorded' : (started ? 'MISSING' : 'pending'),
    closedPairs, totalMs: summary.totalMs, humanWaitMs: summary.humanWaitMs, humanWaitPct: summary.humanWaitPct,
  };
}

// ── the whole status ─────────────────────────────────────────────────────────

/**
 * Measure everything and decide. Synchronous: all I/O is the injected `exec` plus local files.
 *
 * @param {{ parentRoot: string, exec?: Function, capacity?: number, storeDir?: string, fetch?: boolean }} input
 * @returns {object} `{ ok:false, error }` or the status document
 */
export function collectStatus({ parentRoot, exec = defaultExec, capacity = DEFAULT_CAPACITY, storeDir, fetch = false }) {
  const loaded = loadRun(parentRoot);
  if (!loaded.ok) return loaded;
  const { run } = loaded;
  const integrationRef = run.integrationRef ?? 'origin/master';
  const warnings = [];
  if (fetch) {
    const res = exec('git', ['fetch', 'origin'], { cwd: parentRoot });
    if (!res.ok) warnings.push(`git fetch origin 실패(${res.error}) — ${integrationRef} 참조가 낡았을 수 있다`);
  }
  const facts = fetchOrcaFacts(exec, run.runId);
  warnings.push(...facts.warnings);
  const ctx = { parentRoot, exec, facts, integrationRef, runFile: orcaRunPath(parentRoot) };
  const measured = run.limbs.map((row) => observeLimb(row, ctx));
  const landed = new Set(measured.filter((r) => r.landing === 'landed' || r.landing === 'closed').map((r) => r.limb));
  const rows = measured.map((r) => ({ ...r, inFlight: isInFlight(r), next: nextForRow(r, { landed, runFile: ctx.runFile }) }));
  const observed = {
    landed: [...landed], capacity,
    inFlight: rows.filter((r) => r.inFlight).map((r) => r.limb),
    doneUnlanded: rows.filter((r) => r.landing === 'done-unlanded').map((r) => r.limb),
    withWorktree: rows.filter((r) => r.bound && r.worktreePath && fs.existsSync(r.worktreePath)).map((r) => r.limb),
  };
  const approval = launchApproval(run, storeDir);
  if (approval.status === 'MISSING') warnings.push('launch 승인 쌍(confirm-launch)이 닫혀 있지 않은데 워커가 이미 시작됐다 — mark.mjs 로 기록이 빠졌거나 승인 없이 시작했다');
  return {
    ok: true, run: { runId: run.runId ?? null, tag: run.tag ?? null, objective: run.objective ?? null, integrationRef }, capacity, rows,
    nextActions: nextActions(run, observed), launchApproval: approval, warnings,
  };
}

// ── mail ─────────────────────────────────────────────────────────────────────

const dispatchOwner = (run, dispatchId) => {
  for (const row of run.limbs) {
    const dispatch = (row.dispatches ?? []).find((d) => d.dispatchId === dispatchId);
    if (dispatch) return { row, dispatch };
  }
  return null;
};

/** `cmdLine` that answers `null` instead of throwing: a hint built from a message field must never take the whole classification down. */
const tryCmd = (...tokens) => {
  try { return cmdLine(...tokens); } catch { return null; }
};

const sendHint = (dispatchId) => tryCmd('orca', 'orchestration', 'send', '--to', `dispatch:${dispatchId}`, '--subject', '<topic>', '--body', '<message>');

function retryHint(row, dispatch) {
  return tryCmd('orca', 'orchestration', 'worker-start', '--task', dispatch.taskId, '--retry-of', dispatch.dispatchId, '--worktree', `id:${row.worktreeId}`, '--agent', '<agent>', '--json');
}

/** Failed dispatches of a limb: the ones Orca lists as failed plus the failed `worker_done` mails of this batch. */
function failureCount(row, facts, batch) {
  const ids = new Set((facts.workers ?? []).filter((w) => w.state === 'failed' && (row.dispatches ?? []).some((d) => d.dispatchId === w.dispatchId)).map((w) => w.dispatchId));
  for (const id of batch.get(row.limb) ?? []) ids.add(id);
  return ids.size;
}

function gitOf(owner, ctx) {
  if (!owner.row.branch) return null;
  return observeLimbGit({ parentRoot: ctx.parentRoot, row: owner.row, integrationRef: ctx.integrationRef, exec: ctx.exec });
}

function doneSucceeded(item, owner, ctx) {
  const git = gitOf(owner, ctx);
  if (git === null) return { ...item, verdict: 'unbound', action: '이 줄기는 worktree 바인딩이 없다 — run.json 확인(bind.mjs worktree 누락?)' };
  if (!git.completion.complete) {
    const last = git.completion.lastTrailer ? `, 마지막 트레일러 ${git.completion.lastTrailer}` : '';
    return { ...item, verdict: 'return-incomplete', action: `완료 아님 — 반송. 트레일러 done 커밋이 없다(${git.completion.reason}${last}). 커밋 + 트레일러 확인 뒤 다시 보고하라고 send`, commands: [sendHint(owner.dispatch.dispatchId)] };
  }
  if (git.landing === 'landed') return { ...item, verdict: 'already-landed', action: `이미 착지 — close: node ${scriptPath('orca', 'close.mjs')} ${owner.row.limb}` };
  const land = `node ${scriptPath('split', 'land.mjs')} ${owner.row.limb} --plan ${toPosix(orcaRunPath(ctx.parentRoot))}`;
  return { ...item, verdict: 'land-check', action: 'land 체크 7행 실행 — PASS 면 착지 대기열, FAIL 이면 빨간 행 detail 을 send 로 반송', commands: [land] };
}

function doneFailed(item, owner, ctx) {
  const count = failureCount(owner.row, ctx.facts, ctx.batchFailures);
  if (count >= 2) return { ...item, verdict: 'failed-owner', action: `같은 줄기의 실패 보고 ${count}회 — 재시도하지 않고 오너에게 올린다(완료로 표시하지 않는다)` };
  return { ...item, verdict: 'failed-retry', action: `실패 보고 ${count}회째 — 완료 아님. 원인을 보고 같은 Task 로 재시도하거나 계획을 고친다`, commands: [retryHint(owner.row, owner.dispatch)] };
}

function classifyDone(item, owner, ctx) {
  if (item.outcome === 'succeeded') return doneSucceeded(item, owner, ctx);
  if (item.outcome === 'failed') return doneFailed(item, owner, ctx);
  return { ...item, verdict: 'other', action: `worker_done 의 outcome 이 ${String(item.outcome)} — 본문을 읽고 판단` };
}

function classifyEscalation(item, owner, ctx) {
  if (!item.stopReason) {
    return { ...item, verdict: 'blocked', action: '워커가 막혔다고 올렸다 — 승인하지 않는다. 줄기 범위 밖 요청이면 deny, 범위 안이면 오너에게 올린다' };
  }
  const git = owner ? gitOf(owner, ctx) : null;
  if (git?.completion.complete) {
    return { ...item, verdict: 'lost-complete', action: `워커 정지(${item.stopReason}) — 그러나 트레일러 done 이 있다: 완료 경로(land 체크)로 간다`, commands: [`node ${scriptPath('split', 'land.mjs')} ${owner.row.limb} --plan ${toPosix(orcaRunPath(ctx.parentRoot))}`] };
  }
  const retry = owner ? [retryHint(owner.row, owner.dispatch)] : [];
  const why = git ? `트레일러 없음(${git.completion.reason})` : 'git 상태를 읽지 못함';
  return { ...item, verdict: 'lost-retry', action: `워커 정지(${item.stopReason}) · ${why} — git 상태가 문맥이다: 같은 Task 로 --retry-of 재시작, 반복되면 오너. 침묵만으로 죽었다고 단정하지 않는다`, commands: retry };
}

function classifyMessage(msg, ctx) {
  const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : {};
  const owner = isFilled(payload.dispatchId) ? dispatchOwner(ctx.run, payload.dispatchId) : null;
  const item = {
    id: msg?.id ?? null, type: msg?.type ?? null, kind: ['worker_done', 'question', 'escalation'].includes(msg?.type) ? msg.type : 'other',
    limb: owner?.row.limb ?? null, dispatchId: payload.dispatchId ?? null, taskId: payload.taskId ?? null, priority: msg?.priority ?? 'normal',
    outcome: payload.outcome ?? null, stopReason: payload.stopReason ?? null, verdict: 'other', action: '', commands: [],
  };
  if (item.kind === 'other') return { ...item, action: `기타 메일(${String(msg?.type)}) — 본문을 읽고 판단` };
  if (!owner && item.kind !== 'escalation') return { ...item, verdict: 'unknown-dispatch', action: `dispatch ${String(item.dispatchId)} 가 run.json 에 없다 — bind.mjs dispatch 누락?` };
  if (item.kind === 'worker_done') return classifyDone(item, owner, ctx);
  if (item.kind === 'escalation') return classifyEscalation(item, owner, ctx);
  return {
    ...item, verdict: 'answer',
    action: '브리프·계획·오너 지시에서 답이 나오면 reply, 아니면 AskUserQuestion 뒤 reply. 사람 게이트 행동을 넘긴 질문이면 승인된 행동은 오너가 보는 리더 세션에서 하거나 줄기 범위에서 뺀다(워커에게 "승인됐으니 하라" 금지)',
    commands: [tryCmd('orca', 'orchestration', 'reply', '--id', String(msg.id), '--body', '<answer>')],
  };
}

/** The message list of a `check --json` document (also accepts a bare array or `{ messages }`). */
export function messagesOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc?.result?.messages)) return doc.result.messages;
  return Array.isArray(doc?.messages) ? doc.messages : null;
}

/**
 * Classify one `orca orchestration check --json` document against run.json and git.
 *
 * @returns {{ ok:true, items:object[], counts:Record<string,number>, warnings:string[] } | { ok:false, error:string }}
 */
export function classifyMail({ doc, parentRoot, exec = defaultExec }) {
  const messages = messagesOf(doc);
  if (messages === null) return { ok: false, error: 'check 출력에서 messages 배열을 찾지 못했다' };
  const loaded = loadRun(parentRoot);
  if (!loaded.ok) return loaded;
  const { run } = loaded;
  const facts = fetchOrcaFacts(exec, run.runId);
  const batchFailures = new Map();
  for (const msg of messages) {
    const owner = msg?.type === 'worker_done' && msg.payload?.outcome === 'failed' ? dispatchOwner(run, msg.payload?.dispatchId) : null;
    if (owner) batchFailures.set(owner.row.limb, new Set([...(batchFailures.get(owner.row.limb) ?? []), msg.payload.dispatchId]));
  }
  const ctx = { run, parentRoot, exec, facts, batchFailures, integrationRef: run.integrationRef ?? 'origin/master' };
  const items = messages.map((msg) => {
    const item = classifyMessage(msg, ctx);
    return { ...item, commands: item.commands.filter((c) => typeof c === 'string') };
  });
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return { ok: true, items, counts, warnings: facts.warnings };
}

// ── bounded stall check (--stall) ────────────────────────────────────────────

/** `no-change` only when the tip, the Task status and the worker state are all identical to the previous snapshot. */
export function judgeStall(previous, current) {
  if (!previous) return { verdict: 'baseline', streak: 0 };
  const same = previous.tip === current.tip && previous.taskStatus === current.taskStatus && previous.workerState === current.workerState;
  return same ? { verdict: 'no-change', streak: (previous.streak ?? 0) + 1 } : { verdict: 'changed', streak: 0 };
}

const stallPath = (parentRoot) => path.join(parentRoot, '.artibot', 'orca', 'stall.json');

function readStallSnapshot(parentRoot) {
  try {
    const doc = JSON.parse(fs.readFileSync(stallPath(parentRoot), 'utf-8'));
    return doc && typeof doc.limbs === 'object' && doc.limbs !== null ? doc.limbs : {};
  } catch { return {}; }
}

const STALL_ACTION = {
  baseline: '기준선 기록(첫 점검) — 아무것도 하지 않는다',
  changed: '변화 있음 — 아무것도 하지 않고 타이머만 다시 건다',
  'no-change': '변화 없음 — 처음이면 그 워커에 send 로 상태 한 줄을 묻는다',
};

/** Judge every in-flight limb against the previous snapshot, then store the new one. */
export function runStall({ parentRoot, rows, now = () => new Date() }) {
  const previous = readStallSnapshot(parentRoot);
  const limbs = {};
  const verdicts = rows.filter((r) => r.inFlight).map((r) => {
    const current = { tip: r.tip, taskStatus: r.taskStatus, workerState: r.worker?.state ?? null };
    const judged = judgeStall(previous[r.limb], current);
    limbs[r.limb] = { ...current, streak: judged.streak };
    const action = judged.verdict === 'no-change' && judged.streak >= 2 ? '두 번 연속 변화 없음 — 오너에게 올린다(워크스페이스 카드 --unread + 한 줄 comment)' : STALL_ACTION[judged.verdict];
    return { limb: r.limb, ...judged, action };
  });
  atomicWriteJsonSync(stallPath(parentRoot), { schema_version: STALL_SCHEMA_VERSION, at: now().toISOString(), limbs });
  return verdicts;
}

// ── rendering ────────────────────────────────────────────────────────────────

const cell = (value) => (value === null || value === undefined ? '-' : String(value));

/** The drill-down printed under a single-limb view: ids, paths, the newest dispatch. */
function renderDetail(r) {
  const latest = r.latest ? `${r.latest.dispatchId} (task ${r.latest.taskId}, ${r.latest.kind})` : '-';
  return [
    `  worktreeId ${cell(r.worktreeId)}`, `  path       ${cell(r.worktreePath === null ? null : toPosix(r.worktreePath))}`, `  forkPoint  ${cell(r.forkPoint)}`,
    `  tip        ${cell(r.tip)}`, `  dispatch   ${latest} · dispatches ${r.dispatches.length} · failed ${r.failedDispatches}`,
  ].join('\n');
}

function renderStatus(doc, { detail = false } = {}) {
  const head = ['limb', 'branch', 'landing', 'task', 'worker', 'trailer', 'commits'];
  const lines = doc.rows.map((r) => [
    r.limb, cell(r.branch), cell(r.landing), cell(r.taskStatus), r.worker ? `${cell(r.worker.state)}/${cell(r.worker.liveness)}` : '-',
    r.trailer ? (r.trailer.complete ? 'done' : cell(r.trailer.reason)) : '-', r.commits,
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const pad = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  const body = lines.map((cols, i) => `${pad(cols)}  → ${doc.rows[i].next.text}`);
  const notes = doc.rows.flatMap((r) => r.notes.map((n) => `note[${r.limb}]: ${n}`));
  const details = detail ? doc.rows.map(renderDetail) : [];
  const a = doc.launchApproval;
  return [
    `/orca status — run ${cell(doc.run.runId)} · tag ${cell(doc.run.tag)} · ${doc.run.integrationRef} · capacity ${doc.capacity}`,
    pad(head), ...body, ...details, '',
    `launch 승인: ${a.status} · closed pairs ${a.closedPairs} · humanWaitPct ${String(a.humanWaitPct)} (null = 미측정)`,
    ...notes, ...doc.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}

const renderNext = (doc) => doc.nextActions.map((a) => {
  const names = (a.limbs ?? (a.limb ? [a.limb] : [])).join(', ');
  return `[${a.kind}] ${names ? `${names} — ` : ''}${a.reason}`;
}).join('\n');

function renderMail(result) {
  if (result.items.length === 0) return 'mail: 메시지 없음';
  const lines = result.items.map((i) => [
    `[${i.kind}${i.priority === 'high' ? ' HIGH' : ''}] ${i.id} · limb ${cell(i.limb)} · dispatch ${cell(i.dispatchId)} → ${i.verdict}`,
    `    ${i.action}`, ...i.commands.map((c) => `    $ ${c}`),
  ].join('\n'));
  return [`mail: ${result.items.length}건 (${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(' · ')})`, ...lines, ...result.warnings.map((w) => `warning: ${w}`)].join('\n');
}

function renderStall(verdicts) {
  return verdicts.length === 0 ? 'stall: 진행 중 줄기 없음' : ['stall:', ...verdicts.map((v) => `  ${v.limb}: ${v.verdict} (streak ${v.streak}) — ${v.action}`)].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export const HELP = `usage:
  node scripts/orca/status.mjs [--parent <root>] [--json] [--next] [--fetch] [--limb <l>] [--stall]
  node scripts/orca/status.mjs mail --file <check-output.json|-> [--parent <root>] [--json]

  --next    print only the next actions (start / land / close / idle)
  --fetch   git fetch origin first (remote-tracking refs only)
  --limb    show one limb row
  --stall   judge in-flight limbs against the previous --stall snapshot (.artibot/orca/stall.json) and store the new one
  mail      classify 'orca orchestration check --json' output; the limb comes from payload.dispatchId

Read-only toward Orca: only read verbs are executed, every state-changing command is printed for the leader.`;

/** @returns {{ ok:true, mail:boolean, file:string|null, parent:string|null, json:boolean, next:boolean, fetch:boolean, stall:boolean, limb:string|null, help:boolean } | { ok:false, error:string, json:boolean }} */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const json = list.includes('--json');
  const out = { ok: true, mail: false, file: null, parent: null, json, next: false, fetch: false, stall: false, limb: null, help: false };
  const valued = { '--parent': 'parent', '--file': 'file', '--limb': 'limb' };
  const flags = { '--next': 'next', '--fetch': 'fetch', '--stall': 'stall', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--json') continue;
    if (a === 'mail' && i === 0) out.mail = true;
    else if (flags[a]) out[flags[a]] = true;
    else if (valued[a]) {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, error: `${a} requires a value`, json };
      out[valued[a]] = v;
      i += 1;
    } else return { ok: false, error: a.startsWith('-') ? `unknown option: ${a}` : `unexpected argument: ${a}`, json };
  }
  if (out.mail && !out.file && !out.help) return { ok: false, error: 'mail requires --file <check-output.json|->', json };
  if (!out.mail && out.file) return { ok: false, error: '--file is only meaningful with mail', json };
  return out;
}

function readMailFile(file) {
  try {
    const text = file === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(file, 'utf-8');
    return { ok: true, doc: JSON.parse(text.replace(/^\u{FEFF}/u, '')) };
  } catch (err) {
    return { ok: false, error: `check 출력을 읽지 못했다(${file}): ${err?.message ?? err}` };
  }
}

function capacityOf(config) {
  const cap = config?.split?.maxWindows;
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAPACITY;
}

function runCli(args, deps) {
  const parentRoot = path.resolve(args.parent ?? deps.cwd);
  const root = checkParentIsRoot(deps.exec, parentRoot);
  if (!root.ok) return { result: root, text: root.error };
  if (args.mail) {
    const file = readMailFile(args.file);
    if (!file.ok) return { result: file, text: file.error };
    const result = classifyMail({ doc: file.doc, parentRoot, exec: deps.exec });
    return { result, text: result.ok ? renderMail(result) : result.error };
  }
  const doc = collectStatus({ parentRoot, exec: deps.exec, capacity: capacityOf(deps.config), storeDir: deps.storeDir, fetch: args.fetch });
  if (!doc.ok) return { result: doc, text: doc.error };
  const rows = args.limb ? doc.rows.filter((r) => r.limb === args.limb) : doc.rows;
  if (args.limb && rows.length === 0) return { result: { ok: false, error: `limb "${args.limb}" 이 run.json 에 없다` }, text: `limb "${args.limb}" 이 run.json 에 없다` };
  const stall = args.stall ? runStall({ parentRoot, rows: doc.rows, now: deps.now }) : null;
  const shown = { ...doc, rows, ...(stall ? { stall } : {}) };
  const parts = [args.next ? renderNext(shown) : renderStatus(shown, { detail: args.limb !== null }), ...(stall ? [renderStall(stall)] : [])];
  return { result: shown, text: parts.join('\n\n') };
}

/**
 * CLI entry. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, exec?: Function, config?: object|null, storeDir?: string, now?: () => Date, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  if (!args.ok) {
    if (args.json) out(`${JSON.stringify({ ok: false, error: args.error })}\n`);
    else err(`${args.error}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  let config = opts.config;
  if (config === undefined) {
    try { config = await loadConfig(); } catch { config = null; }
  }
  let outcome;
  try {
    outcome = runCli(args, { cwd: opts.cwd ?? process.cwd(), exec: opts.exec ?? defaultExec, config, storeDir: opts.storeDir, now: opts.now });
  } catch (error) {
    const message = `unexpected failure: ${error?.message ?? error}`;
    outcome = { result: { ok: false, error: message }, text: message };
  }
  const { result, text } = outcome;
  if (args.json) out(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) out(`${text}\n`);
  else err(`${text}\n`);
  return result.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
