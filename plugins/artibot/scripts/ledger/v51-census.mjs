#!/usr/bin/env node
/**
 * One-command census for the v5.1 track: run the existing ledger readers against
 * ONE snapshot of a project's central ledger and aggregate their output into one
 * JSON document and, optionally, an evidence markdown file.
 *
 * WHY. v5.0 means "code landed"; whether Shadow and Canary WORK is judged on live
 * ledgers from real projects (.artibot/guides/v5-design/V5-RESCOPE-20260930.md,
 * MEASUREMENT-RUNBOOK.md). Until this file that took a dozen hand-typed commands,
 * each reading the ledger at a different moment. This is the one command.
 *
 * USAGE
 *   node scripts/ledger/v51-census.mjs [--cwd <projectRoot>] [--since <iso | epoch-ms>]
 *        [--json] [--out <evidence.md>] [--plugin-root <dir>] [--autopilot-dir <dir>]
 *        [--exclude-sessions <list-file | id,id,...>]
 *   `--cwd` is the PROJECT being measured and must be its repository root (where
 *   `.git` is): the shared resolver does not walk upward. It is NOT where the
 *   readers are found — those are this file's siblings, located by import.meta.url,
 *   so the script works from any cwd and uses the plugin copy it lives in.
 *   `--json` prints the document as ONE line; otherwise the evidence markdown is
 *   printed. `--out` also writes that markdown (must end in `.md`, so it can never
 *   name a ledger). An all-digit `--since` is EPOCH MILLISECONDS (same rule as the
 *   readers); it becomes one ISO instant handed to every windowed reader, and each
 *   then runs twice, window and whole history (runbook 2.3, backlog R-11 forbid
 *   reporting the window alone). `--plugin-root`, `--exclude-sessions` (session-
 *   coverage only) and `--autopilot-dir` are passed through to their readers.
 *
 * -- THE SNAPSHOT: HOW EVERY READER SEES THE SAME BYTES ---------------------
 *  The ledger path comes from `lib/runtime/ledger.js#ledgerFilePath`, the resolver
 *  the readers use (not reimplemented here). The file is copied ONCE, at start,
 *  into a fresh temp directory placed where that same resolver puts the ledger of a
 *  non-git root, and that directory is handed to each reader as its `--cwd`
 *  (usage-cost-table takes `--ledger <file>` and gets the file). The readers are
 *  spawned as child processes and are not modified. A reader never sees the live
 *  file, so its two reads (session-coverage reads twice with `--since`) cannot
 *  straddle an append. Proof is checked, not assumed: each reader prints the path
 *  and byte count it read and `consistency` compares both with the snapshot. A reader
 *  that prints neither is UNPROVEN and `consistency.ok` is false; the identities each
 *  reader promises (runbook 4) are checked too. Live growth is in `ledger`, in NO number.
 *
 * -- WHICH READERS, AND WHICH ARE NOT RUN -----------------------------------
 *  The registry and its reasons live in `v51-census-readers.mjs`. Seven readers run
 *  on the snapshot (Observe 2-5, usage, `model-routing.mjs validate --live`); one,
 *  recovery-journal-census, reads the autopilot session store and is labeled
 *  `live-store`. Readers whose input is more than the ledger, or is not a ledger,
 *  are listed in `notRun` with the reason and the command — a reader that cannot
 *  be handed only a snapshot is reported, never read live.
 *
 * -- EXIT CODES, STDOUT ------------------------------------------------------
 *  0  a census was printed — INCLUDING no ledger (status `no-ledger`, nothing run),
 *     an unreadable ledger, a failing reader (status `partial`, `errors` names it,
 *     its metrics are `error` with null numbers: a reader that threw prints empty
 *     folds and an empty fold is not a measured zero) and a consistency violation.
 *  1  `--out` could not be written (the document is still printed).
 *  2  usage error: ONE stderr line prefixed `v51-census:`, NOTHING on stdout.
 *  Every metric row carries `numerator`, `denominator`, `ratio`, `measuredAt` (the
 *  reader's own time, else the run's start) and a `status`; a zero denominator is
 *  `unmeasured` with a null ratio, never a measured 0.
 *
 * -- WHAT THIS CANNOT SEE ----------------------------------------------------
 *  `limitations` and `unverified` in the document say it: no host version or
 *  repository HEAD is read; the snapshot is a byte copy, so a line being appended
 *  at that instant reaches the readers as their own `corrupt` count; the store
 *  reader is not snapshotted and not windowed.
 *
 * @module scripts/ledger/v51-census
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import {
  consistencyOf, get, isObj, LIMITATIONS, metricsOf, noChecks, NOT_RUN, READERS, SNAPSHOT_CHECKS,
} from './v51-census-readers.mjs';

export { NOT_RUN, READERS };

const OWN_SCRIPT = fileURLToPath(import.meta.url);
/** This file's own plugin root: scripts/ledger -> plugin root. Readers live under it. */
const OWN_PLUGIN_ROOT = path.resolve(path.dirname(OWN_SCRIPT), '..', '..');
const SCHEMA = 'v51-census/1';

