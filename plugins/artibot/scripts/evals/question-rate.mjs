#!/usr/bin/env node
/**
 * question-rate - how often does the model ask the owner a question?
 * (V5-BACKLOG SH-09: "the point of this row is the effect on question
 * frequency, not the notation change".) READ ONLY.
 *
 * It parses the host's MAIN transcripts (`<projects-dir>/<slug>/*.jsonl`,
 * top level only - the per-session `subagents` folders are skipped on purpose)
 * one JSON line at a time and counts, per time window:
 *
 *   numerator    `tool_use` blocks whose `name` is exactly `AskUserQuestion`
 *                inside `assistant` entries, one per unique tool_use id
 *                (`asks.calls`; `asks.questions` sums the length of each
 *                call's `input.questions` array - a count, never the text).
 *   denominator  typed prompts (`prompts.typedBroad`): `user` entries that are
 *                not tool results, not meta, not harness-injected (task
 *                notifications, teammate/peer messages, local-command echoes,
 *                interrupt markers, scheduled fires, compaction summaries) and
 *                whose origin is absent or `human`. `typedStrict` keeps only
 *                entries the host explicitly labels `origin.kind = human`. The loosest
 *                denominator, `nonToolResultUserTurns` (every user entry that
 *                is not a tool result), is shown as well so the sensitivity of
 *                any reading to the denominator is visible.
 *                Also reported: sessions, assistant turns (unique message id),
 *                and `promptsWithAskShare` = typed prompts followed by at
 *                least one ask before the next typed prompt.
 *
 * It is a JSON parse, not a text search: the string `AskUserQuestion` also
 * sits in tool listings, skill text and tool results - a raw count of this
 * project's transcripts over-reports by an order of magnitude (see the
 * evidence document for the measured ratio).
 *
 * -- WINDOWS ---------------------------------------------------------------
 *  `--window <name>=<ISO-8601 with Z or offset>` (repeatable, strictly
 *  ascending) STARTS a window; the window before the first one is called
 *  `before-<first name>`. Bounds are start-inclusive / end-exclusive and an
 *  entry belongs to the window of ITS OWN timestamp. Without `--window` there
 *  is one window, `all`. The caller supplies boundaries: the plugin content a
 *  session sees is decided by what was INSTALLED, so pass install times
 *  (fall back to a release tag time and say so). This file knows no dates.
 *
 * -- WHAT IT WRITES --------------------------------------------------------
 *  Nothing but stdout. It opens files for reading only, creates no directory,
 *  and prints counts and allowlisted identifiers - never prompt text, question
 *  text, session ids or file names. `tests/evals/question-rate.test.js`
 *  asserts the byte-level no-touch property and the no-content property.
 *
 * -- EXIT CODES ------------------------------------------------------------
 *  0  a JSON document was printed (READ `ok`: no transcripts found => `ok:false`)
 *  1  unexpected internal error (message on stderr, stdout empty)
 *  2  usage error (stdout empty)
 *
 * -- WHAT THIS CANNOT SEE (also emitted as `blindSpots` in the output) -------
 *  See BLIND_SPOTS below. A rate read without its numerator, its interval and
 *  that list is a rate nobody should act on.
 *
 * @module scripts/evals/question-rate
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isMainEntry } from '../hooks/_main-entry.js';

export const SCHEMA = 'question-rate/1';
export const ASK_TOOL_NAME = 'AskUserQuestion';
export const DELEGATION_TOOLS = Object.freeze(['Agent', 'Task', 'TeamCreate', 'SendMessage']);
export const SPAWN_TOOLS = Object.freeze(['Agent', 'Task']);
export const ORCHESTRATION_COMMANDS = Object.freeze(['team', 'autopilot', 'split', 'orchestrate']);
export const TYPED_CLASSES = Object.freeze(['human_explicit', 'human_unlabeled', 'command']);
export const MODES = Object.freeze(['interactive', 'orchestrated', 'headless']);

/** Things the numbers cannot tell you. Emitted verbatim in the output. */
export const BLIND_SPOTS = Object.freeze([
  'Only AskUserQuestion tool_use blocks are counted. A question asked in plain assistant text is not counted, so a fall in this metric can coexist with an unchanged or higher real question rate.',
  'Main transcripts only (top-level jsonl files of the chosen directories). Sub-agent transcripts are excluded on purpose; their questions do not reach the owner directly.',
  'Retention: transcripts older than the host cleanup period are gone. input.oldestFileBirthtime and input.oldestEntryTimestamp show where the data starts; a window that begins before it is truncated, not empty.',
  'Windows are assigned by entry timestamp. The plugin content a session sees is largely fixed when it starts, so a session that straddles a boundary mixes both regimes (boundaries[].sessionsStraddling, sensitivity.bySessionStart).',
  'The typed-prompt denominator classifies transcript shapes (prompts.byClass). Harness-injected turns of an unknown shape count as human_unlabeled; typedStrict (origin.kind = human) is the conservative alternative.',
  'Task mix, owner permission mode and session length differ between windows and are not controlled here. byMode and the mix histograms only expose them.',
  'Counts are small. Read every rate with its numerator and ci95; overlapping intervals mean the data cannot separate the windows.',
  'This is an association over calendar windows, not the causal effect of any single change.',
  'Entries copied between files (resumed sessions) are counted once; input.duplicateEntriesSkipped reports how many copies were dropped.',
]);

