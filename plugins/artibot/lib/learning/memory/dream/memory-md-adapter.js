/**
 * Memory MD Adapter (Dreaming L3) — non-destructive read / serialize.
 *
 * Parses the user-visible auto-memory Markdown files
 * (`<memoryDir>/*.md`, frontmatter `metadata.{node_type, type, originSessionId}`
 * + body + `[[links]]`) and the `MEMORY.md` index (one line per memory:
 * `- [Title](file.md) — hook`). Provides round-trippable serialization and
 * index regeneration so consolidation can stage rewritten copies WITHOUT ever
 * touching the source files.
 *
 * Design contract (PRD-DREAMING §5, S1):
 *   - `memoryDir` is injected (episodic.js `options.storePath` pattern). Tests
 *     pass a temp fixture dir; nothing here ever resolves the real
 *     `~/.claude/projects/.../memory` on its own.
 *   - parse(read) is read-only. serialize(write) only ever targets the caller-
 *     supplied path — callers (the apply step) point it at staging/archive.
 *   - The index 1-line format and ordering are preserved on regeneration.
 *
 * Zero external deps. All writes are atomic. No network IO.
 *
 * @module lib/learning/memory/dream/memory-md-adapter
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  atomicWriteJson, // re-exported for symmetry; MD uses writeText below
  ensureDir,
  listFiles,
  readTextFile,
} from '../../../core/file.js';
import fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_FILE = 'MEMORY.md';
const INDEX_HEADER = '# Project Memory';
/** Index line: `- [Title](file.md) — hook` (em dash separator). */
const INDEX_LINE_RE = /^-\s*\[([^\]]*)\]\(([^)]+)\)\s*—\s*(.*)$/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const LINK_RE = /\[\[([^\]]+)\]\]/g;

// ---------------------------------------------------------------------------
// Pure helpers — frontmatter
// ---------------------------------------------------------------------------

/**
 * Parse the minimal YAML subset used by auto-memory frontmatter: top-level
 * `key: value` pairs plus a single nested `metadata:` block of `key: value`.
 * Deliberately tiny — no arrays/anchors — matching the harness writer format.
 *
 * @param {string} yaml
 * @returns {{front: object, metadata: object}}
 */
function parseFrontmatter(yaml) {
  const front = {};
  const metadata = {};
  let inMetadata = false;
  for (const rawLine of yaml.split('\n')) {
    if (!rawLine.trim()) continue;
    const indented = /^\s+\S/.test(rawLine);
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const key = rawLine.slice(0, colon).trim();
    const value = stripQuotes(rawLine.slice(colon + 1).trim());
    if (key === 'metadata' && value === '') {
      inMetadata = true;
      continue;
    }
    if (inMetadata && indented) {
      metadata[key] = value;
    } else {
      inMetadata = false;
      front[key] = value;
    }
  }
  return { front, metadata };
}

