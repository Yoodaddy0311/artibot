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
 *   run.json.lanes[limb] = { state, since: ISO, window?: session, note?: text,
 *                            projected_from: 'run.json', updated_at: ISO }
 *
 * `projected_from`/`updated_at` are stamped by `writeWorkerState`, not here:
 * `since` moves only on a state change, so a re-assert needs a second
 * timestamp to say the record was touched at all.
 *
 * Rules (all fail-closed, exit 1 with the reason):
 *   - `state` must be in `LANE_OPS_STATES` — the allowlist is printed on refusal.
 *   - `limb` must be in `plan.json` — no `--force`; a typo must not create a lane.
 *   - Every other key of `run.json` is preserved verbatim (live files carry
 *     free-form `metrics`, `landings`, `rebootShutdown_*`, …); other lanes'
 *     entries are preserved too.
 *   - `since` is set when the state CHANGES; re-asserting the same state keeps
 *     the earlier `since` (idempotent re-runs do not reset the clock).
 *
 * ONE writer, one chain: this script validates (allowlist + plan membership,
 * the part callers get wrong) and then hands the write to
 * `lib/topology/split-state.js#writeWorkerState`, which owns the record shape,
 * the `since` rule and the ledger ordering. `scripts/split/dispatch.mjs` calls
 * `setLaneState`, never `run.json` directly, so there is exactly one path from
 * any caller to that key.
 *
 * `--list` prints every plan limb with its current state (`unknown` when the
 * key is absent or outside the allowlist — the same answer the reader gives).
 * It asks `lib/topology/split-state.js#readWorkerState`, the one door for "what
 * is this worker doing", so the table is the canonical answer for every run:
 *  - a run that carries no record, or whose record the canary switch is not
 *    honouring, is answered from `run.json.lanes` exactly as before (a record
 *    the switch ignores ends the human table with a `binding: disabled` line);
 *  - a BOUND run with the switch ON is answered from the bound mission's Task
 *    Graph node, so a store commit whose `run.json` projection did not land
 *    still lists correctly. Every row then carries `source` (`store` · `run.json`
 *    · `null`), and a binding that cannot be read (`unread` — no session id or
 *    the store would not open · `dangling` · `invalid`) falls back to the
 *    projection AND says so in a `binding:` line. A read never refuses: this is
 *    a status table, and the writer is the one that exits 1 on a bad binding.
 *
 * `listLaneStates` returns the rows; `readLaneStates` also returns the binding
 * report the footer is made from.
 *
 * ── A run with a `missionBinding` (SH-11) ───────────────────────────────
 * The write goes to the bound mission's Task Graph node (`ops` + `status` in
 * ONE commit) and `run.json.lanes[limb]` is rewritten from it, stamped
 * `projected_from: 'store'`. Every failure of that path — a binding whose
 * mission is gone (`binding-dangling`), a damaged record, no session id to
 * open a store with (`store-unavailable`), a store that moved twice
 * (`cas-conflict`) — is a refusal: exit 1 with the reason, `run.json` untouched,
 * NO fallback to the legacy write. The way out of a binding you no longer want
 * is deliberate: remove `missionBinding` from plan.json. A run WITHOUT one is
 * written exactly as before and opens no store.
 *
 * ── The canary switch (SH-11) ────────────────────────────────────────────
 * All of the above happens only while `artibot.config.json#
 * split.missionBinding.enabled` is a literal `true` (`task-feed.mjs#
 * missionBindingEnabled`; shipped `false`). With the key off, a run that
 * carries a record is written by the LEGACY path — `run.json` only, no store
 * opened — and the result adds `binding: { status: 'disabled' }`. That is the
 * revert: `split.missionBinding.enabled: false`, nothing else to undo. Turning
 * the key back on is guarded: a lane the legacy path wrote after the node last
 * changed (a later stamp, or a different word than `ops.state` written after
 * `ops.since`) refuses as `binding-stale` (the node's `ops` is behind
 * `run.json`).
 *
 * After a successful write, `main` (the CLI only — never `setLaneState`,
 * which dispatch also calls) hands the transition to
 * `lane-lease.mjs#syncLaneLease`, which renews or releases the limb's
 * StateStore lease. RECORD-ONLY: its result is the one `lease` key of
 * `--json`, and it never changes the exit code or the human line.
 *
 * @module scripts/split/lane-state
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLaneOpsState, LANE_OPS_STATES, LANE_OPS_TO_V11_STATUS } from '../../lib/supervisor/contracts.js';
import { readPlanJson, readRunJson, windowForLimb } from '../../lib/git/split-run-file.js';
import { readWorkerState, writeWorkerState } from '../../lib/topology/split-state.js';
import { BINDING_DISABLED, carriesMissionBinding } from '../../lib/topology/split-state-sources.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import { syncLaneLease } from './lane-lease.mjs';
import { missionBindingEnabled, openFeedStore, sessionIdFromEnv } from './task-feed.mjs';

