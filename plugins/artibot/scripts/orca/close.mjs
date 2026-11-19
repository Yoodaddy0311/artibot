#!/usr/bin/env node
/**
 * `orca close <limb>` — make a limb safe to delete, then PRINT the commands that
 * delete it (DESIGN §4.4 close, §10 change 4, §11.6). It never runs a command
 * that changes Orca: every worker-release / worktree-rm / task-update line is
 * output for the leader to type, after the guards below passed.
 *
 *   node scripts/orca/close.mjs <limb> [--abandon] [--parent <root>] [--json]
 *
 * The order is the contract — each step must pass before the next, and the
 * commands are printed only when ALL of them passed (fail closed, no partial
 * output of the deleting lines):
 *   1. landing   trailer `done` AND commits > 0 AND tip is an ancestor of the
 *                integration ref (`landingState`; an empty limb is an ancestor of
 *                everything and is NOT landed). `--abandon` skips this step.
 *   2. report    `report.md` is copied to the parent's `.artibot/orca/<limb>/`
 *                BEFORE anything is deleted — it lives in an ignored path and
 *                goes away with the worktree. Never overwrites (a different
 *                second report becomes `report-2.md`).
 *   3. teardown  `scripts/split/worktree-setup.mjs --teardown` removes ONLY
 *                reparse points (the node_modules junction). It must run before
 *                the clean check: a junction makes `git status` list its target's
 *                contents as untracked (P0-8, 2026-11-19) and Orca then refuses
 *                the removal.
 *   4. reparse   no reparse point is left in the worktree (bounded walk: `.git` is
 *                not entered; a real `node_modules` is looked at one level — its
 *                direct children and the children of its `@<scope>` folders — and
 *                nothing below a package). A junction followed by a recursive
 *                delete would take the PARENT's files with it.
 *   5. clean     `git status --porcelain` is empty — a forced removal would drop
 *                uncommitted work silently. (`--abandon` only reports it.) The
 *                failure text says the teardown ALREADY removed the junction and
 *                that `bind.mjs worktree` (idempotent) puts it back.
 *
 * A value in run.json that no command line can carry (a newline, NUL, ESC or a
 * typographic quote U+2018-U+201F — a tampered or damaged file) does not slip
 * through quoting: every guard may pass, but the close then FAILS with the reason
 * and prints no command (`shellQuote` refuses such a token).
 *
 * Exit codes are not the truth about removal (§10 change 4): the first
 * `worktree rm` can fail on Windows with Permission denied on
 * `.git/worktrees/<name>` and succeed when replayed with IDENTICAL flags (a
 * different flag set is refused by Orca). So the output carries three
 * verification commands (git worktree list, git branch, Orca worktree list) and
 * says to replay once. A leftover `.git/worktrees/<name>` folder is tolerated.
 *
 * `--abandon` (a limb dropped before landing): the same teardown and report copy,
 * but the worktree and the branch are KEPT and the only command printed is the
 * Orca task-update that records the disposition there. The plugin keeps no
 * disposition key (DESIGN §4.4). If the worker is still alive, stopping it is the
 * owner's explicit instruction, not something this script prints.
 *
 * Exit codes: 0 every guard passed (or already closed) · 1 usage / a guard failed.
 *
 * @module scripts/orca/close
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry } from '../hooks/_main-entry.js';
import { atomicWriteBytes, checkParentIsRoot, cmdLine, defaultExec, loadRun, observeLimbGit, runWorktreeSetup, toPosix } from './status.mjs';

/** Said when a later guard (clean tree) stops the close AFTER the teardown step already removed the node_modules junction. */
export const JUNCTION_RESTORE_NOTE = 'teardown 이 이미 junction 을 제거했다 — 작업을 이어가려면 bind.mjs worktree 를 다시 실행(멱등)해 junction 을 복구한다';

const MAX_WALK_ENTRIES = 100_000;
const MAX_REPORT_VERSIONS = 99;
const DIRTY_LINES_SHOWN = 10;

const isFilled = (value) => typeof value === 'string' && value.trim() !== '';

