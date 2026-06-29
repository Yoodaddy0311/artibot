/**
 * Ledger learning review queue (F-06 D2 — human review gate).
 *
 * The privacy-sensitive promotion path chosen for F-06 (PRD §11, 2026-06-26):
 * ledger corpus is staged into a review queue AUTOMATICALLY, but nothing is
 * promoted into the learning store until a human approves it. Mirrors the
 * `/dreaming` stage → report → apply gate (lib/learning/memory/dream).
 *
 *   enqueueFromCorpus  → reads NEW corpus (D1, sinceCursor) → queue + watermark↑
 *   listPending / renderReviewReport → the human gate surface
 *   approve(ids|all)   → collectExperience promotion → dequeue
 *   reject(ids|all)    → dequeue WITHOUT promotion
 *
 * Queue file: `<projectRoot>/.artibot/ledger/.review-queue.json` (gitignored
 * with the rest of the ledger dir). All public functions are best-effort and
 * MUST NOT throw — DATA POLICY: local files only, no network.
 *
 * @module lib/learning/ledger/review-queue
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _internals as storeInternals } from './store.js';
import { markCorpusConsumed, readSessionCorpus } from './corpus.js';
import { collectExperience } from '../lifelong-learner.js';

const { LEDGER_REL } = storeInternals;
const QUEUE_FILE = '.review-queue.json';

function queuePath(projectRoot) {
  return path.join(projectRoot, LEDGER_REL, QUEUE_FILE);
}

/** Tiny deterministic hash (djb2) — stable item ids without external deps. */
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function itemId(entry) {
  return `${entry.session}#${hash(`${entry.role}\n${entry.text}`)}`;
}

async function readQueue(projectRoot) {
  try {
    const obj = JSON.parse(await readFile(queuePath(projectRoot), 'utf-8'));
    return Array.isArray(obj?.items) ? obj.items : [];
  } catch {
    return [];
  }
}

async function writeQueue(projectRoot, items) {
  const file = queuePath(projectRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify({ items }), 'utf-8');
    await rename(tmp, file);
    return true;
  } catch {
    try { await rm(tmp, { force: true }); } catch { /* noop */ }
    return false;
  }
}

/**
 * Map a queue item to a `collectExperience`-shaped record. Conversation signal
 * is promoted as a 'success' experience under the 'ledger-corpus' category so
 * the existing GRPO pattern-analyzer can group/score it.
 * @param {{ session: string, role: string, text: string }} item
 * @returns {object}
 */
export function toExperience(item) {
  return {
    type: 'success',
    category: 'ledger-corpus',
    data: { role: item.role, text: item.text, session: item.session },
    sessionId: item.session,
  };
}

/**
 * Stage NEW ledger corpus into the review queue and advance the corpus
 * consumption watermark (so the same lines are not re-staged). Auto step — no
 * promotion happens here.
 * @param {string} projectRoot
 * @param {{ sessionId?: string, limit?: number }} [opts]
 * @returns {Promise<{ staged: number }>}
 */
export async function enqueueFromCorpus(projectRoot, opts = {}) {
  if (!projectRoot) return { staged: 0 };
  try {
    const { entries, positions } = await readSessionCorpus(projectRoot, { ...opts, sinceCursor: true });
    if (!entries.length) return { staged: 0 };

    const queue = await readQueue(projectRoot);
    const seen = new Set(queue.map((i) => i.id));
    const staged = [];
    for (const e of entries) {
      const id = itemId(e);
      if (seen.has(id)) continue;
      seen.add(id);
      staged.push({ id, session: e.session, role: e.role, text: e.text });
    }
    await writeQueue(projectRoot, queue.concat(staged));
    await markCorpusConsumed(projectRoot, positions);
    return { staged: staged.length };
  } catch {
    return { staged: 0 };
  }
}

/**
 * List the items currently awaiting review.
 * @param {string} projectRoot
 * @returns {Promise<Array<{ id, session, role, text }>>}
 */
export async function listPending(projectRoot) {
  if (!projectRoot) return [];
  return readQueue(projectRoot);
}

/**
 * Render a human-readable review report for the gate.
 * @param {Array<{ id, session, role, text }>} items
 * @returns {string}
 */
export function renderReviewReport(items) {
  if (!Array.isArray(items) || items.length === 0) return '검토 대기 항목 없음.';
  const lines = items.map((it) => {
    const preview = String(it.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return `- [${it.id}] (${it.session} · ${it.role}) ${preview}`;
  });
  return `검토 대기 ${items.length}건:\n${lines.join('\n')}`;
}

/** Resolve which queue items a {ids?|all?} selector targets. */
function select(items, selector) {
  if (selector?.all) return items;
  const ids = new Set(Array.isArray(selector?.ids) ? selector.ids : []);
  return items.filter((i) => ids.has(i.id));
}

/**
 * Approve items: promote each via `promote` (default = collectExperience
 * adapter) then dequeue them. Best-effort, never throws.
 * @param {string} projectRoot
 * @param {{ ids?: string[], all?: boolean }} selector
 * @param {{ promote?: (item) => unknown }} [deps]
 * @returns {Promise<{ promoted: number, remaining: number }>}
 */
export async function approve(projectRoot, selector, deps = {}) {
  if (!projectRoot) return { promoted: 0, remaining: 0 };
  const promote = typeof deps.promote === 'function'
    ? deps.promote
    : (item) => collectExperience(toExperience(item));
  try {
    const queue = await readQueue(projectRoot);
    const targets = select(queue, selector);
    // Track the ACTUALLY-promoted ids — a mid-list failure must keep exactly the
    // failed item queued, not whichever item shares its position.
    const promotedIds = new Set();
    for (const item of targets) {
      try { await promote(item); promotedIds.add(item.id); } catch { /* keep failed item queued */ }
    }
    const remaining = queue.filter((i) => !promotedIds.has(i.id));
    await writeQueue(projectRoot, remaining);
    return { promoted: promotedIds.size, remaining: remaining.length };
  } catch {
    return { promoted: 0, remaining: 0 };
  }
}

/**
 * Reject items: dequeue WITHOUT promotion. Best-effort, never throws.
 * @param {string} projectRoot
 * @param {{ ids?: string[], all?: boolean }} selector
 * @returns {Promise<{ removed: number, remaining: number }>}
 */
export async function reject(projectRoot, selector) {
  if (!projectRoot) return { removed: 0, remaining: 0 };
  try {
    const queue = await readQueue(projectRoot);
    const drop = new Set(select(queue, selector).map((i) => i.id));
    const remaining = queue.filter((i) => !drop.has(i.id));
    await writeQueue(projectRoot, remaining);
    return { removed: queue.length - remaining.length, remaining: remaining.length };
  } catch {
    return { removed: 0, remaining: 0 };
  }
}

export const _internals = Object.freeze({ QUEUE_FILE, queuePath, itemId, hash });
