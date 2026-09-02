#!/usr/bin/env node
/**
 * `split lane-state <limb> <state>` — the WRITER for `run.json.lanes[limb]`.
 *
 * Until 2026-09-02 this key had readers only (`scripts/split/fanout-probe.mjs`
 * via `lib/supervisor/lane-monitor.js#readLaneOpsState`, allowlist
 * `lib/supervisor/contracts.js#LANE_OPS_STATES`) and no writer, so every lane
 * read as `unknown` forever: the fan-out probe could never suppress a
 * false alert and the watch table's ops column never filled. This script
 * is the one place the leader sets that state.
 *
 * Shape written (the reader accepts a string or `{ state }`; the object form
 * is used so a window and a note can ride along):
 *
 *   run.json.lanes[limb] = { state, since: ISO, window?: session, note?: text }
 *
 * Rules (all fail-closed, exit 1 with the reason):
 *   - `state` must be in `LANE_OPS_STATES` — the allowlist is printed on refusal.
 *   - `limb` must be in `plan.json` — no `--force`; a typo must not create a lane.
 *   - Every other key of `run.json` is preserved verbatim (live files carry
 *     free-form `metrics`, `landings`, `rebootShutdown_*`, …); other lanes'
 *     entries are preserved too. Writes go through
 *     `lib/git/split-run-file.js#updateRunJson` (atomic tmp + rename).
 *   - `since` is set when the state CHANGES; re-asserting the same state keeps
 *     the earlier `since` (idempotent re-runs do not reset the clock).
 *
 * `--list` prints every plan limb with its current state (`unknown` when the
 * key is absent or outside the allowlist — the same answer the reader gives).
 *
 * @module scripts/split/lane-state
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLaneOpsState, LANE_OPS_STATES } from '../../lib/supervisor/contracts.js';
import { readRunJson, updateRunJson, windowForLimb } from '../../lib/git/split-run-file.js';
import { isMainEntry } from '../hooks/_main-entry.js';

export const HELP = `usage: node scripts/split/lane-state.mjs <limb> <state> [--window <session>] [--note <text>] [--json]
       node scripts/split/lane-state.mjs --list [--json]

  <state>            one of: ${LANE_OPS_STATES.join(' | ')}
  --window <session> record the window (session name) alongside the state
  --note <text>      free-form note (why / what is next)
  --list             print every plan limb with its current ops state
  --json             machine output

Writes run.json.lanes[<limb>] = { state, since, window?, note? } atomically; every other run.json key is preserved.
Refuses a state outside the allowlist and a limb not in plan.json (no --force).`;

/**
 * @param {string[]} argv
 * @returns {{ limb: string|null, state: string|null, window: string|null, note: string|null, list: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { limb: null, state: null, window: null, note: null, list: false, json: false, help: false };
  const withValue = { '--window': 'window', '--note': 'note' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list') out.list = true;
    else if (a === '--json') out.json = true;
    else if (withValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      out[withValue[a]] = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else if (out.limb === null) out.limb = a;
    else if (out.state === null) out.state = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** Limb slugs from plan.json (throws when the plan is missing). */
function planLimbs(parentRoot) {
  const planPath = path.join(parentRoot, '.artibot', 'split', 'plan.json');
  if (!fs.existsSync(planPath)) throw new Error(`plan.json missing: ${planPath} — run /split plan first`);
  const plan = JSON.parse(stripBom(fs.readFileSync(planPath, 'utf-8')));
  return (Array.isArray(plan.limbs) ? plan.limbs : []).map((l) => l?.limb).filter((l) => typeof l === 'string' && l);
}

/** Current entry for a limb as the reader sees it: `{ state|null, since, window, note }`. */
function currentEntry(run, limb) {
  const raw = run?.lanes && typeof run.lanes === 'object' ? run.lanes[limb] : undefined;
  if (typeof raw === 'string') return { state: isLaneOpsState(raw) ? raw : null, since: null, window: null, note: null, raw };
  if (raw && typeof raw === 'object') {
    return {
      state: isLaneOpsState(raw.state) ? raw.state : null,
      since: typeof raw.since === 'string' ? raw.since : null,
      window: typeof raw.window === 'string' ? raw.window : null,
      note: typeof raw.note === 'string' ? raw.note : null,
      raw,
    };
  }
  return { state: null, since: null, window: null, note: null, raw: undefined };
}

