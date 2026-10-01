/**
 * Task Budget helper — maps effort levels to max_tokens budgets per
 * `artibot.config.json#/runtime/effort/budgetMap` and produces the
 * directive string injected into the user prompt.
 *
 * Used by `scripts/hooks/runtime-prompt.js` to auto-wire budgets for
 * slash commands and by `/team` orchestrator for per-teammate prompts.
 *
 * @module lib/runtime/task-budget
 */

import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readJsonFileSync } from '../core/file.js';
import { getTokenizerCoeff } from '../core/model-catalog.js';
import {
  resolveScopedStatePath, resolveSessionReadChain, resolveSessionStatePath,
} from '../core/runtime-state.js';
import { isMainEntry } from '../../scripts/hooks/_main-entry.js';

const DEFAULT_BUDGET_MAP = Object.freeze({
  max: 200000,
  xhigh: 128000,
  high: 64000,
  medium: 32000,
  low: 16000,
});

const DEFAULT_BETA_HEADER = 'context-1m-2025-08-01';

/**
 * Minimum max_tokens budget the Task Budgets beta accepts for the `fable`
 * (Claude Fable 5) tier — mirrors the catalog constraint `task-budget-min-20k`.
 * Without this, `low` (16k) falls under the beta floor.
 */
const FABLE_MIN_BUDGET = 20000;

/**
 * Resolve the model tokenizer coefficient from `opts`. Precedence:
 *   1. explicit numeric `opts.tokenizerCoeff` (finite, > 0),
 *   2. else `opts.modelTier` via the catalog (lazy/guarded, never-throw),
 *   3. else 1.0.
 *
 * @param {{ tokenizerCoeff?: number, modelTier?: string }|null|undefined} opts
 * @returns {number} Coefficient (> 0); 1.0 on any invalid/missing input.
 */
function resolveTokenizerCoeff(opts) {
  const explicit = opts?.tokenizerCoeff;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const tier = opts?.modelTier;
  if (typeof tier === 'string' && tier) {
    try {
      const coeff = getTokenizerCoeff(tier);
      if (typeof coeff === 'number' && Number.isFinite(coeff) && coeff > 0) {
        return coeff;
      }
    } catch {
      return 1.0;
    }
  }
  return 1.0;
}

/**
 * Resolve max_tokens budget for a given effort level.
 *
 * The optional `overlay` is the L4 learned effort-policy overlay (P3). When it
 * carries a valid budget multiplier for `level` (a finite number in [0.5, 1.5]),
 * the base budget is multiplied by it and re-clamped to the map ceiling
 * (`budgetMap.max`) so a learned boost can never exceed the hard cap. Any
 * missing / zero / NaN / out-of-range multiplier is ignored, leaving the base
 * budget unchanged — overlay-absent behaviour is byte-identical to before.
 *
 * On top of the overlay, an optional `opts` applies the MODEL tokenizer
 * coefficient (`opts.tokenizerCoeff`, or `opts.modelTier` resolved via the
 * catalog) to the effort→budget output, reusing the same round-then-clamp
 * mechanism as the overlay multiplier so a coefficient can never exceed the
 * map ceiling. When `opts.modelTier === 'fable'`, the result is additionally
 * clamped UP to the Task Budgets beta floor (20k) so `low` is never rejected.
 * With `opts` absent the output is byte-identical to the overlay-only path.
 *
 * @param {'max'|'xhigh'|'high'|'medium'|'low'|string|null|undefined} effortLevel
 * @param {object} [config] - artibot.config.json object (optional).
 * @param {{ budgetMultipliers?: Record<string, number> }|null} [overlay] - learned overlay (optional).
 * @param {{ tokenizerCoeff?: number, modelTier?: string }|null} [opts] - model coefficient injection (optional).
 * @returns {number|null} Budget in tokens, or null if level is unknown.
 */
