#!/usr/bin/env node
/**
 * Run the Resume Contract report and the lane reconcile, and print them. Once.
 *
 * `/resume --contract` (commands/resume.md, the `--contract` section) describes
 * two blocks in prose and names the two functions that produce them. Prose is
 * not a caller: until this script existed, nothing in the repository actually
 * invoked `buildResumeReport` from a command surface, so "the report exists"
 * and "the report runs" were two different statements and only the first was
 * true. This file makes the second one true, and does nothing else.
 *
 * ── REPORT ONLY, AND HOW THAT IS STRUCTURAL ────────────────────────────────
 * Zero write ports are bound. The three places a write could enter are each
 * closed by construction rather than by intention:
 *
 *   1. The StateStore's five write bindings — enumerated as `WRITE_PORTS` in
 *      `tests/firewall/resume-contract-report-only.test.js`, and deliberately
 *      not spelled here — are never bound. `lib/checkpoint/resume-controller.js`
 *      accepts no write port at all, so there is nowhere to pass them TO, and
 *      the CLI test pins four of the five names at zero occurrences in this
 *      file so a later edit cannot reach for one quietly.
 *   2. `reconcile` is wrapped, not forwarded. The wrapper hard-codes
 *      `apply: false` and takes no argument, so a caller asking for the
 *      applying branch of `lib/project-state/reconcile.js#reconcileStore`
 *      cannot reach it even if some future controller forwarded the request —
 *      the mistake `tests/firewall/resume-contract-report-only.test.js` exists
 *      to catch. The CLI test pins the opposite spelling at zero occurrences.
 *   3. The store's ledger port REFUSES. `createStateStore` requires an
 *      `appendEvent` function, and the store abandons any write whose paired
 *      event is refused (`state-manager.js#emitStateUpdated`, which returns
 *      before the journal append). Binding a refusal rather than a no-op means
 *      that if a write path is ever reached from here by accident, it fails
 *      closed instead of committing an unpaired write.
 *      PRECISELY what "fails closed" covers: no journal line and no snapshot,
 *      because both are written after the refusal check. It does NOT cover the
 *      store directory or the file lock — `state-manager.js#commit` creates the
 *      directory and takes the lock BEFORE calling the body that refuses. So a
 *      write attempt from here would leave no record, but could leave a
 *      directory. No such path exists today; this says what the guarantee is
 *      worth if one is ever added.
 *
 * THE LEDGER WRITER IS NOT IMPORTED — not the function, not its name.
 * `lib/runtime/middleware/tasks.js#openMissionStore` is the existing way to open
 * this store and would have been the obvious reuse, but it binds the runtime
 * ledger writer (`lib/runtime/ledger.js`) as its `appendEvent` port and pins
 * `source: 'hook'` — a real writer, wired into a report. So the store is opened
 * here instead, with the refusing port above. `tests/scripts/resume-report-cli.test.js`
 * reads this file's source and pins the writer's identifier at zero occurrences,
 * comments included, so this paragraph names the module rather than the export.
 *
 * ── WHY NO `resolveModel` PORT ─────────────────────────────────────────────
 * Step 9 ("Re-evaluate model/cache availability") stays `reconcile:model-unknown`
 * on purpose. `lib/core/model-policy.js#resolveModel(agentType, opts, config)`
 * takes an AGENT TYPE; a checkpoint's `current_model` is a model id. Feeding
 * one to the other returns a well-formed answer to a question nobody asked, and
 * the report would then print a model comparison that means nothing. An honest
 * "unknown" is the fail-closed reading the rules require.
 *
 * ── EXIT CODES ─────────────────────────────────────────────────────────────
 *   0  a report was produced — INCLUDING when everything in it is blocked
 *   1  an unexpected failure escaped `main` (a bug here, not a finding about
 *      the project): the message goes to stderr and NO document is printed, so
 *      a caller never parses a half-built report as a whole one
 *   2  usage error: the command line is wrong and nothing was read
 *
 * A blocked report is a successful report. This is a reporting tool, not a
 * gate, so `blocked_by` entries change what is printed and never the exit code;
 * a caller that wants a gate must read the document. Per-block failures (no
 * store, no run state file, unparseable JSON) print `측정 불가: <사유>` for that
 * block alone and leave the rest of the document standing — the partial-failure
 * rule of the `--contract` section.
 *
 * USAGE
 *   node scripts/checkpoint/resume-report.mjs --all [--cwd <projectRoot>]
 *   node scripts/checkpoint/resume-report.mjs --mission <id> [--cwd <root>]
 *     [--run-json <path>] [--json]
 *
 * @module scripts/checkpoint/resume-report
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createFileStoreAdapter } from '../../lib/checkpoint/adapters/file-store.js';
import { createCheckpointService } from '../../lib/checkpoint/checkpoint-service.js';
import { createCheckpointStore } from '../../lib/checkpoint/checkpoint-store.js';
import { buildResumeReport } from '../../lib/checkpoint/resume-controller.js';
import { readLimbCompletion } from '../../lib/git/limb-completion.js';
import { getRepoIdentity, repoShortName, splitLimbBranch } from '../../lib/git/repo-identity.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { isLeaseExpired } from '../../lib/project-state/lease.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { reconcileLanes } from '../../lib/supervisor/lane-reconcile.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. */
const VALUE_FLAGS = ['--mission', '--cwd', '--run-json'];

