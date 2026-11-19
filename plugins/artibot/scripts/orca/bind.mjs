#!/usr/bin/env node
/**
 * `orca bind` — record what Orca created, equip the worktree, print the next
 * command (DESIGN §4.3 identifiers, §4.4-7, §10 change 8, §11.6).
 *
 *   node scripts/orca/bind.mjs run      --run-id <runId> [--parent <root>] [--json]
 *   node scripts/orca/bind.mjs worktree <limb> --worktree <selector> [--brief <file>] [--parent <root>] [--json]
 *   node scripts/orca/bind.mjs dispatch <limb> --task <orcaTaskId> --dispatch <dispatchId> [--kind initial|retry|rework] [--parent <root>] [--json]
 *
 * The leader's ids go in; the script READS Orca (`worktree show`, a read verb —
 * every call goes through `callOrcaJson`'s allowlist) and never changes it. The
 * next Orca command is printed, not run.
 *
 * `worktree` — the limb's stable key is the worktree id Orca issued; branch, path
 * and the fork point are observed, not predicted:
 *   - refuses the main checkout (a junction or a teardown there would act on the
 *     parent) and a branch name the session hook would relocate
 *     (`^[A-Za-z0-9_-]+$` — `scripts/hooks/git-autopilot-session.js`; a name with a
 *     slash, such as `orca/<limb>-<tag>`, stays put);
 *   - `forkPoint` = `git rev-parse HEAD` of the fresh worktree, written ONCE
 *     (`bindLimb` keeps the first value): re-measuring after the worker committed
 *     would move the base to the tip and `land`'s `forkPoint..branch` diff would
 *     skip the limb's own work. It must be an ancestor of the integration ref —
 *     a HEAD with commits of its own is not a fork point and is refused;
 *   - the binding is recorded FIRST, then the worktree is equipped (junction via
 *     `scripts/split/worktree-setup.mjs`, brief + `prompt.md` into the limb contract
 *     directory of the worktree). A failure after the binding leaves it recorded and
 *     exits 1; running the same command again is idempotent.
 * `prompt.md` is rendered from `templates/orca/PROMPT-TEMPLATE.md` through
 * `lib/git/split-brief.js#renderPrompt` (an unresolved placeholder is refused).
 * The `[보고 계약]` block is read from `commands/team.md` — the canonical copy — and
 * addressed to `main`: inside the worker it is for the worker's own teammates. The
 * worker → leader channel is Orca mail, not SendMessage.
 *
 * `dispatch` — an append-only receipt (`appendDispatch`). A start that FAILED is
 * recorded too, with the ids its receipt carries. The same dispatch twice is a
 * no-op, a second dispatch for a limb needs an explicit `--kind retry|rework`.
 *
 * Exit codes: 0 ok · 1 usage / a check failed. `--json`: one document, `{ ok:false, error }` on failure.
 *
 * @module scripts/orca/bind
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry } from '../hooks/_main-entry.js';
import { loadConfig } from '../../lib/core/config.js';
import { appendDispatch, bindLimb, DISPATCH_KINDS, LIMB_SLUG } from '../../lib/git/orca-plan.js';
import { updateOrcaRun } from '../../lib/git/orca-run-file.js';
import {
  DEFAULT_REQUIRED_SECTIONS, extractReportContract, missingSections, renderModelPolicy, renderPrompt, SIBLING_FILES,
} from '../../lib/git/split-brief.js';
import { RUN_ID_PATTERN } from './mark.mjs';
import {
  atomicWriteBytes, callOrcaJson, checkParentIsRoot, cmdLine, defaultExec, isAncestor, loadRun, PLUGIN_ROOT, runWorktreeSetup, toPosix,
} from './status.mjs';

export const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'templates', 'orca', 'PROMPT-TEMPLATE.md');
const REPORT_CONTRACT_SOURCE = path.join(PLUGIN_ROOT, 'commands', 'team.md');

/**
 * Branch names the session hook may move onto its `artibot/` prefix. A copy of the hook's private
 * constant; `tests/orca/bind-orca.test.js` pins it to the hook SOURCE so the two cannot drift.
 */