export const HELP = `usage: node scripts/orca/close.mjs <limb> [--abandon] [--parent <root>] [--json]

  guards, in order: landing -> report.md copy -> junction teardown -> reparse point 0 -> clean tree
  prints (never runs): worker-release, worktree rm, and the three verification commands
  --abandon   limb dropped before landing: same teardown + report copy, worktree and branch stay,
              prints only the Orca task-update that records the cancellation`;

/** @returns {{ ok:true, limb:string, abandon:boolean, parent:string|null, json:boolean, help:boolean } | { ok:false, error:string, json:boolean }} */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const json = list.includes('--json');
  const out = { ok: true, limb: '', abandon: false, parent: null, json, help: false };
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--json') continue;
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--abandon') out.abandon = true;
    else if (a === '--parent') {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, error: '--parent requires a value', json };
      out.parent = v;
      i += 1;
    } else if (a.startsWith('-')) return { ok: false, error: `unknown option: ${a}`, json };
    else if (out.limb === '') out.limb = a;
    else return { ok: false, error: `unexpected argument: ${a}`, json };
  }
  if (out.limb === '' && !out.help) return { ok: false, error: 'missing <limb>', json };
  return out;
}

// ── step 2: report.md ────────────────────────────────────────────────────────

/**
 * Copy the worker's `report.md` into the parent's orchestration state folder.
 * Identical bytes already stored = nothing to do; different bytes get the next free `report-<n>.md`.
 *
 * @returns {{ status: 'absent'|'copied'|'already-copied', path: string|null }}
 */
export function copyReport(source, destDir) {
  if (!fs.existsSync(source)) return { status: 'absent', path: null };
  const bytes = fs.readFileSync(source);
  fs.mkdirSync(destDir, { recursive: true });
  for (let n = 1; n <= MAX_REPORT_VERSIONS; n += 1) {
    const dest = path.join(destDir, n === 1 ? 'report.md' : `report-${n}.md`);
    if (!fs.existsSync(dest)) {
      atomicWriteBytes(dest, bytes);
      return { status: 'copied', path: dest };
    }
    if (fs.readFileSync(dest).equals(bytes)) return { status: 'already-copied', path: dest };
  }
  throw new Error(`report.md: ${MAX_REPORT_VERSIONS} stored versions already exist in ${destDir}`);
}

// ── step 4: reparse points ───────────────────────────────────────────────────

/**
 * Bounded walk for reparse points (junctions / symlinks). Links are reported, never followed;
 * `.git` is not entered. A REAL `node_modules` is looked at one level only: its direct children
 * (`node_modules/<pkg>`) and the children of its `@<scope>` folders (`node_modules/@<scope>/<pkg>`) are
 * lstat-ed and a link among them is reported (pnpm-style layouts are made of exactly those links);
 * nothing below a package is entered (SR-2). A `node_modules` entry that is itself a link is reported
 * too. Every entry looked at counts toward the cap. Unreadable directories and a hit on the cap are
 * returned — the caller must treat either as "not proven".
 *
 * @returns {{ found: string[], scanned: number, capped: boolean, unreadable: string[] }}
 */
export function findReparsePoints(root, { maxEntries = MAX_WALK_ENTRIES } = {}) {
  const found = [];
  const unreadable = [];
  let scanned = 0;
  const stack = [{ dir: root, kind: 'tree' }];
  while (stack.length > 0) {
    const { dir, kind } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { unreadable.push(dir); continue; }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > maxEntries) return { found, scanned, capped: true, unreadable };
      if (entry.name === '.git' || entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      let isLink;
      try { isLink = fs.lstatSync(full).isSymbolicLink(); } catch { unreadable.push(full); continue; }
      if (isLink) found.push(full);
      else if (entry.isDirectory()) {
        const next = nextWalkKind(kind, entry.name);
        if (next !== null) stack.push({ dir: full, kind: next });
      }
    }
  }
  return { found, scanned, capped: false, unreadable };
}

/** Which walk a REAL directory gets: the tree is walked fully, a real node_modules one level, an @scope folder inside it one level, nothing deeper. */
function nextWalkKind(parentKind, name) {
  if (parentKind === 'tree') return name === 'node_modules' ? 'modules' : 'tree';
  return parentKind === 'modules' && name.startsWith('@') ? 'scope' : null;
}

