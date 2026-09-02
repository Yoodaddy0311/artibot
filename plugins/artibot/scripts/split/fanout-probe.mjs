#!/usr/bin/env node
/**
 * Fan-out probe — is each split window delegating, or working solo?
 *
 *   node scripts/split/fanout-probe.mjs [--all] [--parent <root>]
 *
 * Generalised from `Ontology/.artibot/split/tools/fanout-probe.js` (leader
 * monitor, 10-minute cadence). One stdout line per event; silence when quiet.
 *
 * Rule (unchanged): a window whose MAIN transcript was updated within
 * `mainActiveMinutes` (10) but whose subagent transcripts show ZERO updates
 * within `subagentActiveMinutes` (5) is `SOLO` — the window is active and
 * doing the work itself instead of fanning out.
 *
 * New: `run.json.lanes[limb].state` gates the alert. A lane the leader has
 * marked anything other than `active` (`review`, `serial-gate`, `suspended`,
 * `done`, …) is expected to be idle, so it is not reported. A window whose
 * limb or state cannot be resolved is STILL reported, with a
 * `(state unknown)` suffix — the probe fails closed toward alerting, never
 * toward silence (`lib/supervisor/lane-monitor.js#readLaneOpsState` returns
 * `null` for anything outside the allowlist).
 *
 * Transcript layout (observed on this host, 2026-09-02):
 *   ~/.claude/projects/<encoded-worktree-root>/<sid>.jsonl          main
 *   ~/.claude/projects/<encoded-worktree-root>/<sid>/**\/*.jsonl    subagents
 * where `<encoded-worktree-root>` for `<parent>/.claude/worktrees/<name>` is
 * `<encoded parent>--claude-worktrees-<name>`.
 *
 * ENCODING NOTE: the harness names project dirs `C--Users-x-Desktop-Ontology`
 * (measured 2026-09-02: `ls ~/.claude/projects | grep -c '^C-Users'` → 0;
 * `C--Users-*` → 13). `lib/handoff/handoff-builder.js#toProjectSlug` was fixed
 * the same day to produce that form, so `projectDirPrefixes` now dedupes to
 * one prefix; the local `observedProjectSlug` is kept as an independent
 * second derivation so a future regression of the slug function cannot
 * silence the probe.
 *
 * ZERO-MATCH RULE: when no transcript dir matches any prefix the probe prints
 * a `[fanout probe]` line even without `--all` — silence must mean "scanned
 * and found nothing alarming", never "scanned nothing".
 *
 * Read-only: `readdirSync`/`statSync` on the projects dir, `plan.json`,
 * `run.json`. Exit 0 always.
 *
 * @module scripts/split/fanout-probe
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toProjectSlug } from '../../lib/handoff/handoff-builder.js';
import { readLaneOpsState } from '../../lib/supervisor/lane-monitor.js';
import { isMainEntry } from '../hooks/_main-entry.js';

export const WORKTREE_INFIX = '--claude-worktrees-';

/** Defaults; overridable via `split.supervisor.probe.*` (see laneC-notes.md). */
export const DEFAULT_PROBE = Object.freeze({
  mainActiveMinutes: 10,
  subagentActiveMinutes: 5,
});

/**
 * @param {string[]} argv
 * @returns {{ all: boolean, parent: string }}
 */
export function parseArgs(argv) {
  const out = { all: false, parent: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--all') out.all = true;
    else if (argv[i] === '--parent' && argv[i + 1]) out.parent = argv[++i];
  }
  out.parent = path.resolve(out.parent);
  return out;
}

/**
 * The harness's observed encoding of an absolute path into a project dir
 * name: every character outside `[A-Za-z0-9-]` becomes `-`.
 * @param {string} root
 * @returns {string}
 */