/** Flags that take none. */
const BOOL_FLAGS = ['--all', '--json'];

const USAGE = 'usage: resume-report.mjs (--mission <id> | --all)'
  + ' [--cwd <projectRoot>] [--run-json <path>] [--json]';

/** The leader's split run state file, relative to the project root. */
const RUN_JSON_RELATIVE = ['.artibot', 'split', 'run.json'];

/** Printed for an empty `blocked_by`. NOT "passed" — resume.md says so. */
const NO_BLOCKS = '-';

/**
 * Report a usage error on ONE line and nothing else.
 *
 * @param {string} message - What was wrong.
 * @returns {2} The exit code, returned so callers read as `return fail(...)`.
 */
function fail(message) {
  process.stderr.write(`resume-report: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list into a flag map.
 *
 * Slot 1 of `process.argv` is never read here or anywhere in this file: the
 * entry-point decision belongs to `isMainEntry` (tests/ci/direct-run-guard).
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{opts: Record<string, string|boolean>}|{error: string}} Parse result.
 */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (BOOL_FLAGS.includes(flag)) {
      opts[flag.slice(2)] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) return { error: `unknown argument: ${flag}` };
    if (i + 1 >= argv.length) return { error: `${flag} requires a value` };
    opts[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  return { opts };
}

/**
 * The command line itself, judged before anything is read.
 *
 * `--mission` and `--all` are mutually exclusive and one is REQUIRED: a default
 * of "all" would make a typo'd mission id silently report the whole project,
 * which reads as success for a question that was never answered.
 *
 * @param {Record<string, string|boolean>} opts - Parsed flags.
 * @returns {string|null} The error, or null.
 */
function usageError(opts) {
  const hasMission = typeof opts.mission === 'string';
  if (hasMission && opts.mission === '') return '--mission must not be empty';
  if (hasMission && opts.all === true) return '--mission and --all are mutually exclusive';
  if (!hasMission && opts.all !== true) return 'one of --mission <id> or --all is required';
  return null;
}

/**
 * Shell-free git that never throws. Same shape as `scripts/split/watch.mjs#git`.
 *
 * @param {string[]} args - Git arguments.
 * @param {string} cwd - Directory to run in.
 * @returns {{ok: boolean, out: string}} Outcome.
 */
function git(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    });
    return { ok: true, out: String(out) };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file - Absolute path.
 * @returns {{ok: true, value: object}|{ok: false, reason: string}} Outcome.
 */
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return { ok: false, reason: `파일 없음 또는 읽기 실패 (${/** @type {any} */ (err)?.code ?? 'error'}): ${file}` };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { ok: false, reason: `JSON 최상위가 객체가 아님: ${file}` };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: `JSON 파싱 실패: ${/** @type {any} */ (err)?.message ?? 'parse error'}` };
  }
}

/**
 * Open the two stores the report reads, with no write binding.
 *
 * Opening is a read: `createStateStore` does `path` arithmetic only (the
 * directory is created by `commit`, not by construction), and
 * `createFileStoreAdapter` documents the same for the checkpoint file. Verified
 * by the CLI test, which hashes the whole store directory across a run.
 *
 * @param {string} projectRoot - Absolute project root.
 * @returns {{store: object, latestValid: Function}} The bound read surfaces.
 */
function openStores(projectRoot) {
  const store = createStateStore({
    projectRoot,
    sessionId: 'resume-report',
    renderProjectionFile: false,
    resolveGitCommonDir: () => resolveGitCommonDir(projectRoot),
    // Refusal, not a no-op: the store abandons a write whose event is refused,
    // so an accidental write path here fails closed instead of committing.
    appendEvent: () => ({ ok: false, reason: 'report-only: this CLI binds no ledger writer' }),
  });
  const checkpoints = createCheckpointStore({ adapter: createFileStoreAdapter({ dir: store.location.dir }) });
  const { latestValid } = createCheckpointService({ store: checkpoints, appendEvent: null });
  return { store, latestValid };
}

