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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { getTokenizerCoeff } from '../core/model-catalog.js';

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

/**
 * Persist the current task budget context for downstream consumers
 * (statusline, team orchestrator, observability).
 *
 * @param {{ command?: string|null, effort?: string|null, budget?: number|null }} meta
 * @param {string} pluginRoot
 * @returns {string|null} Absolute path to the written file, or null on failure.
 */
export function persistTaskBudget(meta, pluginRoot) {
  if (!meta || typeof pluginRoot !== 'string' || !pluginRoot) return null;
  const { command = null, effort = null, budget = null } = meta;
  if (!effort || typeof budget !== 'number' || budget <= 0) return null;

  try {
    const runtimeDir = path.join(pluginRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const filePath = path.join(runtimeDir, 'current-task-budget.json');
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
// Effort records (F05) — identity + expiry on the effort hand-off
//
// `runtime/current-effort.json` is a SINGLE file shared by every session under
// one plugin root. Two concurrent sessions overwrite each other's record, and a
// record left by an earlier prompt is indistinguishable from the current one —
// so the reader could hand a stale or foreign command/budget to a task.
//
// The fix adds identity (`sessionId`, `promptId`) and an expiry (`expiresAt`) to
// the record, plus a per-session file at `runtime/effort/<sid>.json`. The legacy
// file is STILL written on every persist with the same payload, because three
// consumers read it by literal path: `lib/tui/dashboard.js`,
// `scripts/hooks/statusline.sh`, and the `commands/team.md` prose pinned by
// `tests/firewall/constitution-stage-a-commands.test.js`.
// ---------------------------------------------------------------------------

/** How long an effort record stays honourable after it is written. */
export const EFFORT_RECORD_TTL_MS = 10 * 60 * 1000;

/** How many per-session records survive a GC pass (newest by mtime). */
export const EFFORT_RECORD_KEEP = 32;

/** Directory under `runtime/` holding the per-session records. */
export const EFFORT_RECORDS_DIRNAME = 'effort';

/**
 * Reduce a session id to characters that cannot leave the records directory.
 *
 * The rule is COPIED from `lib/observability/decision-events.js#sanitizeRunId`
 * rather than imported: L5 runtime must not depend on the observability module
 * for a four-line string function, and the charset is the contract here.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeEffortRecordId(raw) {
  return String(raw)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
}

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
 * Persist the effort record to BOTH the legacy shared file and (when a session
 * id is known) the per-session file. Never throws.
 *
 * `meta === null` writes nothing and does NOT delete a stale file — that is
 * today's behaviour in `scripts/hooks/runtime-prompt.js#persistEffortMeta` and
 * deleting would be a separate behaviour change. Staleness is handled by the
 * expiry gate in {@link readEffortRecord} instead.
 *
 * @param {object|null} meta
 * @param {string} pluginRoot
 * @param {{ sessionId?: string|null, promptId?: string|null, now?: number|Date, ttlMs?: number, keep?: number }} [opts]
 * @returns {{ legacyPath: string|null, sessionPath: string|null }}
 */
export function persistEffortRecord(meta, pluginRoot, opts = {}) {
  const result = { legacyPath: null, sessionPath: null };
  if (!meta || typeof pluginRoot !== 'string' || !pluginRoot) return result;

  const record = buildEffortRecord(meta, opts);
  const line = JSON.stringify(record) + '\n';
  const runtimeDir = path.join(pluginRoot, 'runtime');

  try {
    mkdirSync(runtimeDir, { recursive: true });
    const legacyPath = path.join(runtimeDir, 'current-effort.json');
    writeFileSync(legacyPath, line);
    result.legacyPath = legacyPath;
  } catch {
    // Non-critical: effort metadata is advisory.
  }

  const sid = record.sessionId ? sanitizeEffortRecordId(record.sessionId) : '';
  if (!sid) return result;

  const recordsDir = path.join(runtimeDir, EFFORT_RECORDS_DIRNAME);
  try {
    mkdirSync(recordsDir, { recursive: true });
    const sessionPath = path.join(recordsDir, `${sid}.json`);
    writeFileSync(sessionPath, line);
    result.sessionPath = sessionPath;
  } catch {
    // Non-critical: the legacy file above is still the hand-off of record.
  }
  gcEffortRecords(recordsDir, { now: opts.now, keep: opts.keep });
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

/**
 * @param {object} record
 * @returns {boolean} true when the record names neither a session nor a prompt.
 */
function hasNoIdentity(record) {
  return !trimmedOrNull(record.sessionId) && !trimmedOrNull(record.promptId);
}

function acceptsRecord(record, nowMs, sessionId, promptId) {
  return !isExpiredRecord(record, nowMs) && !conflictsWithIdentity(record, sessionId, promptId);
}

/**
 * Read the effort record for this reader's identity. The GATE: a record is
 * refused when it has expired, when it names a different session, or when it
 * names a different prompt.
 *
 * Lookup order: the per-session file first (when a session id is known), then
 * the legacy shared file. A REFUSED session file does not fall through to a
 * legacy file that names a different session — that fall-through is the
 * cross-session overwrite this gate exists to stop. It falls through only to a
 * legacy file with no identity at all, which is how pre-F05 writers left it.
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
  const runtimeDir = path.join(pluginRoot, 'runtime');
  const legacyPath = path.join(runtimeDir, 'current-effort.json');

  const sid = sessionId ? sanitizeEffortRecordId(sessionId) : '';
  if (sid) {
    const sessionRecord = readRecordFile(path.join(runtimeDir, EFFORT_RECORDS_DIRNAME, `${sid}.json`));
    if (sessionRecord) {
      if (acceptsRecord(sessionRecord, nowMs, sessionId, promptId)) return sessionRecord;
      const legacy = readRecordFile(legacyPath);
      return legacy && hasNoIdentity(legacy) && !isExpiredRecord(legacy, nowMs) ? legacy : null;
    }
  }

  const legacy = readRecordFile(legacyPath);
  if (!legacy) return null;
  return acceptsRecord(legacy, nowMs, sessionId, promptId) ? legacy : null;
}

/**
 * @param {string} filePath
 * @returns {boolean} true when the file is gone after the call.
 */
function removeRecordFile(filePath) {
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect the per-session records, deleting the expired ones as it goes.
 *
 * @param {string} dir
 * @param {number} nowMs
 * @returns {{ survivors: Array<{ filePath: string, mtimeMs: number }>, removed: number }}
 */
function sweepExpiredRecords(dir, nowMs) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { survivors: [], removed: 0 };
  }
  const survivors = [];
  let removed = 0;
  for (const name of names) {
    const filePath = path.join(dir, name);
    let mtimeMs;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const record = readRecordFile(filePath);
    if (record && isExpiredRecord(record, nowMs)) {
      if (removeRecordFile(filePath)) removed += 1;
      continue;
    }
    survivors.push({ filePath, mtimeMs });
  }
  return { survivors, removed };
}

/**
 * Garbage-collect the per-session records directory: expired first, then the
 * oldest by mtime beyond `keep`. Never throws; a missing directory is a no-op.
 *
 * @param {string} dir
 * @param {{ now?: number|Date, keep?: number }} [opts]
 * @returns {{ removed: number, kept: number }}
 */
export function gcEffortRecords(dir, opts = {}) {
  if (typeof dir !== 'string' || !dir) return { removed: 0, kept: 0 };
  const nowMs = toEpochMs(opts.now);
  const keep = Number.isInteger(opts.keep) && opts.keep >= 0 ? opts.keep : EFFORT_RECORD_KEEP;

  const { survivors, removed } = sweepExpiredRecords(dir, nowMs);
  survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let overflowRemoved = 0;
  for (const entry of survivors.slice(keep)) {
    if (removeRecordFile(entry.filePath)) overflowRemoved += 1;
  }
  return { removed: removed + overflowRemoved, kept: survivors.length - overflowRemoved };
}