export const HELP = `usage: node scripts/split/lane-state.mjs <limb> <state> [--window <session>] [--note <text>] [--json]
       node scripts/split/lane-state.mjs --list [--json]

  <state>            one of: ${LANE_OPS_STATES.join(' | ')}
  --window <session> record the window (session name) alongside the state
  --note <text>      free-form note (why / what is next)
  --list             print every plan limb with its current ops state (a bound run, key on: from its mission's Task Graph node)
  --json             machine output

Writes run.json.lanes[<limb>] = { state, since, window?, note?, projected_from, updated_at } atomically; every other run.json key is preserved.
Refuses a state outside the allowlist and a limb not in plan.json (no --force).
A run whose plan.json carries a missionBinding is written through that mission's Task Graph first (run.json is then its projection) while artibot.config.json#split.missionBinding.enabled is true; a binding that cannot be honoured refuses with exit 1 and run.json untouched. With the key off (the shipped default) the binding is ignored: run.json is written directly and the result says binding.status "disabled".`;

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
 * The StateStore a BOUND run's lane write goes through, opened lazily (only
 * `writeWorkerState` calls this, and only for a bound run — an unbound write
 * opens nothing). `null` when there is no session id: a store needs one for
 * its ledger envelopes, and the writer turns `null` into `store-unavailable`.
 *
 * @param {string} parentRoot
 * @param {{ sessionId?: string|null, openStore?: (root: string, sid: string) => object }} opts
 * @returns {object|null}
 */
function openBoundStore(parentRoot, opts) {
  const sid = opts.sessionId ?? sessionIdFromEnv();
  if (typeof sid !== 'string' || sid === '') return null;
  return (opts.openStore ?? openFeedStore)(parentRoot, sid);
}

/**
 * Set one lane's ops state. Writes `run.json` — or, for a run that carries a
 * `missionBinding`, the bound mission's Task Graph node first and `run.json`
 * as its projection (`lib/topology/split-state.js#writeWorkerState`). Throws
 * on refusal; a bound run's refusals (`binding-dangling`, `store-unavailable`,
 * `cas-conflict`, …) throw with the reason first and leave `run.json` as it was.
 *
 * @param {{ limb: string, state: string, window?: string|null, note?: string|null }} input
 * @param {{ cwd?: string, now?: () => Date, sessionId?: string|null, openStore?: (root: string, sid: string) => object, config?: object|null }} [opts] - `sessionId` / `openStore` matter for a bound run only. `config`: the parsed artibot.config.json the canary key is read from (`null` = no config = off; absent = read the shipped file).
 * @returns {{ limb: string, state: string, previous: string|null, since: string, window: string|null, note: string|null, changed: boolean, ledger: string, source?: 'store', missionId?: string, stateVersion?: number, projection?: string, binding?: {status: 'disabled'} }} - `ledger` is what the event half did: `appended`, `skipped:no-event` (this transition owes none), `skipped:no-port` (no ledger injected — this CLI injects none) or `skipped:missing:<key>`. A skip is a real hole in `ledger ⊇ store` and this return is its only signal. The four keys after `ledger` appear for a BOUND run only, and `previous` / `changed` are then the STORE's answer, not run.json's. `binding` appears only when the run carries a record the canary switch is not honouring.
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
  const run = readRunJson(parentRoot);
  const prev = currentEntry(run, limb);
  // Resolved here, not in the writer: the window fallback chain
  // (argument → recorded lane entry → `windowReuse`) is this script's rule.
  // `writeWorkerState` only carries the value it is handed.
  const win = window ?? prev.window ?? windowForLimb(run, limb);
  const noteOut = note ?? prev.note;
  const written = writeWorkerState({
    runDir: path.join(parentRoot, '.artibot', 'split'),
    worker: limb,
    patch: { ops_state: state, ...(win ? { window: win } : {}), ...(noteOut ? { note: noteOut } : {}) },
    now: opts.now,
    openStore: () => openBoundStore(parentRoot, opts),
    // The canary key, asked lazily and only for a run that carries a record —
    // `lib/topology` is L4 and reads no config.
    honorBinding: () => missionBindingEnabled(opts),
  });
  // A bound run's refusal is an exception, like every other refusal here: the
  // CLI exits 1 with the reason and `run.json` is exactly what it was.
  if (written.ok === false) throw new Error(written.detail ? `${written.reason}: ${written.detail}` : written.reason);
  const bound = written.source === 'store';
  return {
    limb,
    state,
    previous: bound ? written.previousOps : prev.state,
    since: written.record.since,
    window: win ?? null,
    note: noteOut ?? null,
    changed: bound ? written.changed : prev.state !== state,
    ledger: written.ledger,
    ...(bound ? { source: 'store', missionId: written.missionId, stateVersion: written.stateVersion, projection: written.projection } : {}),
    ...(written.binding ? { binding: written.binding } : {}),
  };
}

/**
 * The StateStore a `--list` read of a BOUND run goes through. Asked in the order
 * that keeps every other run out of it: the plan's own key first, then the canary
 * switch, and only then a store — so a run with no record never reads config or
 * opens anything, and a record the switch is not honouring is not consulted
 * (`readWorkerState` then answers `disabled`, from `run.json`).
 *
 * @param {string} parentRoot
 * @param {object} opts - the `readLaneStates` options
 * @returns {{ honored: boolean, store: object|null, unread: string|null }} `unread` says why a honoured binding has no store to read
 */