/**
 * Set one lane's ops state. Writes `run.json`. Throws on refusal.
 *
 * @param {{ limb: string, state: string, window?: string|null, note?: string|null }} input
 * @param {{ cwd?: string, now?: () => Date }} [opts]
 * @returns {{ limb: string, state: string, previous: string|null, since: string, window: string|null, note: string|null, changed: boolean }}
 */
export function setLaneState({ limb, state, window = null, note = null }, opts = {}) {
  const parentRoot = path.resolve(opts.cwd ?? process.cwd());
  if (!limb || !state) throw new Error('limb and state are required (see --help)');
  if (!isLaneOpsState(state)) {
    throw new Error(`state ${JSON.stringify(state)} is not allowed — allowlist: ${LANE_OPS_STATES.join(', ')}`);
  }
  const limbs = planLimbs(parentRoot);
  if (!limbs.includes(limb)) {
    throw new Error(`limb ${JSON.stringify(limb)} not in plan.json (known: ${limbs.join(', ') || '(none)'}) — no --force, fix the name`);
  }
  const now = (opts.now ?? (() => new Date()))().toISOString();
  let result = null;
  updateRunJson(parentRoot, (cur) => {
    const prev = currentEntry(cur, limb);
    const changed = prev.state !== state;
    const since = changed || !prev.since ? now : prev.since;
    const win = window ?? prev.window ?? windowForLimb(cur, limb);
    // Preserve hand-added keys (`pr`, `inspector`, …): spread the existing
    // object entry and overwrite only state/since/window/note. A string entry
    // (`lanes[limb] = 'review'`) is promoted to the object form.
    const base = prev.raw && typeof prev.raw === 'object' ? prev.raw : {};
    const entry = { ...base, state, since };
    if (win) entry.window = win;
    const noteOut = note ?? prev.note;
    if (noteOut) entry.note = noteOut;
    const lanes = cur.lanes && typeof cur.lanes === 'object' && !Array.isArray(cur.lanes) ? cur.lanes : {};
    result = { limb, state, previous: prev.state, since, window: win ?? null, note: noteOut ?? null, changed };
    return { ...cur, lanes: { ...lanes, [limb]: entry } };
  });
  return result;
}

/**
 * Every plan limb with its current ops state (`unknown` when unreadable).
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {Array<{ limb: string, state: string, since: string|null, window: string|null, note: string|null }>}
 */
export function listLaneStates(opts = {}) {
  const parentRoot = path.resolve(opts.cwd ?? process.cwd());
  const run = readRunJson(parentRoot);
  return planLimbs(parentRoot).map((limb) => {
    const e = currentEntry(run, limb);
    return { limb, state: e.state ?? 'unknown', since: e.since, window: e.window ?? windowForLimb(run, limb), note: e.note };
  });
}

/** Fixed-width table. */
function renderTable(rows) {
  const cols = ['limb', 'state', 'since', 'window', 'note'];
  const cell = (r, c) => String(r[c] ?? '-');
  const widths = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => cell(r, c).length))]));
  const line = (r) => cols.map((c) => cell(r, c).padEnd(widths[c])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join('\n');
}

/**
 * CLI entry. Returns exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => Date, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {number}
 */
export function main(argv, opts = {}) {
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
    if (args.list) {
      const rows = listLaneStates(opts);
      out(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${renderTable(rows)}\n`);
      return 0;
    }
    if (!args.limb || !args.state) {
      err(`limb and state are required\n${HELP}\n`);
      return 1;
    }
    const r = setLaneState({ limb: args.limb, state: args.state, window: args.window, note: args.note }, opts);
    if (args.json) out(`${JSON.stringify(r, null, 2)}\n`);
    else out(`${r.limb}: ${r.previous ?? 'unknown'} → ${r.state}${r.changed ? '' : ' (unchanged)'} since ${r.since}${r.window ? ` window=${r.window}` : ''}${r.note ? ` note=${r.note}` : ''}\n`);
    return 0;
  } catch (e) {
    if (args.json) out(`${JSON.stringify({ error: e.message, allowlist: LANE_OPS_STATES }, null, 2)}\n`);
    else err(`lane-state refused: ${e.message}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
