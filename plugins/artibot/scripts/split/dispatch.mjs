#!/usr/bin/env node
/**
 * `/split dispatch <limb>` — render the window prompt from the template,
 * materialise the brief into the worktree, and print the ONE-LINE pointer the
 * leader sends. THIS SCRIPT NEVER SENDS. The leader (main session) takes the
 * printed `pointer` and does `SendMessage(to=<to>, message=<pointer>)`; the
 * window reads `prompt.md` / `brief.md` from disk.
 *
 * Why (proposal A5, Ontology 2026-09-02): pasting a ~2.5KB prompt per lane by
 * hand, nine times, cost leader context and produced substitution mistakes.
 * Rendering is now code (`lib/git/split-brief.js#renderPrompt`, fail-closed on
 * any unresolved placeholder) and the message is a pointer.
 *
 * Inputs (parentRoot = cwd):
 *   <parentRoot>/.artibot/split/plan.json      limb rows (worktreePath / branch)
 *   <parentRoot>/.artibot/split/run.json       window map (optional)
 *   <parentRoot>/.artibot/split/<limb>/brief.md  parent brief (required)
 *   <parentRoot>/.artibot/split/gotchas.md     {GOTCHAS_DELTA} (optional, or --gotchas)
 *   commands/split.md (plugin)                 {REPORT_CONTRACT} — single source of truth
 *   artibot.config.json                        {MODEL_POLICY} via resolveModel; split.dispatch.{budget,template}
 *
 * Outputs (unless --dry-run):
 *   <worktreePath>/.artibot/split/<limb>/brief.md   byte-exact copy
 *   <worktreePath>/.artibot/split/<limb>/prompt.md  rendered prompt
 *
 * Exit codes: 0 ok · 1 refused / error (message on stderr, or JSON with --json).
 *
 * @module scripts/split/dispatch
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractReportContract, materializeLimb, renderModelPolicy, renderPrompt } from '../../lib/git/split-brief.js';
import { getRepoIdentity, repoShortName } from '../../lib/git/repo-identity.js';
import { readRunJson, windowForLimb } from '../../lib/git/split-run-file.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import { limbsFromPlan } from '../../lib/git/split-dispatch.js';
import { loadConfig } from '../../lib/core/config.js';
import { toProjectSlug } from '../../lib/handoff/handoff-builder.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Plugin root, resolved from this file — never from cwd (cwd is the user's repo). */
export const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
/** Built-in template; `--template` or `split.dispatch.template` override it. */
export const DEFAULT_TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'split', 'PROMPT-TEMPLATE.md');
/** The contract carrier read for `{REPORT_CONTRACT}`. */
export const SPLIT_MD = path.join(PLUGIN_ROOT, 'commands', 'split.md');
/** `{BUDGET}` when neither `--budget` nor `split.dispatch.budget` is set. */
export const DEFAULT_BUDGET = 600000;

export const HELP = `usage: node scripts/split/dispatch.mjs <limb> [options]

  --template <path>   prompt template (default: templates/split/PROMPT-TEMPLATE.md)
  --window <session>  target session name for the pointer (default: run.json windows/windowReuse[limb], else null)
  --parent <session>  parent (leader) session name for {PARENT} (default: plan.json.parentSession / run.json.parentSession)
  --gotchas <path>    text for {GOTCHAS_DELTA} (default: .artibot/split/gotchas.md, else "(없음)")
  --budget <n>        {BUDGET} (default: artibot.config.json#split.dispatch.budget, else ${DEFAULT_BUDGET})
  --dry-run           render only; write nothing (prints the prompt with --json)
  --json              machine output { to, limb, pointer, promptPath, briefPath }

This script NEVER sends. Take \`pointer\` and send it yourself:
  SendMessage(to=<to>, message=<pointer>)
The window reads prompt.md / brief.md from disk; the pointer is one line.`;

/**
 * Parse argv. Unknown `--flags` are an error (fail-closed — a typo must not
 * silently become a default).
 *
 * @param {string[]} argv
 * @returns {{ limb: string|null, template: string|null, window: string|null, parent: string|null, gotchas: string|null, budget: number|null, dryRun: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { limb: null, template: null, window: null, parent: null, gotchas: null, budget: null, dryRun: false, json: false, help: false };
  const withValue = { '--template': 'template', '--window': 'window', '--parent': 'parent', '--gotchas': 'gotchas', '--budget': 'budget' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (withValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      out[withValue[a]] = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else if (out.limb === null) out.limb = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (out.budget !== null) {
    const n = Number(out.budget);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget must be a positive integer (got ${out.budget})`);
    out.budget = n;
  }
  return out;
}

/** Forward-slash form for prompt text (the brief pointer keeps `path.join` form — that is `buildLimbMessage`'s call). */
const fwd = (p) => String(p).replace(/\\/g, '/');

/**
 * Resolve the limb row from `plan.json`. Rows written by `/split plan` carry
 * `worktreePath`/`branch`; older or hand-written plans may not, in which case
 * the canonical names are derived (`limbsFromPlan`) from `plan.repoShort`.
 *
 * @param {object} plan
 * @param {string} limb
 * @param {string} parentRoot
 * @param {string} repoShort
 * @returns {{ limb: string, worktreePath: string, branch: string }}
 */
export function resolveLimbRow(plan, limb, parentRoot, repoShort) {
  const rows = Array.isArray(plan?.limbs) ? plan.limbs : [];
  const row = rows.find((r) => r && r.limb === limb);
  if (!row) {
    const known = rows.map((r) => r?.limb).filter(Boolean).join(', ') || '(none)';
    throw new Error(`limb ${JSON.stringify(limb)} not in plan.json (known: ${known})`);
  }
  if (typeof row.worktreePath === 'string' && row.worktreePath && typeof row.branch === 'string' && row.branch) {
    return { limb, worktreePath: row.worktreePath, branch: row.branch };
  }
  const derived = limbsFromPlan({ limbs: [row] }, parentRoot, { repoShort })[0];
  return {
    limb,
    worktreePath: row.worktreePath || derived.worktreePath,
    branch: row.branch || derived.branch,
  };
}