function storeForRead(parentRoot, opts) {
  if (!carriesMissionBinding(readPlanJson(parentRoot)) || !missionBindingEnabled(opts)) return { honored: false, store: null, unread: null };
  try {
    const store = openBoundStore(parentRoot, opts);
    return { honored: true, store, unread: store ? null : 'no session id to open the StateStore with' };
  } catch (err) {
    return { honored: true, store: null, unread: `opening the StateStore threw: ${err?.message ?? err}` };
  }
}

const textOrNull = (v) => (typeof v === 'string' ? v : null);

/**
 * The ops word `readWorkerState` reports for one worker, or `unknown`. A lane
 * entry's own hand-added `ops_state` key rides along in the record next to the
 * word the reader derived, and would read as a state when the entry's real
 * `state` is one the allowlist rejects; for `run.json` the v1.1 status derived
 * from the real word is the witness that tells the two apart.
 *
 * @param {object|undefined} w - a `readWorkerState` worker record
 * @returns {string}
 */
function opsWordOf(w) {
  const word = w?.ops_state;
  if (!isLaneOpsState(word)) return 'unknown';
  if (w.source === 'run.json' && LANE_OPS_TO_V11_STATUS[word] !== w.status) return 'unknown';
  return word;
}

/**
 * Every plan limb with its current ops state (`unknown` when unreadable),
 * answered by `lib/topology/split-state.js#readWorkerState`, plus the binding
 * report the human footer is made from.
 *
 * @param {{ cwd?: string, sessionId?: string|null, openStore?: (root: string, sid: string) => object, config?: object|null }} [opts] - `config` / `sessionId` / `openStore` matter for a run that carries a `missionBinding` only
 * @returns {{ rows: Array<{ limb: string, state: string, since: string|null, window: string|null, note: string|null, source?: string|null }>, binding: object|null, unread: string|null }} `source` is on every row exactly when `binding` is a report other than `disabled`; `binding` is `null` for a run that carries no record
 */
export function readLaneStates(opts = {}) {
  const parentRoot = path.resolve(opts.cwd ?? process.cwd());
  const limbs = planLimbs(parentRoot);
  const run = readRunJson(parentRoot);
  const bound = storeForRead(parentRoot, opts);
  const ask = (store) => readWorkerState({
    runDir: path.join(parentRoot, '.artibot', 'split'),
    ...(store ? { store } : {}),
    honorBinding: () => bound.honored,
  });
  let read;
  let unread = bound.unread;
  try {
    read = ask(bound.store);
  } catch (err) {
    // A store that throws WHEN READ (a locked or damaged journal) must not take the status table with it: the
    // projection answers and the footer says why. A throw that is not the store's (a damaged run.json) recurs
    // in the retry below and stays loud.
    if (!bound.store) throw err;
    unread = `reading the StateStore threw: ${err?.message ?? err}`;
    read = ask(null);
  }
  const binding = read.binding ?? null;
  const showSource = binding !== null && binding.status !== BINDING_DISABLED.status;
  const rows = limbs.map((limb) => {
    const w = read.workers[limb];
    const row = { limb, state: opsWordOf(w), since: textOrNull(w?.since), window: textOrNull(w?.window) ?? windowForLimb(run, limb), note: textOrNull(w?.note) };
    return showSource ? { ...row, source: w?.source ?? null } : row;
  });
  return { rows, binding, unread };
}

