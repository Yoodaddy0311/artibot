#!/usr/bin/env node
/**
 * `orca mark` — wall-clock windows of one `/orca` run (DESIGN §11.1 E1, §11.6).
 *
 *   node scripts/orca/mark.mjs start <segment> --run-id <runId> [--human-wait] [--json]
 *   node scripts/orca/mark.mjs end   <segment> --run-id <runId> [--json]
 *   node scripts/orca/mark.mjs summary         --run-id <runId> [--json]
 *
 * WHY THIS EXISTS: the launch approval is the one human wait `/orca` keeps, and
 * its length is the number the P1 acceptance asks for (사람 대기 비율 is not
 * `null`). The ledger event `human.asked` cannot carry it — it is written only
 * when a hook BLOCKS a command — so the pair goes through the existing
 * `/split` wall-clock store instead (`lib/observability/split-telemetry.js`,
 * reused unmodified): the leader wraps the approval prompt in
 * `start confirm-launch --human-wait` / `end confirm-launch`, and the whole
 * run in `start run` / `end run` (`RUN_SEGMENT` is the denominator the
 * human-wait percentage is computed against).
 *
 * RECORD ONLY. This script judges nothing and never reaches Orca, git, or the
 * network. `summary` prints what `summarizeWallClock` returns, and a value that
 * was not measured stays `null` — never `0`. `0` is a real zero-length
 * measurement (the owner pre-delegated the launch and the pair is written
 * back to back), and the two must stay distinguishable.
 *
 * `runId` is the ORCA run id (`run_3c01…`), which becomes a file name inside
 * the telemetry store, so it is restricted to a path-safe charset and a path
 * separator or `..` is refused rather than normalised.
 *
 * Exit codes: 0 ok · 1 usage / validation / write error. `--json` prints one
 * JSON document on stdout; a failure is `{ ok:false, error }` with exit 1.
 *
 * @module scripts/orca/mark
 */

import { isMainEntry } from '../hooks/_main-entry.js';
import {
  readSplitEvents,
  recordWallClockEnd,
  recordWallClockStart,
  RUN_SEGMENT,
  summarizeWallClock,
} from '../../lib/observability/split-telemetry.js';

/** Segment the launch approval is recorded under (`status.mjs` reads the same name). */
export const CONFIRM_LAUNCH_SEGMENT = 'confirm-launch';

/** Orca run ids look like `run_3c01547fc37f`; the charset is wider on purpose and path-safe. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const HELP = `usage:
  node scripts/orca/mark.mjs start <segment> --run-id <runId> [--human-wait] [--json]
  node scripts/orca/mark.mjs end <segment> --run-id <runId> [--json]
  node scripts/orca/mark.mjs summary --run-id <runId> [--json]

  segments the run uses: ${CONFIRM_LAUNCH_SEGMENT} (wrap the launch approval, --human-wait), ${RUN_SEGMENT} (the whole run)
  --human-wait  the window is the operator's time, not the machine's (start only)
  --json        one JSON document on stdout; a failure is { ok:false, error } and exit 1

A value that was not measured is printed as null, never 0.`;

/**
 * @param {string[]} argv
 * @returns {{ ok: true, cmd: 'start'|'end'|'summary', segment: string|null, runId: string, humanWait: boolean, json: boolean, help: boolean } | { ok: false, error: string, json: boolean }}
 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const json = list.includes('--json');
  const fail = (error) => ({ ok: false, error, json });
  const out = { ok: true, cmd: null, segment: null, runId: '', humanWait: false, json, help: false };
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') continue;
    else if (a === '--human-wait') out.humanWait = true;
    else if (a === '--run-id') {
      const v = list[i + 1];
      if (v === undefined || v.startsWith('--')) return fail('--run-id requires a value');
      out.runId = v;
      i += 1;
    } else if (a.startsWith('--')) return fail(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (out.help) return { ...out, cmd: 'summary' };
  return finishParse(out, positional, fail);
}

/** Positional + cross-field checks, split out of {@link parseArgs} to keep it flat. */
function finishParse(out, positional, fail) {
  const [cmd, segment] = positional;
  if (cmd !== 'start' && cmd !== 'end' && cmd !== 'summary') return fail(`unknown or missing command: ${cmd ?? '(none)'}`);
  const expected = cmd === 'summary' ? 0 : 1;
  if (positional.length - 1 !== expected) {
    return fail(cmd === 'summary' ? 'summary takes no segment' : `${cmd} takes exactly one <segment>`);
  }
  if (!RUN_ID_PATTERN.test(out.runId)) return fail(`--run-id must match ${RUN_ID_PATTERN} (got ${JSON.stringify(out.runId)})`);
  if (cmd !== 'summary' && !SEGMENT_PATTERN.test(segment ?? '')) return fail(`segment must match ${SEGMENT_PATTERN} (got ${JSON.stringify(segment ?? '')})`);
  if (out.humanWait && cmd !== 'start') return fail('--human-wait is only meaningful with start');
  return { ...out, cmd, segment: cmd === 'summary' ? null : segment };
}