const Z95 = 1.959964;
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const TAG_RE = /^\s*<([A-Za-z][A-Za-z0-9_:-]*)/;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const WINDOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const COMMAND_TAGS = new Set(['command-name', 'command-message', 'command-args']);
const LOCAL_TAGS = new Set([
  'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'bash-input', 'bash-stdout', 'bash-stderr',
]);
const SYSTEM_TAGS = new Set(['system-reminder', 'user-prompt-submit-hook']);

export const USAGE = `usage: node scripts/evals/question-rate.mjs [options]

  --dir <path>            transcript directory (repeatable); overrides slug lookup
  --slug <slug>           project directory name under the projects dir
  --cwd <path>            project root the slug is derived from (default: process cwd)
  --projects-dir <path>   default: <home>/.claude/projects
  --with-worktrees        also read sibling directories named <slug>--claude-worktrees-*
  --window <name>=<ISO>   start of a window (repeatable, ascending; ISO needs Z or an offset)
  --now <ISO>             measuredAt override (reproduction / tests)
  --help                  this text

Prints one JSON document on stdout. Writes nothing else.
`;

export class UsageError extends Error {}

/* ------------------------------------------------------------------ helpers */

const bump = (map, key, n = 1) => { map[key] = (map[key] ?? 0) + n; };
const hist = () => Object.create(null);
const round = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const hashText = (t) => createHash('sha1').update(t).digest('hex').slice(0, 16);

/** Histogram with keys in a stable order (null-prototype in, plain object out). */
function sortedHist(map) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Enumeration-like field value -> short identifier, or 'none' / 'other'. Never free text. */
function token(v) {
  if (v === undefined || v === null) return 'none';
  return typeof v === 'string' && TOKEN_RE.test(v) ? v : 'other';
}

