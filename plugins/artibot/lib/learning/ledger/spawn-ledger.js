/**
 * Subagent Spawn Ledger — append-only NDJSON audit of teammate fan-out.
 *
 * The ambient conversation ledger records user/assistant turns only; it never
 * sees `tool_use`, so counting how many subagents a session spawned (and on
 * which model) meant walking `~/.claude/projects/<sid>/*.jsonl` by hand, and
 * the model policy (impl tier vs review tier) had no audit surface at all.
 * This store closes that gap from the SubagentStart/SubagentStop hook:
 *
 *   <projectRoot>/.artibot/ledger/spawns.ndjson   — one record per line
 *
 * The directory is the same gitignored tree the ambient ledger uses
 * (`lib/learning/ledger/store.js#LEDGER_REL`), so existing rotation/ignore
 * rules cover it. `.ndjson` (not `.jsonl`) keeps it out of the ambient
 * ledger's per-session rotation sweep, which only targets `*.jsonl`.
 *
 * Record shape (one line):
 *   { ts, sessionId, agentId, agentName, agentType, requestedModel,
 *     canonicalModel, modelMismatch, event: 'start'|'stop', durationMs? }
 *
 * `requestedModel` is whatever the spawn payload carried (a model id or a
 * tier alias — caller-owned). `canonicalModel` is the value returned by
 * `lib/core/model-policy.js#resolveModel`, i.e. the effective policy TIER
 * (`opus`, `fable`, …), not a model id; map through
 * `lib/core/model-catalog.js#MODELS` when an id is needed. Same value the
 * hook stores in `artibot-state.json#agents[id].canonicalModel`.
 *
 * DATA POLICY: local file only, no network. Every string field is passed
 * through the ledger's secret scrubber BEFORE serialization, so a redaction
 * can never break the JSON framing of the line (scrubbing a serialized line
 * would let a pattern swallow the closing quote).
 * All public functions are best-effort and MUST NOT throw — the hook that
 * calls them must never block a spawn.
 *
 * @module lib/learning/ledger/spawn-ledger
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.js';

/**
 * Ledger directory relative to the project root. Mirrors
 * `store.js#LEDGER_REL` (asserted equal by the spawn-ledger test) so the
 * ambient ledger and the spawn ledger always share one tree.
 * @type {string}
 */
export const LEDGER_REL = path.join('.artibot', 'ledger');

/** @type {string} */
export const SPAWN_FILE = 'spawns.ndjson';

/** @type {readonly string[]} */
export const SPAWN_EVENTS = Object.freeze(['start', 'stop']);

/**
 * Absolute path of the spawn ledger for a project root.
 * @param {string} projectRoot
 * @returns {string}
 */
export function spawnLedgerPath(projectRoot) {
  return path.join(projectRoot, LEDGER_REL, SPAWN_FILE);
}

/**
 * Coerce an arbitrary value to a string field or null.
 * @param {unknown} v
 * @returns {string|null}
 */
function strOrNull(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * String field with secrets scrubbed (or null). Applied per field, never to
 * the serialized line — see the module header.
 * @param {unknown} v
 * @returns {string|null}
 */
function scrubbed(v) {
  const s = strOrNull(v);
  return s === null ? null : redactSecrets(s);
}

/**
 * Normalize a caller-supplied record into the canonical line shape. Unknown
 * keys are dropped; missing keys become null so every line has the same
 * columns and downstream readers never branch on `undefined`.
 *
 * @param {object} record
 * @param {() => Date} now
 * @returns {object|null} Canonical record, or null when `event` is invalid
 */
function normalizeRecord(record, now) {
  const r = record && typeof record === 'object' ? record : {};
  const event = SPAWN_EVENTS.includes(r.event) ? r.event : null;
  if (!event) return null;
  const out = {
    ts: strOrNull(r.ts) ?? now().toISOString(),
    sessionId: scrubbed(r.sessionId),
    agentId: scrubbed(r.agentId),
    agentName: scrubbed(r.agentName),
    agentType: scrubbed(r.agentType),
    requestedModel: scrubbed(r.requestedModel),
    canonicalModel: scrubbed(r.canonicalModel),
    modelMismatch: r.modelMismatch === true,
    event,
  };
  if (Number.isFinite(r.durationMs) && r.durationMs >= 0) {
    out.durationMs = Math.round(r.durationMs);
  }
  return out;
}

/**
 * Append one spawn record to `<projectRoot>/.artibot/ledger/spawns.ndjson`.
 * Creates the directory on first use. Synchronous so a short-lived hook
 * process cannot exit before the line lands. Never throws.
 *
 * @param {string} projectRoot absolute project root
 * @param {object} record see module header for the shape
 * @param {{ now?: () => Date }} [opts]
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function appendSpawn(projectRoot, record, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ok: false, reason: 'no-project-root' };
  }
  const canonical = normalizeRecord(record, now);
  if (!canonical) return { ok: false, reason: 'invalid-event' };
  try {
    const file = spawnLedgerPath(projectRoot);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(canonical)}\n`, 'utf-8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, reason: err?.code || err?.message || 'append-failed' };
  }
}

/**
 * Parse one NDJSON line; null for blank, corrupt, or non-object lines.
 * @param {string} line
 * @returns {object|null}
 */
function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Read spawn records, tolerating corrupt lines (skipped, never thrown).
 *
 * @param {string} projectRoot
 * @param {{ since?: string|number|Date, sessionId?: string }} [filter]
 *   `since` — keep records whose `ts` is at or after this instant;
 *   `sessionId` — keep records for one session only.
 * @returns {object[]} Records in file order; `[]` when the file is missing
 */
export function readSpawns(projectRoot, filter = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];
  const file = spawnLedgerPath(projectRoot);
  let raw;
  try {
    if (!existsSync(file)) return [];
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const sinceMs = filter.since === undefined ? null : new Date(filter.since).getTime();
  const sid = strOrNull(filter.sessionId);
  const out = [];
  for (const line of raw.split('\n')) {
    const rec = parseLine(line);
    if (!rec) continue;
    if (sid && rec.sessionId !== sid) continue;
    if (Number.isFinite(sinceMs) && !(Date.parse(rec.ts) >= sinceMs)) continue;
    out.push(rec);
  }
  return out;
}

/**
 * Pure roll-up of spawn records for audits (fan-out probe, model-policy).
 * Only `start` events count as spawns; `stop` events contribute nothing to
 * the counts but still advance `lastTs`.
 *
 * @param {object[]} records
 * @returns {{
 *   total: number,
 *   bySession: Record<string, { count: number, byModel: Record<string, number> }>,
 *   lastTs: string|null,
 * }}
 */
export function summarizeSpawns(records) {
  const list = Array.isArray(records) ? records : [];
  const bySession = {};
  let total = 0;
  let lastTs = null;
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const ts = strOrNull(rec.ts);
    if (ts && (lastTs === null || ts > lastTs)) lastTs = ts;
    if (rec.event !== 'start') continue;
    const sid = strOrNull(rec.sessionId) ?? 'unknown';
    const model = strOrNull(rec.canonicalModel) ?? strOrNull(rec.requestedModel) ?? 'unknown';
    const bucket = bySession[sid] ?? { count: 0, byModel: {} };
    bySession[sid] = {
      count: bucket.count + 1,
      byModel: { ...bucket.byModel, [model]: (bucket.byModel[model] ?? 0) + 1 },
    };
    total += 1;
  }
  return { total, bySession, lastTs };
}