export const RELOCATABLE_BRANCH_NAME = /^[A-Za-z0-9_-]+$/;

/** Orca task and dispatch ids (`task_873e6cb5afb2`, `ctx_bba48a83896e`) — charset only, no assumption about length growth. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

const FULL_SHA = /^[0-9a-f]{40}$/;
const isFilled = (value) => typeof value === 'string' && value.trim() !== '';
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export const HELP = `usage:
  node scripts/orca/bind.mjs run --run-id <runId> [--parent <root>] [--json]
  node scripts/orca/bind.mjs worktree <limb> --worktree <selector> [--brief <file>] [--parent <root>] [--json]
  node scripts/orca/bind.mjs dispatch <limb> --task <orcaTaskId> --dispatch <dispatchId> [--kind ${DISPATCH_KINDS.join('|')}] [--parent <root>] [--json]

  run        record the Orca run id in run.json (once)
  worktree   observe the worktree Orca created (orca worktree show), record it, equip it, print the next command
             --worktree takes the selector from Orca's receipt (id:<repoId>::<path> works)
             --brief    parent brief to copy (default: the limb contract directory under the parent root)
  dispatch   append the worker-start receipt ids (also for a start that failed)

Reads Orca only (worktree show); the commands to type next are printed.`;

// ── argv ─────────────────────────────────────────────────────────────────────

const VALUED = { '--run-id': 'runId', '--worktree': 'selector', '--brief': 'brief', '--task': 'task', '--dispatch': 'dispatch', '--kind': 'kind', '--parent': 'parent' };

/** @returns {{ ok:true, sub:'run'|'worktree'|'dispatch', limb:string|null, help:boolean, json:boolean } & Record<string, unknown> | { ok:false, error:string, json:boolean }} */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const json = list.includes('--json');
  const out = { ok: true, sub: null, limb: null, runId: null, selector: null, brief: null, task: null, dispatch: null, kind: null, parent: null, json, help: false };
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--json') continue;
    if (a === '--help' || a === '-h') out.help = true;
    else if (VALUED[a]) {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, error: `${a} requires a value`, json };
      out[VALUED[a]] = v;
      i += 1;
    } else if (a.startsWith('-')) return { ok: false, error: `unknown option: ${a}`, json };
    else positional.push(a);
  }
  return out.help ? out : finishParse(out, positional);
}

function finishParse(out, positional) {
  const bad = (error) => ({ ok: false, error, json: out.json });
  const [sub, limb, ...rest] = positional;
  if (!['run', 'worktree', 'dispatch'].includes(sub)) return bad(`unknown or missing subcommand: ${sub ?? '(none)'}`);
  if (rest.length > 0 || (sub === 'run' && limb !== undefined)) return bad(`unexpected argument: ${sub === 'run' ? limb : rest[0]}`);
  const merged = { ...out, sub, limb: limb ?? null };
  if (sub === 'run') return RUN_ID_PATTERN.test(merged.runId ?? '') ? merged : bad(`--run-id must match ${RUN_ID_PATTERN}`);
  if (!LIMB_SLUG.test(merged.limb ?? '')) return bad(`<limb> must match ${LIMB_SLUG} (got ${JSON.stringify(merged.limb)})`);
  if (sub === 'worktree') return isFilled(merged.selector) && !/[\r\n]/.test(merged.selector) ? merged : bad('--worktree <selector> is required');
  const idError = ['task', 'dispatch'].find((key) => !ID_PATTERN.test(merged[key] ?? ''));
  if (idError) return bad(`--${idError} must match ${ID_PATTERN}`);
  if (merged.kind !== null && !DISPATCH_KINDS.includes(merged.kind)) return bad(`--kind must be one of ${DISPATCH_KINDS.join('|')}`);
  return merged;
}

// ── bind run ─────────────────────────────────────────────────────────────────

/** The checkout root every subcommand reads and writes under — a cwd that drifted into a subdirectory is refused before run.json is touched. */
function resolveParent(args, deps) {
  const parentRoot = path.resolve(args.parent ?? deps.cwd);
  const root = checkParentIsRoot(deps.exec, parentRoot);
  return root.ok ? { ok: true, parentRoot } : root;
}

