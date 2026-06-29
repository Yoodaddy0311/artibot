/**
 * Denoised ledger corpus reader (F-06 D1 — learning-signal feedback).
 *
 * Exposes the already-denoised + secret-redacted conversation persisted by the
 * ambient ledger ({@link module:lib/learning/ledger/store}) as a learning input
 * corpus. This is the read side that F-06's review-gate (D2) consumes before any
 * learning promotion; it never feeds swarm directly (R2 enforcement = D3).
 *
 * Consumption watermark: a SEPARATE cursor file (`.corpus-cursor.json`) tracks
 * how many lines each session has been *consumed* into learning — distinct from
 * store's write watermark (`.cursor.json`) so the two never corrupt each other.
 * Reading never advances the watermark; only {@link markCorpusConsumed} does
 * (the review gate calls it on approval).
 *
 * DATA POLICY: local file reads only, no network, no ledger mutation. Every
 * public function is best-effort and MUST NOT throw — a missing dir / unreadable
 * file is a normal path that yields an empty corpus.
 *
 * @module lib/learning/ledger/corpus
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeHasText, contentText } from './slim.js';
import { safeSession, _internals as storeInternals } from './store.js';

const { LEDGER_REL } = storeInternals;
const CORPUS_CURSOR_FILE = '.corpus-cursor.json';

function ledgerDir(projectRoot) {
  return path.join(projectRoot, LEDGER_REL);
}
function corpusCursorPath(projectRoot) {
  return path.join(ledgerDir(projectRoot), CORPUS_CURSOR_FILE);
}

/**
 * Read the per-session consumption watermark map. Returns {} on any failure.
 * @param {string} projectRoot
 * @returns {Promise<Record<string, number>>}
 */
async function readCorpusCursor(projectRoot) {
  try {
    const obj = JSON.parse(await readFile(corpusCursorPath(projectRoot), 'utf-8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Atomically write the consumption watermark (tmp + rename). Best-effort.
 * @param {string} projectRoot
 * @param {Record<string, number>} cursor
 */
async function writeCorpusCursor(projectRoot, cursor) {
  const file = corpusCursorPath(projectRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(ledgerDir(projectRoot), { recursive: true });
    await writeFile(tmp, JSON.stringify(cursor), 'utf-8');
    await rename(tmp, file);
  } catch {
    try { await rm(tmp, { force: true }); } catch { /* noop */ }
  }
}

/**
 * List session ledger files (`*.jsonl`), oldest first by mtime. The cursor
 * files are excluded automatically (they do not end in `.jsonl`).
 * @param {string} projectRoot
 * @returns {Promise<Array<{ sid: string, file: string }>>}
 */
async function listSessionFiles(projectRoot) {
  let names;
  try {
    names = await readdir(ledgerDir(projectRoot));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(ledgerDir(projectRoot), name);
    try {
      const st = await stat(file);
      if (st.isFile()) records.push({ sid: name.slice(0, -'.jsonl'.length), file, mtime: st.mtimeMs });
    } catch { /* race-disappear: skip */ }
  }
  records.sort((a, b) => a.mtime - b.mtime);
  return records.map(({ sid, file }) => ({ sid, file }));
}

/**
 * Parse one session file into conversation entries, starting at `startIdx`
 * (consumption watermark). Returns the entries plus the total non-empty line
 * count (the next watermark position).
 * @param {string} sid
 * @param {string} raw
 * @param {number} startIdx
 * @returns {{ entries: Array<{session,role,text}>, total: number }}
 */
function parseSession(sid, raw, startIdx) {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  const entries = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // malformed line — skip but still counted by total
    }
    if (!claudeHasText(obj)) continue;
    entries.push({ session: sid, role: obj.type, text: contentText(obj.message.content) });
  }
  return { entries, total: lines.length };
}

/**
 * Read the denoised conversation corpus from the ledger.
 *
 * @param {string} projectRoot
 * @param {{ sessionId?: string, limit?: number, sinceCursor?: boolean }} [opts]
 * @returns {Promise<{ entries: Array<{ session: string, role: string, text: string }>, positions: Record<string, number> }>}
 */
export async function readSessionCorpus(projectRoot, opts) {
  const empty = { entries: [], positions: {} };
  if (!projectRoot) return empty;
  const { sessionId, limit, sinceCursor = false } = (opts && typeof opts === 'object') ? opts : {};

  try {
    let sessions = await listSessionFiles(projectRoot);
    if (sessionId !== undefined) {
      const sid = safeSession(sessionId);
      sessions = sessions.filter((s) => s.sid === sid);
    }
    const cursor = sinceCursor ? await readCorpusCursor(projectRoot) : {};

    let entries = [];
    const positions = {};
    for (const { sid, file } of sessions) {
      let raw;
      try {
        raw = await readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const startIdx = sinceCursor && Number.isInteger(cursor[sid]) ? cursor[sid] : 0;
      const { entries: e, total } = parseSession(sid, raw, startIdx);
      entries = entries.concat(e);
      positions[sid] = total;
    }

    if (Number.isInteger(limit) && limit >= 0 && entries.length > limit) {
      entries = entries.slice(-limit); // keep the most recent N
    }
    return { entries, positions };
  } catch {
    return empty;
  }
}

/**
 * Advance the consumption watermark — called by the review gate AFTER approval
 * so the same lines are not re-surfaced. Best-effort, never throws.
 *
 * @param {string} projectRoot
 * @param {Record<string, number>} positions - session → consumed line count.
 * @returns {Promise<{ ok: boolean }>}
 */
export async function markCorpusConsumed(projectRoot, positions) {
  if (!projectRoot || !positions || typeof positions !== 'object') return { ok: false };
  try {
    const cursor = await readCorpusCursor(projectRoot);
    for (const [sid, count] of Object.entries(positions)) {
      if (Number.isInteger(count) && count >= 0) {
        cursor[safeSession(sid)] = Math.max(cursor[safeSession(sid)] || 0, count);
      }
    }
    await writeCorpusCursor(projectRoot, cursor);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export const _internals = Object.freeze({ CORPUS_CURSOR_FILE, corpusCursorPath, listSessionFiles });