// ── the guard steps ──────────────────────────────────────────────────────────

const pass = (name, detail, extra = {}) => ({ name, ok: true, detail, ...extra });
const fail = (name, detail, extra = {}) => ({ name, ok: false, detail, ...extra });

function stepLanding(ctx) {
  const { git } = ctx;
  const facts = `landing=${git.landing} · 커밋 ${git.completion.commitCount} · 트레일러 ${git.completion.reason} · tip⊂${ctx.integrationRef} ${String(git.ancestor)}`;
  if (ctx.abandon) return pass('landing', `--abandon — 착지를 요구하지 않는다 (${facts})`);
  if (git.landing === 'landed') return pass('landing', `착지 확인 (${facts})`);
  const unreadable = { 'no-branch': '브랜치가 없다', 'git-error': 'git 이 답하지 못했다', 'bad-input': '입력이 잘못됐다' }[git.completion.reason];
  const why = unreadable ? `착지를 증명하지 못한다 — ${unreadable}(${git.completion.reason})` : {
    'no-commits': '커밋이 없다 — 빈 줄기는 착지로 읽히지 않는다',
    'in-progress': `트레일러 done 이 없다(${git.completion.reason})`,
    'done-unlanded': `트레일러 done 인데 ${ctx.integrationRef} 에 아직 없다 — land/integrate 먼저. 병합 직후라면 git fetch origin 으로 참조를 갱신한 뒤 다시`,
  }[git.landing] ?? `알 수 없는 상태 ${git.landing}`;
  return fail('landing', `${why} (${facts})`);
}

function stepReport(ctx) {
  const source = path.join(ctx.row.worktreePath, '.artibot', 'split', ctx.row.limb, 'report.md');
  const destDir = path.join(ctx.parentRoot, '.artibot', 'orca', ctx.row.limb);
  try {
    const copied = copyReport(source, destDir);
    const detail = { absent: 'report.md 없음 — 복사할 것이 없다', copied: `복사: ${toPosix(copied.path ?? '')}`, 'already-copied': `이미 같은 내용이 저장돼 있다: ${toPosix(copied.path ?? '')}` }[copied.status];
    return pass('report', detail, { report: copied });
  } catch (err) {
    return fail('report', `report.md 복사 실패 — 삭제 명령을 내지 않는다: ${err?.message ?? err}`);
  }
}

function stepTeardown(ctx) {
  if (!ctx.worktreeExists) return pass('teardown', 'worktree 폴더가 이미 없다 — junction 정리 생략');
  const res = ctx.runSetup(ctx.row.worktreePath, { parentRoot: ctx.parentRoot, teardown: true });
  if (!res.ok) return fail('teardown', `junction teardown 실패/거부 — ${res.error ?? 'unknown'}`, { rows: res.rows });
  const unlinked = res.rows.filter((r) => r.status === 'done').length;
  return pass('teardown', `reparse point 만 제거 (제거 ${unlinked} · 건너뜀 ${res.rows.length - unlinked})`, { rows: res.rows });
}

function stepReparse(ctx) {
  if (!ctx.worktreeExists) return pass('reparse', 'worktree 폴더가 없다 — 확인할 것이 없다');
  const walk = findReparsePoints(ctx.row.worktreePath, { maxEntries: ctx.maxWalkEntries });
  if (walk.found.length > 0) return fail('reparse', `reparse point 가 남아 있다(${walk.found.length}): ${walk.found.slice(0, 5).map(toPosix).join(', ')}`, { walk });
  if (walk.capped || walk.unreadable.length > 0) {
    return fail('reparse', `reparse point 0 을 증명하지 못했다 — ${walk.capped ? `${walk.scanned}개에서 탐색 상한` : `읽을 수 없는 경로 ${walk.unreadable.length}개`}`, { walk });
  }
  return pass('reparse', `reparse point 0 (항목 ${walk.scanned}개 확인 — .git 제외, node_modules 는 직계·@scope 직계만)`, { walk });
}