function mean(xs) {
  return xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function median(xs) {
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : round((xs[mid - 1] + xs[mid]) / 2);
}

/** Directory name the host derives from a project root. */
export function slugForCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Score interval for a Poisson count `k` observed over `n` units, scaled `per`.
 * Behaves at k = 0 (lower bound 0, upper bound z^2 / n), unlike mean +/- 1.96*sqrt(k).
 *
 * @returns {[number, number]|null}
 */
export function poissonScoreInterval(k, n, per = 100) {
  if (!(n > 0)) return null;
  const c = (Z95 * Z95) / 2;
  const d = Z95 * Math.sqrt(k + (Z95 * Z95) / 4);
  const lo = k === 0 ? 0 : Math.max(0, k + c - d);
  return [round((lo / n) * per), round(((k + c + d) / n) * per)];
}

/** Wilson score interval for a proportion `k / n`. @returns {[number, number]|null} */
export function wilsonInterval(k, n) {
  if (!(n > 0)) return null;
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [round(Math.max(0, center - half)), round(Math.min(1, center + half))];
}

const ratio100 = (k, n) => ({
  calls: k, prompts: n, value: n > 0 ? round((k / n) * 100) : null, ci95: poissonScoreInterval(k, n, 100),
});
const share = (k, n) => ({ k, n, value: n > 0 ? round(k / n) : null, ci95: wilsonInterval(k, n) });

/* ------------------------------------------------------------------ windows */

/** @param {string} spec `<name>=<ISO>` @returns {{name: string, atMs: number}} */
export function parseWindowSpec(spec) {
  const m = /^([^=]+)=(.+)$/.exec(String(spec));
  if (m === null) throw new UsageError(`--window expects <name>=<ISO-8601 with Z or offset>: ${spec}`);
  const [, name, at] = m;
  if (!WINDOW_NAME_RE.test(name)) throw new UsageError(`bad window name: ${name}`);
  if (!ISO_RE.test(at)) throw new UsageError(`window time needs ISO-8601 with Z or an offset: ${at}`);
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new UsageError(`unparseable window time: ${at}`);
  return { name, atMs };
}

/**
 * @param {Array<{name: string, atMs: number}>} specs ascending window starts
 * @returns {Array<{name: string, startMs: number, endMs: number}>}
 */
export function buildWindows(specs) {
  if (specs.length === 0) return [{ name: 'all', startMs: -Infinity, endMs: Infinity }];
  const seen = new Set();
  specs.forEach((s, i) => {
    if (seen.has(s.name)) throw new UsageError(`duplicate window name: ${s.name}`);
    seen.add(s.name);
    if (i > 0 && !(s.atMs > specs[i - 1].atMs)) throw new UsageError('window times must be strictly ascending');
  });
  const windows = [{ name: `before-${specs[0].name}`, startMs: -Infinity, endMs: specs[0].atMs }];
  specs.forEach((s, i) => {
    windows.push({ name: s.name, startMs: s.atMs, endMs: i + 1 < specs.length ? specs[i + 1].atMs : Infinity });
  });
  return windows;
}

/** Start-inclusive / end-exclusive lookup. @returns {number} -1 when outside every window */
export function windowIndex(ms, windows) {
  for (let i = 0; i < windows.length; i += 1) {
    if (ms >= windows[i].startMs && ms < windows[i].endMs) return i;
  }
  return -1;
}

/* ----------------------------------------------------------- classification */

function entryText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

const onlyToolResults = (content) => Array.isArray(content) && content.length > 0
  && content.every((b) => b && b.type === 'tool_result');

function originKindOf(e) {
  const o = e.origin;
  return o && typeof o === 'object' && typeof o.kind === 'string' ? o.kind : null;
}

function classifyOrigin(kind) {
  if (kind === 'peer') return 'peer_message';
  if (kind === 'task-notification') return 'task_notification';
  if (kind === 'auto-continuation') return 'auto_continuation';
  return null;
}

/**
 * Class of a prompt-shaped text. Anything the host labels with a non-human
 * origin is never a typed prompt, and an origin kind this file does not know
 * fails closed to `other_origin`.
 *
 * @param {string|null} text
 * @param {string|null} originKind
 * @returns {string}
 */
export function classifyPromptText(text, originKind) {
  const byOrigin = classifyOrigin(originKind);
  if (byOrigin !== null) return byOrigin;
  if (typeof text !== 'string' || text.trim() === '') return 'other';
  const m = TAG_RE.exec(text);
  const tag = m === null ? null : m[1];
  if (tag === 'task-notification') return 'task_notification';
  if (tag === 'teammate-message') return 'peer_message';
  if (tag !== null && COMMAND_TAGS.has(tag)) return 'command';
  if (tag !== null && LOCAL_TAGS.has(tag)) return 'local_command';
  if (tag !== null && SYSTEM_TAGS.has(tag)) return 'meta';
  if (text.startsWith('[Request interrupted')) return 'interrupt';
  if (originKind !== null && originKind !== 'human') return 'other_origin';
  return originKind === 'human' ? 'human_explicit' : 'human_unlabeled';
}

/**
 * Class of one `user` transcript entry.
 * tool_result | compact_summary | meta | scheduled | task_notification |
 * peer_message | auto_continuation | command | local_command | interrupt |
 * other_origin | human_explicit | human_unlabeled | other
 *
 * @param {object} e
 * @returns {string}
 */
export function classifyUserEntry(e) {
  const content = e?.message?.content;
  if (onlyToolResults(content)) return 'tool_result';
  if (e.isCompactSummary === true) return 'compact_summary';
  if (e.isMeta === true || e.isVisibleInTranscriptOnly === true) return 'meta';
  if (e.scheduledTaskId !== undefined || e.scheduledFireId !== undefined) return 'scheduled';
  return classifyPromptText(entryText(content), originKindOf(e));
}

function commandNameOf(text) {
  const m = COMMAND_NAME_RE.exec(text);
  if (m === null) return 'other';
  const bare = m[1].split(':').pop().toLowerCase();
  return ORCHESTRATION_COMMANDS.includes(bare) ? bare : 'other';
}

/* ------------------------------------------------------------------ analysis */

function newState(windows) {
  return {
    windows,
    seenUuid: new Set(),
    seenMsgId: new Set(),
    seenAskId: new Set(),
    askIndex: new Map(),
    sessions: new Map(),
    sw: windows.map(() => new Map()),
    hist: windows.map(() => ({
      byClass: hist(), byOrigin: hist(), permissionMode: hist(), commandsByName: hist(),
      queuedByClass: hist(), queuedByMode: hist(),
    })),
    queued: { typedLike: 0, alsoUserEntry: 0 },
    input: {
      lines: 0, blankLines: 0, parseFailures: 0, unreadableFiles: 0,
      duplicateEntriesSkipped: 0, duplicateAskCallsSkipped: 0, sidechainEntriesSkipped: 0, undatedEntries: 0,
      oldestEntryMs: null, newestEntryMs: null,
    },
  };
}

function sessionOf(st, key) {
  let s = st.sessions.get(key);
  if (s === undefined) {
    s = {
      key, firstMs: null, minWi: null, maxWi: null, entrypoint: null,
      cur: null, typedHashes: new Set(), queued: [], totals: { typed: 0, calls: 0 },
    };
    st.sessions.set(key, s);
  }
  return s;
}

function countersOf(st, wi, key) {
  const m = st.sw[wi];
  let c = m.get(key);
  if (c === undefined) {
    c = {
      userEntries: 0, assistantTurns: 0, toolUses: 0, spawns: 0,
      typed: 0, typedStrict: 0, queuedOnly: 0,
      calls: 0, questions: 0, callsNoQ: 0, answered: 0, errored: 0, promptsWithAsk: 0, asksBeforePrompt: 0,
      orchCmd: false, delegation: false,
    };
    m.set(key, c);
  }
  return c;
}

/** Timestamp -> window bookkeeping for one counted entry. @returns {{ms: number, wi: number}|null} */
function stamp(st, s, e) {
  const ms = Date.parse(e.timestamp);
  if (!Number.isFinite(ms)) {
    st.input.undatedEntries += 1;
    return null;
  }
  const wi = windowIndex(ms, st.windows);
  const inp = st.input;
  if (inp.oldestEntryMs === null || ms < inp.oldestEntryMs) inp.oldestEntryMs = ms;
  if (inp.newestEntryMs === null || ms > inp.newestEntryMs) inp.newestEntryMs = ms;
  if (s.firstMs === null || ms < s.firstMs) s.firstMs = ms;
  s.minWi = s.minWi === null ? wi : Math.min(s.minWi, wi);
  s.maxWi = s.maxWi === null ? wi : Math.max(s.maxWi, wi);
  return { ms, wi };
}

function resolveAskResults(st, content) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    const a = st.askIndex.get(b.tool_use_id);
    if (a === undefined || a.resolved) continue;
    a.resolved = true;
    if (b.is_error === true) a.c.errored += 1;
    else a.c.answered += 1;
  }
}

