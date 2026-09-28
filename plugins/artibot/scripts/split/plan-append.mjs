#!/usr/bin/env node
/**
 * `split plan-append` — add a limb to an EXISTING run's `plan.json` (rolling
 * assignment). The one sanctioned writer for appended limb rows.
 *
 * Why (Codex SP-04, 2026-09-28): Wave 19~23 appended limbs to `plan.json` by
 * hand 22 times, and an inline `node -e` state write once truncated
 * `run.json` to "" (2026-09-15). This script validates first and writes
 * second, and it writes through a backup plus an atomic replace.
 *
 * Row shape (split.md §plan step 7 `limbs[]`, plus two ADDITIVE keys):
 *
 *   { limb, worktreeName, worktreePath, branch, taskIds, affectedPaths,
 *     wave: <campaign wave number, int >= 1>, rolling: <bool> }
 *
 * `worktreeName`/`worktreePath`/`branch` come from
 * `lib/git/split-dispatch.js#limbsFromPlan` (which validates the slug through
 * `lib/git/limb-completion.js#limbNames`). `forkPoint` is NOT written — the
 * `dispatch` script records it once the worktree exists.
 *
 * Refusals (exit 1, one-line reason on stderr, plan.json bytes untouched and
 * no `.bak` created): plan.json missing or malformed; run.json malformed; limb
 * name invalid or already in the plan; empty task/path lists; bad `--wave`;
 * a `--path` that is not a concrete repo-relative path (absolute, `..`, `~`,
 * drive, `:`, bare `.`); an existing limb that is NOT landed whose
 * `affectedPaths` are missing or unusable by the same rule (ownership
 * unknown); ownership overlap
 * (`lib/autopilot/fast-profile.js#areAffectedPathsConflicting`) or a shared
 * task id with any limb that is not landed. LANDED means `readLaneOpsState(run.json, limb) === 'done'`
 * (the `lane-state.mjs` record) — a `Split-Limb: done` trailer alone does NOT
 * count (leader decision 2026-09-28, fail-closed, no override flag). A missing
 * run.json means no limb is landed.
 *
 * Write order: the current plan.json bytes are copied to `plan.json.bak`
 * FIRST, then the new object goes through `lib/core/file.js#atomicWriteJsonSync`
 * (tmp + rename). A failed write leaves plan.json as it was and the `.bak` in
 * place. `schema_version` is kept as-is, stamped 1 only when absent (the
 * `lib/git/split-run-file.js` rule).
 *
 * @module scripts/split/plan-append
 */

import fs from 'node:fs';
import path from 'node:path';
import { areAffectedPathsConflicting, inspectAffectedPaths } from '../../lib/autopilot/fast-profile.js';
import { atomicWriteJsonSync } from '../../lib/core/file.js';
import { getRepoIdentity, repoShortName } from '../../lib/git/repo-identity.js';
import { limbsFromPlan } from '../../lib/git/split-dispatch.js';
import { planJsonPath, readRunJson, SPLIT_FILE_SCHEMA_VERSION } from '../../lib/git/split-run-file.js';
import { readLaneOpsState } from '../../lib/supervisor/lane-monitor.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * New worktree names longer than this were observed truncated by the harness
 * (2026-09-28, one observation: 34 chars -> 33). A warning, not a refusal.
 */
export const WORKTREE_NAME_WARN_LENGTH = 33;

export const HELP = `usage: node scripts/split/plan-append.mjs --limb <name> --path <affectedPath> [--path ...] --wave <n> [options]

  --parent <root>    parent repo root holding the split state dir (default: cwd)
  --limb <name>      limb slug (validated like /split plan; must not exist in plan.json)
  --task <id>        task id for the row (repeatable; default: the limb name)
  --path <path>      owned path, repo-relative (repeatable; at least one)
  --wave <n>         campaign wave number, integer >= 1
  --rolling          mark the row rolling: true (default false)
  --dry-run          validate and print the row; write nothing
  --json             machine output { ok, planPath, backupPath, added, warnings, dryRun } / { ok: false, error }

Writes plan.json.bak first, then plan.json atomically (tmp + rename).
Refuses duplicates, unusable paths (absolute, .., ~, drive, bare .), ownership overlap and
double-assigned task ids with any limb whose lane state is not 'done'.`;

