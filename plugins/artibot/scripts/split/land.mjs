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
 * `--base` defaults to `plan.base` (the plan-time SHA). Once a limb has
 * merged an advanced main, pass the live ref (`--base master`) or the
 * ownership diff will list other limbs' merged-in files (lib header,
 * "Base choice matters").
 *
 * Exit codes: 0 PASS · 1 FAIL / UNSUPPORTED / usage or plan error.
 *
 * @module scripts/split/land
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkLimbLanding, defaultExec } from '../../lib/git/limb-landing-check.js';
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
 * WHAT THIS ROW CANNOT SEE: files outside `plugins/artibot/` (the CI lint
 * script is plugin-scoped, so neither can CI); anything eslint is configured
 * to ignore; and whether the limb branch is the thing being linted — eslint
 * reads the WORKING TREE, so running this from a checkout that does not have
 * the limb checked out lints the wrong bytes. The row reports the paths it
 * linted so that mismatch is visible rather than assumed.
 *
 * @param {object} p
 * @param {string} p.cwd - parent repo root
 * @param {string} p.base - base ref
 * @param {string} p.branch - limb branch
 * @param {typeof defaultExec} [p.exec=defaultExec] - git runner (injected in tests)
 * @param {typeof spawnSync} [p.spawn=spawnSync] - process runner for eslint
 * @param {string} [p.pluginRoot=PLUGIN_ROOT]
 * @returns {{ id: string, name: string, ok: boolean, detail: string }}
 */
export function lintCheck({
  cwd, base, branch, exec = defaultExec, spawn = spawnSync, pluginRoot = PLUGIN_ROOT,
} = {}) {
  const mk = (ok, detail) => Object.freeze({ id: 'lint', name: 'lint (변경 파일 한정)', ok, detail });

  // `-z`: this repo has Korean paths and `core.quotepath` defaults to on, so
  // newline-separated output would arrive C-quoted and split wrong.
  const names = exec(['diff', '--name-only', '-z', `${base}..${branch}`], { cwd });
  if (names.status !== 0) return mk(false, `UNSUPPORTED — git diff 실패: ${(names.stderr || '').trim().split('\n')[0] || `exit ${names.status}`}`);

  const prefix = 'plugins/artibot/';
  const changed = String(names.stdout || '').split('\0').filter(Boolean);
  const lintable = changed.filter((f) => /\.(?:js|mjs)$/.test(f));
  const inPlugin = lintable.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  const outside = lintable.filter((f) => !f.startsWith(prefix));
  const outsideNote = outside.length ? ` · 플러그인 밖 ${outside.length}건 미검사(CI lint 스코프도 동일)` : '';

  if (inPlugin.length === 0) return mk(true, `SKIP — 변경된 .js/.mjs 0건${outsideNote}`);

  // The eslint JS entry, not the `.bin` shim: spawning `eslint.cmd` without a
  // shell is EINVAL on Windows since Node 20 (measured 2026-09-04 — the row
  // reported UNSUPPORTED for every run), and `shell: true` would put user paths
  // through cmd quoting. `process.execPath` runs the same file on every OS.
  const bin = path.join(pluginRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(bin)) return mk(false, `UNSUPPORTED — eslint 없음 (${bin}); npm ci 후 재실행. PASS 로 넘기지 않는다${outsideNote}`);

  const r = spawn(process.execPath, [bin, '--max-warnings=0', ...inPlugin], {
    cwd: pluginRoot, encoding: 'utf-8', windowsHide: true, timeout: 180000, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return mk(false, `UNSUPPORTED — eslint 실행 실패: ${r.error.message}${outsideNote}`);
  if (r.status === 0) return mk(true, `${inPlugin.length}파일 0 errors 0 warnings${outsideNote}`);
  const first = String(r.stdout || r.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' / ');
  return mk(false, `${inPlugin.length}파일 — ${first}${outsideNote}`);
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
  const base = args.base ?? (typeof loaded.plan.base === 'string' ? loaded.plan.base : '');
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
  const lint = lintCheck({
    cwd: parentRoot, base, branch: loaded.entry.branch, ...(exec ? { exec } : {}), ...(lintSpawn ? { spawn: lintSpawn } : {}),
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
  if (args.json) {
    stdout(JSON.stringify({ limb: args.limb, branch: loaded.entry.branch, base, ...result }, null, 2));
  } else {
    stdout(formatLandingTable(result, { limb: args.limb, branch: loaded.entry.branch, base }));
  }
  return result.status === 'PASS' ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = runLand({ argv: process.argv.slice(2) });
}
