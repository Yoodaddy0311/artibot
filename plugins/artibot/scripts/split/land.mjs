#!/usr/bin/env node
/**
 * `split land <limb>` — print the mechanical landing checklist for one limb.
 *
 *   node scripts/split/land.mjs <limb> [--base <ref>] [--plan <path>] [--json] [--pr-body <out>]
 *
 * Reads `<cwd>/.artibot/split/plan.json` (`{ runId, base, repoShort,
 * limbs:[{ limb, branch, worktreePath, affectedPaths }] }`), runs
 * `lib/git/limb-landing-check.js#checkLimbLanding`, prints one PASS/FAIL row
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
import { checkLimbLanding } from '../../lib/git/limb-landing-check.js';
import { isMainEntry } from '../hooks/_main-entry.js';

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
 * @param {{ argv: string[], cwd?: string, stdout?: (s: string) => void, stderr?: (s: string) => void, exec?: Function }} p
 * @returns {number} exit code
 */
export function runLand({ argv, cwd = process.cwd(), stdout = (s) => process.stdout.write(`${s}\n`), stderr = (s) => process.stderr.write(`${s}\n`), exec } = {}) {
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
  const result = checkLimbLanding({
    cwd: parentRoot,
    limb: args.limb,
    branch: loaded.entry.branch,
    base,
    allowlist: Array.isArray(loaded.entry.affectedPaths) ? loaded.entry.affectedPaths : [],
    ...(exec ? { exec } : {}),
  });
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