/**
 * Parse argv. Unknown flags are an error (fail-closed).
 *
 * @param {string[]} argv
 * @returns {{ parent: string|null, limb: string|null, tasks: string[], paths: string[], wave: number|null, rolling: boolean, dryRun: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { parent: null, limb: null, tasks: [], paths: [], wave: null, rolling: false, dryRun: false, json: false, help: false };
  const single = { '--parent': 'parent', '--limb': 'limb', '--wave': 'wave' };
  const repeat = { '--task': 'tasks', '--path': 'paths' };
  const flags = { '--rolling': 'rolling', '--dry-run': 'dryRun', '--json': 'json', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (flags[a]) {
      out[flags[a]] = true;
      continue;
    }
    if (!single[a] && !repeat[a]) throw new Error(`unknown argument: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
    if (single[a]) out[single[a]] = v;
    else out[repeat[a]] = [...out[repeat[a]], v];
    i += 1;
  }
  if (out.wave !== null) {
    const n = Number(out.wave);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--wave must be an integer >= 1 (got ${out.wave})`);
    out.wave = n;
  }
  return out;
}

const isNonEmptyStringList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim());

/**
 * Shape checks for one spec, before any plan lookup. `null` = valid.
 *
 * @param {{ limb: string, taskIds: string[], affectedPaths: string[], wave: number, rolling: boolean }} spec
 * @returns {string|null}
 */
function specShapeError(spec) {
  if (!spec || typeof spec.limb !== 'string' || !spec.limb) return 'limb name is required';
  if (!isNonEmptyStringList(spec.taskIds)) return `limb ${spec.limb}: taskIds must be a non-empty list of ids`;
  if (!isNonEmptyStringList(spec.affectedPaths)) return `limb ${spec.limb}: at least one affected path is required (ownership cannot be checked without one)`;
  if (!Number.isInteger(spec.wave) || spec.wave < 1) return `limb ${spec.limb}: wave must be an integer >= 1`;
  if (typeof spec.rolling !== 'boolean') return `limb ${spec.limb}: rolling must be a boolean`;
  return null;
}

/**
 * Why a path list cannot serve as an ownership claim, or `null`.
 *
 * Every entry must name a concrete repo-relative path. `inspectAffectedPaths`
 * flags absolute / `~` / drive / `..` / `:` / non-string entries as unsafe and
 * silently drops absent or root-only ones (`null`, `.`, `./`);
 * `areAffectedPathsConflicting` drops all of them, so any such entry would
 * slip past the overlap check (fail-open — `--path .` passed an active limb).
 * Checked per entry, so a mixed list like `['src/a.js', '.']` is refused too.
 *
 * @param {unknown} values
 * @returns {string|null}
 */
function pathClaimError(values) {
  if (!Array.isArray(values) || values.length === 0) return 'no affectedPaths';
  const bad = values.filter((v) => {
    const r = inspectAffectedPaths([v]);
    return r.unsafe || r.paths.length === 0;
  });
  return bad.length ? `unusable affectedPaths ${JSON.stringify(bad)}` : null;
}

/** Task ids of a row, as next-wave counts them (`[limb]` when absent). */
const rowTaskIds = (row) => (Array.isArray(row?.taskIds) && row.taskIds.length ? row.taskIds : [row?.limb]);

/**
 * Ownership and assignment check of one spec against every limb that is NOT
 * landed: the row's own claim must be usable, paths must not overlap, and no
 * task id may be assigned twice. `null` = no conflict.
 *
 * @param {object} spec
 * @param {object[]} rows - existing plan rows plus specs accepted before this one
 * @param {object|null} run
 * @returns {string|null}
 */