function handleUser(st, s, e) {
  const at = stamp(st, s, e);
  if (at === null) return;
  const content = e.message?.content;
  const c = countersOf(st, at.wi, s.key);
  c.userEntries += 1;
  if (s.entrypoint === null) s.entrypoint = token(e.entrypoint);
  resolveAskResults(st, content);
  const cls = classifyUserEntry(e);
  const h = st.hist[at.wi];
  bump(h.byClass, cls);
  if (cls === 'tool_result') return;
  const originKind = originKindOf(e);
  bump(h.byOrigin, token(originKind));
  if (!TYPED_CLASSES.includes(cls)) return;
  const text = entryText(content) ?? '';
  c.typed += 1;
  s.totals.typed += 1;
  if (originKind === 'human') c.typedStrict += 1;
  bump(h.permissionMode, token(e.permissionMode));
  if (cls === 'command') {
    const name = commandNameOf(text);
    bump(h.commandsByName, name);
    if (name !== 'other') c.orchCmd = true;
  }
  s.typedHashes.add(hashText(text));
  s.cur = { c, asked: false };
}

function recordAsk(st, s, c, block) {
  if (typeof block.id === 'string') {
    if (st.seenAskId.has(block.id)) {
      st.input.duplicateAskCallsSkipped += 1;
      return;
    }
    st.seenAskId.add(block.id);
    st.askIndex.set(block.id, { c, resolved: false });
  }
  const questions = Array.isArray(block.input?.questions) ? block.input.questions.length : 0;
  c.calls += 1;
  s.totals.calls += 1;
  c.questions += questions;
  if (questions === 0) c.callsNoQ += 1;
  if (s.cur === null) c.asksBeforePrompt += 1;
  else if (!s.cur.asked) {
    s.cur.asked = true;
    s.cur.c.promptsWithAsk += 1;
  }
}