/**
 * The read ports for one `buildResumeReport` call.
 *
 * @param {object} store - The StateStore.
 * @param {Function} latestValid - Checkpoint service port.
 * @param {number} nowMs - One clock reading for the whole run.
 * @returns {object} Ports.
 */
function readPorts(store, latestValid, nowMs) {
  return {
    latestValid,
    getMission: (missionId) => store.getMission(missionId),
    getTaskGraph: (missionId) => store.getTaskGraph(missionId),
    getLease: (missionId, taskId) => store.getLease(missionId, taskId),
    isLeaseExpired,
    // `apply` is hard-coded, never forwarded — see the module header.
    reconcile: () => store.reconcile({ apply: false }),
    now: () => nowMs,
  };
}

/**
 * Count the three step verdicts of one report.
 *
 * @param {object[]} steps - Step entries.
 * @returns {{ok: number, failed: number, unknown: number}} Counts.
 */
function countSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return {
    ok: list.filter((s) => s?.ok === true).length,
    failed: list.filter((s) => s?.ok === false).length,
    unknown: list.filter((s) => s?.ok !== true && s?.ok !== false).length,
  };
}

/**
 * Build the Resume Contract block.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {string|null} missionId - One mission, or null for every active one.
 * @param {number} nowMs - Clock reading.
 * @returns {Promise<object>} The block: `{store, missions}` or `{unavailable}`.
 */
async function contractBlock(projectRoot, missionId, nowMs) {
  let store;
  let latestValid;
  try {
    ({ store, latestValid } = openStores(projectRoot));
  } catch (err) {
    return { unavailable: `스토어를 열 수 없음: ${/** @type {any} */ (err)?.message ?? err}` };
  }

  let ids;
  try {
    ids = missionId === null ? Object.keys(store.getState().active_missions ?? {}) : [missionId];
  } catch (err) {
    return { unavailable: `mission 목록을 읽을 수 없음: ${/** @type {any} */ (err)?.message ?? err}` };
  }

  const ports = readPorts(store, latestValid, nowMs);
  const missions = [];
  for (const id of ids) {
    const report = await buildResumeReport(ports, { missionId: id });
    missions.push({
      mission_id: id,
      // An id that is in no store still produces a well-formed report — every
      // step just reads "absent". Without this flag that document is
      // indistinguishable from a real mission in trouble, which is how a typo'd
      // `--mission` reads as a finding. The controller cannot say it: a missing
      // mission and a mission with nothing to say are the same to a read port.
      in_store: store.getMission(id) !== null,
      checkpoint_id: report.evidence?.checkpoint_id ?? null,
      ts: report.evidence?.ts ?? null,
      resumable: report.resumable,
      steps: countSteps(report.steps),
      blocked_by: report.blocked_by,
    });
  }
  return { store: { dir: store.location.dir, source: store.location.source }, missions };
}

/**
 * Limb names and their branches, from the two files that know them.
 *
 * `plan.json` carries the branch verbatim; a limb known only to `run.json` gets
 * the naming rule (`repo-identity.js#splitLimbBranch`) applied to the repo short
 * name, which is what `scripts/split/watch.mjs#resolveLimbs` does.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {object} run - Parsed run state file.
 * @param {object|null} plan - Parsed plan file, when present.
 * @returns {Array<{limb: string, branch: string|null}>} Limbs in report order.
 */
function resolveLimbBranches(projectRoot, run, plan) {
  const byName = new Map();
  for (const entry of Array.isArray(plan?.limbs) ? plan.limbs : []) {
    if (typeof entry?.limb === 'string' && entry.limb) {
      byName.set(entry.limb, typeof entry.branch === 'string' ? entry.branch : null);
    }
  }
  // `run.json.limbs` holds bare strings by contract; live files have also held
  // objects (measured 2026-09-21), so only strings are taken from it and the
  // authoritative enumeration is `lanes`, which `reconcileLanes` unions anyway.
  for (const name of Array.isArray(run?.limbs) ? run.limbs : []) {
    if (typeof name === 'string' && name && !byName.has(name)) byName.set(name, null);
  }
  for (const name of Object.keys(run?.lanes && typeof run.lanes === 'object' ? run.lanes : {})) {
    if (!byName.has(name)) byName.set(name, null);
  }

  let repoShort = typeof plan?.repoShort === 'string' ? plan.repoShort : '';
  if (!repoShort) {
    try {
      repoShort = repoShortName(getRepoIdentity(projectRoot));
    } catch {
      repoShort = '';
    }
  }
  return [...byName].map(([limb, branch]) => ({
    limb,
    branch: branch ?? (repoShort ? splitLimbBranch(repoShort, limb) : null),
  }));
}