function ownershipError(spec, rows, run) {
  for (const row of rows) {
    const name = row?.limb;
    const ops = readLaneOpsState(run, name);
    if (ops === 'done') continue;
    const state = ops ?? 'unknown';
    const claim = pathClaimError(row?.affectedPaths);
    if (claim) {
      return `limb ${name} (lane state ${state}) has ${claim} — ownership unknown; fix its row or mark it done with lane-state.mjs first`;
    }
    if (areAffectedPathsConflicting(row.affectedPaths, spec.affectedPaths)) {
      return `limb ${spec.limb} overlaps owned paths of limb ${name} (lane state ${state}, not landed)`;
    }
    const shared = spec.taskIds.filter((id) => rowTaskIds(row).includes(id));
    if (shared.length) {
      return `limb ${spec.limb} task ${shared.join(', ')} is already assigned to limb ${name} (lane state ${state}, not landed)`;
    }
  }
  return null;
}

/**
 * Build the plan row for a validated spec. Throws on an invalid slug
 * (`limbNames`), which the caller turns into a refusal.
 *
 * @param {object} spec
 * @param {{ parentRoot: string, repoShort: string }} ctx
 * @returns {object}
 */
function buildRow(spec, { parentRoot, repoShort }) {
  const [derived] = limbsFromPlan({ limbs: [{ limb: spec.limb }] }, parentRoot, { repoShort });
  return {
    limb: spec.limb,
    worktreeName: path.basename(derived.worktreePath),
    worktreePath: derived.worktreePath,
    branch: derived.branch,
    taskIds: [...spec.taskIds],
    affectedPaths: [...spec.affectedPaths],
    wave: spec.wave,
    rolling: spec.rolling,
  };
}

/**
 * Pure core: append limb rows to a parsed plan. Never mutates its inputs.
 *
 * @param {object} plan - parsed plan.json
 * @param {object|null} run - parsed run.json (`null` = absent → nothing landed)
 * @param {Array<{ limb: string, taskIds: string[], affectedPaths: string[], wave: number, rolling: boolean }>} specs
 * @param {{ parentRoot: string, repoShort: string }} ctx
 * @returns {{ ok: true, plan: object, added: object[], warnings: string[] } | { ok: false, reason: string }}
 */
export function appendLimbs(plan, run, specs, ctx) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, reason: 'plan is not a JSON object' };
  if (!Array.isArray(specs) || specs.length === 0) return { ok: false, reason: 'no limb to append' };
  const existing = Array.isArray(plan.limbs) ? plan.limbs : [];
  const known = new Set(existing.map((r) => r?.limb).filter(Boolean));
  const added = [];
  const warnings = [];
  for (const spec of specs) {
    const shape = specShapeError(spec);
    if (shape) return { ok: false, reason: shape };
    const claim = pathClaimError(spec.affectedPaths);
    if (claim) return { ok: false, reason: `limb ${spec.limb}: ${claim} — every --path must be a repo-relative file or directory` };
    if (known.has(spec.limb)) return { ok: false, reason: `limb ${spec.limb} already exists in plan.json` };
    let row;
    try {
      row = buildRow(spec, ctx);
    } catch (e) {
      return { ok: false, reason: `invalid limb name ${JSON.stringify(spec.limb)}: ${e.message}` };
    }
    const overlap = ownershipError(spec, [...existing, ...added], run);
    if (overlap) return { ok: false, reason: overlap };
    if (row.worktreeName.length > WORKTREE_NAME_WARN_LENGTH) {
      warnings.push(`worktree name ${row.worktreeName} is ${row.worktreeName.length} chars; new worktrees above ${WORKTREE_NAME_WARN_LENGTH} were observed truncated — check git worktree list before dispatch`);
    }
    known.add(spec.limb);
    added.push(row);
  }
  return { ok: true, plan: { ...plan, limbs: [...existing, ...added] }, added, warnings };
}

/** `schema_version` kept as-is; stamped only when absent (split-run-file rule). */
function stampSchemaVersion(obj) {
  return Object.hasOwn(obj, 'schema_version') ? obj : { ...obj, schema_version: SPLIT_FILE_SCHEMA_VERSION };
}

/** Refusal error: the CLI prints `.message` as the one-line reason. */
function refuse(reason) {
  return Object.assign(new Error(reason), { refused: true });
}