export function getTaskBudgetForEffort(effortLevel, config = {}, overlay = null, opts = null) {
  if (!effortLevel) return null;
  const level = String(effortLevel).toLowerCase();
  const map = config?.runtime?.effort?.budgetMap || DEFAULT_BUDGET_MAP;
  const value = map[level];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const ceiling = typeof map.max === 'number' && Number.isFinite(map.max) && map.max > 0
    ? map.max
    : DEFAULT_BUDGET_MAP.max;

  let budget = value;
  const mult = overlay?.budgetMultipliers?.[level];
  if (typeof mult === 'number' && Number.isFinite(mult) && mult >= 0.5 && mult <= 1.5) {
    budget = Math.min(Math.round(budget * mult), ceiling);
  }

  // Apply the model tokenizer coefficient through the same round+ceiling clamp.
  const coeff = resolveTokenizerCoeff(opts);
  if (coeff !== 1.0) {
    budget = Math.min(Math.round(budget * coeff), ceiling);
  }

  // fable: Task Budgets beta floor — clamp UP so low (16k) is never rejected.
  if (opts?.modelTier === 'fable' && budget < FABLE_MIN_BUDGET) {
    budget = Math.min(FABLE_MIN_BUDGET, ceiling);
  }

  return budget;
}

/**
 * Build the task budget directive string for prompt injection.
 *
 * Output format (single line):
 *   [artibot:task-budget max_tokens=N]
 *   [artibot:task-budget max_tokens=N anthropic-beta=context-1m-2025-08-01]
 *
 * The beta header is appended only when long-context is enabled in config.
 *
 * @param {'max'|'xhigh'|'high'|'medium'|'low'|string|null|undefined} effortLevel
 * @param {number|null} budget
 * @param {object} [config] - artibot.config.json object (optional).
 * @returns {string} Directive string (empty when inputs are invalid).
 */
export function buildTaskBudgetDirective(effortLevel, budget, config = {}) {
  if (!effortLevel || typeof budget !== 'number' || budget <= 0) return '';

  const longContext = config?.runtime?.longContext || {};
  const betaEnabled = longContext.enabled === true;
  const betaHeader = longContext.betaHeader || DEFAULT_BETA_HEADER;

  const segments = [`max_tokens=${budget}`];
  if (betaEnabled) {
    segments.push(`anthropic-beta=${betaHeader}`);
  }
  return `[artibot:task-budget ${segments.join(' ')}]`;
}

/** SESSION-scoped file names (see `lib/core/runtime-state.js`). */
const EFFORT_FILE = 'current-effort.json';
const TASK_BUDGET_FILE = 'current-task-budget.json';

/**
 * Persist the current task budget context for downstream consumers
 * (statusline, team orchestrator, observability).
 *
 * O2: written to `<state dir>/runtime/sessions/<session_id>/current-task-budget.json`
 * — one per session, so two sessions no longer overwrite one slot — or, when the
 * caller has no session id, to the flat `<state dir>/runtime/current-task-budget.json`.
 * The state dir is `resolveArtibotDir()` (`~/.claude/artibot`), NOT `pluginRoot`, which
 * in a marketplace install is a version-scoped cache directory that is replaced on
 * update. `pluginRoot` is still required (a caller with no plugin root gets null, as
 * before) but no longer decides where the file lands.
 *
 * @param {{ command?: string|null, effort?: string|null, budget?: number|null }} meta
 * @param {string} pluginRoot
 * @param {{ sessionId?: string|null }} [opts]
 * @returns {string|null} Absolute path to the written file, or null on failure.
 */