function bindRun(args, deps) {
  const where = resolveParent(args, deps);
  if (!where.ok) return where;
  const { parentRoot } = where;
  const loaded = loadRun(parentRoot);
  if (!loaded.ok) return loaded;
  const current = loaded.run.runId;
  if (isFilled(current) && current !== args.runId) return fail(`이미 다른 Orca runId(${current})가 바인딩돼 있다 — 새 런은 plan 을 새로 만든다(--force-new)`);
  if (current === args.runId) return { ok: true, sub: 'run', runId: args.runId, alreadyBound: true, next: null };
  const updated = updateOrcaRun(parentRoot, (run) => {
    if (isFilled(run.runId) && run.runId !== args.runId) throw new Error('runId-conflict');
    return { ...run, runId: args.runId };
  });
  if (!updated.ok) return fail(`run.json 쓰기 실패(${updated.reason}): ${updated.detail ?? ''}`.trim());
  return { ok: true, sub: 'run', runId: args.runId, alreadyBound: false, next: `node ${toPosix(path.join(PLUGIN_ROOT, 'scripts', 'orca', 'status.mjs'))} --next` };
}

// ── bind worktree: observe ───────────────────────────────────────────────────

const samePath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';

/** `worktree show` → the validated facts, or `{ ok:false, error }`. Nothing is written here. */
function observeWorktree(selector, parentRoot, deps) {
  const call = callOrcaJson(deps.exec, ['worktree', 'show', '--worktree', selector, '--json']);
  if (!call.ok) return fail(`orca worktree show 실패: ${call.error}`);
  const wt = call.result?.worktree;
  if (!isFilled(wt?.id) || !isFilled(wt?.path)) return fail('worktree show 영수증에 id/path 가 없다');
  if (wt.isMainWorktree === true || wt.isBare === true || samePath(wt.path, parentRoot)) {
    return fail('이 선택자는 메인 체크아웃을 가리킨다 — 줄기 worktree 가 아니다(junction·teardown 이 부모에 작용한다). 방금 만든 worktree 의 선택자를 줘라');
  }
  const ref = wt.branch;
  const branch = typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  if (branch === null) return fail(`worktree 의 브랜치를 읽지 못했다(detached HEAD?): ${JSON.stringify(ref ?? null)}`);
  if (RELOCATABLE_BRANCH_NAME.test(branch)) {
    return fail(`브랜치 "${branch}" 에 '/' 가 없다 — 세션 훅(git-autopilot-session)이 artibot/ 접두 쪽으로 옮겨 버린다. worktree 를 orca/<limb>-<tag> 같은 이름으로 다시 만든다`);
  }
  if (!fs.existsSync(wt.path)) return fail(`worktree 경로가 디스크에 없다: ${wt.path}`);
  return { ok: true, worktreeId: wt.id, worktreePath: path.resolve(wt.path), branch };
}

/** The recorded fork point, or a fresh measurement that must sit on the integration ref. */
function forkPointFor(row, wt, ctx) {
  if (isFilled(row.forkPoint)) return { ok: true, forkPoint: row.forkPoint, warnings: [] };
  if (Array.isArray(row.dispatches) && row.dispatches.length > 0) {
    return fail('forkPoint 가 기록되지 않았는데 이미 dispatch 가 있다 — 워커가 커밋한 뒤의 HEAD 는 분기점이 아니다. 분기점을 git 으로 직접 확인해 run.json 을 고쳐라');
  }
  const head = ctx.exec('git', ['rev-parse', 'HEAD'], { cwd: wt.worktreePath });
  const sha = head.ok ? head.stdout.trim() : '';
  if (!FULL_SHA.test(sha)) return fail(`git rev-parse HEAD 실패(${wt.worktreePath}): ${head.error ?? sha}`);
  const onBase = isAncestor(ctx.exec, ctx.parentRoot, sha, ctx.integrationRef);
  if (onBase === false) {
    return fail(`worktree HEAD ${sha.slice(0, 12)} 는 ${ctx.integrationRef} 의 조상이 아니다 — 이미 자기 커밋이 있거나 다른 base 에서 만들어졌다. 분기점으로 기록하면 그 커밋이 base 에 섞여 land 가 놓친다`);
  }
  const warnings = onBase === null ? [`${ctx.integrationRef} 를 읽지 못해 forkPoint 가 base 위에 있음을 확인하지 못했다(git fetch origin 후 다시?)`] : [];
  return { ok: true, forkPoint: sha, warnings };
}