/**
 * Git evidence for one limb, in the shape `lane-monitor.js#assessLane` documents.
 *
 * ── THE TIMESTAMP IS ATTRIBUTED, NOT JUST READ ────────────────────────────
 * `git log -1 <branch>` answers "when was the tip committed?", which is NOT the
 * question. A limb that has produced nothing sits AT its base, so the tip is the
 * base commit and its date belongs to whoever made the base — often minutes
 * old on a fresh run. Handing that to `assessLane` reads as a `commit` signal
 * minutes old and classifies an idle lane `healthy` with an empty `blocked_by`:
 * fail-open, in the one direction the supervisor exists to catch.
 *
 * So the date is taken only when the limb has commits OF ITS OWN in the base
 * range — `commitCount > 0` over a `base..branch` walk that resolved. That
 * property is read off the measurement rather than off a list of `reason`
 * words, so a new reason cannot quietly join the attributing side. Both halves
 * matter: without a base there is no range, and a full-history walk counts the
 * shared past as the limb's own.
 *
 * Unattributed means `lastCommitAt: null`, and with no heartbeat either that is
 * `signal: 'none'` → `health: 'unknown'` (lane-monitor.js, the `signal === 'none'`
 * return) → `reconcile:lane-unknown`. "Not measured" is louder than a borrowed
 * timestamp, which is the fail-closed direction.
 *
 * `dirty` is `null` — NOT measured, and it changes nothing here: the branch
 * that reads it (`session.present === false`) is unreachable from this CLI,
 * which observes no session and therefore passes none. It is present in the
 * shape only so the evidence object is the one `assessLane` documents.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {string|null} branch - Limb branch.
 * @param {string|undefined} base - Integration base, when known.
 * @returns {{complete: boolean, lastCommitAt: string|null, dirty: null, reason: string}} Evidence.
 */
function limbGitEvidence(projectRoot, branch, base) {
  if (!branch) return { complete: false, lastCommitAt: null, dirty: null, reason: 'no-branch-name' };
  const completion = readLimbCompletion({ cwd: projectRoot, branch, base });
  const ownCommits = completion.base !== null && completion.commitCount > 0;
  // Not merely ignored when unattributable — not asked for. The tip date of a
  // limb that committed nothing is evidence about the base, not about the limb.
  const log = ownCommits ? git(['log', '-1', '--format=%cI', `refs/heads/${branch}`, '--'], projectRoot) : null;
  const stamp = log?.ok === true ? log.out.trim() : '';
  return {
    complete: completion.complete,
    lastCommitAt: stamp === '' ? null : stamp,
    dirty: null,
    reason: completion.reason,
  };
}

/**
 * Build the lane reconcile block.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {string} runJsonPath - Path to the leader's run state file.
 * @param {number} nowMs - Clock reading.
 * @returns {object} The block: `{run_json, limbs}` or `{run_json, unavailable}`.
 */
function laneBlock(projectRoot, runJsonPath, nowMs) {
  const parsed = readJson(runJsonPath);
  if (!parsed.ok) return { run_json: runJsonPath, unavailable: parsed.reason };

  const run = parsed.value;
  const planPath = path.join(path.dirname(runJsonPath), 'plan.json');
  const planRead = readJson(planPath);
  const plan = planRead.ok ? planRead.value : null;
  const base = typeof run.base === 'string' ? run.base : (typeof plan?.base === 'string' ? plan.base : undefined);

  const lanesInput = {};
  const gitReasons = new Map();
  for (const { limb, branch } of resolveLimbBranches(projectRoot, run, plan)) {
    const gitEvidence = limbGitEvidence(projectRoot, branch, base);
    gitReasons.set(limb, { branch, reason: gitEvidence.reason, lastCommitAt: gitEvidence.lastCommitAt });
    // `session` is deliberately absent: presence is not observed here, and
    // `{present: false}` would be an assertion this CLI cannot make.
    lanesInput[limb] = { gitEvidence };
  }

  const rows = reconcileLanes(run, lanesInput, { nowMs }).map((r) => ({
    ...r,
    branch: gitReasons.get(r.limb)?.branch ?? null,
    complete_reason: gitReasons.get(r.limb)?.reason ?? null,
    // Reported so a reader can tell "no commit of its own" from "a commit this
    // CLI failed to read" — the two produce the same `unknown` health.
    last_commit_at: gitReasons.get(r.limb)?.lastCommitAt ?? null,
  }));
  return { run_json: runJsonPath, base: base ?? null, plan_json: plan === null ? null : planPath, limbs: rows };
}