/**
 * Parse plan.json from the exact bytes that go to `.bak` (one read — no window
 * between backup and parse). Same rule as `split-run-file.js#readPlanJson`:
 * BOM tolerated, non-object refused.
 *
 * @param {Buffer} bytes
 * @param {string} planPath
 * @returns {object}
 */
function parsePlanBytes(bytes, planPath) {
  const text = bytes.toString('utf-8');
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${planPath} is not a JSON object`);
  return parsed;
}

/**
 * Read plan.json bytes + parsed object and run.json. Throws a refusal.
 *
 * @param {string} parentRoot
 * @returns {{ planPath: string, bytes: Buffer, plan: object, run: object|null }}
 */
function loadState(parentRoot) {
  const planPath = planJsonPath(parentRoot);
  let bytes;
  try {
    bytes = fs.readFileSync(planPath);
  } catch (e) {
    throw refuse(e?.code === 'ENOENT' ? `plan.json missing: ${planPath}` : `plan.json unreadable: ${e.message}`);
  }
  let plan;
  let run;
  try {
    plan = parsePlanBytes(bytes, planPath);
  } catch (e) {
    throw refuse(`plan.json malformed: ${e.message}`);
  }
  try {
    run = readRunJson(parentRoot);
  } catch (e) {
    throw refuse(`run.json malformed (landed state unknown): ${e.message}`);
  }
  return { planPath, bytes, plan, run };
}

/**
 * Validate and (unless dry-run) write. Throws a refusal on any failure.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{ cwd?: string, writeJson?: (filePath: string, data: object) => void }} [opts] - `writeJson` is the test seam for the atomic write (default `atomicWriteJsonSync`).
 * @returns {{ ok: true, planPath: string, backupPath: string|null, added: object[], warnings: string[], dryRun: boolean }}
 */
export function runAppend(args, opts = {}) {
  const parentRoot = path.resolve(args.parent ?? opts.cwd ?? process.cwd());
  if (!args.limb) throw refuse('--limb is required');
  if (args.wave === null) throw refuse('--wave is required');
  const { planPath, bytes, plan, run } = loadState(parentRoot);
  const repoShort = typeof plan.repoShort === 'string' && plan.repoShort
    ? plan.repoShort
    : repoShortName(getRepoIdentity(parentRoot));
  if (!repoShort) throw refuse('repoShort unknown — plan.json has none and the parent root has no git identity');
  const spec = {
    limb: args.limb,
    taskIds: args.tasks.length ? args.tasks : [args.limb],
    affectedPaths: args.paths,
    wave: args.wave,
    rolling: args.rolling,
  };
  const r = appendLimbs(plan, run, [spec], { parentRoot, repoShort });
  if (!r.ok) throw refuse(r.reason);
  if (args.dryRun) return { ok: true, planPath, backupPath: null, added: r.added, warnings: r.warnings, dryRun: true };
  const backupPath = `${planPath}.bak`;
  fs.writeFileSync(backupPath, bytes);
  try {
    (opts.writeJson ?? atomicWriteJsonSync)(planPath, stampSchemaVersion(r.plan));
  } catch (e) {
    throw refuse(`plan.json write failed (${e.message}); plan.json is unchanged, backup at ${backupPath}`);
  }
  return { ok: true, planPath, backupPath, added: r.added, warnings: r.warnings, dryRun: false };
}

/**
 * CLI entry. Returns exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, writeJson?: Function, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {number}
 */
export function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`plan-append refused: ${e.message}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  try {
    const r = runAppend(args, opts);
    if (args.json) out(`${JSON.stringify(r, null, 2)}\n`);
    else {
      const verb = r.dryRun ? 'would append' : 'appended';
      out(`${verb} ${r.added.map((a) => `${a.limb} (wave ${a.wave}${a.rolling ? ', rolling' : ''})`).join(', ')} to ${r.planPath}${r.backupPath ? ` — backup ${r.backupPath}` : ''}\n`);
    }
    for (const w of r.warnings) err(`warning: ${w}\n`);
    return 0;
  } catch (e) {
    err(`plan-append refused: ${e.message}\n`);
    if (args.json) out(`${JSON.stringify({ ok: false, error: e.message }, null, 2)}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
