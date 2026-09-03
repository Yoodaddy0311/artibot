/**
 * Feature-completion scorecard — evidence-graded area scoring with before/after
 * snapshots for the `/scorecard` command. Grade a set of areas (each 0–100 with
 * file:line evidence), snapshot into a single append-only store, then diff two
 * snapshots into a "작업 전 | 작업 후 | 상승폭 | 남은 갭" table.
 *
 * Design rules (match lib/planning/artifacts.js):
 *   - Pure & immutable: builders return new objects, never mutate inputs.
 *   - Claim-honest: an area with NO evidence is stored but flagged
 *     `unverified: true` (rendered with a `*` + footnote) rather than silently
 *     scored — the point is defensible numbers, and hiding "no proof" is worse
 *     than showing it.
 *   - `now` is injectable (`() => Date`) for deterministic tests.
 *   - Korean-path safe (path.join only), atomic writes, auto-created dirs.
 *   - Failure-tolerant: returns `{ snapshots: [] }` / `{ ok: false }` on error.
 *
 * @module lib/planning/scorecard
 */

import path from 'node:path';
import { atomicWriteJson, readJsonFile } from '../core/file.js';
import { isMainEntry } from '../../scripts/hooks/_main-entry.js';

/** @typedef {() => Date} NowFn */
/** @typedef {{ file: string, note?: string }} Evidence */
/** @typedef {{ name: string, score: number, evidence: Evidence[], unverified?: boolean }} Area */
/** @typedef {{ label: string, ts: string, areas: Area[] }} Snapshot */
/** @typedef {{ snapshots: Snapshot[] }} Store */

const DEFAULT_NOW = () => new Date();
const STORE_REL = ['.artibot', 'scorecard.json'];
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** Clamp a value to [0, 100]; non-numbers to 0. */
function clampScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return MIN_SCORE;
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, n));
}

/** Absolute path to the single scorecard store for a project. */
function storePath(projectRoot) {
  return path.join(projectRoot, ...STORE_REL);
}

/**
 * Load the scorecard store. Missing/corrupt file yields `{ snapshots: [] }`.
 * @param {{ projectRoot: string }} params
 * @returns {Promise<Store>}
 */
export async function loadScorecard({ projectRoot } = {}) {
  if (!projectRoot) return { snapshots: [] };
  const data = await readJsonFile(storePath(projectRoot));
  if (!data || !Array.isArray(data.snapshots)) return { snapshots: [] };
  return { snapshots: data.snapshots };
}

/**
 * Append a snapshot. Pure — returns a NEW store, leaving `store` untouched.
 * Each area's score is clamped; an area with an empty evidence array is kept but
 * flagged `unverified: true` (claim-honesty).
 * @param {Store} store
 * @param {{ label: string, areas: Array<{name:string, score:number, evidence?:Evidence[]}>, now?: NowFn }} params
 * @returns {Store}
 */
export function addSnapshot(store, { label, areas = [], now = DEFAULT_NOW } = {}) {
  const prior = store && Array.isArray(store.snapshots) ? store.snapshots : [];
  const gradedAreas = (Array.isArray(areas) ? areas : []).map((a) => {
    const evidence = Array.isArray(a?.evidence) ? a.evidence : [];
    const area = { name: String(a?.name ?? ''), score: clampScore(a?.score), evidence };
    if (evidence.length === 0) area.unverified = true;
    return area;
  });
  const snapshot = {
    label: String(label ?? 'scorecard'),
    ts: now().toISOString(),
    areas: gradedAreas,
  };
  return { snapshots: [...prior, snapshot] };
}

/**
 * Persist the store atomically to `<projectRoot>/.artibot/scorecard.json`.
 * @param {{ projectRoot: string }} params
 * @param {Store} store
 * @returns {Promise<{ ok: true, filePath: string } | { ok: false, error: string }>}
 */