/** Read a UTF-8 file, CRLF → LF, or `null` when absent. */
function readTextOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Run dispatch for one limb. Pure apart from the reads listed in the module
 * header and the two writes `materializeLimb` does (skipped with `dryRun`).
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{ cwd?: string, config?: object|null, splitMdPath?: string }} [opts] - `config` injectable for tests (null = read via loadConfig)
 * @returns {Promise<{ to: string|null, limb: string, pointer: string, promptPath: string|null, briefPath: string, copied: boolean, dryRun: boolean, prompt: string }>}
 */
export async function runDispatch(args, opts = {}) {
  if (!args.limb) throw new Error('limb is required (see --help)');
  const parentRoot = path.resolve(opts.cwd ?? process.cwd());
  const splitDir = path.join(parentRoot, '.artibot', 'split');
  const planText = readTextOrNull(path.join(splitDir, 'plan.json'));
  if (planText === null) throw new Error(`plan.json missing: ${path.join(splitDir, 'plan.json')} — run /split plan first`);
  const plan = JSON.parse(planText);
  const run = readRunJson(parentRoot);

  let config = opts.config === undefined ? null : opts.config;
  if (config === null && opts.config === undefined) {
    try { config = await loadConfig(); } catch { config = null; }
  }
  const dispatchCfg = config?.split?.dispatch && typeof config.split.dispatch === 'object' ? config.split.dispatch : {};

  const repoShort = typeof plan.repoShort === 'string' && plan.repoShort
    ? plan.repoShort
    : repoShortName(getRepoIdentity(parentRoot));
  const row = resolveLimbRow(plan, args.limb, parentRoot, repoShort);

  const parent = args.parent ?? plan.parentSession ?? run?.parentSession ?? null;
  if (!parent) throw new Error('parent session unknown — pass --parent <session> (or set plan.json.parentSession)');

  const templatePath = args.template ?? (typeof dispatchCfg.template === 'string' && dispatchCfg.template ? dispatchCfg.template : DEFAULT_TEMPLATE);
  const template = readTextOrNull(templatePath);
  if (template === null) throw new Error(`template missing: ${templatePath}`);

  const splitMd = readTextOrNull(opts.splitMdPath ?? SPLIT_MD);
  if (splitMd === null) throw new Error(`commands/split.md missing: ${opts.splitMdPath ?? SPLIT_MD}`);
  const contract = extractReportContract(splitMd).replace(/\{리더 이름\}/g, parent);

  const gotchasPath = args.gotchas ?? path.join(splitDir, 'gotchas.md');
  const gotchas = readTextOrNull(gotchasPath);
  if (args.gotchas && gotchas === null) throw new Error(`--gotchas file missing: ${gotchasPath}`);

  const budget = args.budget ?? (Number.isInteger(dispatchCfg.budget) && dispatchCfg.budget > 0 ? dispatchCfg.budget : DEFAULT_BUDGET);
  const parentRootOut = typeof plan.parentRoot === 'string' && plan.parentRoot ? plan.parentRoot : parentRoot;

  const prompt = renderPrompt(template, {
    RUN: String(plan.runId ?? ''),
    LIMB: row.limb,
    WORKTREE_DIR: path.basename(row.worktreePath.replace(/[\\/]+$/, '')),
    WORKTREE_PATH: fwd(row.worktreePath),
    BRANCH: row.branch,
    BASE: String(plan.base ?? ''),
    PARENT: parent,
    PARENT_ROOT: fwd(parentRootOut),
    SLUG: toProjectSlug(parentRootOut),
    REPO_SHORT: repoShort,
    MODEL_POLICY: renderModelPolicy(config),
    GOTCHAS_DELTA: gotchas === null ? '(없음)' : gotchas.trim() || '(없음)',
    REPORT_CONTRACT: contract,
    BUDGET: budget,
  });

  const mat = materializeLimb({
    parentRoot, worktreePath: row.worktreePath, limb: row.limb, branch: row.branch, plan, prompt, dryRun: args.dryRun,
  });
  const to = args.window ?? windowForLimb(run, row.limb);
  return {
    to, limb: row.limb, pointer: mat.pointer, promptPath: mat.promptPath, briefPath: mat.briefPath, copied: mat.copied, dryRun: args.dryRun, prompt,
  };
}

/**
 * CLI entry. Returns the exit code; prints to stdout/stderr.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, config?: object|null, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  try {
    const r = await runDispatch(args, opts);
    if (args.json) {
      const { prompt, ...rest } = r;
      out(`${JSON.stringify(args.dryRun ? { ...rest, prompt } : rest, null, 2)}\n`);
    } else {
      out([
        `limb: ${r.limb}${r.dryRun ? ' (dry-run — nothing written)' : ''}`,
        `to: ${r.to ?? '(unknown — pass --window; SendMessage target needed)'}`,
        `brief: ${r.briefPath}${r.copied ? ' (copied)' : ''}`,
        `prompt: ${r.promptPath ?? '(not written)'}`,
        '',
        'pointer (send this ONE message yourself — this script never sends):',
        r.pointer,
        '',
      ].join('\n'));
    }
    return 0;
  } catch (e) {
    if (args.json) out(`${JSON.stringify({ error: e.message, limb: args.limb }, null, 2)}\n`);
    else err(`dispatch refused: ${e.message}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