/** Flags this script accepts; the runbook section is pinned to this list by a test. */
export const FLAGS = Object.freeze({
  value: ['--cwd', '--since', '--out', '--plugin-root', '--autopilot-dir', '--exclude-sessions'],
  boolean: ['--json'],
});

const USAGE = 'usage: v51-census.mjs [--cwd <projectRoot>] [--since <iso | epoch-ms (all digits)>] [--json]'
  + ' [--out <evidence.md>] [--plugin-root <dir>] [--autopilot-dir <dir>] [--exclude-sessions <list-file | id,id,...>]';

const MAX_DATE_MS = 8.64e15;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 512 * 1024 * 1024;
/** 0xC0000142, a child that died in the Windows loader before any script ran. */
const STATUS_DLL_INIT_FAILED = 3221225794;

/** Config keys whose value belongs next to every number (runbook 2.3 item 7). */
const SWITCH_KEYS = Object.freeze([
  'autopilot.reportVerifyGate.enforce', 'runtime.resume.staleGuard', 'routing.canary.actionClasses',
  'routing.canary.tier', 'automation.autoActivate.commands', 'autopilot.recovery.transitionFromVerdict',
  'runtime.checkpoint.saveOnSave', 'runtime.questionGate.enforce', 'runtime.artifactLifecycle.enabled',
  'split.missionBinding.enabled', 'team.followWorkflowPlan', 'ledger.hookFired.slots',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const nowIso = (deps) => (deps.now ?? (() => new Date()))().toISOString();
const tail = (text) => (typeof text === 'string' && text !== '' ? text.slice(-400) : null);
const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/** Same path on this platform (case-insensitive on Windows). */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Resolve `--since` to epoch ms, or null. All digits is epoch ms, handled before Date.parse. */
function toEpochMs(raw) {
  const text = String(raw).trim();
  if (text === '') return null;
  const ms = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

/** Read a JSON file without throwing. */
function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf-8')) };
  } catch (err) {
    return { ok: false, error: err?.code ?? err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Report a usage error on ONE line and nothing else. */
function fail(message) {
  process.stderr.write(`v51-census: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{opts: Record<string, string|boolean>}|{error: string}}
 */
export function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (FLAGS.boolean.includes(flag)) { opts[flag.slice(2)] = true; continue; }
    if (!FLAGS.value.includes(flag)) return { error: `unknown argument: ${flag}` };
    // A blank value is a missing value: `--cwd ''` must not fall back to the process cwd.
    if (i + 1 >= argv.length || argv[i + 1].trim() === '') return { error: `${flag} requires a non-blank value` };
    opts[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  return { opts };
}

/** Turn the option bag into the request a census takes, or name what is wrong. */
function toRequest(opts) {
  let since = null;
  if (opts.since !== undefined) {
    const ms = toEpochMs(opts.since);
    if (ms === null) return { error: `--since must be an ISO timestamp or epoch ms, got: ${opts.since}` };
    since = new Date(ms).toISOString();
  }
  if (opts.out !== undefined && !/\.md$/i.test(opts.out)) {
    return { error: `--out must name a .md file, got: ${opts.out}` };
  }
  const list = opts['exclude-sessions'];
  // The readers run with the snapshot root as cwd, so a relative list file would stop resolving.
  const isFile = list !== undefined && !list.includes(',') && existsSync(list) && statSync(list).isFile();
  return {
    request: {
      cwd: path.resolve(opts.cwd ?? process.cwd()),
      since,
      json: opts.json === true,
      out: opts.out === undefined ? null : path.resolve(opts.out),
      pluginRoot: opts['plugin-root'] === undefined ? null : path.resolve(opts['plugin-root']),
      autopilotDir: opts['autopilot-dir'] === undefined ? null : path.resolve(opts['autopilot-dir']),
      exclude: isFile ? path.resolve(list) : (list ?? null),
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot and reader runs
// ---------------------------------------------------------------------------

/**
 * Copy the live ledger once into a fresh temp root, at the path the shared resolver
 * assigns a non-git root, so `--cwd <root>` makes every reader read this copy.
 *
 * READ, THEN WRITE — NEVER THE PLATFORM'S SINGLE-CALL FILE COPY. On Windows that call
 * opens the source without write sharing, so for as long as it runs every hook that
 * appends to the live ledger fails with EBUSY, and the writer does not retry: the row
 * is silently lost. A measuring tool that drops the rows it measures is its own next
 * defect. Measured by the reviewer against a 25 MB ledger: 4,793 of 8,820 appends
 * failed during the single-call copy and 0 of 5,926 during a read plus a write, because
 * a read shares the file. The hash is of the very buffer that was read and written.
 *
 * @param {string} live
 * @param {object} deps
 * @returns {{root: string, file: string, bytes: number, sha256: string, takenAt: string}}
 */
function takeSnapshot(live, deps) {
  const root = realpathSync.native(mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), 'artibot-census-')));
  try {
    const file = ledgerFilePath(root);
    mkdirSync(path.dirname(file), { recursive: true });
    const buf = readFileSync(live);
    writeFileSync(file, buf);
    return {
      root, file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), takenAt: nowIso(deps),
    };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** The arguments one reader run gets: prefix, the snapshot feed, `--since` for the window, extras. */
function argsFor(spec, ctx, scope) {
  const feeds = { cwd: ['--cwd', ctx.snapRoot], ledger: ['--ledger', ctx.snapFile], store: [] };
  const since = spec.windowed && scope === 'window' ? ['--since', ctx.since] : [];
  return [...(spec.prefix ?? []), ...(feeds[spec.feed] ?? []), ...since, ...(spec.extra ? spec.extra(ctx) : [])];
}

/** Spawn a reader, once more if it died in the Windows loader with no output at all. */
function spawnChild(deps, file, args, cwd) {
  const spawn = deps.spawn ?? spawnSync;
  const go = () => spawn(process.execPath, [file, ...args], {
    cwd, encoding: 'utf-8', windowsHide: true, env: process.env, maxBuffer: MAX_BUFFER, timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const first = go();
  return first.status === STATUS_DLL_INIT_FAILED && !first.stdout && !first.stderr ? go() : first;
}

/** Why a child gave nothing to read, or the parsed JSON object it printed. */
function interpret(res) {
  const stderr = tail(res.stderr);
  const fault = (kind, message, exitCode, extra = {}) => ({
    error: { kind, message, exitCode, signal: res.signal ?? null, stderr, ...extra },
  });
  if (res.error) {
    const kind = { ETIMEDOUT: 'timeout', ENOBUFS: 'output-too-large' }[res.error.code] ?? 'spawn';
    return fault(kind, res.error.message ?? String(res.error), res.status ?? null);
  }
  if (res.status !== 0) return fault('exit', firstLine(res.stderr) || `exit ${res.status}`, res.status);
  const out = String(res.stdout ?? '').trim();
  try {
    const parsed = JSON.parse(out);
    if (isObj(parsed)) return { result: parsed };
    throw new TypeError('stdout JSON is not an object');
  } catch (err) {
    return fault('unparsable-output', `stdout is not a JSON object: ${err.message}`, 0, { stdoutHead: out.slice(0, 200) });
  }
}

/** What the reader says about itself once its JSON parsed: error, unmeasured, or ok. */
function judge(result) {
  if (typeof result.error === 'string' && result.error !== '') {
    return { status: 'error', error: { kind: 'reader-reported', message: result.error, exitCode: 0, signal: null, stderr: null } };
  }
  if (result.ok === false) return { status: 'unmeasured', reason: String(result.reason ?? 'reader reported ok:false') };
  return { status: 'ok' };
}

/** A run that did not happen. Every key is present, so a consumer reads one shape. */
function skipped(spec, scope, reason) {
  return {
    reader: spec.id, axis: spec.axis, scope, input: spec.feed === 'store' ? 'live-store' : 'snapshot', status: 'skipped', reason,
    exitCode: null, signal: null, startedAt: null, durationMs: 0, measuredAt: null, inputPath: null, inputIsSnapshot: null,
    args: null, result: null, error: null,
  };
}

/** Run one reader in one scope and describe what happened. Never throws. */
function runReader(spec, scope, ctx, deps) {
  const script = path.isAbsolute(spec.script) ? spec.script : path.join(OWN_PLUGIN_ROOT, spec.script);
  if (!existsSync(script)) return skipped(spec, scope, 'reader-missing');
  const args = argsFor(spec, ctx, scope);
  const startedAt = nowIso(deps);
  const t0 = Date.now();
  const { result = null, error = null } = interpret(spawnChild(deps, script, args, ctx.snapRoot));
  const verdict = result === null ? { status: 'error', error } : judge(result);
  const inputPath = result === null ? null : (spec.inputPath(result) ?? null);
  const shown = { [ctx.snapRoot]: '<snapshot-root>', [ctx.snapFile]: '<snapshot-ledger>' };
  return {
    ...skipped(spec, scope, null),
    status: verdict.status,
    reason: verdict.reason ?? null,
    exitCode: error?.exitCode ?? 0,
    signal: error?.signal ?? null,
    startedAt,
    durationMs: Date.now() - t0,
    measuredAt: result === null ? null : (spec.measuredAt(result) ?? null),
    inputPath,
    inputIsSnapshot: spec.feed === 'store' || inputPath === null ? null : samePath(inputPath, ctx.snapFile),
    args: args.map((a) => shown[a] ?? a),
    result,
    error: verdict.error ?? null,
  };
}

/** Runs to make: each reader once per scope; a store reader once, scope `all`. */
function plan(readers, scopes) {
  return readers.flatMap((spec) => {
    if (spec.feed === 'store') return [[spec, 'all']];
    return (spec.windowed ? scopes : [scopes[0]]).map((scope) => [spec, scope]);
  });
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Plugin version and the switch values stamped beside the numbers. */
function pluginBlock(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  const config = readJson(path.join(root, 'artibot.config.json'));
  const values = config.ok
    ? SWITCH_KEYS.map((key) => {
      const value = get(config.value, key);
      return { key, present: value !== undefined, value: value === undefined ? null : value };
    })
    : [];
  return {
    root,
    version: manifest.ok && typeof manifest.value?.version === 'string' ? manifest.value.version : null,
    switches: config.ok ? { status: 'ok', values } : { status: 'unreadable', error: config.error, values },
  };
}

/** The live ledger as found, without opening it. */
function liveLedger(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? { file, present: true, bytes: st.size } : { file, present: false, bytes: null, note: 'not a regular file' };
  } catch (err) {
    return { file, present: false, bytes: null, note: err?.code ?? null };
  }
}

function unverifiedOf(doc) {
  const out = [
    '호스트 claude 버전과 대상 리포 HEAD 커밋은 읽지 않았다 — T0 기록(런북 2.1)에 직접 적는다.',
    'plugin.switches 는 이 플러그인 루트의 설정 파일 값이다. 실행 중이던 세션이 그 값을 썼는지는 미확인이다.',
    '이 census 를 돌린 세션의 훅 행은 원장에 들어 있을 수 있다 — 세션 id 를 기록하고 --exclude-sessions 로 raw 와 병기한다(런북 1.5).',
  ];
  if (doc.ledger.grewDuringRun === true) {
    out.push(`실행 중 원장이 ${doc.ledger.bytesAtEnd - doc.snapshot.bytes} B 늘었다 — 그 행은 어떤 수치에도 없다.`);
  }
  if (doc.errors.length > 0) out.push(`판독기 오류 ${doc.errors.length}건 — 그 지표는 미측정이다(수치를 0 으로 읽지 않는다).`);
  return out;
}

/** Assemble the document from everything measured. */
function assemble(head, parts) {
  const errors = [
    ...parts.runs.filter((r) => r.status === 'error').map((r) => ({ reader: r.reader, scope: r.scope, kind: r.error.kind, message: r.error.message })),
    ...parts.extractErrors,
  ];
  const incomplete = parts.runs.some((r) => r.status === 'skipped' && r.reason === 'reader-missing');
  const doc = {
    ...head,
    status: head.status ?? (errors.length > 0 || incomplete || parts.consistency.ok === false ? 'partial' : 'ok'),
    runs: parts.runs,
    notRun: NOT_RUN.map((n) => ({ ...n })),
    metrics: parts.metrics,
    consistency: parts.consistency,
    limitations: LIMITATIONS.map((l) => ({ ...l })),
    errors,
    unverified: [],
  };
  doc.unverified = unverifiedOf(doc);
  return doc;
}

/** A census with no reader run: every reader listed as skipped, for one reason. */
function emptyCensus(head, job, reason) {
  const runs = plan(job.readers, job.scopes).map(([spec, scope]) => skipped(spec, scope, reason));
  return assemble(head, { runs, metrics: [], consistency: noChecks(), extractErrors: [] });
}

/** Run every planned reader on the snapshot and assemble the document. */
function measure(head, snap, job, deps) {
  const ctx = {
    snapRoot: snap.root,
    snapFile: snap.file,
    since: job.request.since,
    pluginRoot: job.request.pluginRoot ?? null,
    autopilotDir: job.request.autopilotDir ?? null,
    exclude: job.request.exclude ?? null,
  };
  const runs = plan(job.readers, job.scopes).map(([spec, scope]) => runReader(spec, scope, ctx, deps));
  const extractErrors = [];
  const metrics = runs.flatMap((run) => metricsOf(job.readers.find((r) => r.id === run.reader), run, extractErrors));
  const after = liveLedger(head.ledger.livePath);
  const ledger = {
    ...head.ledger, bytesAtEnd: after.bytes, grewDuringRun: after.bytes === null ? null : after.bytes > snap.bytes,
  };
  const snapshot = {
    path: snap.root, file: snap.file, takenAt: snap.takenAt, bytes: snap.bytes, sha256: snap.sha256, removed: false,
  };
  return assemble({ ...head, ledger, snapshot }, {
    runs, metrics, consistency: consistencyOf(job.readers, runs, snap), extractErrors,
  });
}

/**
 * Take the census: snapshot once, run every reader on it, aggregate.
 *
 * `deps` are test seams: `now`, `spawn`, `readers`, `tmpRoot`, `timeoutMs`.
 *
 * @param {{cwd: string, since: string|null, pluginRoot?: string|null, autopilotDir?: string|null,
 *   exclude?: string|null}} request
 * @param {object} [deps]
 * @returns {object} the document
 */
export function census(request, deps = {}) {
  const t0 = Date.now();
  const job = {
    readers: deps.readers ?? READERS,
    scopes: request.since === null ? ['history'] : ['history', 'window'],
    request,
  };
  const live = liveLedger(ledgerFilePath(request.cwd));
  const head = {
    schema: SCHEMA,
    status: null,
    message: null,
    measuredAt: nowIso(deps),
    finishedAt: null,
    durationMs: 0,
    project: { cwd: request.cwd, since: request.since, scopes: job.scopes },
    plugin: pluginBlock(path.resolve(request.pluginRoot ?? OWN_PLUGIN_ROOT)),
    ledger: {
      livePath: live.file, present: live.present, readable: live.present, bytesAtStart: live.bytes, bytesAtEnd: live.bytes, grewDuringRun: null,
    },
    snapshot: null,
  };
  const finish = (doc) => ({ ...doc, finishedAt: nowIso(deps), durationMs: Date.now() - t0 });
  if (!live.present) {
    const message = `no ledger at ${live.file} — empty census (is --cwd the repository root, where .git is? the path resolver does not walk upward)`;
    return finish(emptyCensus({ ...head, status: 'no-ledger', message }, job, 'no-ledger'));
  }
  let snap;
  try {
    snap = takeSnapshot(live.file, deps);
  } catch (err) {
    const message = `ledger at ${live.file} could not be copied: ${err?.code ?? err?.message ?? err}`;
    const blocked = { ...head, status: 'ledger-unreadable', message, ledger: { ...head.ledger, readable: false } };
    return finish(emptyCensus(blocked, job, 'ledger-unreadable'));
  }
  let doc;
  try {
    doc = measure(head, snap, job, deps);
  } finally {
    rmSync(snap.root, { recursive: true, force: true });
  }
  doc.snapshot.removed = !existsSync(snap.root);
  return finish(doc);
}

// ---------------------------------------------------------------------------
// Markdown evidence
// ---------------------------------------------------------------------------

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const pct = (r) => (r === null || r === undefined ? 'null' : `${(r * 100).toFixed(1)}%`);

/** A markdown table from a header row and body rows. */
function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** The command that reproduces this census, rebuilt from the request. */
function commandLine(request) {
  const q = (s) => `"${s}"`;
  const parts = ['node', q(OWN_SCRIPT), '--cwd', q(request.cwd)];
  if (request.since !== null) parts.push('--since', request.since);
  if (request.pluginRoot) parts.push('--plugin-root', q(request.pluginRoot));
  if (request.autopilotDir) parts.push('--autopilot-dir', q(request.autopilotDir));
  if (request.exclude) parts.push('--exclude-sessions', q(request.exclude));
  if (request.json) parts.push('--json');
  if (request.out) parts.push('--out', q(request.out));
  return parts.join(' ');
}

function headSection(doc) {
  const count = (s) => doc.runs.filter((r) => r.status === s).length;
  const { checks } = doc.consistency;
  const red = checks.filter((x) => x.holds === false);
  const unproven = checks.filter((x) => SNAPSHOT_CHECKS.includes(x.id) && x.holds === null);
  return [
    '## 0. 판정(먼저)',
    `판정 없음 — 이 census 는 측정만 한다. 상태: **${doc.status}**.`,
    ...(doc.message === null ? [] : [`- ${doc.message}`]),
    `- 판독기 실행 ${doc.runs.length}건: ok ${count('ok')} · unmeasured ${count('unmeasured')} · error ${count('error')} · skipped ${count('skipped')}`,
    `- 일관성 점검 ${checks.length}건 중 위반 ${red.length}건 · 미증명 ${unproven.length}건 (consistency.ok = ${doc.consistency.ok})`,
    ...doc.errors.map((e) => `- 오류: ${e.reader} (${e.scope}) ${e.kind} — ${e.message}`),
    ...red.map((x) => `- 위반: ${x.id} (${x.reader}, ${x.scope}) 기대 ${JSON.stringify(x.expected)} 실제 ${JSON.stringify(x.actual)}`),
    ...unproven.map((x) => `- 미증명: ${x.id} (${x.reader}, ${x.scope}) — 판독기가 입력 경로나 바이트 수를 출력하지 않아 사본을 읽었다는 증거가 없다`),
  ].join('\n');
}

function methodSection(doc, request) {
  const s = doc.snapshot;
  const runs = doc.runs.map((r) => [r.reader, r.scope, r.input, r.status, r.exitCode ?? '', r.durationMs, r.inputIsSnapshot ?? '']);
  return [
    '## 1. 방법과 재현 명령(원문)',
    '```text', commandLine(request), '```',
    s === null
      ? '- snapshot: 없음(원장이 없거나 복사하지 못했다).'
      : `- snapshot: ${s.bytes} B, sha256 \`${s.sha256}\`, ${s.takenAt} 에 복사. 모든 원장 판독기가 이 사본 하나를 읽었고 실행 뒤 삭제했다.`,
    `- 원장 증가: 시작 ${doc.ledger.bytesAtStart ?? 'null'} B → 종료 ${doc.ledger.bytesAtEnd ?? 'null'} B (grewDuringRun = ${doc.ledger.grewDuringRun}). 증가분은 수치에 없다.`,
    '',
    table(['판독기', '범위', '입력', '상태', 'exit', 'ms', '사본을 읽음'], runs),
  ].join('\n');
}

function resultSection(doc) {
  const rows = doc.metrics.map((m) => [
    `\`${m.id}\``, m.scope, m.numerator ?? 'null', m.denominator ?? 'null', pct(m.ratio), m.measuredAt,
    [m.status === 'measured' ? '' : `${m.status}: ${m.reason}`, m.note ?? ''].filter((x) => x !== '').join(' · '),
  ]);
  const body = rows.length === 0
    ? '측정된 지표가 없다.'
    : table(['지표', '범위', '분자', '분모', '비율', '측정 시각(UTC)', '비고'], rows);
  return ['## 2. 결과 — 분자/분모, 창, 측정 시각', '', body].join('\n');
}

/** Checks grouped by id: how many ran, how many were violated, how many could not be judged. */
function checkTable(checks) {
  const byId = new Map();
  for (const x of checks) {
    const t = byId.get(x.id) ?? { n: 0, red: 0, unjudged: 0 };
    byId.set(x.id, { n: t.n + 1, red: t.red + (x.holds === false ? 1 : 0), unjudged: t.unjudged + (x.holds === null ? 1 : 0) });
  }
  return byId.size === 0
    ? '대조한 항목이 없다.'
    : table(['점검', '건수', '위반', '미판정'], [...byId].map(([id, t]) => [id, t.n, t.red, t.unjudged]));
}

function checksSection(doc) {
  const s = doc.snapshot;
  const checks = doc.consistency.checks;
  return [
    '## 3. 유효성 대조',
    s === null
      ? '- snapshot 이 없어 대조할 것이 없다.'
      : `- 각 원장 판독기가 출력한 입력 경로·바이트 수를 snapshot(${s.bytes} B)과 대조했다. 위반과 미판정 열이 둘 다 0 이어야 모든 판독기가 같은 사본을 읽었음이 증명된 것이다(미판정은 통과가 아니다).`,
    '',
    checkTable(checks.filter((c) => SNAPSHOT_CHECKS.includes(c.id))),
    '',
    '## 4. 관측치 정합성',
    '판독기가 구조상 지키는 항등식(줄 수 census 합, 판독기별 합계 항등식)을 자동 대조한다. 위반은 숨기지 않고 §0 에 올린다.',
    '',
    checkTable(checks.filter((c) => !SNAPSHOT_CHECKS.includes(c.id))),
  ].join('\n');
}

function tailSections(doc) {
  const switches = doc.plugin.switches.values.map((v) => [v.key, v.present ? JSON.stringify(v.value) : '(키 없음)']);
  return [
    '## 5. 이 수치가 못 보는 것',
    ...doc.limitations.map((l) => `- ${l.text}`),
    '',
    '실행하지 않은 판독기(런북 3.1):',
    '',
    table(['판독기', '이유', '따로 돌리는 법'], doc.notRun.map((n) => [n.id, n.why, `\`${n.runSeparately}\``])),
    '',
    '## 6. 미확인',
    ...doc.unverified.map((u) => `- ${u}`),
    '',
    `## 부록. 플러그인 ${doc.plugin.version ?? '미확인'} 설정 스위치 (\`${doc.plugin.root}\`)`,
    '',
    switches.length === 0 ? `설정 파일을 읽지 못했다: ${doc.plugin.switches.error}` : table(['키', '값'], switches),
    '',
    '원시 출력은 같은 실행의 `--json` 문서(`runs[].result`)에 있다. 이 md 는 그 요약이다.',
  ].join('\n');
}

/**
 * The evidence markdown, following the runbook's evidence skeleton (6.1).
 *
 * @param {object} doc a census document
 * @param {object} request the request it answered
 * @returns {string}
 */
export function renderMarkdown(doc, request) {
  const windowLine = doc.project.since === null ? '없음(전체 이력)' : `--since ${doc.project.since} (범위 window 와 history 를 병기)`;
  return [
    `# v5.1 census — ${path.basename(doc.project.cwd)} (${doc.measuredAt.slice(0, 10)})`,
    '',
    `- 대상 프로젝트: \`${doc.project.cwd}\` · 플러그인 ${doc.plugin.version ?? '미확인'} · 측정 시작 ${doc.measuredAt}(UTC) · snapshot ${doc.snapshot?.takenAt ?? '없음'}`,
    `- 창: ${windowLine} · 원장: \`${doc.ledger.livePath}\``,
    '- 주장 등급: 표의 수치는 판독기 출력(실측)이다. 추론과 미확인은 그렇게 적는다(§6).',
    '- 이 문서는 상태 전환 권한이 없다. 이 census 는 판정을 하지 않는다.',
    '',
    headSection(doc),
    '',
    methodSection(doc, request),
    '',
    resultSection(doc),
    '',
    checksSection(doc),
    '',
    tailSections(doc),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The document for a throw nobody foresaw: still an observation, still parseable. */
function crashDoc(request, err, deps) {
  const message = String(err?.message ?? err);
  const head = {
    schema: SCHEMA,
    status: 'error',
    message: `census failed: ${message}`,
    measuredAt: nowIso(deps),
    finishedAt: nowIso(deps),
    durationMs: 0,
    project: { cwd: request.cwd, since: request.since, scopes: [] },
    plugin: pluginBlock(OWN_PLUGIN_ROOT),
    ledger: { livePath: null, present: false, readable: false, bytesAtStart: null, bytesAtEnd: null, grewDuringRun: null },
    snapshot: null,
  };
  const extractErrors = [{ reader: '*', scope: '*', kind: 'census-crashed', message }];
  return assemble(head, { runs: [], metrics: [], consistency: noChecks(), extractErrors });
}

/**
 * Run the script.
 *
 * @param {string[]} argv arguments after the script path
 * @param {object} [deps] test seams, see {@link census}
 * @returns {number} process exit code
 */
export function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const checked = toRequest(parsed.opts);
  if (checked.error !== undefined) return fail(checked.error);
  const { request } = checked;

  let doc;
  try {
    doc = census(request, deps);
  } catch (err) {
    doc = crashDoc(request, err, deps);
  }
  const markdown = renderMarkdown(doc, request);
  let code = 0;
  if (request.out !== null) {
    try {
      mkdirSync(path.dirname(request.out), { recursive: true });
      writeFileSync(request.out, `${markdown}\n`, 'utf-8');
    } catch (err) {
      process.stderr.write(`v51-census: could not write ${request.out}: ${err?.code ?? err?.message ?? err}\n`);
      code = 1;
    }
  }
  process.stdout.write(request.json ? `${JSON.stringify(doc)}\n` : `${markdown}\n`);
  return code;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `main` turns a throw into a printed document; this only covers a failure of the
  // printing itself. Reading a number must never fail the caller's step.
  try {
    process.exitCode = main(argv);
  } catch {
    process.exitCode = 0;
  }
}
