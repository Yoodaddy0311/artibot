/**
 * Dream Collector (L3) — read-only input gathering (PRD-DREAMING §4.1).
 *
 * Collects consolidation inputs from the user-visible memory tree and adjacent
 * session artefacts WITHOUT mutating any of them:
 *   - `<memoryDir>/*.md`  → parsed memory records (via memory-md-adapter)
 *   - `MEMORY.md`         → index rows (for later regeneration)
 *   - `<projectDir>/.artibot/handoffs/*.md`, `SESSION-NOTES.md` → recent N
 *   - per-agent correction files (if a corrections dir is supplied)
 *
 * Each item carries provenance (`source` path + content `hash`). External
 * signals (corrections, session notes) are flagged `externalSignal: true` so
 * the distiller can use them to demote contradicted insights (§6 trap ②).
 *
 * Zero external deps. No network IO. Everything is injected for tests.
 *
 * @module lib/learning/memory/dream/collector
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { listFiles, readTextFile } from '../../../core/file.js';
import { readSessionCorpus } from '../../ledger/corpus.js';
import { createMemoryMdAdapter } from './memory-md-adapter.js';

const DEFAULT_RECENT = 10;
// Bound ledger ingestion: cap total entries pulled and per-session signal text
// so a long ambient ledger never bloats the consolidation input (PRD F-08 위험).
const LEDGER_MAX_ENTRIES = 200;
const LEDGER_TEXT_CAP = 4000;

/** @param {string} text */
function hash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/**
 * Read up to `limit` most-recently-modified `.md` files from a directory as
 * raw provenance-tagged items. Missing dir → empty. Read-only.
 *
 * @param {string} dir
 * @param {number} limit
 * @param {string} kind
 * @param {boolean} externalSignal
 * @returns {Promise<Array<object>>}
 */
async function readRecentDocs(dir, limit, kind, externalSignal) {
  const files = await listFiles(dir, '.md');
  // listFiles is name-ordered; take the tail as a cheap "recent" heuristic and
  // keep it deterministic (no fs.stat timestamps → reproducible in tests).
  const picked = files.slice(-Math.max(0, limit));
  const out = [];
  for (const full of picked) {
    const raw = await readTextFile(full);
    if (raw === null) continue;
    out.push({ kind, source: full, externalSignal, text: raw, hash: hash(raw) });
  }
  return out;
}

/**
 * Read a single optional file as a provenance item (e.g. SESSION-NOTES.md).
 * @param {string} filePath
 * @param {string} kind
 * @returns {Promise<object|null>}
 */
async function readOptionalFile(filePath, kind) {
  const raw = await readTextFile(filePath);
  if (raw === null) return null;
  return { kind, source: filePath, externalSignal: true, text: raw, hash: hash(raw) };
}

/**
 * Read the ambient ledger as provenance-tagged signals (one per session). Reuses
 * the denoised corpus reader (F-06 D1) — read-only, never throws. Each session's
 * conversation is flattened to `role: text` lines, capped at LEDGER_TEXT_CAP.
 * @param {string} projectDir
 * @returns {Promise<Array<object>>}
 */
async function readLedgerSignals(projectDir) {
  let corpus;
  try {
    corpus = await readSessionCorpus(projectDir, { limit: LEDGER_MAX_ENTRIES });
  } catch {
    return []; // defense-in-depth: readSessionCorpus is already never-throw
  }
  const bySession = new Map();
  for (const e of corpus.entries) {
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(`${e.role}: ${e.text}`);
  }
  const out = [];
  for (const [session, lines] of bySession) {
    const text = lines.join('\n').slice(0, LEDGER_TEXT_CAP);
    const source = path.join(projectDir, '.artibot', 'ledger', `${session}.jsonl`);
    out.push({ kind: 'ledger', source, externalSignal: true, text, hash: hash(text) });
  }
  return out;
}

/**
 * Create a collector bound to injected directories.
 *
 * @param {object} options
 * @param {string} options.memoryDir - User-visible memory dir (read-only).
 * @param {string} [options.projectDir] - Root holding `.artibot/`.
 * @param {string} [options.correctionsDir] - Per-agent correction files dir.
 * @param {number} [options.recent] - Max recent handoffs/corrections (default 10).
 * @returns {object} frozen collector
 */
export function createCollector(options = {}) {
  const memoryDir = options.memoryDir;
  if (!memoryDir) throw new Error('createCollector requires options.memoryDir');
  const projectDir = options.projectDir || null;
  const correctionsDir = options.correctionsDir || null;
  const recent = Number.isFinite(options.recent) && options.recent > 0
    ? Math.floor(options.recent) : DEFAULT_RECENT;
  const adapter = createMemoryMdAdapter({ memoryDir });

  /**
   * Gather all inputs read-only.
   * @returns {Promise<{memories: object[], indexRows: object[], signals: object[]}>}
   */
  async function collect() {
    const memories = await adapter.readAll();
    const indexRows = await adapter.readIndex();

    const signals = [];
    if (projectDir) {
      const handoffsDir = path.join(projectDir, '.artibot', 'handoffs');
      signals.push(...await readRecentDocs(handoffsDir, recent, 'handoff', true));
      const notes = await readOptionalFile(
        path.join(projectDir, '.artibot', 'SESSION-NOTES.md'), 'session-notes',
      );
      if (notes) signals.push(notes);
      signals.push(...await readLedgerSignals(projectDir));
    }
    if (correctionsDir) {
      signals.push(...await readRecentDocs(correctionsDir, recent, 'correction', true));
    }

    return Object.freeze({
      memories: Object.freeze(memories),
      indexRows: Object.freeze(indexRows),
      signals: Object.freeze(signals),
    });
  }

  return Object.freeze({
    get memoryDir() { return memoryDir; },
    get adapter() { return adapter; },
    collect,
  });
}