function handleAssistant(st, s, e) {
  const at = stamp(st, s, e);
  if (at === null) return;
  const c = countersOf(st, at.wi, s.key);
  const id = e.message?.id;
  if (typeof id !== 'string' || !st.seenMsgId.has(id)) {
    if (typeof id === 'string') st.seenMsgId.add(id);
    c.assistantTurns += 1;
  }
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    c.toolUses += 1;
    if (DELEGATION_TOOLS.includes(b.name)) c.delegation = true;
    if (SPAWN_TOOLS.includes(b.name)) c.spawns += 1;
    if (b.name === ASK_TOOL_NAME) recordAsk(st, s, c, b);
  }
}

/** Prompts typed while the model was busy arrive as `queued_command` attachments. */
function handleQueued(st, s, e) {
  const ms = Date.parse(e.timestamp);
  if (!Number.isFinite(ms)) {
    st.input.undatedEntries += 1;
    return;
  }
  const wi = windowIndex(ms, st.windows);
  const a = e.attachment;
  const text = entryText(a.prompt ?? a.content ?? a.text ?? null);
  const origin = a.origin ?? e.origin;
  const originKind = origin && typeof origin === 'object' && typeof origin.kind === 'string' ? origin.kind : null;
  const cls = text === null ? 'other' : classifyPromptText(text, originKind);
  bump(st.hist[wi].queuedByClass, cls);
  bump(st.hist[wi].queuedByMode, token(a.commandMode));
  if (TYPED_CLASSES.includes(cls)) s.queued.push({ wi, hash: hashText(text) });
}

/** A queued typed prompt that is also a user entry of the same session is not a second prompt. */
function finalizeQueued(st, s) {
  for (const q of s.queued) {
    st.queued.typedLike += 1;
    if (s.typedHashes.has(q.hash)) st.queued.alsoUserEntry += 1;
    else countersOf(st, q.wi, s.key).queuedOnly += 1;
  }
}

function processEntry(st, s, e) {
  if (e.isSidechain === true) {
    st.input.sidechainEntriesSkipped += 1;
    return;
  }
  if (typeof e.uuid === 'string') {
    if (st.seenUuid.has(e.uuid)) {
      st.input.duplicateEntriesSkipped += 1;
      return;
    }
    st.seenUuid.add(e.uuid);
  }
  if (e.type === 'user') handleUser(st, s, e);
  else if (e.type === 'assistant') handleAssistant(st, s, e);
  else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') handleQueued(st, s, e);
}