function stepClean(ctx) {
  if (!ctx.worktreeExists) return pass('clean', 'worktree 폴더가 없다 — 확인할 것이 없다');
  const res = ctx.exec('git', ['status', '--porcelain'], { cwd: ctx.row.worktreePath });
  if (!res.ok) return fail('clean', `git status 를 읽지 못했다 — 청결을 증명하지 못한다(${res.error})`);
  const dirty = res.stdout.split(/\r?\n/).filter(Boolean);
  if (dirty.length === 0) return pass('clean', '워킹트리 청결');
  const shown = dirty.slice(0, DIRTY_LINES_SHOWN).join(' | ');
  const more = dirty.length > DIRTY_LINES_SHOWN ? ` … 외 ${dirty.length - DIRTY_LINES_SHOWN}건` : '';
  const detail = `커밋되지 않은 변경 ${dirty.length}건: ${shown}${more}`;
  if (ctx.abandon) return pass('clean', `(--abandon: 정보) ${detail}`);
  return fail('clean', `${detail} — 삭제하면 사라진다. 커밋하거나 오너가 버리기로 한 뒤 다시. ${JUNCTION_RESTORE_NOTE}`);
}

const STEPS = Object.freeze([stepLanding, stepReport, stepTeardown, stepReparse, stepClean]);

// ── the lines to type ────────────────────────────────────────────────────────

const REPLAY_NOTE = '첫 worktree rm 은 Windows 에서 .git/worktrees/<name> Permission denied 로 ok:false(exit 1)를 낼 수 있다(P0 실측 2026-11-19). 종료코드를 믿지 말고 아래 검증 3개로 판정한다. 하나라도 남아 있으면 같은 플래그로 1회만 다시 친다 — 다른 플래그로 치면 Orca 가 거부한다. .git/worktrees/<name> 폴더 잔여는 허용한다(기존 Windows 이슈, git worktree prune 도 같은 이유로 실패한다).';

function removalPlan(run, row) {
  const releases = [...row.dispatches].reverse().map((d) => cmdLine('orca', 'orchestration', 'worker-release', '--dispatch', d.dispatchId));
  const remove = cmdLine('orca', 'worktree', 'rm', '--worktree', `id:${row.worktreeId}`, '--force', '--delete-branch', '--json');
  const verify = [
    cmdLine('git', 'worktree', 'list', '--porcelain'),
    cmdLine('git', 'branch', '--list', row.branch),
    cmdLine('orca', 'worktree', 'list', '--limit', '10000', '--json'),
  ];
  return { commands: [...releases, remove], verify, onFailure: REPLAY_NOTE, note: 'worker-release 는 정산된 워커용이다(멱등) — 아직 도는 워커가 있으면 오너 지시 없이 닫지 않는다.' };
}

function abandonPlan(run, row) {
  const latest = row.dispatches[row.dispatches.length - 1];
  if (!latest) return { commands: [], verify: [], onFailure: null, note: '시작된 워커가 없다 — Orca 에 남길 처분이 없다. worktree 와 브랜치는 남긴다.' };
  const update = cmdLine('orca', 'orchestration', 'task-update', '--id', latest.taskId, '--status', 'failed', '--result', 'cancelled', ...(isFilled(run.runId) ? ['--run', run.runId] : []), '--json');
  return { commands: [update], verify: [], onFailure: null, note: 'worktree 와 브랜치는 남긴다. 워커가 아직 살아 있으면 그것을 멈추는 것은 오너의 명시 지시 때만이다(여기서 출력하지 않는다).' };
}

// ── driver ───────────────────────────────────────────────────────────────────

function prepare(args, deps) {
  const parentRoot = path.resolve(args.parent ?? deps.cwd);
  const root = checkParentIsRoot(deps.exec, parentRoot);
  if (!root.ok) return root;
  const loaded = loadRun(parentRoot);
  if (!loaded.ok) return loaded;
  const row = loaded.run.limbs.find((l) => l.limb === args.limb);
  if (!row) return { ok: false, error: `limb "${args.limb}" 이 run.json 에 없다 (있는 것: ${loaded.run.limbs.map((l) => l.limb).join(', ') || '없음'})` };
  if (![row.worktreeId, row.worktreePath, row.branch].every(isFilled)) return { ok: false, error: `limb "${args.limb}" 은 worktree 에 바인딩되지 않았다 — 닫을 것이 없다` };
  const integrationRef = loaded.run.integrationRef ?? 'origin/master';
  const git = observeLimbGit({ parentRoot, row, integrationRef, exec: deps.exec });
  return {
    ok: true, run: loaded.run, row: { ...row, dispatches: Array.isArray(row.dispatches) ? row.dispatches : [] },
    ctx: { parentRoot, integrationRef, git, abandon: args.abandon, exec: deps.exec, runSetup: deps.runSetup, maxWalkEntries: deps.maxWalkEntries, worktreeExists: fs.existsSync(row.worktreePath) },
  };
}