export async function saveScorecard({ projectRoot } = {}, store) {
  if (!projectRoot) return { ok: false, error: 'no_project_root' };
  try {
    const filePath = storePath(projectRoot);
    await atomicWriteJson(filePath, { snapshots: (store && store.snapshots) || [] });
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * Diff two snapshots by area name. New area yields before=null; a removed area
 * yields after=null & delta=null. `remaining` = 100 − after (gap to full), null
 * when the area is gone. Pure.
 * @param {Snapshot} prev
 * @param {Snapshot} curr
 * @returns {Array<{name:string, before:number|null, after:number|null, delta:number|null, remaining:number|null, unverified:boolean}>}
 */
export function diffSnapshots(prev, curr) {
  const p = new Map((prev?.areas || []).map((a) => [a.name, a]));
  const c = new Map((curr?.areas || []).map((a) => [a.name, a]));
  const names = [...new Set([...p.keys(), ...c.keys()])].sort();
  return names.map((name) => {
    const before = p.has(name) ? p.get(name).score : null;
    const after = c.has(name) ? c.get(name).score : null;
    const delta = before !== null && after !== null ? Math.round((after - before) * 10) / 10 : null;
    const remaining = after !== null ? MAX_SCORE - after : null;
    const unverified = Boolean((c.get(name) || p.get(name) || {}).unverified);
    return { name, before, after, delta, remaining, unverified };
  });
}

/** A ▰▱ gauge `barWidth` cells wide filled to `pct`% (0 when null). */
function gauge(pct, barWidth) {
  const filled = pct === null ? 0 : Math.round((pct / MAX_SCORE) * barWidth);
  const f = Math.min(barWidth, Math.max(0, filled));
  return '▰'.repeat(f) + '▱'.repeat(barWidth - f);
}

/**
 * Render diff rows as the reference GFM table:
 *   `| 평가 항목 | 작업 전 | 작업 후 | 상승폭 | 남은 갭 |`
 * The 남은 갭 column shows a ▰▱ gauge filled to `after`. before=null yields "—";
 * unverified areas get a `*` and a footnote.
 * @param {Array} rows - diffSnapshots() output.
 * @param {{ barWidth?: number }} [opts]
 * @returns {string}
 */
export function renderScorecard(rows, { barWidth = 10 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '_채점된 영역이 없습니다._';
  const fmt = (v) => (v === null ? '—' : String(v));
  const sign = (d) => (d === null ? '—' : d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : '± 0');
  let anyUnverified = false;
  const lines = ['| 평가 항목 | 작업 전 | 작업 후 | 상승폭 | 남은 갭 |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const mark = r.unverified ? ' *' : '';
    if (r.unverified) anyUnverified = true;
    const gaugeCell = r.after === null ? '—' : `${gauge(r.after, barWidth)} ${r.remaining}`;
    lines.push(`| ${r.name}${mark} | ${fmt(r.before)} | ${fmt(r.after)} | ${sign(r.delta)} | ${gaugeCell} |`);
  }
  if (anyUnverified) lines.push('', '`*` = 증거 없음(unverified) — file:line 근거 미제시 항목.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// NEON THEMED TTY renderer — fixed-width, truecolor gauge, ▲green/▼red deltas.
// Used when stdout is a TTY; the plain GFM renderScorecard is used otherwise.
// ---------------------------------------------------------------------------

/** neon-city palette — the fallback when no theme file / palette is supplied. */
const NEON_CITY_PALETTE = {
  signals: { primary: [0, 245, 255], accent: [255, 0, 110], danger: [255, 23, 68], dim: [70, 40, 90], warn: [255, 190, 11] },
  glyphs: { fill: '▰', empty: '▱', sep: '◢◤', spark: '⚡' },
};
const C_GREEN = [80, 250, 123];
const C_RED = [255, 85, 85];
// SGR escapes are written as \x1b, never as a raw ESC byte: a literal control byte makes grep/ripgrep read this file as binary (tests/firewall/no-control-bytes.test.js).
const RESET = '\x1b[0m';

/** Truecolor SGR prefix for an [r,g,b] triple. */
function neon([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Display width: CJK / fullwidth code points count as 2 cells, others as 1. */
function dispWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

/** Right-pad a string to `width` display cells (accounts for CJK width). */
function padCell(str, width) {
  return str + ' '.repeat(Math.max(0, width - dispWidth(str)));
}

/** Merge a partial palette over the neon-city defaults (signals + glyphs). */
function mergePalette(p) {
  const g = (p && p.glyphs) || {};
  const signals = { ...NEON_CITY_PALETTE.signals, ...(p && p.signals) };
  const glyphs = {
    fill: g.fill || NEON_CITY_PALETTE.glyphs.fill,
    empty: g.empty || NEON_CITY_PALETTE.glyphs.empty,
    sep: g.sep || NEON_CITY_PALETTE.glyphs.sep,
    spark: g.spark || NEON_CITY_PALETTE.glyphs.spark,
  };
  return { signals, glyphs };
}

/**
 * Load the live theme palette from `<home>/.claude/artibot/runtime/current-theme.json`,
 * falling back to neon-city when the file is absent or corrupt. Always resolves to a
 * palette with `signals` + `glyphs.fill/empty` (merged over neon-city).
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{signals: object, glyphs: object}>}
 */
export async function loadThemePalette({ home = process.env.HOME || process.env.USERPROFILE || '' } = {}) {
  let p = null;
  if (home) {
    const file = path.join(home, '.claude', 'artibot', 'runtime', 'current-theme.json');
    p = await readJsonFile(file); // graceful: returns null on missing/corrupt
  }
  return mergePalette(p);
}

/**
 * Themed gauge: filled cells run a primary→accent truecolor gradient (same
 * lerp as statusline bar()), empties in `dim`. `pct`-filled of `barWidth`.
 */
function gaugeTty(pct, barWidth, pal) {
  const filled = pct === null ? 0 : Math.round((pct / MAX_SCORE) * barWidth);
  const f = Math.min(barWidth, Math.max(0, filled));
  const [pr, pg, pb] = pal.signals.primary;
  const [ar, ag, ab] = pal.signals.accent;
  let out = '';
  for (let i = 0; i < f; i++) {
    const t = f > 1 ? (i * 100) / (f - 1) : 0;
    const r = Math.round(pr + ((ar - pr) * t) / 100);
    const g = Math.round(pg + ((ag - pg) * t) / 100);
    const b = Math.round(pb + ((ab - pb) * t) / 100);
    out += neon([r, g, b]) + pal.glyphs.fill;
  }
  return out + neon(pal.signals.dim) + pal.glyphs.empty.repeat(barWidth - f) + RESET;
}

/**
 * Render diff rows for a TTY: fixed-width columns, theme truecolor gauge,
 * green ▲ / red ▼ deltas. Falls back to the neon-city palette when none is
 * supplied (via mergePalette). Pure — no I/O; the injected palette is used as-is.
 * @param {Array} rows - diffSnapshots() output.
 * @param {{ palette?: object, barWidth?: number }} [opts]
 * @returns {string}
 */
export function renderScorecardTty(rows, { palette, barWidth = 10 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '채점된 영역이 없습니다.';
  const pal = mergePalette(palette);
  const fmt = (v) => (v === null ? '—' : String(v));
  const delta = (d) => {
    if (d === null) return `${neon(pal.signals.dim)}—${RESET}`;
    if (d > 0) return `${neon(C_GREEN)}▲ +${d}${RESET}`;
    if (d < 0) return `${neon(C_RED)}▼ ${d}${RESET}`;
    return `${neon(pal.signals.dim)}± 0${RESET}`;
  };
  // Name cell is padded to a fixed column, then a 2-space gap. The label text
  // never contains a run of 2+ spaces, so the first double-space on every row is
  // exactly this column boundary — keeping the score column vertically aligned.
  const nameW = Math.max(8, ...rows.map((r) => dispWidth(r.name) + (r.unverified ? 2 : 0)));
  const banner = `${neon(pal.signals.accent)}${pal.glyphs.sep} SCORECARD ${pal.glyphs.sep}${neon(pal.signals.dim)}${'━'.repeat(28)}${RESET}`;
  const head = neon(pal.signals.accent) +
    `${padCell('평가 항목', nameW)}  ${padCell('전', 4)} ${padCell('후', 4)} ${padCell('상승폭', 7)} 남은 갭` + RESET;
  const out = [banner, head];
  let anyUnverified = false;
  for (const r of rows) {
    const label = r.name + (r.unverified ? ' *' : '');
    if (r.unverified) anyUnverified = true;
    const gaugeCell = r.after === null ? '—' : `${gaugeTty(r.after, barWidth, pal)} ${r.remaining}`;
    out.push(`${padCell(label, nameW)}  ${padCell(fmt(r.before), 4)} ${padCell(fmt(r.after), 4)} ${padCell(delta(r.delta), 7)} ${gaugeCell}`);
  }
  // Footer separator (no digits — excluded from the aligned data rows) + an
  // average-delta line. The name cell pads to nameW and the numeric average
  // begins right after the 2-space gap, so its score-column offset matches the
  // data rows (aligned) while the ▲/▼ arrow + spark trail after.
  out.push(`${neon(pal.signals.dim)}${'━'.repeat(nameW + 28)}${RESET}`);
  const deltas = rows.map((r) => r.delta).filter((d) => d !== null);
  if (deltas.length > 0) {
    const avg = Math.round((deltas.reduce((a, d) => a + d, 0) / deltas.length) * 10) / 10;
    const mag = Math.abs(avg);
    const arrow = avg > 0 ? `${neon(C_GREEN)}▲` : avg < 0 ? `${neon(C_RED)}▼` : `${neon(pal.signals.dim)}±`;
    out.push(`${neon(pal.signals.accent)}${padCell('평균', nameW)}${RESET}  ${mag} ${arrow} ${neon(pal.signals.warn)}${pal.glyphs.spark}${RESET}`);
  }
  if (anyUnverified) out.push('', `${neon(pal.signals.warn)}* = 증거 없음(unverified)${RESET}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI — `node scorecard.js add|diff|list`. Keeps the /scorecard command Bash
// snippet simple: the snapshot payload ({label, areas}) arrives on stdin as
// JSON. Prints markdown to stdout; never throws. TTY stdout gets the themed
// renderer; a pipe/redirect keeps the plain GFM table.
// ---------------------------------------------------------------------------

/** Render diff rows themed when stdout is a TTY, plain GFM otherwise. */
function renderForOutput(rows) {
  return process.stdout.isTTY ? renderScorecardTty(rows) : renderScorecard(rows);
}

/** Read all of stdin as a string (empty when no pipe). */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

/** Value of a `--flag <value>` pair in argv, or '' when absent. */
function argFlag(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : '';
}

/**
 * Pick the diff pair for the CLI `diff` command: default = newest two, or the
 * `--from <label> --to <label>` pair when given. `diffSnapshots` stays a pure
 * pairwise function — this selection lives only at the CLI layer.
 * @returns {{ prev: Snapshot, curr: Snapshot } | { error: string }}
 */
function selectDiffPair(store, argv) {
  const fromLabel = argFlag(argv, '--from');
  const toLabel = argFlag(argv, '--to');
  if (fromLabel || toLabel) {
    const prev = store.snapshots.find((s) => s.label === fromLabel);
    const curr = store.snapshots.find((s) => s.label === toLabel);
    if (!prev || !curr) return { error: '--from / --to 라벨에 해당하는 스냅샷을 찾지 못했습니다.' };
    return { prev, curr };
  }
  if (store.snapshots.length < 2) {
    return { error: `비교하려면 스냅샷 2개가 필요합니다 — 현재 ${store.snapshots.length}개.` };
  }
  const [prev, curr] = store.snapshots.slice(-2);
  return { prev, curr };
}

async function runCli(argv) {
  const sub = argv[2];
  const projectRoot = process.cwd();
  const store = await loadScorecard({ projectRoot });
  if (sub === 'list') {
    if (store.snapshots.length === 0) { process.stdout.write('_저장된 스냅샷이 없습니다._\n'); return; }
    for (const [i, s] of store.snapshots.entries()) {
      process.stdout.write(`${i}: ${s.label} (${s.ts}) — ${s.areas.length}개 영역\n`);
    }
    return;
  }
  if (sub === 'diff') {
    const pick = selectDiffPair(store, argv);
    if (pick.error) { process.stdout.write(pick.error + '\n'); return; }
    process.stdout.write(renderForOutput(diffSnapshots(pick.prev, pick.curr)) + '\n');
    return;
  }
  // default: add — { label, areas } on stdin
  const raw = (await readStdin()) || '{}';
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  const next = addSnapshot(store, { label: payload.label, areas: payload.areas });
  const saved = await saveScorecard({ projectRoot }, next);
  const snaps = next.snapshots;
  // First snapshot renders as a baseline (before=—); else diff the two newest.
  const rows = snaps.length >= 2
    ? diffSnapshots(snaps.at(-2), snaps.at(-1))
    : diffSnapshots({ areas: [] }, snaps.at(-1));
  process.stdout.write(renderForOutput(rows) + '\n');
  process.stdout.write(saved.ok ? `\nsaved: ${saved.filePath}\n` : `\n저장 실패: ${saved.error}\n`);
}

// Run only as a CLI entry point; importing (tests) gets the exports untouched.
const isDirectRun = isMainEntry(import.meta.url);
if (isDirectRun) {
  runCli(process.argv).catch((err) => {
    process.stdout.write(`_scorecard 오류: ${String((err && err.message) || err)}_\n`);
  });
}