/** @param {string} v */
function stripQuotes(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Quote a YAML scalar only when it contains characters that need it. */
function yamlScalar(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  if (/[:#"']/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

/**
 * Serialize the frontmatter block back to the canonical layout the harness
 * emits: top-level keys first, then a `metadata:` block.
 *
 * @param {object} front
 * @param {object} metadata
 * @returns {string}
 */
function serializeFrontmatter(front, metadata) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(front)) {
    lines.push(`${k}: ${yamlScalar(v)}`);
  }
  const metaKeys = Object.keys(metadata || {});
  if (metaKeys.length) {
    lines.push('metadata:');
    for (const k of metaKeys) lines.push(`  ${k}: ${yamlScalar(metadata[k])}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Extract `[[link]]` slugs from a body, de-duplicated, order preserved. */
function extractLinks(body) {
  const out = [];
  const seen = new Set();
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body)) !== null) {
    const slug = m[1].trim();
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/** Stable content hash for provenance / unchanged-assertions. */
function hashContent(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Pure helpers — record parse/serialize
// ---------------------------------------------------------------------------

/**
 * Parse a single memory MD document into a structured record. Pure — caller
 * supplies the raw text and the file basename for provenance.
 *
 * @param {string} raw
 * @param {string} [file] - basename (e.g. `project_artibot.md`)
 * @returns {object} frozen record
 */
export function parseMemoryDoc(raw, file = '') {
  const text = String(raw ?? '');
  const fmMatch = text.match(FRONTMATTER_RE);
  const yaml = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  const { front, metadata } = parseFrontmatter(yaml);
  return Object.freeze({
    file,
    name: front.name || (file ? file.replace(/\.md$/, '') : ''),
    description: front.description || '',
    nodeType: metadata.node_type || '',
    type: metadata.type || '',
    originSessionId: metadata.originSessionId || '',
    front: Object.freeze({ ...front }),
    metadata: Object.freeze({ ...metadata }),
    body,
    links: Object.freeze(extractLinks(body)),
    hash: hashContent(text),
  });
}

/**
 * Serialize a record back to canonical MD text. Round-trips with
 * {@link parseMemoryDoc} for documents that originated from the harness writer.
 *
 * @param {object} record
 * @returns {string}
 */
export function serializeMemoryDoc(record) {
  const front = record.front && Object.keys(record.front).length
    ? { ...record.front }
    : pickFront(record);
  const metadata = record.metadata && Object.keys(record.metadata).length
    ? { ...record.metadata }
    : pickMetadata(record);
  const fm = serializeFrontmatter(front, metadata);
  const body = String(record.body ?? '');
  // Source docs carry a blank line between frontmatter and body.
  return `${fm}\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

/** Reconstruct a front block from flat fields when `front` was not supplied. */
function pickFront(record) {
  const front = {};
  if (record.name) front.name = record.name;
  if (record.description) front.description = record.description;
  return front;
}

/** Reconstruct a metadata block from flat fields when not supplied. */
function pickMetadata(record) {
  const metadata = {};
  if (record.nodeType) metadata.node_type = record.nodeType;
  if (record.type) metadata.type = record.type;
  if (record.originSessionId) metadata.originSessionId = record.originSessionId;
  return metadata;
}

// ---------------------------------------------------------------------------
// Pure helpers — MEMORY.md index
// ---------------------------------------------------------------------------

/**
 * Parse the MEMORY.md index into ordered `{title, file, hook}` rows. Lines
 * that don't match the canonical format are ignored (header / blanks).
 *
 * @param {string} raw
 * @returns {Array<{title: string, file: string, hook: string}>}
 */
export function parseIndex(raw) {
  const rows = [];
  for (const line of String(raw ?? '').split('\n')) {
    const m = line.match(INDEX_LINE_RE);
    if (m) rows.push({ title: m[1].trim(), file: m[2].trim(), hook: m[3].trim() });
  }
  return rows;
}

/**
 * Render index rows back to the canonical 1-line-per-memory format with the
 * `# Project Memory` header. Preserves caller-provided ordering.
 *
 * @param {Array<{title: string, file: string, hook: string}>} rows
 * @returns {string}
 */
export function serializeIndex(rows) {
  const lines = [INDEX_HEADER, ''];
  for (const r of rows) {
    lines.push(`- [${r.title}](${r.file}) — ${r.hook}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build the single canonical index line from a parsed memory record. Title
 * comes from the first `# ` heading in the body (falling back to `name`); the
 * hook is the `description`.
 *
 * @param {object} record
 * @returns {{title: string, file: string, hook: string}}
 */
export function indexRowFor(record) {
  const headingMatch = String(record.body ?? '').match(/^#{1,6}\s+(.+)$/m);
  const title = (headingMatch ? headingMatch[1].trim() : '') || record.name || record.file;
  return { title, file: record.file || `${record.name}.md`, hook: record.description || '' };
}

// ---------------------------------------------------------------------------
// Factory — directory-bound adapter
// ---------------------------------------------------------------------------

/**
 * Create an adapter bound to an injected memory directory.
 *
 * @param {object} options
 * @param {string} options.memoryDir - Source memory dir (read-only here).
 * @param {string} [options.stagingDir] - Where serialized proposals/copies go.
 * @returns {object} frozen adapter
 */
export function createMemoryMdAdapter(options = {}) {
  const memoryDir = options.memoryDir;
  if (!memoryDir) throw new Error('createMemoryMdAdapter requires options.memoryDir');
  const stagingDir = options.stagingDir || path.join(memoryDir, '.dream-staging');
  const indexPath = path.join(memoryDir, INDEX_FILE);

  /**
   * Read every `*.md` memory (excluding the index) into parsed records.
   * Read-only: never writes to memoryDir.
   * @returns {Promise<object[]>}
   */
  async function readAll() {
    const files = await listFiles(memoryDir, '.md');
    const records = [];
    for (const full of files) {
      const base = path.basename(full);
      if (base === INDEX_FILE) continue;
      const raw = await readTextFile(full);
      if (raw === null) continue;
      records.push({ ...parseMemoryDoc(raw, base), path: full });
    }
    return records;
  }

  /** Read + parse the MEMORY.md index rows (read-only). */
  async function readIndex() {
    const raw = await readTextFile(indexPath);
    return parseIndex(raw || '');
  }

  /**
   * Write a serialized memory doc to an arbitrary absolute path. Used by the
   * apply step to emit into staging/archive/active — NEVER defaulted at the
   * source file. Atomic via tmp+rename (mirrors core/file write semantics).
   * @param {string} targetPath
   * @param {string} text
   */
  async function writeDoc(targetPath, text) {
    await ensureDir(path.dirname(targetPath));
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, targetPath);
  }

  /**
   * Regenerate the MEMORY.md index from a set of active records, dropping rows
   * whose files disappeared (merge) and adding new ones. Returns the rendered
   * text WITHOUT writing — the apply step decides where it lands.
   *
   * @param {object[]} activeRecords
   * @param {{preserveOrderFrom?: Array<{file:string}>}} [opts]
   * @returns {string}
   */
  function regenerateIndex(activeRecords, opts = {}) {
    const rowByFile = new Map();
    for (const rec of activeRecords) {
      const row = indexRowFor(rec);
      rowByFile.set(row.file, row);
    }
    const ordered = [];
    const seen = new Set();
    // Keep prior order for surviving files first (stable index).
    for (const prior of opts.preserveOrderFrom || []) {
      if (rowByFile.has(prior.file) && !seen.has(prior.file)) {
        ordered.push(rowByFile.get(prior.file));
        seen.add(prior.file);
      }
    }
    // Append any new files not present in the prior index.
    for (const [file, row] of rowByFile.entries()) {
      if (!seen.has(file)) {
        ordered.push(row);
        seen.add(file);
      }
    }
    return serializeIndex(ordered);
  }

  return Object.freeze({
    get memoryDir() { return memoryDir; },
    get stagingDir() { return stagingDir; },
    get indexPath() { return indexPath; },
    readAll,
    readIndex,
    writeDoc,
    regenerateIndex,
  });
}

// Re-export atomicWriteJson so dream engines can import store writes from one
// place without reaching past the adapter into core (keeps L3→L1 single hop).
export { atomicWriteJson };