/**
 * Run the guards for one limb and build the printable commands.
 *
 * @returns {object} `{ ok:false, error, checks? }` or `{ ok:true, ... commands, verify, onFailure }`
 */
export function runClose(args, deps) {
  const prepared = prepare(args, deps);
  if (!prepared.ok) return prepared;
  const { run, row } = prepared;
  const ctx = { ...prepared.ctx, row };
  if (ctx.git.completion.reason === 'no-branch' && !ctx.worktreeExists) {
    return { ok: true, limb: args.limb, abandon: args.abandon, alreadyClosed: true, checks: [], commands: [], verify: [], onFailure: null, note: '브랜치와 worktree 가 이미 없다 — 닫을 것이 없다. Orca 목록 잔여만 확인하라.' };
  }
  const checks = [];
  for (const step of STEPS) {
    const check = step(ctx);
    checks.push(check);
    if (!check.ok) return { ok: false, limb: args.limb, abandon: args.abandon, error: `${check.name}: ${check.detail}`, checks };
  }
  let plan;
  try {
    plan = args.abandon ? abandonPlan(run, row) : removalPlan(run, row);
  } catch (err) {
    // A value in run.json that no command line can carry safely (a newline, NUL, ESC or a typographic quote — a tampered or
    // damaged file): every guard passed, but no command is printed, and the reason says why (SR-4).
    return { ok: false, limb: args.limb, abandon: args.abandon, error: `명령 줄을 안전하게 만들 수 없다 — 명령을 내지 않는다(run.json 의 id·경로 값을 확인): ${err?.message ?? err}`, checks };
  }
  return { ok: true, limb: args.limb, abandon: args.abandon, alreadyClosed: false, checks, ...plan };
}

function renderClose(r) {
  const head = r.alreadyClosed ? `close ${r.limb}: 이미 닫혀 있다` : `close ${r.limb}${r.abandon ? ' (--abandon)' : ''}: 모든 guard 통과`;
  const checks = (r.checks ?? []).map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
  const commands = r.commands.length > 0 ? ['', '아래를 리더가 직접 친다(이 스크립트는 실행하지 않았다):', ...r.commands.map((c) => `  $ ${c}`)] : [];
  const verify = r.verify.length > 0 ? ['', '검증(종료코드 대신 이 3개로 판정):', ...r.verify.map((c) => `  $ ${c}`)] : [];
  return [head, ...checks, ...commands, ...verify, ...(r.onFailure ? ['', r.onFailure] : []), ...(r.note ? ['', r.note] : [])].join('\n');
}

/**
 * CLI entry. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, exec?: Function, runSetup?: Function, maxWalkEntries?: number, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {number}
 */
export function main(argv, opts = {}) {
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
  const deps = { cwd: opts.cwd ?? process.cwd(), exec: opts.exec ?? defaultExec, runSetup: opts.runSetup ?? runWorktreeSetup, maxWalkEntries: opts.maxWalkEntries };
  let result;
  try {
    result = runClose(args, deps);
  } catch (error) {
    // Fail closed and tidy: an unexpected exception (a token no shell quoting can carry, a vanished path) is a refusal, not a stack trace.
    result = { ok: false, limb: args.limb, abandon: args.abandon, error: `unexpected failure: ${error?.message ?? error}`, checks: [] };
  }
  if (args.json) out(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) out(`${renderClose(result)}\n`);
  else err(`${renderFailure(result)}\n`);
  return result.ok ? 0 : 1;
}

function renderFailure(r) {
  const checks = (r.checks ?? []).map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
  return [`close ${r.limb ?? ''}: 중단 — ${r.error}`, ...checks, '삭제 명령은 출력하지 않는다(fail closed).'].join('\n');
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