// ── bind worktree: record ────────────────────────────────────────────────────

const BIND_REFUSAL = {
  'unknown-limb': '줄기가 run.json 에 없다',
  'bad-binding': '바인딩 값이 올바르지 않다',
  'already-bound': '이 줄기는 이미 다른 worktree 에 바인딩돼 있다 — 다시 묶으면 첫 worktree 가 고아가 된다',
};

function recordBinding(parentRoot, limb, binding) {
  const updated = updateOrcaRun(parentRoot, (run) => {
    const bound = bindLimb(run, limb, binding);
    if (!bound.ok) throw new Error(bound.reason);
    return bound.run;
  });
  if (!updated.ok) return fail(`바인딩 기록 실패(${updated.reason}): ${BIND_REFUSAL[updated.detail] ?? updated.detail ?? ''}`.trim());
  const row = updated.run.limbs.find((l) => l.limb === limb);
  return { ok: true, binding: { worktreeId: row.worktreeId, worktreePath: row.worktreePath, branch: row.branch, forkPoint: row.forkPoint } };
}

// ── bind worktree: equip ─────────────────────────────────────────────────────

const limbDir = (root, limb) => path.join(root, '.artibot', 'split', limb);

/** Render `prompt.md`. Fail-closed: an unknown or unresolved placeholder throws. */
export function renderWorkerPrompt({ templateText, run, limb, binding, parentRoot, config, contract }) {
  const withPaths = templateText
    .replaceAll('{BRIEF_PATH}', toPosix(path.join(limbDir(binding.worktreePath, limb), 'brief.md')))
    .replaceAll('{PARENT_BRIEF_PATH}', toPosix(path.join(limbDir(parentRoot, limb), 'brief.md')))
    .replaceAll('{REPORT_PATH}', toPosix(path.join(limbDir(binding.worktreePath, limb), 'report.md')));
  return renderPrompt(withPaths, {
    RUN: run.runId, LIMB: limb, WORKTREE_PATH: toPosix(binding.worktreePath), BRANCH: binding.branch, BASE: binding.forkPoint,
    PARENT_ROOT: toPosix(parentRoot), MODEL_POLICY: renderModelPolicy(config), REPORT_CONTRACT: contract,
  });
}

/**
 * Copy the parent brief into the worktree (byte-exact, atomic; required sections checked), copy the
 * sibling files the parent has, and write `prompt.md`. Throws on a missing or incomplete brief.
 */
export function installLimbContract({ parentRoot, worktreePath, limb, briefSource, prompt }) {
  const source = briefSource ?? path.join(limbDir(parentRoot, limb), 'brief.md');
  if (!fs.existsSync(source)) throw new Error(`브리프가 없다: ${source} — 줄기 브리프를 먼저 쓴다`);
  const bytes = fs.readFileSync(source);
  const missing = missingSections(bytes.toString('utf-8'), DEFAULT_REQUIRED_SECTIONS);
  if (missing.length > 0) throw new Error(`브리프에 필수 절이 없다: ${missing.join(', ')} (${source})`);
  const dest = limbDir(worktreePath, limb);
  const briefPath = path.join(dest, 'brief.md');
  const promptPath = path.join(dest, 'prompt.md');
  atomicWriteBytes(briefPath, bytes);
  atomicWriteBytes(promptPath, Buffer.from(prompt, 'utf-8'));
  const siblings = SIBLING_FILES.map((name) => {
    const from = path.join(path.dirname(source), name);
    const copied = fs.existsSync(from);
    if (copied) atomicWriteBytes(path.join(dest, name), fs.readFileSync(from));
    return { name, copied };
  });
  return { briefPath, promptPath, siblings };
}

