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
import { createMemoryMdAdapter } from './memory-md-adapter.js';

const DEFAULT_RECENT = 10;

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
