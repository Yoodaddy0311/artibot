/**
 * Ambient Conversation Ledger — incremental append store + rotation.
 *
 * Persists denoised, secret-redacted conversation to a gitignored local store:
 *   <projectRoot>/.artibot/ledger/<safeSession>.jsonl  — per-session ledger
 *   <projectRoot>/.artibot/ledger/.cursor.json         — per-session watermark
 *
 * Design (PRD ADR-4): each turn appends only NEW conversation lines (line-count
 * watermark) — never rewrites the file. A safe reconcile path (dedup against
 * the existing ledger) covers the edge cases where the line-count cannot be
 * trusted: transcript tail-capped at 4 MB, or transcript shrank/rotated. The
 * SessionEnd `finalizeSession` always runs the authoritative dedup reconcile.
 *
 * DATA POLICY: local files only, no network. The directory is gitignored.
 * All public functions are best-effort and MUST NOT throw on I/O failure —
 * the hook that calls them must never block a session.
 *
 * @module lib/learning/ledger/store
 */

import { existsSync } from 'node:fs';
import {
  appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { slimLines } from './slim.js';
import { redactLines } from './redact.js';

const LEDGER_REL = path.join('.artibot', 'ledger');
const CURSOR_FILE = '.cursor.json';
// DoS guard: cap transcript read at 4 MB (mirrors stop-recap.js).
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_KEEP = 50;

/**
 * Resolve keep value from explicit option or `ARTIBOT_LEDGER_KEEP` env.
 * @param {number|undefined} explicit
 * @returns {number}
 */
function resolveKeep(explicit) {
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const raw = process.env.ARTIBOT_LEDGER_KEEP;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_KEEP;
}

/**
 * Sanitize a session id into a safe filename component (basename only,
 * reject path-traversal sentinels). Mirrors save_log.py:128-130.
 * @param {unknown} sessionId
 * @returns {string}
 */
export function safeSession(sessionId) {
  const base = path.basename(String(sessionId ?? ''));
  if (base === '' || base === '.' || base === '..') return 'session';
  return base;
}

function ledgerDir(projectRoot) {
  return path.join(projectRoot, LEDGER_REL);
}
function sessionFile(projectRoot, sessionId) {
  return path.join(ledgerDir(projectRoot), `${safeSession(sessionId)}.jsonl`);
}
function cursorPath(projectRoot) {
  return path.join(ledgerDir(projectRoot), CURSOR_FILE);
}

/**
 * Read the per-session watermark cursor map. Returns {} on any failure.
 * @param {string} projectRoot
 * @returns {Promise<Record<string, { lines: number, updatedAt?: string }>>}
 */
async function readCursor(projectRoot) {
  try {
    const obj = JSON.parse(await readFile(cursorPath(projectRoot), 'utf-8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Atomically write the cursor map (tmp + rename). Best-effort.
 * @param {string} projectRoot
 * @param {object} cursor
 */
async function writeCursor(projectRoot, cursor) {
  const file = cursorPath(projectRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(cursor), 'utf-8');
    await rename(tmp, file);
  } catch {
    try { await rm(tmp, { force: true }); } catch { /* noop */ }
  }
}

/**
 * Read transcript text, capping at the DoS bound (tail-sliced when over).
 * @param {string} transcriptPath
 * @returns {Promise<{ lines: string[], capped: boolean }>}
 */
async function readTranscriptLines(transcriptPath) {
  let raw = await readFile(transcriptPath, 'utf-8');
  let capped = false;
  if (raw.length > MAX_TRANSCRIPT_BYTES) {
    raw = raw.slice(-MAX_TRANSCRIPT_BYTES);
    capped = true;
  }
  return { lines: raw.split('\n'), capped };
}

/**
 * Read the existing ledger file's lines into a Set for dedup.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {Promise<Set<string>>}
 */
async function readLedgerSet(projectRoot, sessionId) {
  try {
    const raw = await readFile(sessionFile(projectRoot, sessionId), 'utf-8');
    return new Set(raw.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Append kept lines to the session ledger (creates dir/file as needed).
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {string[]} kept
 */
async function appendKept(projectRoot, sessionId, kept) {
  if (!kept.length) return;
  await mkdir(ledgerDir(projectRoot), { recursive: true });
  await appendFile(sessionFile(projectRoot, sessionId), `${kept.join('\n')}\n`, 'utf-8');
}

/**
 * Rotate session ledger files down to `keep` (newest by mtime kept). The
 * cursor file (.cursor.json) and non-.jsonl files are never rotation targets.
 * Best-effort: a locked/missing victim never fails the whole prune.
 * @param {string} projectRoot
 * @param {number} keep
 * @returns {Promise<{ removed: number }>}
 */
export async function rotateLedger(projectRoot, keep = resolveKeep()) {
  const dir = ledgerDir(projectRoot);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0 };
  }
  const records = [];
  for (const filename of entries) {
    if (!filename.endsWith('.jsonl')) continue;
    const full = path.join(dir, filename);
    try {
      const st = await stat(full);
      if (st.isFile()) records.push({ path: full, mtime: st.mtimeMs });
    } catch { /* race-disappear: skip */ }
  }
  if (records.length <= keep) return { removed: 0 };
  records.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const v of records.slice(keep)) {
    try { await unlink(v.path); removed += 1; } catch { /* best-effort */ }
  }
  return { removed };
}

/**
 * Compute the kept+redacted lines to append, plus the next cursor value.
 * Fast path: line-count watermark slice. Safe path (capped or shrunk): dedup
 * reconcile against the existing ledger.
 *
 * @param {string} projectRoot
 * @param {string} sid
 * @param {string[]} allLines
 * @param {boolean} capped
 * @param {boolean} forceReconcile
 * @returns {Promise<{ kept: string[], nextLines: number|null }>}
 */
async function computeAppend(projectRoot, sid, allLines, capped, forceReconcile) {
  const cursor = await readCursor(projectRoot);
  const prev = Number.isInteger(cursor[sid]?.lines) ? cursor[sid].lines : 0;
  // Only newline-terminated lines are "complete". split('\n') yields one more
  // element than there are newlines, so the final element (a trailing '' when
  // the file ends in '\n', or a partial in-progress line otherwise) is never a
  // complete record and must not be counted or consumed.
  const completeCount = Math.max(0, allLines.length - 1);
  const useReconcile = capped || forceReconcile || prev > completeCount;

  if (useReconcile) {
    const slimmed = redactLines(slimLines(allLines));
    const existing = await readLedgerSet(projectRoot, sid);
    const kept = slimmed.filter((l) => !existing.has(l));
    // When capped we cannot trust line counts; leave the cursor unchanged.
    const nextLines = capped ? null : completeCount;
    return { kept, nextLines };
  }

  const newLines = allLines.slice(prev, completeCount);
  const kept = redactLines(slimLines(newLines));
  return { kept, nextLines: completeCount };
}

/**
 * Capture one turn: append newly-added conversation (denoised + redacted) to
 * the session ledger. Best-effort, never throws.
 *
 * @param {{ projectRoot: string, sessionId: unknown, transcriptPath: string, now?: () => Date }} opts
 * @returns {Promise<{ appended: number, capped?: boolean, ok: boolean }>}
 */
export async function captureTurn(opts) {
  return runCapture(opts, false);
}

/**
 * Finalize at SessionEnd: authoritative dedup reconcile to catch anything the
 * incremental path missed. Best-effort, never throws.
 *
 * @param {{ projectRoot: string, sessionId: unknown, transcriptPath: string, now?: () => Date }} opts
 * @returns {Promise<{ appended: number, capped?: boolean, ok: boolean }>}
 */
export async function finalizeSession(opts) {
  return runCapture(opts, true);
}

/**
 * @param {{ projectRoot: string, sessionId: unknown, transcriptPath: string, now?: () => Date }} opts
 * @param {boolean} forceReconcile
 */
async function runCapture(opts, forceReconcile) {
  const { projectRoot, sessionId, transcriptPath, now = () => new Date() } = opts ?? {};
  if (!projectRoot || !transcriptPath || !existsSync(transcriptPath)) {
    return { appended: 0, ok: false };
  }
  try {
    const sid = safeSession(sessionId);
    const { lines: allLines, capped } = await readTranscriptLines(transcriptPath);
    const { kept, nextLines } = await computeAppend(
      projectRoot, sid, allLines, capped, forceReconcile,
    );
    await appendKept(projectRoot, sid, kept);

    if (nextLines !== null) {
      const cursor = await readCursor(projectRoot);
      cursor[sid] = { lines: nextLines, updatedAt: now().toISOString() };
      await writeCursor(projectRoot, cursor);
    }
    await rotateLedger(projectRoot, resolveKeep());
    return { appended: kept.length, capped, ok: true };
  } catch (err) {
    process.stderr.write(`[artibot:ledger-store] ${err?.message || 'capture failed'}\n`);
    return { appended: 0, ok: false };
  }
}

export const _internals = Object.freeze({
  LEDGER_REL, CURSOR_FILE, MAX_TRANSCRIPT_BYTES, DEFAULT_KEEP, resolveKeep,
  sessionFile, cursorPath,
});
