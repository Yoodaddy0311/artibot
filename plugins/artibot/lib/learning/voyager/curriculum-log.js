/**
 * Voyager Curriculum Log — append-only JSONL event trail.
 *
 * Records proposal / approval / rejection events for Voyager-style skill
 * curation. Pure local storage. Deterministic — every append is a single
 * line with monotonic ISO timestamps; reads never mutate.
 *
 * Storage: `plugins/artibot/runtime/voyager-curriculum.jsonl` by default.
 *
 * @module lib/learning/voyager/curriculum-log
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REL_PATH = path.join('runtime', 'voyager-curriculum.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveLogPath(options) {
  if (typeof options?.logPath === 'string' && options.logPath.length > 0) {
    return options.logPath;
  }
  if (typeof options?.pluginRoot === 'string' && options.pluginRoot.length > 0) {
    return path.join(options.pluginRoot, DEFAULT_REL_PATH);
  }
  return DEFAULT_REL_PATH;
}

async function appendLine(logPath, record) {
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(logPath, line, 'utf-8');
}

function nowIso(now) {
  const ts = typeof now === 'function' ? now() : Date.now();
  return new Date(ts).toISOString();
}

function validateBaseArgs(hash, extras = {}) {
  if (!hash || typeof hash !== 'string') {
    return { ok: false, reason: 'invalid-hash' };
  }
  for (const [k, v] of Object.entries(extras)) {
    if (v === null || v === undefined) return { ok: false, reason: `missing-${k}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Writers — one function per event kind
// ---------------------------------------------------------------------------

/**
 * Record a new proposal event.
 * @param {string} hash - Cluster signature (not the file name).
 * @param {object} cluster - Scored cluster snapshot (subset persisted).
 * @param {number} score
 * @param {{logPath?: string, pluginRoot?: string, now?: () => number}} [options]
 * @returns {Promise<{logged: boolean, reason?: string}>}
 */
export async function logProposal(hash, cluster, score, options = {}) {
  const validation = validateBaseArgs(hash, { cluster });
  if (!validation.ok) return { logged: false, reason: validation.reason };
  const record = {
    kind: 'proposal',
    signature: hash,
    at: nowIso(options.now),
    score: typeof score === 'number' ? Number(score.toFixed(3)) : null,
    occurrence: Number(cluster?.occurrence ?? cluster?.frames?.length ?? 0),
    distinctSessions: Number(cluster?.distinctSessions ?? 0),
    exampleIntent: String(cluster?.exampleIntent ?? '').slice(0, 240),
    tools: Array.isArray(cluster?.toolUnion) ? cluster.toolUnion.slice(0, 20) : [],
  };
  await appendLine(resolveLogPath(options), record);
  return { logged: true };
}

/**
 * Record an approval event.
 * @param {string} hash
 * @param {{skillName?: string, targetFile?: string}} outcome
 * @param {object} [options]
 * @returns {Promise<{logged: boolean, reason?: string}>}
 */
export async function logApproval(hash, outcome, options = {}) {
  const validation = validateBaseArgs(hash);
  if (!validation.ok) return { logged: false, reason: validation.reason };
  const record = {
    kind: 'approval',
    signature: hash,
    at: nowIso(options.now),
    skillName: outcome?.skillName ? String(outcome.skillName).slice(0, 80) : null,
    targetFile: outcome?.targetFile ? String(outcome.targetFile).slice(0, 400) : null,
  };
  await appendLine(resolveLogPath(options), record);
  return { logged: true };
}

/**
 * Record a rejection event.
 * @param {string} hash
 * @param {string} reason
 * @param {object} [options]
 * @returns {Promise<{logged: boolean, reason?: string}>}
 */
export async function logRejection(hash, reason, options = {}) {
  const validation = validateBaseArgs(hash);
  if (!validation.ok) return { logged: false, reason: validation.reason };
  const record = {
    kind: 'rejection',
    signature: hash,
    at: nowIso(options.now),
    reason: String(reason || '').slice(0, 240),
  };
  await appendLine(resolveLogPath(options), record);
  return { logged: true };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async function readAllLines(logPath) {
  try {
    const raw = await fs.readFile(logPath, 'utf-8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseLines(lines) {
  const records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && rec.kind && rec.signature) {
        records.push(rec);
      }
    } catch { /* skip malformed */ }
  }
  return records;
}

/**
 * Summarize events in a time window.
 *
 * @param {{since?: number|string|Date, pluginRoot?: string, logPath?: string, now?: () => number}} [options]
 * @returns {Promise<{proposals: number, approvals: number, rejections: number, approvalRate: number, records: object[]}>}
 */
export async function summary(options = {}) {
  const logPath = resolveLogPath(options);
  const lines = await readAllLines(logPath);
  const records = parseLines(lines);
  const sinceTs = resolveSince(options.since, options.now);
  const inWindow = sinceTs === null
    ? records
    : records.filter((r) => Date.parse(r.at) >= sinceTs);
  const proposals = inWindow.filter((r) => r.kind === 'proposal').length;
  const approvals = inWindow.filter((r) => r.kind === 'approval').length;
  const rejections = inWindow.filter((r) => r.kind === 'rejection').length;
  const decided = approvals + rejections;
  const approvalRate = decided === 0 ? 0 : Number((approvals / decided).toFixed(3));
  return {
    proposals,
    approvals,
    rejections,
    approvalRate,
    records: Object.freeze(inWindow.slice()),
  };
}

function resolveSince(since, nowFn) {
  if (since instanceof Date) return since.getTime();
  if (typeof since === 'number' && Number.isFinite(since)) {
    // Interpret small positive ints as "days back" unless clearly an epoch ms.
    if (since < 10_000) {
      const now = typeof nowFn === 'function' ? nowFn() : Date.now();
      return now - since * DAY_MS;
    }
    return since;
  }
  if (typeof since === 'string') {
    const parsed = Date.parse(since);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const _internals = Object.freeze({
  resolveLogPath,
  resolveSince,
  DEFAULT_REL_PATH,
});