export function persistTaskBudget(meta, pluginRoot, opts = {}) {
  if (!meta || typeof pluginRoot !== 'string' || !pluginRoot) return null;
  const { command = null, effort = null, budget = null } = meta;
  if (!effort || typeof budget !== 'number' || budget <= 0) return null;

  try {
    const filePath = resolveScopedStatePath(opts?.sessionId, TASK_BUDGET_FILE);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
      command,
      effort,
      budget,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(filePath, JSON.stringify(payload) + '\n');
    return filePath;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Effort records (F05, relocated by O2) — identity + expiry on the effort hand-off
//
// F05 found `current-effort.json` was ONE file shared by every session under one
// plugin root: two concurrent sessions overwrote each other's record, and a record
// left by an earlier prompt was indistinguishable from the current one — so the
// reader could hand a stale or foreign command/budget to a task. It added identity
// (`sessionId`, `promptId`) and an expiry (`expiresAt`) to the record and gated the
// read on both.
//
// O2 removed the shared slot itself. The record now lives at
// `<state dir>/runtime/sessions/<session_id>/current-effort.json`
// (`lib/core/runtime-state.js`), one per session, in a directory that survives
// plugin updates — the F05 gate stays, because a session can still find a record
// that has expired or names another prompt. The flat
// `<state dir>/runtime/current-effort.json` is written only when the payload has no
// session id, and is read back only by a reader that ALSO has no session id (as is
// `<pluginRoot>/runtime/`, where hooks before O2 wrote): a reader that knows its
// session reads its own file and nothing else, so it can never be handed a flat record
// that belongs to somebody else. The display consumers `lib/tui/dashboard.js` and
// `scripts/hooks/statusline.sh` follow the same rule and still name the file, which
// `tests/firewall/effort-record-expiry.test.js` pins. `commands/team.md` does NOT
// read it as a decision input — it uses {@link readEffortSnapshot} via the CLI
// below; the path survives there only as prose about that display copy, pinned by
// `tests/firewall/constitution-stage-a-commands.test.js`.
//
// The per-session `runtime/effort/<sid>.json` directory and its GC are gone: a
// session directory holds at most five small files and is swept by age
// (`runtime-state.js#sweepSessionDirs`).
// ---------------------------------------------------------------------------

/** How long an effort record stays honourable after it is written. */
export const EFFORT_RECORD_TTL_MS = 10 * 60 * 1000;

/**
 * @param {number|Date|undefined|null} now
 * @returns {number} epoch ms; `Date.now()` when no usable clock was injected.
 */
function toEpochMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime();
  return Date.now();
}

/**
 * @param {unknown} value
 * @returns {string|null} trimmed non-empty string, else null.
 */
function trimmedOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Build the effort record payload. Pure — no I/O, no ambient clock when `now`
 * is injected.
 *
 * @param {object} meta - `{ command, effort, baseline, shift, reason }`
 * @param {{ sessionId?: string|null, promptId?: string|null, now?: number|Date, ttlMs?: number }} [opts]
 * @returns {object} meta plus `sessionId`, `promptId`, `updatedAt`, `expiresAt`.
 */
export function buildEffortRecord(meta, opts = {}) {
  const nowMs = toEpochMs(opts.now);
  const ttlMs = typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? opts.ttlMs
    : EFFORT_RECORD_TTL_MS;
  return {
    ...meta,
    sessionId: trimmedOrNull(opts.sessionId),
    promptId: trimmedOrNull(opts.promptId),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

/**
 * Persist the effort record — to the session's own file when the session is
 * identifiable, to the flat file otherwise. Never throws.
 *
 * `pluginRoot` is required (a caller with none gets the empty result, as before) but
 * does not decide where the record lands: that is the STATE dir
 * (`runtime-state.js#resolveScopedStatePath`), which survives plugin updates.
 *
 * `meta === null` writes nothing and does NOT delete a stale file — that is
 * today's behaviour in `scripts/hooks/runtime-prompt.js#persistEffortMeta` and
 * deleting would be a separate behaviour change. Staleness is handled by the
 * expiry gate in {@link readEffortRecord} instead.
 *
 * @param {object|null} meta
 * @param {string} pluginRoot
 * @param {{ sessionId?: string|null, promptId?: string|null, now?: number|Date, ttlMs?: number }} [opts]
 * @returns {{ legacyPath: string|null, sessionPath: string|null }} `sessionPath`: the
 *   per-session file written; `legacyPath`: the flat file written, which is only
 *   written when there is no usable session id (hence never both).
 */
export function persistEffortRecord(meta, pluginRoot, opts = {}) {
  const result = { legacyPath: null, sessionPath: null };
  if (!meta || typeof pluginRoot !== 'string' || !pluginRoot) return result;

  const record = buildEffortRecord(meta, opts);
  const sessionPath = resolveSessionStatePath(record.sessionId, EFFORT_FILE);
  const target = sessionPath ?? resolveScopedStatePath(null, EFFORT_FILE);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(record) + '\n');
    if (sessionPath) result.sessionPath = target;
    else result.legacyPath = target;
  } catch {
    // Non-critical: effort metadata is advisory.
  }
  return result;
}

/**
 * @param {string} filePath
 * @returns {object|null} parsed record, or null when missing/unreadable/not an object.
 */
function readRecordFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A record is expired only when it carries a PARSEABLE `expiresAt` at or before
 * `nowMs`. A record without the key (every pre-F05 fixture) is never expired.
 *
 * @param {object} record
 * @param {number} nowMs
 * @returns {boolean}
 */
function isExpiredRecord(record, nowMs) {
  const ts = Date.parse(record.expiresAt);
  return Number.isFinite(ts) && ts <= nowMs;
}

/**
 * Identity conflict = both sides name an id and they differ. A record with no
 * identity is honoured by any reader (legacy compatibility); a reader with no
 * identity honours any record (the middleware often has no `prompt_id`).
 *
 * @param {object} record
 * @param {string|null} sessionId
 * @param {string|null} promptId
 * @returns {boolean}
 */
function conflictsWithIdentity(record, sessionId, promptId) {
  const recordSession = trimmedOrNull(record.sessionId);
  if (recordSession && sessionId && recordSession !== sessionId) return true;
  const recordPrompt = trimmedOrNull(record.promptId);
  return Boolean(recordPrompt && promptId && recordPrompt !== promptId);
}

function acceptsRecord(record, nowMs, sessionId, promptId) {
  return !isExpiredRecord(record, nowMs) && !conflictsWithIdentity(record, sessionId, promptId);
}

/**
 * @param {string[]} paths - candidate record files, best first.
 * @returns {object|null} the first one that parses to a record.
 */
function readFirstRecord(paths) {
  for (const filePath of paths) {
    const record = readRecordFile(filePath);
    if (record) return record;
  }
  return null;
}

/**
 * Read the effort record for this reader's identity. The GATE: a record is
 * refused when it has expired, when it names a different session, or when it
 * names a different prompt.
 *
 * Lookup: a reader that knows its session reads THAT session's file and nothing else —
 * no fall-through to a flat record, whether the session file is missing or refused. A
 * flat record belongs to no session in particular, and handing it to a session is the
 * cross-session overwrite this gate exists to stop. Only a reader with NO session id
 * takes the FLAT files — the state dir's, then `<pluginRoot>/runtime/`, where hooks
 * wrote before O2 (the same file on the install.sh layout) — through the same gate.
 *
 * `pluginRoot` names only the LEGACY location; the session and state-dir paths come
 * from `runtime-state.js` and do not depend on it.
 *
 * @param {string} pluginRoot
 * @param {{ sessionId?: string|null, promptId?: string|null, now?: number|Date }} [opts]
 * @returns {object|null}
 */
export function readEffortRecord(pluginRoot, opts = {}) {
  if (typeof pluginRoot !== 'string' || !pluginRoot) return null;
  const nowMs = toEpochMs(opts.now);
  const sessionId = trimmedOrNull(opts.sessionId);
  const promptId = trimmedOrNull(opts.promptId);

  const candidates = resolveSessionReadChain(sessionId, EFFORT_FILE, { pluginRoot });
  const record = readFirstRecord(candidates);
  if (!record) return null;
  return acceptsRecord(record, nowMs, sessionId, promptId) ? record : null;
}

/**
 * The effort hand-off as ONE snapshot: the record {@link readEffortRecord}
 * accepted for this reader, plus the budget RECOMPUTED from that record's
 * effort with {@link getTaskBudgetForEffort}.
 *
 * R2b: the budget is deliberately NOT read from `current-task-budget.json`.
 * Before O2 that file was a single slot every session under a plugin root
 * overwrote, with no identity, so pairing it with a gated effort handed session A
 * its own `max` with session B's `low` budget. It is per-session now, but it is
 * still a slot without identity or expiry (and the flat fallback is still shared),
 * so recomputing from the accepted effort remains what makes the two halves share
 * one identity gate by construction. The file is still WRITTEN
 * (`persistTaskBudget`) for the dashboard and statusline, which display it; it is
 * not a decision input.
 *
 * `config` must be the config the writer used, so the recomputed number equals
 * the one `scripts/hooks/runtime-prompt.js` injected into the prompt. Overlay and
 * tokenizer opts are not applied because that writer applies neither.
 *
 * @param {string} pluginRoot
 * @param {{ sessionId?: string|null, promptId?: string|null, now?: number|Date }} [opts]
 * @param {object} [config] - artibot.config.json object (optional).
 * @returns {{ effort: string|null, command: string|null, shift: number|null,
 *   reason: string|null, taskBudget: number|null }|null} null when no record is accepted.
 */
export function readEffortSnapshot(pluginRoot, opts = {}, config = {}) {
  const record = readEffortRecord(pluginRoot, opts);
  if (!record) return null;
  const effort = record.effort || null;
  return {
    effort,
    command: record.command || null,
    shift: typeof record.shift === 'number' ? record.shift : null,
    reason: record.reason || null,
    taskBudget: getTaskBudgetForEffort(effort, config),
  };
}

// ---------------------------------------------------------------------------
// CLI — the reader for prose consumers (`commands/team.md`), so a command file
// takes effort + budget from the same gate as the tasks middleware instead of
// reading the two shared runtime files by hand.
//
//   node <pluginRoot>/lib/runtime/task-budget.js snapshot --session <id> [--prompt <id>]
//
// stdout: one line, the {@link readEffortSnapshot} JSON or `null`. Always exits
// 0 — the hand-off is advisory and a caller must treat `null` as "no effort".
// A missing, empty or blank `--session` answers `null` without reading.
// `--plugin-root <dir>` overrides the plugin root (default: this file's plugin).
// The config is read exactly as `middleware/tasks.js#readTeamGateInputs` reads
// it, so the CLI and the middleware recompute the same budget.
// ---------------------------------------------------------------------------

const SNAPSHOT_FLAGS = Object.freeze({
  '--session': 'sessionId',
  '--prompt': 'promptId',
  '--plugin-root': 'pluginRoot',
});

/**
 * @param {string[]} args - argv AFTER the subcommand.
 * @returns {{ sessionId: string|null, promptId: string|null, pluginRoot: string|null }}
 */
function parseSnapshotArgs(args) {
  const parsed = { sessionId: null, promptId: null, pluginRoot: null };
  for (let i = 0; i < args.length; i += 1) {
    const key = SNAPSHOT_FLAGS[args[i]];
    if (key && i + 1 < args.length) {
      parsed[key] = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

/**
 * @param {string[]} args - CLI arguments without the node binary and script path.
 * @returns {string} the stdout line (without the trailing newline).
 */
export function runSnapshotCli(args) {
  try {
    if (args[0] !== 'snapshot') return 'null';
    const parsed = parseSnapshotArgs(args.slice(1));
    // Fail-closed: a reader with no session id is honoured by ANY legacy record,
    // so an unset `$CLAUDE_CODE_SESSION_ID` would return another session's
    // effort. The library keeps its legacy contract; this new surface does not.
    if (!trimmedOrNull(parsed.sessionId)) return 'null';
    const pluginRoot = parsed.pluginRoot
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const config = readJsonFileSync(path.join(pluginRoot, 'artibot.config.json')) || {};
    const snapshot = readEffortSnapshot(pluginRoot, {
      sessionId: parsed.sessionId,
      promptId: parsed.promptId,
    }, config);
    return JSON.stringify(snapshot);
  } catch {
    return 'null';
  }
}

if (isMainEntry(import.meta.url)) {
  process.stdout.write(`${runSnapshotCli(process.argv.slice(2))}\n`);
}