/**
 * Render a GFM table with padded columns.
 *
 * @param {string[]} head - Header cells.
 * @param {Array<Array<string>>} rows - Body rows.
 * @returns {string} The table.
 */
function renderTable(head, rows) {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => `| ${cells.map((v, i) => String(v ?? '').padEnd(width[i])).join(' | ')} |`;
  return [line(head), `|${width.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.map((r) => line(r))].join('\n');
}

/**
 * @param {string[]} list - A `blocked_by` array.
 * @returns {string} The cell text; `-` when empty (never "passed").
 */
function blockedCell(list) {
  return Array.isArray(list) && list.length > 0 ? list.join(' ') : NO_BLOCKS;
}

/**
 * Render the Resume Contract block as text.
 *
 * @param {object} block - Block from {@link contractBlock}.
 * @returns {string[]} Lines.
 */
function renderContract(block) {
  const out = ['## Resume Contract (steps 1-9 · report only)'];
  if (block.unavailable) return [...out, `측정 불가: ${block.unavailable}`];
  out.push(`store: ${block.store.dir} (${block.store.source})`);
  if (block.missions.length === 0) return [...out, '측정 불가: 활성 mission 0건 — 보고할 대상이 없다'];
  out.push(renderTable(
    ['mission', 'in store', 'checkpoint', 'steps ok/fail/unknown', 'resumable', 'blocked_by'],
    block.missions.map((m) => [
      m.mission_id,
      m.in_store ? 'yes' : 'NO (unknown id)',
      m.checkpoint_id ?? '-',
      `${m.steps.ok}/${m.steps.failed}/${m.steps.unknown}`,
      m.resumable === true ? 'yes' : 'no',
      blockedCell(m.blocked_by),
    ]),
  ));
  return out;
}

/**
 * Render the lane reconcile block as text.
 *
 * @param {object} block - Block from {@link laneBlock}.
 * @returns {string[]} Lines.
 */
function renderLanes(block) {
  const out = ['## lane reconcile (run.json vs git · report only)', `run.json: ${block.run_json}`];
  if (block.unavailable) return [...out, `측정 불가: ${block.unavailable}`];
  if (block.limbs.length === 0) return [...out, '측정 불가: 레인 0건 — run.json 에 limbs·lanes 가 없다'];
  out.push(renderTable(
    ['limb', 'ops', 'lane state', 'health', 'signal', 'complete', 'own last commit', 'blocked_by'],
    block.limbs.map((l) => [
      l.limb ?? '-',
      l.opsState ?? 'unknown',
      l.laneState ?? 'unknown',
      l.assessment?.health ?? '-',
      l.assessment?.signal ?? '-',
      l.complete_reason ?? '-',
      l.last_commit_at ?? '-',
      blockedCell(l.blocked_by),
    ]),
  ));
  return out;
}

/**
 * Render the whole document as ONE text block.
 *
 * @param {object} doc - The document.
 * @returns {string} Text.
 */
function renderText(doc) {
  return [
    `# RESUME CONTRACT REPORT — ${doc.generated_at}`,
    `projectRoot: ${doc.project_root}`,
    `scope: ${doc.scope}`,
    '',
    ...renderContract(doc.contract),
    '',
    ...renderLanes(doc.lanes),
    '',
    '보고 전용 — 이 실행은 상태를 전이시키지 않고 파일을 쓰지 않는다.'
      + ' blocked_by 의 `-` 는 "차단 사유 없음"이며 "검증 통과"가 아니다.',
    '',
  ].join('\n');
}

/**
 * Run the script.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const { opts } = parsed;
  const usage = usageError(opts);
  if (usage !== null) return fail(usage);

  const projectRoot = path.resolve(typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd());
  const runJsonPath = typeof opts['run-json'] === 'string' && opts['run-json']
    ? path.resolve(opts['run-json'])
    : path.join(projectRoot, ...RUN_JSON_RELATIVE);
  const nowMs = Date.now();
  const missionId = typeof opts.mission === 'string' ? opts.mission : null;

  const doc = {
    schema: 'resume-report/1',
    generated_at: new Date(nowMs).toISOString(),
    project_root: projectRoot,
    scope: missionId === null ? 'all active missions' : `mission ${missionId}`,
    contract: await contractBlock(projectRoot, missionId, nowMs),
    lanes: laneBlock(projectRoot, runJsonPath, nowMs),
  };

  process.stdout.write(opts.json === true ? `${JSON.stringify(doc, null, 2)}\n` : renderText(doc));
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  main(argv).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`resume-report: unexpected failure: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