function equip({ args, run, binding, parentRoot, deps, config }) {
  const setup = deps.runSetup(binding.worktreePath, { parentRoot, limb: args.limb });
  if (!setup.ok) return fail(`junction/프로비저닝 실패 — 워커를 시작하지 않는다: ${setup.error ?? 'unknown'}`, { setup });
  try {
    const templateText = fs.readFileSync(deps.templatePath, 'utf-8');
    const contract = extractReportContract(fs.readFileSync(deps.contractSource, 'utf-8')).replace(/\{리더 이름\}/g, 'main');
    const prompt = renderWorkerPrompt({ templateText, run, limb: args.limb, binding, parentRoot, config, contract });
    const installed = installLimbContract({ parentRoot, worktreePath: binding.worktreePath, limb: args.limb, briefSource: args.brief ? path.resolve(args.brief) : undefined, prompt });
    return { ok: true, setup, contract: installed };
  } catch (err) {
    return fail(`브리프·prompt 준비 실패 — 워커를 시작하지 않는다: ${err?.message ?? err}`, { setup });
  }
}

export function bindWorktree(args, deps, config) {
  const where = resolveParent(args, deps);
  if (!where.ok) return where;
  const { parentRoot } = where;
  const loaded = loadRun(parentRoot);
  if (!loaded.ok) return loaded;
  const { run } = loaded;
  const row = run.limbs.find((l) => l.limb === args.limb);
  if (!row) return fail(`limb "${args.limb}" 이 run.json 에 없다 (있는 것: ${run.limbs.map((l) => l.limb).join(', ') || '없음'})`);
  if (!isFilled(run.runId)) return fail('Orca runId 가 아직 바인딩되지 않았다 — bind.mjs run --run-id <runId> 를 먼저 친다');
  const observed = observeWorktree(args.selector, parentRoot, deps);
  if (!observed.ok) return observed;
  const integrationRef = run.integrationRef ?? 'origin/master';
  const fork = forkPointFor(row, observed, { exec: deps.exec, parentRoot, integrationRef });
  if (!fork.ok) return fork;
  const recorded = recordBinding(parentRoot, args.limb, { worktreeId: observed.worktreeId, worktreePath: observed.worktreePath, branch: observed.branch, forkPoint: fork.forkPoint });
  if (!recorded.ok) return recorded;
  const equipped = equip({ args, run, binding: recorded.binding, parentRoot, deps, config });
  if (!equipped.ok) return { ...equipped, bound: true, binding: recorded.binding, error: `${equipped.error} (바인딩은 기록됐다 — 고친 뒤 같은 명령을 다시 치면 된다)` };
  const spec = equipped.contract.promptPath;
  return {
    ok: true, sub: 'worktree', limb: args.limb, selector: `id:${recorded.binding.worktreeId}`, binding: recorded.binding,
    setup: equipped.setup.rows, contract: equipped.contract, warnings: fork.warnings,
    next: cmdLine('orca', 'orchestration', 'task-create', '--spec-file', toPosix(spec), '--task-title', args.limb, '--json'),
  };
}

// ── bind dispatch ────────────────────────────────────────────────────────────

const APPEND_REFUSAL = {
  'unknown-limb': '줄기가 run.json 에 없다',
  duplicate: '이 dispatch id 는 이미 기록돼 있다',
  'bad-kind': 'kind 가 올바르지 않다',
  'bad-dispatch': 'dispatch 기록 값이 올바르지 않다',
};