/** The closed (start+end) `confirm-launch` windows of a summary — the launch-approval pairs. */
export function closedConfirmLaunchPairs(summary) {
  const segments = Array.isArray(summary?.segments) ? summary.segments : [];
  return segments.filter((s) => s.segment === CONFIRM_LAUNCH_SEGMENT && s.durationMs !== null);
}

function openCount(summary, segment) {
  return summary.unpaired.filter((u) => u.segment === segment && u.side === 'start').length;
}

/**
 * Record one window edge. The store is read first only to warn about an
 * unbalanced pair; the edge is written either way (a crash between start and
 * end is the case the summary must show, not hide).
 */
function recordEdge(args, { storeDir, now }) {
  const ts = now().toISOString();
  const before = summarizeWallClock(readSplitEvents(args.runId, { storeDir }));
  const open = openCount(before, args.segment);
  const warnings = [];
  let event;
  if (args.cmd === 'start') {
    if (open > 0) warnings.push(`segment "${args.segment}" is already open (${open}) — the new start nests (pairing is LIFO)`);
    event = recordWallClockStart(args.runId, { segment: args.segment, humanWait: args.humanWait, storeDir, ts });
  } else {
    if (open === 0) warnings.push(`no open start for "${args.segment}" — recorded as an unpaired end`);
    event = recordWallClockEnd(args.runId, { segment: args.segment, storeDir, ts });
  }
  return { ok: true, command: args.cmd, runId: args.runId, segment: args.segment, humanWait: args.cmd === 'start' ? args.humanWait : null, event, warnings };
}

function summarize(args, { storeDir }) {
  const events = readSplitEvents(args.runId, { storeDir });
  const summary = summarizeWallClock(events);
  return {
    ok: true,
    command: 'summary',
    runId: args.runId,
    eventCount: events.length,
    ...summary,
    confirmLaunchClosedPairs: closedConfirmLaunchPairs(summary).length,
  };
}

/** Why a percentage is `null`, in words — the numbers themselves are never altered. */
function nullReason(r) {
  if (r.humanWaitPct !== null) return null;
  if (r.totalMs === null) return `no closed "${RUN_SEGMENT}" window (mark start/end ${RUN_SEGMENT})`;
  if (r.humanWaitMs === null) return 'no human-wait window, or one of them is still open';
  return 'run window has zero length';
}

function renderSummary(r) {
  const TS = 24;
  const row = (seg, human, start, end, ms) => `${seg.padEnd(16)} ${human.padEnd(5)} ${start.padEnd(TS)} ${end.padEnd(TS)} ${ms}`;
  const rows = r.segments.map((s) => row(s.segment, s.humanWait ? 'yes' : 'no', String(s.startedAt), String(s.endedAt), String(s.durationMs)));
  const unpaired = r.unpaired.length ? r.unpaired.map((u) => `${u.segment} (${u.side} only, ${String(u.ts)})`).join(' · ') : '(none)';
  const reason = nullReason(r);
  return [
    `run ${r.runId} — wall-clock summary (${r.eventCount} events)`,
    row('segment', 'human', 'startedAt', 'endedAt', 'durationMs'),
    ...(rows.length ? rows : ['(no windows recorded)']),
    `totalMs: ${String(r.totalMs)} · humanWaitMs: ${String(r.humanWaitMs)} · humanWaitPct: ${String(r.humanWaitPct)}${reason ? ` (null: ${reason})` : ''}`,
    `unpaired: ${unpaired}`,
    `confirm-launch closed pairs: ${r.confirmLaunchClosedPairs}`,
  ].join('\n');
}

function renderEdge(r) {
  const head = `recorded ${r.event.type} "${r.segment}"${r.humanWait ? ' (human-wait)' : ''} for ${r.runId} at ${r.event.ts}`;
  return [head, ...r.warnings.map((w) => `warning: ${w}`)].join('\n');
}

/**
 * Library entry. Never throws for bad input; filesystem errors become `{ ok:false }`.
 *
 * @param {ReturnType<typeof parseArgs>} args - an `ok` parse result
 * @param {{ storeDir?: string, now?: () => Date }} [opts] - `storeDir` is the test seam (default: the `/split` runtime store)
 * @returns {object}
 */
export function runMark(args, opts = {}) {
  const ctx = { storeDir: opts.storeDir, now: opts.now ?? (() => new Date()) };
  try {
    return args.cmd === 'summary' ? summarize(args, ctx) : recordEdge(args, ctx);
  } catch (err) {
    return { ok: false, error: `${args.cmd} failed: ${err?.message ?? err}` };
  }
}

/**
 * CLI entry. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {{ storeDir?: string, now?: () => Date, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {number}
 */
export function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  if (args.ok && args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  if (!args.ok) {
    if (args.json) out(`${JSON.stringify({ ok: false, error: args.error })}\n`);
    else err(`${args.error}\n${HELP}\n`);
    return 1;
  }
  const result = runMark(args, opts);
  if (args.json) out(`${JSON.stringify(result, null, 2)}\n`);
  else if (!result.ok) err(`${result.error}\n`);
  else out(`${result.command === 'summary' ? renderSummary(result) : renderEdge(result)}\n`);
  return result.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
