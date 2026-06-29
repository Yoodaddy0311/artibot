/**
 * Ledger statistics (F-09 — surface ambient-capture metrics on `/learning`).
 *
 * Pure read-only aggregation over the project-local ledger directory
 * (`<projectRoot>/.artibot/ledger/`): how many sessions/lines were captured,
 * how many secrets were redacted, and how much corpus has flowed into the
 * learning review pipeline (consumed / pending). Feeds the `/learning`
 * dashboard's "Ledger (Ambient Capture)" section.
 *
 * DATA POLICY: local file reads only, no network, no mutation. Best-effort —
 * MUST NOT throw; a missing dir / unreadable file yields zeroed metrics.
 *
 * @module lib/learning/ledger/stats
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { _internals as storeInternals } from './store.js';
import { _internals as corpusInternals } from './corpus.js';
import { _internals as queueInternals } from './review-queue.js';

const { LEDGER_REL } = storeInternals;
const { CORPUS_CURSOR_FILE } = corpusInternals;
const { QUEUE_FILE } = queueInternals;

// Redaction tokens emitted by lib/learning/ledger/redact.js (auth/credentials/
// secrets/env scope): REDACTED_KEY|SECRET|TOKEN, PRIVATE_KEY, ENV_VAR,
// CONNECTION_STRING.
const REDACTION_TOKEN = /\[(?:REDACTED_[A-Z]+|PRIVATE_KEY|ENV_VAR|CONNECTION_STRING)\]/g;

const EMPTY = Object.freeze({
  sessions: 0, lines: 0, redactions: 0, bytes: 0, consumed: 0, pending: 0,
});

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Compute ledger capture / redaction / review-pipeline metrics.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ sessions: number, lines: number, redactions: number, bytes: number, consumed: number, pending: number }>}
 */
export async function computeLedgerStats(projectRoot) {
  if (!projectRoot) return { ...EMPTY };
  const dir = path.join(projectRoot, LEDGER_REL);

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { ...EMPTY };
  }

  const stats = { ...EMPTY };
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue; // cursor/queue dotfiles are .json, skipped
    let raw;
    try {
      raw = await readFile(path.join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    stats.sessions += 1;
    stats.bytes += Buffer.byteLength(raw, 'utf-8');
    stats.lines += raw.split('\n').filter((l) => l.trim() !== '').length;
    stats.redactions += (raw.match(REDACTION_TOKEN) || []).length;
  }

  const cursor = await readJson(path.join(dir, CORPUS_CURSOR_FILE));
  if (cursor && typeof cursor === 'object') {
    for (const v of Object.values(cursor)) {
      if (Number.isInteger(v) && v >= 0) stats.consumed += v;
    }
  }

  const queue = await readJson(path.join(dir, QUEUE_FILE));
  if (Array.isArray(queue?.items)) stats.pending = queue.items.length;

  return stats;
}