function bindDispatch(args, deps) {
  const where = resolveParent(args, deps);
  if (!where.ok) return where;
  const { parentRoot } = where;
  const loaded = loadRun(parentRoot);
  if (!loaded.ok) return loaded;
  const row = loaded.run.limbs.find((l) => l.limb === args.limb);
  if (!row) return fail(`limb "${args.limb}" 이 run.json 에 없다 (있는 것: ${loaded.run.limbs.map((l) => l.limb).join(', ') || '없음'})`);
  const existing = loaded.run.limbs.flatMap((l) => (l.dispatches ?? []).map((d) => ({ limb: l.limb, ...d }))).find((d) => d.dispatchId === args.dispatch);
  if (existing) {
    return existing.limb === args.limb && existing.taskId === args.task
      ? { ok: true, sub: 'dispatch', limb: args.limb, dispatch: existing, alreadyRecorded: true, count: row.dispatches.length }
      : fail(`dispatch ${args.dispatch} 는 이미 limb ${existing.limb} / task ${existing.taskId} 로 기록돼 있다`);
  }
  const hasAny = Array.isArray(row.dispatches) && row.dispatches.length > 0;
  if (args.kind === null && hasAny) return fail(`limb "${args.limb}" 에는 dispatch 가 이미 ${row.dispatches.length}개 있다 — 두 번째부터는 --kind retry|rework 를 명시한다(같은 Task 재시도 = retry, 후속 Task = rework)`);
  const entry = { dispatchId: args.dispatch, taskId: args.task, kind: args.kind ?? 'initial', at: deps.now().toISOString() };
  const updated = updateOrcaRun(parentRoot, (run) => {
    const appended = appendDispatch(run, args.limb, entry);
    if (!appended.ok) throw new Error(appended.reason);
    return appended.run;
  });
  if (!updated.ok) return fail(`dispatch 기록 실패(${updated.reason}): ${APPEND_REFUSAL[updated.detail] ?? updated.detail ?? ''}`.trim());
  const count = updated.run.limbs.find((l) => l.limb === args.limb).dispatches.length;
  return { ok: true, sub: 'dispatch', limb: args.limb, dispatch: entry, alreadyRecorded: false, count };
}

// ── driver ───────────────────────────────────────────────────────────────────

function render(r) {
  if (r.sub === 'run') return r.alreadyBound ? `runId ${r.runId} 는 이미 바인딩돼 있다` : `runId ${r.runId} 기록 완료${r.next ? `\n다음: ${r.next}` : ''}`;
  if (r.sub === 'dispatch') return `${r.alreadyRecorded ? '이미 기록됨' : '기록'}: limb ${r.limb} · dispatch ${r.dispatch.dispatchId} · task ${r.dispatch.taskId} · ${r.dispatch.kind} (이 줄기 dispatch ${r.count}개)\n턴을 끝낸다 — Orca 가 워커 보고로 깨운다(폴링 금지)`;
  const b = r.binding;
  return [
    `바인딩 완료: limb ${r.limb}`, `  worktreeId ${b.worktreeId}`, `  path       ${toPosix(b.worktreePath)}`, `  branch     ${b.branch}`, `  forkPoint  ${b.forkPoint}`,
    `  junction/프로비저닝: ${r.setup.map((row) => `${row.kind}:${row.status}`).join(' · ') || '없음'}`,
    `  brief  ${toPosix(r.contract.briefPath)}`, `  prompt ${toPosix(r.contract.promptPath)}`,
    ...r.warnings.map((w) => `warning: ${w}`),
    '', `다음에 칠 명령(워커 시작 선택자는 ${r.selector}):`, `  $ ${r.next}`,
  ].join('\n');
}

/**
 * CLI entry. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, exec?: Function, runSetup?: Function, config?: object|null, now?: () => Date, templatePath?: string, contractSource?: string, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
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
  const deps = {
    cwd: opts.cwd ?? process.cwd(), exec: opts.exec ?? defaultExec, runSetup: opts.runSetup ?? runWorktreeSetup,
    now: opts.now ?? (() => new Date()), templatePath: opts.templatePath ?? TEMPLATE_PATH, contractSource: opts.contractSource ?? REPORT_CONTRACT_SOURCE,
  };
  let result;
  try {
    if (args.sub === 'run') result = bindRun(args, deps);
    else if (args.sub === 'dispatch') result = bindDispatch(args, deps);
    else {
      let { config } = opts;
      if (config === undefined) {
        try { config = await loadConfig(); } catch { config = null; }
      }
      result = bindWorktree(args, deps, config);
    }
  } catch (error) {
    result = fail(`unexpected failure: ${error?.message ?? error}`);
  }
  if (args.json) out(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) out(`${render(result)}\n`);
  else err(`${result.error}\n`);
  return result.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