/**
 * Every plan limb with its current ops state (`unknown` when unreadable).
 *
 * @param {Parameters<typeof readLaneStates>[0]} [opts]
 * @returns {ReturnType<typeof readLaneStates>['rows']}
 */
export function listLaneStates(opts = {}) {
  return readLaneStates(opts).rows;
}

/** Fixed-width table; a `source` column appears only when the rows carry one. */
function renderTable(rows) {
  const cols = ['limb', 'state', 'since', 'window', 'note', ...(rows.some((r) => 'source' in r) ? ['source'] : [])];
  const cell = (r, c) => String(r[c] ?? '-');
  const widths = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => cell(r, c).length))]));
  const line = (r) => cols.map((c) => cell(r, c).padEnd(widths[c])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join('\n');
}

/**
 * The line under the table when the binding is anything but healthy: where the
 * rows came from, so a run.json projection is never read as the canonical node.
 *
 * @param {object|null} binding - `readWorkerState`'s `binding` report
 * @param {string|null} unread - why a honoured binding had no store
 * @returns {string} `''` for a run with no record or a healthy binding, else one line ending in a newline
 */
function bindingFooter(binding, unread) {
  if (binding === null || binding.status === 'bound') return '';
  const behind = 'rows are the run.json projection and may be behind the store';
  const lines = {
    disabled: 'binding: disabled (the record in plan.json is not consulted: the canary key is not a literal true) - rows are the run.json lanes',
    unread: `binding: unread (${unread ?? 'the StateStore was not read'}) - ${behind}`,
    dangling: `binding: dangling (mission ${binding.mission_id} is not in the StateStore) - ${behind}`,
    invalid: `binding: invalid (${binding.reason}) - ${behind}`,
  };
  return `${lines[binding.status] ?? `binding: ${binding.status} - ${behind}`}\n`;
}

/**
 * Run the lease sync without letting it reach the exit code. `syncLaneLease`
 * is total already; this guards an injected one. The sync gets the same
 * `config` the write did, so both halves read ONE answer for the canary key.
 *
 * @param {{ syncLease?: Function, config?: object|null }} opts
 * @param {{ parentRoot: string, limb: string, state: string }} input
 * @returns {{ outcome: string, missionId: string|null, binding?: {status: 'disabled'} }}
 */
function syncLease(opts, input) {
  try {
    return (opts.syncLease ?? syncLaneLease)(input, { config: opts.config });
  } catch (e) {
    return { outcome: `skipped:sync-threw:${e?.message ?? 'unknown'}`, missionId: null };
  }
}

/**
 * CLI entry. Returns exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => Date, sessionId?: string|null, openStore?: (root: string, sid: string) => object, config?: object|null, stdout?: (s: string) => void, stderr?: (s: string) => void, syncLease?: (input: { parentRoot: string, limb: string, state: string }, ports: { config?: object|null }) => { outcome: string, missionId: string|null } }} [opts] - `syncLease` is the test seam for the lease sync; `sessionId` / `openStore` are the seams for a bound run's store; `config` is the parsed artibot.config.json the canary key is read from (forwarded to the sync; absent = the shipped file).
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
      const { rows, binding, unread } = readLaneStates(opts);
      out(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${renderTable(rows)}\n${bindingFooter(binding, unread)}`);
      return 0;
    }
    if (!args.limb || !args.state) {
      err(`limb and state are required\n${HELP}\n`);
      return 1;
    }
    const r = setLaneState({ limb: args.limb, state: args.state, window: args.window, note: args.note }, opts);
    const lease = syncLease(opts, { parentRoot: path.resolve(opts.cwd ?? process.cwd()), limb: r.limb, state: r.state });
    if (args.json) out(`${JSON.stringify({ ...r, lease }, null, 2)}\n`);
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