async function readFileInto(st, file) {
  const s = sessionOf(st, file.path);
  try {
    const rl = readline.createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      st.input.lines += 1;
      if (line.trim() === '') {
        st.input.blankLines += 1;
        continue;
      }
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        st.input.parseFailures += 1;
        continue;
      }
      if (e !== null && typeof e === 'object') processEntry(st, s, e);
    }
  } catch {
    st.input.unreadableFiles += 1;
  }
  finalizeQueued(st, s);
}

function modeOf(s, c) {
  if (s.entrypoint !== null && s.entrypoint !== 'cli') return 'headless';
  return c.orchCmd || c.delegation ? 'orchestrated' : 'interactive';
}

function summarizeWindow(st, w, wi) {
  const rows = [];
  for (const [key, c] of st.sw[wi]) {
    if (c.userEntries + c.assistantTurns > 0) rows.push({ s: st.sessions.get(key), c });
  }
  const sum = (f) => rows.reduce((t, r) => t + f(r.c), 0);
  const typed = sum((c) => c.typed);
  const strict = sum((c) => c.typedStrict);
  const queuedOnly = sum((c) => c.queuedOnly);
  const calls = sum((c) => c.calls);
  const questions = sum((c) => c.questions);
  const answered = sum((c) => c.answered);
  const errored = sum((c) => c.errored);
  const withAsk = sum((c) => c.promptsWithAsk);
  const turns = sum((c) => c.assistantTurns);
  const perSession = rows.map((r) => r.c.typed).sort((a, b) => a - b);
  const h = st.hist[wi];
  const nonToolResult = Object.entries(h.byClass).reduce((t, [k, n]) => (k === 'tool_result' ? t : t + n), 0);
  const byMode = Object.fromEntries(MODES.map((m) => [m, { sessions: 0, typedBroad: 0, calls: 0 }]));
  for (const r of rows) {
    const b = byMode[modeOf(r.s, r.c)];
    b.sessions += 1;
    b.typedBroad += r.c.typed;
    b.calls += r.c.calls;
  }
  for (const m of MODES) byMode[m].callsPer100TypedPrompts = ratio100(byMode[m].calls, byMode[m].typedBroad);
  const started = [...st.sessions.values()].filter((s) => s.firstMs !== null && windowIndex(s.firstMs, st.windows) === wi).length;
  return {
    name: w.name,
    startInclusive: iso(w.startMs),
    endExclusive: iso(w.endMs),
    sessions: {
      active: rows.length,
      started,
      withAsk: rows.filter((r) => r.c.calls > 0).length,
      withoutTypedPrompt: perSession.filter((n) => n === 0).length,
      typedPromptsPerSession: { mean: mean(perSession), median: median(perSession), max: perSession.length > 0 ? perSession[perSession.length - 1] : null },
    },
    prompts: {
      typedBroad: typed,
      typedStrict: strict,
      nonToolResultUserTurns: nonToolResult,
      queuedTypedNotInUserEntries: queuedOnly,
      byClass: sortedHist(h.byClass),
      byOrigin: sortedHist(h.byOrigin),
      typedByPermissionMode: sortedHist(h.permissionMode),
      commandsByName: sortedHist(h.commandsByName),
      queuedAttachments: { byClass: sortedHist(h.queuedByClass), byCommandMode: sortedHist(h.queuedByMode) },
    },
    turns: { assistantTurns: turns, toolUses: sum((c) => c.toolUses), agentSpawns: sum((c) => c.spawns) },
    asks: {
      calls,
      questions,
      callsWithoutQuestionsArray: sum((c) => c.callsNoQ),
      answered,
      errored,
      unresolved: calls - answered - errored,
      promptsWithAsk: withAsk,
      callsBeforeAnyTypedPrompt: sum((c) => c.asksBeforePrompt),
      maxCallsInOneSession: rows.reduce((mx, r) => Math.max(mx, r.c.calls), 0),
    },
    rates: {
      callsPer100TypedPrompts: ratio100(calls, typed),
      callsPer100TypedPromptsStrict: ratio100(calls, strict),
      callsPer100TypedPromptsPlusQueued: ratio100(calls, typed + queuedOnly),
      callsPer100NonToolResultUserTurns: ratio100(calls, nonToolResult),
      promptsWithAskShare: share(withAsk, typed),
      callsPerActiveSession: rows.length > 0 ? round(calls / rows.length) : null,
      callsPer1000AssistantTurns: turns > 0 ? round((calls / turns) * 1000) : null,
      questionsPerCall: calls > 0 ? round(questions / calls) : null,
    },
    byMode,
  };
}