export function observedProjectSlug(root) {
  return String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Candidate `~/.claude/projects/` directory-name prefixes for this parent's
 * worktrees: the plugin's canonical slug and the observed encoding, deduped.
 * Pure.
 *
 * @param {string} parentRoot
 * @returns {string[]}
 */
export function projectDirPrefixes(parentRoot) {
  const out = [];
  for (const slug of [toProjectSlug(parentRoot), observedProjectSlug(parentRoot)]) {
    if (slug && !out.includes(`${slug}${WORKTREE_INFIX}`)) out.push(`${slug}${WORKTREE_INFIX}`);
  }
  return out;
}

/**
 * Map worktree dir name (lower-cased) → limb, from `plan.json` (`worktreePath`
 * basename, else `worktreeName`), `run.json.windowReuse[limb]`
 * (`"<session> @ <path>"`, Ontology 2026-08-31 form) and
 * `run.json.windows[limb]` (string, or `{ worktreePath }` —
 * `lib/git/split-run-file.js#windowForLimb`'s shapes). Pure.
 *
 * @param {object|null} plan
 * @param {object|null} run
 * @returns {Map<string, string>}
 */
export function limbByWindow(plan, run) {
  const map = new Map();
  const put = (p, limb) => {
    if (typeof p !== 'string' || !p || typeof limb !== 'string' || !limb) return;
    const base = path.basename(p.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (base) map.set(base.toLowerCase(), limb);
  };
  for (const l of Array.isArray(plan?.limbs) ? plan.limbs : []) {
    put(l?.worktreeName, l?.limb);
    put(l?.worktreePath, l?.limb); // later wins: the real path beats the planned name
  }
  for (const table of [run?.windowReuse, run?.windows]) {
    if (!table || typeof table !== 'object') continue;
    for (const [limb, spec] of Object.entries(table)) {
      if (typeof spec === 'string') {
        const at = spec.lastIndexOf('@');
        if (at >= 0) put(spec.slice(at + 1).trim(), limb);
      } else if (spec && typeof spec === 'object') {
        put(spec.worktreePath, limb);
      }
    }
  }
  return map;
}

/**
 * @typedef {object} WindowScan
 * @property {string} window - worktree dir name (as on disk)
 * @property {string} prefix - which projects-dir prefix matched
 * @property {string|null} sid - newest main transcript's session id
 * @property {number|null} mainMtimeMs
 * @property {number} subTotal - subagent transcripts found
 * @property {number} subActive - of those, updated within `subActiveMs`
 */

/**
 * Walk one project dir. Read-only.
 * @param {string} dir
 * @param {number} nowMs
 * @param {number} subActiveMs
 * @returns {{ sid: string|null, mainMtimeMs: number|null, subTotal: number, subActive: number }}
 */
function scanOne(dir, nowMs, subActiveMs) {
  let mains;
  try {
    mains = fs.readdirSync(dir)
      .filter((e) => e.endsWith('.jsonl'))
      .map((e) => ({ e, m: fs.statSync(path.join(dir, e)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {
    return { sid: null, mainMtimeMs: null, subTotal: 0, subActive: 0 };
  }
  if (!mains.length) return { sid: null, mainMtimeMs: null, subTotal: 0, subActive: 0 };
  const sid = mains[0].e.replace(/\.jsonl$/, '');
  let subTotal = 0;
  let subActive = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        subTotal += 1;
        try {
          if (nowMs - fs.statSync(p).mtimeMs < subActiveMs) subActive += 1;
        } catch { /* skip */ }
      }
    }
  };
  walk(path.join(dir, sid));
  return { sid, mainMtimeMs: mains[0].m, subTotal, subActive };
}

/**
 * Scan `~/.claude/projects/` for this parent's worktree transcript dirs.
 * Read-only; missing projects dir → `[]`.
 *
 * @param {{ projectsRoot?: string, prefixes: string[], nowMs: number, subActiveMs: number }} opts
 * @returns {WindowScan[]}
 */
export function scanWindows({ projectsRoot, prefixes, nowMs, subActiveMs }) {
  const root = projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const pd of dirs) {
    const prefix = prefixes.find((p) => pd.startsWith(p));
    if (!prefix) continue;
    const scanned = scanOne(path.join(root, pd), nowMs, subActiveMs);
    out.push({ window: pd.slice(prefix.length), prefix, ...scanned });
  }
  return out;
}

/**
 * @typedef {object} ProbeEvent
 * @property {'solo'|'ok'|'idle'|'skip'} kind
 * @property {string} window
 * @property {string|null} sid
 * @property {number|null} mainAgeMin
 * @property {number} subTotal
 * @property {number} subActive
 * @property {string|null} limb
 * @property {string|null} opsState - `null` = unknown
 */

/**
 * Classify scanned windows. Pure — the only logic in this file worth a test.
 *
 *   - main transcript older than `mainActiveMs` → `idle` (window not working; landing wait, /clear wait)
 *   - limb resolved AND ops state known AND ≠ `active` → `skip` (expected idle)
 *   - subagent activity 0 → `solo` (alert; `opsState === null` marks "state unknown")
 *   - otherwise `ok`
 *
 * @param {object} input
 * @param {WindowScan[]} input.windows
 * @param {number} input.nowMs
 * @param {number} input.mainActiveMs
 * @param {Map<string, string>} input.limbByWindow - lower-cased window → limb
 * @param {object|null} input.run - parsed run.json (for `readLaneOpsState`)
 * @returns {ProbeEvent[]}
 */
export function classifyWindows({ windows, nowMs, mainActiveMs, limbByWindow: byWin, run }) {
  const out = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || typeof w.window !== 'string') continue;
    const limb = byWin?.get?.(w.window.toLowerCase()) ?? null;
    const opsState = limb ? readLaneOpsState(run, limb) : null;
    const mainAgeMin = Number.isFinite(w.mainMtimeMs) ? Math.round((nowMs - w.mainMtimeMs) / 60000) : null;
    const base = { window: w.window, sid: w.sid ?? null, mainAgeMin, subTotal: w.subTotal ?? 0, subActive: w.subActive ?? 0, limb, opsState };
    if (mainAgeMin === null || nowMs - w.mainMtimeMs > mainActiveMs) {
      out.push({ kind: 'idle', ...base });
    } else if (opsState !== null && opsState !== 'active') {
      out.push({ kind: 'skip', ...base });
    } else if ((w.subActive ?? 0) === 0) {
      out.push({ kind: 'solo', ...base });
    } else {
      out.push({ kind: 'ok', ...base });
    }
  }
  return out;
}

/**
 * One line per event; `solo` always, the rest only with `all`. Pure.
 * @param {ProbeEvent[]} events
 * @param {{ all?: boolean }} [opts]
 * @returns {string[]}
 */
export function formatEvents(events, opts = {}) {
  const lines = [];
  for (const e of events) {
    const sid = e.sid ? e.sid.slice(0, 8) : '-';
    const lane = e.limb ? ` limb=${e.limb}` : '';
    const unknown = e.opsState === null ? ' (state unknown)' : ` state=${e.opsState}`;
    if (e.kind === 'solo') {
      lines.push(`[fanout SOLO] ${e.window}${lane} sid=${sid} main活${e.mainAgeMin}분전 서브에이전트 누계=${e.subTotal} 5분내활동=0${unknown}`);
    } else if (opts.all) {
      if (e.kind === 'ok') lines.push(`[fanout ok] ${e.window}${lane} 누계=${e.subTotal} 활동=${e.subActive}${unknown}`);
      else if (e.kind === 'skip') lines.push(`[fanout skip] ${e.window}${lane} state=${e.opsState} (not active)`);
      else lines.push(`[fanout idle] ${e.window}${lane} main ${e.mainAgeMin === null ? '없음' : `${e.mainAgeMin}분전`}`);
    }
  }
  return lines;
}

/**
 * @param {string} file
 * @returns {object|null}
 */
function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * CLI entry. Always exits 0; prints nothing when quiet.
 * @returns {Promise<void>}
 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const splitDir = path.join(args.parent, '.artibot', 'split');
    const plan = readJson(path.join(splitDir, 'plan.json'));
    const run = readJson(path.join(splitDir, 'run.json'));
    let probe = DEFAULT_PROBE;
    try {
      const { loadConfig } = await import('../../lib/core/config.js');
      const cfg = await loadConfig();
      const p = cfg?.split?.supervisor?.probe;
      if (p && typeof p === 'object') {
        probe = {
          mainActiveMinutes: Number.isFinite(p.mainActiveMinutes) ? p.mainActiveMinutes : DEFAULT_PROBE.mainActiveMinutes,
          subagentActiveMinutes: Number.isFinite(p.subagentActiveMinutes) ? p.subagentActiveMinutes : DEFAULT_PROBE.subagentActiveMinutes,
        };
      }
    } catch { /* defaults */ }
    const nowMs = Date.now();
    const windows = scanWindows({
      prefixes: projectDirPrefixes(args.parent),
      nowMs,
      subActiveMs: probe.subagentActiveMinutes * 60000,
    });
    const events = classifyWindows({
      windows, nowMs, mainActiveMs: probe.mainActiveMinutes * 60000, limbByWindow: limbByWindow(plan, run), run,
    });
    const lines = formatEvents(events, { all: args.all });
    if (windows.length === 0) {
      lines.push(`[fanout probe] 0 transcript dirs matched prefixes ${projectDirPrefixes(args.parent).join(' | ')} — 창 상태를 판정할 수 없다(미확인), 침묵이 아니다`);
    }
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } catch (err) {
    process.stdout.write(`[fanout error] ${err?.message ?? err}\n`);
  }
  process.exitCode = 0;
}

if (isMainEntry(import.meta.url)) {
  await main();
}
