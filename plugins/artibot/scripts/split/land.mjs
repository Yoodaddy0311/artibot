#!/usr/bin/env node
/**
 * `split land <limb>` — print the mechanical landing checklist for one limb.
 *
 *   node scripts/split/land.mjs <limb> [--base <ref>] [--plan <path>] [--json] [--pr-body <out>]
 *
 * Reads `<cwd>/.artibot/split/plan.json` (`{ runId, base, repoShort,
 * limbs:[{ limb, branch, worktreePath, affectedPaths }] }`), runs
 * `lib/git/limb-landing-check.js#checkLimbLanding` plus a `lint` row of its
 * own ({@link lintCheck}), prints one PASS/FAIL row
 * per check plus the overall status, and exits 0 only on PASS.
 *
 * It never pushes, merges, or writes anything except the optional
 * `--pr-body <out>` file. PASS is not approval — `## 검수` in the PR body is
 * for a human verdict (see the lib header).
 *
 * It also prints a `pin tests` section ({@link pinTestsFor}) naming the test
 * files that literally cite a config file this limb changed. Information only:
 * nothing is executed, no check row is added, and the exit code is unaffected.
 *
 * BASE PRECEDENCE ({@link effectiveBase}): `--base` > `plan.limbs[].forkPoint`
 * > `plan.base`. `plan.base` is the SHA at PLAN time, but a worktree is created
 * later and branches off whatever the integration branch had advanced to by
 * then, so every commit that landed in between reads as this limb's change —
 * measured as `ownership FAIL` on files no one on the limb touched. `forkPoint`
 * is what `dispatch` records at worktree creation and is therefore the honest
 * base. The resolved base is printed as one line under the table (`--json`:
 * `effectiveBase`); it is information, not a check row, and cannot move the
 * exit code.
 *
 * WHAT THAT LINE CANNOT SEE: a limb REBASED after dispatch — `forkPoint` is
 * still used, and the mismatch appears only as a note; the `merge-base` shown
 * when no fork point was recorded depends on the LIVE `master` ref and is never
 * used as the base; and a `forkPoint` that is itself wrong (a window that
 * committed before dispatch recorded it) yields an empty diff, which the
 * existing `empty` check reports as FAIL rather than this line.
 *
 * Exit codes: 0 PASS · 1 FAIL / UNSUPPORTED / usage or plan error.
 *
 * @module scripts/split/land
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkLimbLanding, defaultExec } from '../../lib/git/limb-landing-check.js';
import { forkPointForLimb } from '../../lib/git/split-run-file.js';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Plugin root (`plugins/artibot`), whose package.json owns the lint script CI runs. */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `lint` row — eslint over the .js/.mjs this limb actually changed.
 *
 * WHY IT IS HERE AND NOT IN `checkLimbLanding`: that module is git-only by
 * construction (one injectable `exec` that spawns `git`, lib header). Lint
 * needs a different binary and a different cwd, so bolting it on there would
 * widen a deliberately narrow contract. This row is appended by the CLI.
 *
 * WHY IT EXISTS: measured 2026-09-04, a limb reported `land` 6/6 PASS while
 * eslint on the same diff had 3 errors and 2 warnings. CI runs
 * `eslint . --max-warnings=0` (plugins/artibot/package.json `scripts.lint`),
 * so that batch was one landing away from a red pipeline and the checklist
 * said nothing (`.artibot/split/gotchas.md` #25).
 *
 * THREE OUTCOMES, and the third is not a pass:
 *   - no changed .js/.mjs      -> ok, detail `SKIP`
 *   - eslint clean             -> ok
 *   - eslint dirty OR MISSING  -> not ok. A missing eslint is `UNSUPPORTED`,
 *     never a silent pass: `check-unused-ratchet` once destroyed its own
 *     baseline and printed PASS when node_modules was absent. Fail closed.
 *
 * WHICH BYTES GET LINTED (#G14, fixed 2026-09-10): eslint reads the WORKING
 * TREE, not git objects, so the cwd it is spawned in decides what is checked.
 * This row used to spawn it in `pluginRoot` — the checkout the RUNNER was
 * started from, normally the parent on master — so it linted the parent's
 * bytes while claiming to report on the limb. Two symptoms, one cause: a
 * violation that existed only on the limb read as PASS, and a file NEW on the
 * limb ("No files matching the pattern") read as FAIL — measured on 3/5 limbs
 * in reports/SPLIT/split-5f9fe3.md. It now lints in `worktreePath`'s plugin
 * root, verifies through git that that checkout really has `branch` on it, and
 * names the directory it linted in every detail string. A missing or wrong
 * `worktreePath` is UNSUPPORTED; falling back to `pluginRoot` was the defect.
 * The one exception is SKIP, which is decided first: a limb that changed no
 * .js/.mjs reads no working tree at all, so it needs no valid one.
 *
 * The eslint BINARY still comes from `pluginRoot/node_modules` (the runner's
 * install) while the cwd is the worktree — the worktree only needs whatever its
 * own `eslint.config.js` imports.
 *
 * The right branch is still not the right bytes, so the checkout is verified
 * twice: `HEAD` must be `branch`, and no file in the lint set may carry an
 * uncommitted change. Without the second check a limb whose branch holds a
 * violation passes whenever its worktree happens to hold a fixed copy.
 *
 * WHAT THIS ROW CANNOT SEE: files outside `plugins/artibot/` (the CI lint
 * script is plugin-scoped, so neither can CI); anything eslint is configured
 * to ignore; uncommitted changes to files NOT in the lint set (deliberate —
 * unrelated dirt is not this row's business); and whether the worktree has the
 * `node_modules` its config needs — that surfaces as eslint exit 2 and is
 * reported as UNSUPPORTED, not predicted.
 *
 * @param {object} p
 * @param {string} p.cwd - parent repo root (git only; refs are shared across worktrees)
 * @param {string} p.base - base ref
 * @param {string} p.branch - limb branch
 * @param {string} p.worktreePath - the limb's checkout root (`plan.limbs[].worktreePath`)
 * @param {typeof defaultExec} [p.exec=defaultExec] - git runner (injected in tests)
 * @param {typeof spawnSync} [p.spawn=spawnSync] - process runner for eslint
 * @param {string} [p.pluginRoot=PLUGIN_ROOT] - where the eslint binary lives
 * @returns {{ id: string, name: string, ok: boolean, detail: string }}
 */
export function lintCheck({
  cwd, base, branch, worktreePath, exec = defaultExec, spawn = spawnSync, pluginRoot = PLUGIN_ROOT,
} = {}) {
  const mk = (ok, detail) => Object.freeze({ id: 'lint', name: 'lint (변경 파일 한정)', ok, detail });

  // `-z`: this repo has Korean paths and `core.quotepath` defaults to on, so
  // newline-separated output would arrive C-quoted and split wrong.
  // `--diff-filter=d`: a file the limb DELETED is still a changed path, but it
  // is gone from the worktree, and eslint exits 2 on a path it cannot resolve —
  // a successful deletion would read as a lint failure.
  //
  // Lowercase `d` EXCLUDES deletions and keeps everything else, typechanges
  // included. Measured 2026-09-10 on git 2.54.0.windows.1 with a blob->symlink
  // commit: `--name-status` gave `D gone.js / M keep.js / T link.js`, and the
  // filter dropped only the `D`. A `.js` that became a symlink therefore stays
  // in the lint set, which is intended — eslint either follows it or fails to
  // parse it, and both are loud. Nothing here can turn it into a PASS.
  const names = exec(['diff', '--name-only', '-z', '--diff-filter=d', `${base}..${branch}`], { cwd });
  if (names.status !== 0) return mk(false, `UNSUPPORTED — git diff 실패: ${(names.stderr || '').trim().split('\n')[0] || `exit ${names.status}`}`);

  const prefix = 'plugins/artibot/';
  const changed = String(names.stdout || '').split('\0').filter(Boolean);
  const lintable = changed.filter((f) => /\.(?:js|mjs)$/.test(f));
  const inPlugin = lintable.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  const outside = lintable.filter((f) => !f.startsWith(prefix));
  const outsideNote = outside.length ? ` · 플러그인 밖 ${outside.length}건 미검사(CI lint 스코프도 동일)` : '';

  // Ordering: SKIP is decided BEFORE the worktree is validated. With nothing to
  // lint there are no bytes to read from the wrong tree, so demanding a valid
  // worktree there would fail limbs that touch no JS for a reason that cannot
  // affect them. Everything past this line does read a working tree.
  if (inPlugin.length === 0) return mk(true, `SKIP — 변경된 .js/.mjs 0건${outsideNote}`);

  // Each UNSUPPORTED below opens with a different phrase on purpose: the table
  // is often the only thing read, so the reason has to be legible without
  // opening the plan or the worktree. `tests/split/land-lint.test.js` pins that
  // they stay pairwise distinct.
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return mk(false, `UNSUPPORTED — worktreePath 없음(plan limbs[] 에 미기재이거나 --plan 이 다른 파일을 가리킨다): 어느 체크아웃을 린트할지 알 수 없다. 러너 루트로 대체하면 줄기가 아닌 바이트를 검사하므로(#G14) 실패로 닫는다${outsideNote}`);
  }
  const wtRoot = path.resolve(worktreePath);
  if (!fs.existsSync(wtRoot)) return mk(false, `UNSUPPORTED — worktree 디렉터리 없음 (${wtRoot}); plan 의 worktreePath 가 낡았거나 창이 정리됐다${outsideNote}`);

  // The header used to merely DOCUMENT that nothing verified the checkout; this
  // closes it. Refs are shared across worktrees but working trees are not, so
  // ask the worktree itself what it has checked out.
  //
  // One call for both facts: `rev-parse --short HEAD --abbrev-ref HEAD` is
  // "fatal: Needed a single revision" and `--abbrev-ref HEAD HEAD` answers the
  // ref name twice (both measured 2026-09-10 on git 2.54.0.windows.1), so the
  // working form is sha first, name second, shortened here.
  // These two open with the reason, not with the word `worktree`: they used to
  // read `worktree HEAD 조회 실패` and `worktree HEAD 불일치`, which are identical
  // for the first 12 characters — and the detail column is what gets truncated.
  const head = exec(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { cwd: wtRoot });
  if (head.status !== 0) return mk(false, `UNSUPPORTED — HEAD 조회 실패: worktree ${wtRoot} 에서 rev-parse 가 ${(head.stderr || '').trim().split('\n')[0] || `exit ${head.status}`}${outsideNote}`);
  const [headSha = '', headName = ''] = String(head.stdout || '').trim().split('\n').map((s) => s.trim());
  // A detached worktree answers the ref name `HEAD`, which is why the sha is
  // reported too — otherwise two different wrong states print the same word.
  const at = headSha ? ` (${headSha.slice(0, 12)})` : '';
  if (headName !== branch) return mk(false, `UNSUPPORTED — HEAD 불일치: ${headName || '(이름 불명)'}${at} 가 체크아웃돼 있고 줄기 ${branch} 가 아니다 — worktree ${wtRoot}; 다른 트리를 린트하면 결과가 줄기와 무관하다${outsideNote}`);

  // The right branch is not yet the right BYTES. eslint reads the working tree,
  // so an uncommitted edit to a file in the lint set is what gets graded — a
  // limb whose branch carries a violation passes if the worktree happens to
  // hold a fixed copy. The row's whole contract is that it reports on the
  // limb's committed bytes, so an overlap is refused rather than graded.
  // Scoped to `inPlugin` on purpose: unrelated dirt is not this row's business.
  // `--untracked-files=no` because a new file that is not in `base..branch` is
  // not in the lint set either.
  const dirty = exec(['status', '--porcelain', '-z', '--untracked-files=no', '--', ...inPlugin.map((f) => prefix + f)], { cwd: wtRoot });
  if (dirty.status !== 0) return mk(false, `UNSUPPORTED — status 조회 실패: worktree ${wtRoot} 에서 ${(dirty.stderr || '').trim().split('\n')[0] || `exit ${dirty.status}`}${outsideNote}`);
  const dirtyEntries = String(dirty.stdout || '').split('\0').filter(Boolean);
  if (dirtyEntries.length) {
    // With a denominator: "3건이 더럽다" does not say whether that is all of
    // the lint set or a corner of it, and the two lead somewhere different.
    const shown = dirtyEntries.slice(0, 3).map((e) => e.trim()).join(', ');
    const more = dirtyEntries.length > 3 ? ` 외 ${dirtyEntries.length - 3}건` : '';
    return mk(false, `UNSUPPORTED — 미커밋 변경 겹침: 린트 대상 ${inPlugin.length}건 중 ${dirtyEntries.length}건이 worktree ${wtRoot} 에서 미커밋 (${shown}${more}) — 커밋 후 재실행. 미커밋 바이트를 채점하면 줄기가 아닌 것을 채점한다${outsideNote}`);
  }

  // The eslint JS entry, not the `.bin` shim: spawning `eslint.cmd` without a
  // shell is EINVAL on Windows since Node 20 (measured 2026-09-04 — the row
  // reported UNSUPPORTED for every run), and `shell: true` would put user paths
  // through cmd quoting. `process.execPath` runs the same file on every OS.
  const bin = path.join(pluginRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(bin)) return mk(false, `UNSUPPORTED — eslint 없음 (${bin}); npm ci 후 재실행. PASS 로 넘기지 않는다${outsideNote}`);

  const wtPluginRoot = path.join(wtRoot, 'plugins', 'artibot');
  const r = spawn(process.execPath, [bin, '--max-warnings=0', ...inPlugin], {
    cwd: wtPluginRoot, encoding: 'utf-8', windowsHide: true, timeout: 180000, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return mk(false, `UNSUPPORTED — eslint 실행 실패 (${wtPluginRoot}): ${r.error.message}${outsideNote}`);
  if (r.status === 0) return mk(true, `${inPlugin.length}파일 0 errors 0 warnings @ ${wtPluginRoot}${outsideNote}`);
  const first = String(r.stdout || r.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' / ');
  // eslint exits 1 for "lint problems found" and 2 for "configuration problem
  // or internal error" (measured 2026-09-10 on 10.2.1: a config importing a
  // missing package, and an unresolvable path, both exit 2). Only 1 is the
  // limb's fault; 2 means we could not lint at all, which must not read as a
  // verdict on the limb — and must never degrade to PASS.
  if (r.status !== 1) return mk(false, `UNSUPPORTED — eslint 설정/입력 오류 exit ${r.status} @ ${wtPluginRoot} — ${first}; worktree 에 node_modules 가 없으면 scripts/split/worktree-setup.mjs ${wtRoot} 로 깔고 재실행${outsideNote}`);
  return mk(false, `${inPlugin.length}파일 @ ${wtPluginRoot} — ${first}${outsideNote}`);
}
/**
 * Config files whose basename is worth grepping the test tree for. A limb that
 * edits one of these usually needs a test that is NOT in its own allowlist.
 * Allowlist, not denylist: an unknown config name yields an empty result rather
 * than a scan of everything (rules §8 — a negative list fail-opens on additions,
 * and here "fail-open" would mean a full-tree grep per changed file).
 */
export const CONFIG_PIN_BASENAMES = Object.freeze([
  'artibot.config.json',
  'dispatch-table.json',
  'hooks.json',
  'ledger-events.allowlist.json',
  'plugin.json',
]);

/** `plugins/artibot/schemas/**\/*.json` — every schema is a config pin target. */
const SCHEMA_DIR_RE = /(?:^|\/)plugins\/artibot\/schemas\/[^\0]+\.json$/;

/** Normalise a path to `/` separators so Windows output is pasteable. */
const slash = (p) => String(p).replaceAll('\\', '/');

/**
 * Is this changed file one whose basename we grep the test tree for?
 * @param {string} file - repo-root-relative path
 * @returns {boolean}
 */
function isConfigPinTarget(file) {
  const norm = slash(file);
  if (SCHEMA_DIR_RE.test(norm)) return true;
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return CONFIG_PIN_BASENAMES.includes(base);
}

/**
 * Recursively list `*.test.js` / `*.test.mjs` under `root`, as `/`-separated
 * paths relative to `root`, sorted. Nothing is excluded — not `fixtures`, not
 * even `node_modules` — because the vitest project include is literally
 * `tests/**\/*.test.{js,mjs}`. Vitest's DEFAULT exclude does drop
 * `**\/node_modules/**`, so this list is a superset of what would run if a
 * `node_modules` ever appeared under `tests/` (0 today, measured 2026-09-14).
 * Listing more, never less, is the safe side for a "run these" hint.
 * @param {string} root
 * @returns {string[]}
 */
function defaultListTests(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not a test file we can name
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (/\.test\.(?:js|mjs)$/.test(e.name)) out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * For each changed CONFIG file, list the test files that cite its basename
 * literally. Pure and injectable; it reads test sources but executes nothing.
 *
 * WHAT THIS GREP CANNOT SEE — three blind spots, all real shapes in this repo:
 *   1. A filename assembled from a variable: `` `${name}.json` `` or
 *      `name + '.json'`. The basename never appears as a literal, so a test
 *      that loads the changed file this way is reported as 0 hits.
 *   2. A directory-glob loader: `readdirSync(path.join(ROOT,'schemas'))` then
 *      validating every entry. It cites the DIRECTORY, never the file, so
 *      schema changes look untested here.
 *   3. Non-`.test.js` companions — a snapshot such as
 *      `tests/hooks-schema-fingerprint.txt` is what actually turns red, but it
 *      is not a test file and is never listed. Only the test that reads it is,
 *      and only if that test also cites the config basename.
 * WHAT IT DOES SEE, and the reason it is worth having: the `path.join`
 * assembled form, `path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')`, keeps the
 * basename as a literal argument — that is exactly the shape of
 * `tests/hooks-schema-shape.test.js:60` (`HOOKS_JSON_PATH`, measured
 * 2026-09-14 01:34 KST), the test the Wave 8 p4 batch missed.
 *
 * A 0-hit result is therefore NOT evidence that no test covers the file; it is
 * evidence that no test NAMES it. The table wording says so.
 *
 * @param {ReadonlyArray<string>} changedFiles - repo-root-relative paths
 * @param {string} testsRoot - directory to scan
 * @param {{ listTests?: (root: string) => string[], readFile?: (p: string) => string }} [deps]
 * @returns {Readonly<{ pinTests: Readonly<Record<string, ReadonlyArray<string>>>, scanned: number, unreadable: number }>}
 */
export function pinTestsFor(changedFiles, testsRoot, deps = {}) {
  const { listTests = defaultListTests, readFile = (p) => fs.readFileSync(p, 'utf-8') } = deps;
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  // Deduplicated and sorted so the same diff always prints the same section.
  const targets = [...new Set(files.filter((f) => typeof f === 'string' && isConfigPinTarget(f)).map(slash))].sort();
  const empty = () => Object.freeze({ pinTests: Object.freeze({}), scanned: 0, unreadable: 0 });
  if (targets.length === 0) return empty(); // no scan at all — the common case

  const rootSlash = slash(testsRoot).replace(/\/+$/, '');
  let tests;
  try {
    tests = [...listTests(testsRoot)].map(slash).sort();
  } catch {
    return empty();
  }

  const basenames = targets.map((t) => t.slice(t.lastIndexOf('/') + 1));
  const hits = Object.fromEntries(targets.map((t) => [t, []]));
  let unreadable = 0;
  for (const rel of tests) {
    let body;
    try {
      body = readFile(`${rootSlash}/${rel}`);
    } catch {
      unreadable += 1;
      continue;
    }
    const text = String(body);
    for (let i = 0; i < targets.length; i += 1) {
      if (text.includes(basenames[i])) hits[targets[i]].push(rel);
    }
  }
  for (const t of targets) hits[t] = Object.freeze(hits[t].sort());
  return Object.freeze({ pinTests: Object.freeze(hits), scanned: tests.length, unreadable });
}

/**
 * Render {@link pinTestsFor} as a table-mode section. Separate from
 * `formatLandingTable` on purpose: that signature is pinned by
 * `tests/git/limb-landing-check.test.js`, and this text is not a check.
 * @param {ReturnType<typeof pinTestsFor>} result
 * @returns {string}
 */
export function formatPinTests(result) {
  const entries = Object.entries(result?.pinTests ?? {});
  if (entries.length === 0) return 'pin tests: 설정 파일 변경 0건';
  const lines = ['pin tests (정보 — 실행하지 않는다, 표적 스위트 결정은 리더):'];
  for (const [file, list] of entries) {
    lines.push(list.length
      ? `  ${file} → ${list.length}건 / 스캔 ${result.scanned}: ${list.join(', ')}`
      : `  ${file} → 0건 (사각 3종 가능: 조립 파일명·글롭 로더·스냅샷) / 스캔 ${result.scanned}`);
  }
  if (result.unreadable) lines.push(`  (읽지 못한 테스트 파일 ${result.unreadable}건은 스캔에서 빠졌다)`);
  return lines.join('\n');
}

/** The branch limbs are cut from and merged back into. */
const INTEGRATION_REF = 'master';

/**
 * Resolve which ref the landing checks should diff against, and say why.
 *
 * PRECEDENCE — `--base` > `forkPoint` > `plan.base`. The CLI flag wins
 * unconditionally: it is the operator's override for the case this function
 * cannot reason about (a limb that has since merged an advanced main), and an
 * override that a recorded value could beat would not be an override.
 *
 * Everything past picking the base is INFORMATION. No `checks[]` row is added
 * — `tests/git/limb-landing-check.test.js` and `tests/split/land-pin-tests.test.js`
 * both pin `checks.length === 7`, and more importantly a base that is merely
 * surprising is not a landing defect. The `git` calls here only ever produce
 * `note` text; `mergeBase` in particular is computed against the LIVE
 * integration ref and is deliberately never used as `base` (that would make the
 * checklist's answer depend on when it was run).
 *
 * The three `note` texts open with different words on purpose: like the
 * `UNSUPPORTED` strings in {@link lintCheck}, this line is often read truncated,
 * so `source` has to be legible from the first few characters.
 *
 * @param {object} p
 * @param {string|null} [p.cliBase] - `--base` value, or null
 * @param {string} [p.planBase] - `plan.base`
 * @param {string|null} [p.forkPoint] - `plan.limbs[].forkPoint`, or null
 * @param {string} [p.branch] - limb branch, for the merge-base hint
 * @param {string} [p.cwd] - parent repo root
 * @param {typeof defaultExec} [p.exec=defaultExec] - git runner (injected in tests)
 * @param {string} [p.integrationRef=INTEGRATION_REF]
 * @returns {Readonly<{ base: string, source: 'cli'|'forkPoint'|'plan', planBase: string, forkPoint: string|null, aheadOfPlanBase: number|null, mergeBase: string|null, note: string }>}
 */
export function effectiveBase({
  cliBase = null, planBase = '', forkPoint = null, branch = '', cwd = process.cwd(),
  exec = defaultExec, integrationRef = INTEGRATION_REF,
} = {}) {
  const plan = typeof planBase === 'string' ? planBase : '';
  const fork = typeof forkPoint === 'string' && forkPoint.trim() ? forkPoint.trim() : null;
  const short = (s) => String(s).slice(0, 12);
  const mk = (base, source, note, extra = {}) => Object.freeze({
    base, source, planBase: plan, forkPoint: fork, aheadOfPlanBase: null, mergeBase: null, note, ...extra,
  });

  if (typeof cliBase === 'string' && cliBase.trim()) {
    return mk(cliBase.trim(), 'cli', `--base 로 명시한 ref 가 이긴다 — forkPoint(${fork ? short(fork) : '미기록'})·plan.base(${plan ? short(plan) : '없음'}) 를 모두 무시한다.`);
  }

  if (fork) {
    if (!plan || fork === plan) {
      return mk(fork, 'forkPoint', `forkPoint 기록값을 base 로 쓴다 — ${plan ? 'plan.base 와 같음' : 'plan.base 없음'}.`);
    }
    // `rev-list --count A..B` is 0 when B is not ahead of A, so it cannot by
    // itself distinguish "same commit" from "diverged"; the ancestry test below
    // is what separates a fast-forward fork point from a rebased one.
    const counted = exec(['rev-list', '--count', `${plan}..${fork}`], { cwd });
    const n = counted.status === 0 ? Number.parseInt(String(counted.stdout || '').trim(), 10) : NaN;
    const ahead = Number.isFinite(n) ? n : null;
    const anc = exec(['merge-base', '--is-ancestor', plan, fork], { cwd });
    // A rebased limb still lands on its fork point — refusing it here would
    // block a legitimate workflow over a fact the checks themselves will show.
    // But it is not passed over in silence either.
    const rebased = anc.status !== 0
      ? ' forkPoint 가 plan.base 의 후손이 아님(줄기가 리베이스됐을 수 있다) — 그래도 forkPoint 를 쓴다.'
      : '';
    const aheadNote = ahead === null
      ? '앞선 커밋 수 미확인(rev-list 실패)'
      : `plan.base 보다 ${ahead} commits 앞`;
    return mk(fork, 'forkPoint', `forkPoint 기록값을 base 로 쓴다 — ${aheadNote}.${rebased}`, { aheadOfPlanBase: ahead });
  }

  if (!plan) return mk('', 'plan', 'plan.base 폴백 불가 — forkPoint 미기록이고 plan.base 도 없다.');

  let mergeBase = null;
  let hint = '';
  if (branch) {
    const mb = exec(['merge-base', integrationRef, branch], { cwd });
    if (mb.status === 0 && String(mb.stdout || '').trim()) {
      mergeBase = String(mb.stdout).trim();
      hint = mergeBase === plan
        ? ` ${integrationRef} 와의 merge-base 도 plan.base 와 같다.`
        : ` ${integrationRef} 와의 merge-base 는 ${short(mergeBase)} 로 plan.base 와 다르다 — 정보일 뿐 base 로 쓰지 않는다; 필요하면 --base ${short(mergeBase)} 를 명시하라.`;
    } else {
      hint = ` ${integrationRef} 와의 merge-base 계산 실패(${(mb.stderr || '').trim().split('\n')[0] || `exit ${mb.status}`}) — 비교 정보 없음.`;
    }
  }
  return mk(plan, 'plan', `plan.base 폴백 — forkPoint 미기록(dispatch 가 기록하기 전 계획이거나 수기 plan).${hint}`, { mergeBase });
}

/**
 * Render {@link effectiveBase} as the one-line table-mode section. Separate
 * from `formatLandingTable` for the same reason as {@link formatPinTests}:
 * that signature is pinned elsewhere and this text is not a check.
 * @param {ReturnType<typeof effectiveBase>} info
 * @returns {string}
 */
export function formatEffectiveBase(info) {
  return `effective base: ${info.base || '(없음)'} · source=${info.source} — ${info.note}`;
}

const USAGE = 'usage: node scripts/split/land.mjs <limb> [--base <ref>] [--plan <path>] [--json] [--pr-body <out>]';

/**
 * Parse argv. Pure; unknown flags are an error, not ignored.
 * @param {string[]} argv - arguments after the script path
 * @returns {{ ok: true, limb: string, base: string|null, plan: string|null, json: boolean, prBody: string|null } | { ok: false, error: string }}
 */
export function parseLandArgs(argv) {
  const out = { ok: true, limb: '', base: null, plan: null, json: false, prBody: null };
  const args = Array.isArray(argv) ? [...argv] : [];
  while (args.length) {
    const a = args.shift();
    if (a === '--json') out.json = true;
    else if (a === '--base' || a === '--plan' || a === '--pr-body') {
      const v = args.shift();
      if (typeof v !== 'string' || !v.trim() || v.startsWith('--')) return { ok: false, error: `${a} needs a value` };
      if (a === '--base') out.base = v;
      else if (a === '--plan') out.plan = v;
      else out.prBody = v;
    } else if (a.startsWith('--')) return { ok: false, error: `unknown flag ${a}` };
    else if (!out.limb) out.limb = a;
    else return { ok: false, error: `unexpected argument ${a}` };
  }
  if (!out.limb) return { ok: false, error: 'missing <limb>' };
  return out;
}

/**
 * Read plan.json and pick the limb entry. Never throws.
 * @param {string} planPath
 * @param {string} limb
 * @returns {{ ok: true, plan: object, entry: object } | { ok: false, error: string }}
 */
export function loadPlanLimb(planPath, limb) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  } catch (e) {
    return { ok: false, error: `cannot read plan ${planPath}: ${e?.message ?? e}` };
  }
  const limbs = Array.isArray(plan?.limbs) ? plan.limbs : [];
  const entry = limbs.find((l) => l?.limb === limb);
  if (!entry) return { ok: false, error: `limb "${limb}" not in plan (have: ${limbs.map((l) => l?.limb).filter(Boolean).join(', ') || 'none'})` };
  if (typeof entry.branch !== 'string' || !entry.branch) return { ok: false, error: `limb "${limb}" has no branch in plan` };
  return { ok: true, plan, entry };
}

/**
 * Render the checklist as a fixed-width table.
 * @param {ReturnType<typeof checkLimbLanding>} result
 * @param {{ limb: string, branch: string, base: string }} ctx
 * @returns {string}
 */
export function formatLandingTable(result, ctx) {
  const lines = [
    `split land ${ctx.limb} · branch ${ctx.branch} · base ${ctx.base}`,
    '',
    '| check | result | detail |',
    '|---|---|---|',
    ...result.checks.map((c) => `| ${c.id} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replaceAll('|', '\\|')} |`),
    '',
    `status: ${result.status}${result.status === 'PASS' ? ' (기계 검사 통과 — 승인은 검수자가 쓴다)' : ''}`,
  ];
  return lines.join('\n');
}

/**
 * Run the command. Injectable IO for tests.
 * @param {{ argv: string[], cwd?: string, stdout?: (s: string) => void, stderr?: (s: string) => void, exec?: Function, lintSpawn?: Function }} p
 * @returns {number} exit code
 */
export function runLand({ argv, cwd = process.cwd(), stdout = (s) => process.stdout.write(`${s}\n`), stderr = (s) => process.stderr.write(`${s}\n`), exec, lintSpawn } = {}) {
  const args = parseLandArgs(argv);
  if (!args.ok) {
    stderr(`${args.error}\n${USAGE}`);
    return 1;
  }
  const parentRoot = path.resolve(cwd);
  const planPath = args.plan ? path.resolve(parentRoot, args.plan) : path.join(parentRoot, '.artibot', 'split', 'plan.json');
  const loaded = loadPlanLimb(planPath, args.limb);
  if (!loaded.ok) {
    stderr(loaded.error);
    return 1;
  }
  const baseInfo = effectiveBase({
    cliBase: args.base,
    planBase: typeof loaded.plan.base === 'string' ? loaded.plan.base : '',
    forkPoint: forkPointForLimb(loaded.plan, args.limb),
    branch: loaded.entry.branch,
    cwd: parentRoot,
    ...(exec ? { exec } : {}),
  });
  const base = baseInfo.base;
  if (!base) {
    stderr('no base: plan.base missing and --base not given');
    return 1;
  }
  const checked = checkLimbLanding({
    cwd: parentRoot,
    limb: args.limb,
    branch: loaded.entry.branch,
    base,
    allowlist: Array.isArray(loaded.entry.affectedPaths) ? loaded.entry.affectedPaths : [],
    ...(exec ? { exec } : {}),
  });
  // Appended, not merged into the lib: see lintCheck's header. A failing lint
  // downgrades PASS to FAIL but never overwrites UNSUPPORTED — that status
  // means the git-side checks could not run at all, which is the louder fact.
  // `worktreePath` comes from the plan, not from `cwd`: git refs are shared so
  // the diff works from anywhere, but eslint reads a working tree and only the
  // limb's own checkout has the limb's bytes (#G14). A plan entry without it is
  // UNSUPPORTED inside `lintCheck` — there is no safe fallback.
  const lint = lintCheck({
    cwd: parentRoot, base, branch: loaded.entry.branch, worktreePath: loaded.entry.worktreePath,
    ...(exec ? { exec } : {}), ...(lintSpawn ? { spawn: lintSpawn } : {}),
  });
  const result = {
    ...checked,
    checks: [...checked.checks, lint],
    status: checked.status === 'PASS' && !lint.ok ? 'FAIL' : checked.status,
  };
  if (args.prBody) {
    try {
      fs.writeFileSync(path.resolve(parentRoot, args.prBody), result.prBody, 'utf-8');
    } catch (e) {
      stderr(`cannot write pr body: ${e?.message ?? e}`);
      return 1;
    }
  }
  // Information only — no `checks[]` row, no effect on `status` or the exit
  // code. The tests scanned are the RUNNER's plugin tree (`PLUGIN_ROOT`), not
  // the limb's worktree, because the pin that matters is the one in the PARENT
  // tree the batch merges into. Consequence, stated rather than hidden: a test
  // the limb itself ADDS is outside this scan and will not be listed.
  const pins = pinTestsFor(result.changedFiles ?? [], path.join(PLUGIN_ROOT, 'tests'));
  if (args.json) {
    stdout(JSON.stringify({
      limb: args.limb, branch: loaded.entry.branch, base, ...result,
      effectiveBase: baseInfo,
      pinTests: pins.pinTests, pinTestsScanned: pins.scanned,
    }, null, 2));
  } else {
    stdout([
      formatLandingTable(result, { limb: args.limb, branch: loaded.entry.branch, base }),
      '',
      formatEffectiveBase(baseInfo),
      '',
      formatPinTests(pins),
    ].join('\n'));
  }
  return result.status === 'PASS' ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = runLand({ argv: process.argv.slice(2) });
}