function summarizeBoundaries(st) {
  const out = [];
  for (let j = 0; j + 1 < st.windows.length; j += 1) {
    let straddling = 0;
    for (const s of st.sessions.values()) {
      if (s.minWi !== null && s.minWi <= j && j < s.maxWi) straddling += 1;
    }
    out.push({ between: [st.windows[j].name, st.windows[j + 1].name], at: iso(st.windows[j].endMs), sessionsStraddling: straddling });
  }
  return out;
}

/** Same numbers with each session assigned wholesale to the window it STARTED in. */
function summarizeBySessionStart(st) {
  const acc = st.windows.map(() => ({ sessions: 0, typed: 0, calls: 0 }));
  for (const s of st.sessions.values()) {
    if (s.firstMs === null) continue;
    const a = acc[windowIndex(s.firstMs, st.windows)];
    a.sessions += 1;
    a.typed += s.totals.typed;
    a.calls += s.totals.calls;
  }
  return acc.map((a, wi) => ({
    name: st.windows[wi].name, sessions: a.sessions, typedBroad: a.typed, calls: a.calls, callsPer100TypedPrompts: ratio100(a.calls, a.typed),
  }));
}

/**
 * @param {object} p
 * @param {Array<{path: string, size: number, mtimeMs: number, birthtimeMs: number}>} p.files
 * @param {Array<{name: string, startMs: number, endMs: number}>} p.windows
 * @param {string} p.measuredAt
 * @param {string[]} [p.dirs]
 * @param {string[]} [p.missingDirs]
 * @returns {Promise<object>}
 */
export async function analyzeTranscripts({ files, windows, measuredAt, dirs = [], missingDirs = [] }) {
  const st = newState(windows);
  for (const f of files) await readFileInto(st, f);
  const births = files.map((f) => f.birthtimeMs).filter((x) => x > 0);
  return {
    schema: SCHEMA,
    ok: files.length > 0,
    reason: files.length > 0 ? null : 'no-transcripts',
    measuredAt,
    metric: {
      numerator: 'assistant tool_use blocks named AskUserQuestion, unique tool_use id (asks.calls); asks.questions = sum of input.questions lengths',
      denominators: 'typedBroad (primary) = user entries that are typed prompts or slash commands, origin absent or human; typedStrict = origin.kind human only; nonToolResultUserTurns = every user entry that is not a tool result (loosest); plusQueued adds typed prompts delivered as queued_command attachments and absent from user entries',
      windowRule: 'an entry belongs to the window of its own timestamp; start-inclusive, end-exclusive',
    },
    input: {
      dirs,
      missingDirs,
      files: files.length,
      bytes: files.reduce((t, f) => t + f.size, 0),
      oldestFileBirthtime: iso(births.length > 0 ? Math.min(...births) : NaN),
      oldestFileMtime: iso(files.length > 0 ? Math.min(...files.map((f) => f.mtimeMs)) : NaN),
      newestFileMtime: iso(files.length > 0 ? Math.max(...files.map((f) => f.mtimeMs)) : NaN),
      oldestEntryTimestamp: iso(st.input.oldestEntryMs ?? NaN),
      newestEntryTimestamp: iso(st.input.newestEntryMs ?? NaN),
      lines: st.input.lines,
      blankLines: st.input.blankLines,
      parseFailures: st.input.parseFailures,
      unreadableFiles: st.input.unreadableFiles,
      duplicateEntriesSkipped: st.input.duplicateEntriesSkipped,
      duplicateAskCallsSkipped: st.input.duplicateAskCallsSkipped,
      sidechainEntriesSkipped: st.input.sidechainEntriesSkipped,
      undatedEntries: st.input.undatedEntries,
      queuedTypedAttachments: { total: st.queued.typedLike, alsoUserEntry: st.queued.alsoUserEntry },
    },
    boundaries: summarizeBoundaries(st),
    windows: windows.map((w, wi) => summarizeWindow(st, w, wi)),
    sensitivity: { bySessionStart: summarizeBySessionStart(st) },
    blindSpots: [...BLIND_SPOTS],
  };
}

/* ------------------------------------------------------------------ files / CLI */

/**
 * Top-level `*.jsonl` files of each directory, oldest first (so that the first
 * copy of a duplicated entry is the original). Reads metadata only.
 *
 * @param {string[]} dirs
 * @returns {{files: Array<{path: string, size: number, mtimeMs: number, birthtimeMs: number}>, missingDirs: string[]}}
 */
export function collectFiles(dirs) {
  const files = [];
  const missingDirs = [];
  for (const dir of dirs) {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      missingDirs.push(dir);
      continue;
    }
    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const p = path.join(dir, ent.name);
      try {
        const s = statSync(p);
        files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs });
      } catch {
        missingDirs.push(p);
      }
    }
  }
  const age = (f) => (f.birthtimeMs > 0 ? f.birthtimeMs : f.mtimeMs);
  files.sort((a, b) => (age(a) - age(b)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, missingDirs };
}

/** @returns {object} parsed options; throws UsageError */
export function parseArgs(argv) {
  const o = { dirs: [], windows: [], slug: null, cwd: null, projectsDir: null, withWorktrees: false, now: null, help: false };
  const withValue = new Set(['--dir', '--window', '--slug', '--cwd', '--projects-dir', '--now']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--with-worktrees') o.withWorktrees = true;
    else if (withValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
      i += 1;
      if (a === '--dir') o.dirs.push(v);
      else if (a === '--window') o.windows.push(parseWindowSpec(v));
      else if (a === '--slug') o.slug = v;
      else if (a === '--cwd') o.cwd = v;
      else if (a === '--projects-dir') o.projectsDir = v;
      else o.now = v;
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  if (o.slug !== null && !SLUG_RE.test(o.slug)) throw new UsageError(`bad slug: ${o.slug}`);
  if (o.now !== null && (!ISO_RE.test(o.now) || !Number.isFinite(Date.parse(o.now)))) throw new UsageError(`bad --now: ${o.now}`);
  return o;
}

/** Transcript directories to read. Explicit --dir wins; otherwise <projects>/<slug> (+ worktree siblings). */
export function resolveDirs(o) {
  if (o.dirs.length > 0) return o.dirs.map((d) => path.resolve(d));
  const projects = o.projectsDir !== null ? path.resolve(o.projectsDir) : path.join(os.homedir(), '.claude', 'projects');
  const slug = o.slug ?? slugForCwd(o.cwd ?? process.cwd());
  const dirs = [path.join(projects, slug)];
  if (o.withWorktrees && existsSync(projects)) {
    for (const name of readdirSync(projects).sort()) {
      if (name.startsWith(`${slug}--claude-worktrees-`)) dirs.push(path.join(projects, name));
    }
  }
  return dirs;
}

/**
 * @param {string[]} argv
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`question-rate: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  let windows;
  try {
    windows = buildWindows(o.windows);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`question-rate: ${e.message}\n${USAGE}`);
    return 2;
  }
  const measuredAt = o.now !== null ? new Date(o.now).toISOString() : new Date().toISOString();
  const dirs = resolveDirs(o);
  const { files, missingDirs } = collectFiles(dirs);
  const result = await analyzeTranscripts({ files, windows, measuredAt, dirs, missingDirs });
  out(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`question-rate: internal error: ${String(e?.message ?? e)}\n`);
      process.exitCode = 1;
    },
  );
}
