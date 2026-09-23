/**
 * `lib/verification/evidence-registry.js` — the E-nnn evidence registry.
 *
 * One JSON line per distinct piece of evidence:
 *
 *   { "id": "E-001", "type": "command", "source": "<who registered it>",
 *     "hash": "<sha256 of the entry>", "created_at": "<ISO time>" }
 *
 * ── Where it lives ───────────────────────────────────────────────────────────
 * Beside the run ledger, through the same rule:
 * `lib/project-state/store-location.js#resolveStoreLocation` puts it at
 * `<git-common-dir>/artibot/evidence.jsonl`, and at
 * `<projectRoot>/.artibot/runtime/evidence.jsonl` when no git common dir
 * resolves. Using the shared rule is what lets every `/split` worktree of one
 * repository mint ids from ONE sequence. A per-worktree file would hand out
 * E-001 once per window.
 *
 * ── The hash is the identity, and the row holds nothing else ────────────────
 * `evidenceHash` covers a canonical serialization of the whole entry (keys
 * sorted at every depth), so the same evidence in another key order is the same
 * evidence. The row stores the hash, not the entry. A command's `output` can
 * carry anything the command printed, and copying it here would give it a
 * second, unredacted home. Anyone holding the entry can recompute the hash and
 * find its id.
 *
 * A hash hides nothing that can be GUESSED. Hash an entry holding a secret, and
 * anyone who can guess the secret can confirm it by hashing a candidate and
 * matching the row. That holds even when every other copy of the entry was
 * redacted. So this module hashes exactly what it is handed, and the CALLER
 * owns redaction. For evidence that also travels on a ledger line (the
 * `verify.completed` writer, `./verify-writer.js#recordVerification`), the bound
 * port must register the entries exactly as the ledger stores them: redacted by
 * `lib/runtime/ledger-redaction.js#redactDeep` at the envelope's `data.evidence`
 * position. A bare call on the entries is a different pass, because the depth
 * limit counts from the root it is given. The exact contract is on that
 * writer's `registerLineEvidence`. Then no row confirms what the ledger hid,
 * and a row's hash recomputes from the stored line its `source` names. This module is L2 and
 * cannot import `lib/runtime/`, so the obligation is on the port, not enforced
 * here.
 *
 * ── Same hash, same id ──────────────────────────────────────────────────────
 * Registering content that is already present returns its existing id and
 * appends nothing. That holds across calls and inside one call. The first
 * registration's `source` is the one kept. Ids are minted under
 * `lib/core/file-lock.js#withFileLock`, which also covers the read of the
 * existing rows, so two writers cannot both read "highest is E-004" and both
 * mint E-005. That lock is fail-open after 5 s (see its module header). A
 * writer stalled longer than that can still race, and nothing here detects it.
 *
 * ── Never throws on the write path ──────────────────────────────────────────
 * `registerEvidence` and `readEvidenceIds` turn every failure into a value: a
 * `reason` string with no ids, or `null` for "could not be read". A refused
 * call writes NOTHING. A partial registration would hand back ids for some
 * entries and silently drop the rest.
 *
 * ── Layer ────────────────────────────────────────────────────────────────
 * L2, like the rest of `lib/verification/`. It imports `lib/project-state/`
 * (an L2 sibling, pure fs and path) and `lib/core/` (L1) only. It owns its store,
 * so it calls `node:fs` directly, the case `eslint.config.js`'s L2 block names.
 *
 * @module lib/verification/evidence-registry
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { withFileLock } from '../core/file-lock.js';
import { resolveGitCommonDir as realResolveGitCommonDir } from '../project-state/git-common-dir.js';
import { resolveStoreLocation } from '../project-state/store-location.js';

/** File name of the registry inside the store directory. */
export const EVIDENCE_REGISTRY_FILE = 'evidence.jsonl';

/** An id this module minted. At least three digits, and it grows past E-999. */
const EVIDENCE_ID_RE = /^E-(\d{3,})$/;

/** A row's hash field, the shape `evidenceHash` produces. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * JSON with object keys sorted at every depth. Arrays keep their order, because
 * order in an evidence list is content. `undefined` members are dropped, as
 * `JSON.stringify` drops them, so an entry and its JSON round-trip hash alike.
 *
 * @param {unknown} value
 * @param {Set<object>} stack - Objects on the current path, for cycle detection.
 * @returns {string}
 */
function canonicalJson(value, stack) {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    if (s === undefined) throw new TypeError(`evidenceHash: unserializable value (${typeof value})`);
    return s;
  }
  if (stack.has(value)) throw new TypeError('evidenceHash: circular entry');
  stack.add(value);
  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v, stack))).join(',')}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const v = /** @type {Record<string, unknown>} */ (value)[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(v, stack)}`);
    }
    out = `{${parts.join(',')}}`;
  }
  stack.delete(value);
  return out;
}

/**
 * sha256 hex of one evidence entry's canonical serialization.
 *
 * Throws on an entry it cannot serialize (a cycle, a BigInt). Hashing a
 * stand-in would give two different unserializable entries the same id.
 *
 * @param {unknown} entry
 * @returns {string} 64 lowercase hex characters.
 */
export function evidenceHash(entry) {
  return createHash('sha256').update(canonicalJson(entry, new Set()), 'utf8').digest('hex');
}

/**
 * The git port's answer, or `null`. A port that throws is treated as
 * unresolved, the same reading `lib/project-state/state-manager.js` gives it.
 *
 * @param {unknown} port
 * @param {string} projectRoot
 * @returns {string|null}
 */
function safeGitCommonDir(port, projectRoot) {
  if (typeof port !== 'function') return null;
  try {
    const value = port(projectRoot);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Absolute path of the registry file for a project.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {{ resolveGitCommonDir?: (projectRoot: string) => (string|null) }} [opts]
 *   The git port. Omitted means the real pure-fs resolver.
 * @returns {string}
 * @throws {TypeError} When `projectRoot` is not a non-empty string (from
 *   `resolveStoreLocation`).
 */
export function evidenceRegistryPath(projectRoot, { resolveGitCommonDir = realResolveGitCommonDir } = {}) {
  const gitCommonDir = safeGitCommonDir(resolveGitCommonDir, projectRoot);
  const { dir } = resolveStoreLocation({ projectRoot, gitCommonDir });
  return path.join(dir, EVIDENCE_REGISTRY_FILE);
}

/**
 * Rows of the registry as parsed objects. Torn and foreign lines are skipped.
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.id !== 'string' || !EVIDENCE_ID_RE.test(row.id)) continue;
    rows.push(row);
  }
  return rows;
}

/**
 * The file's text, or `''` when it does not exist yet. Other errors propagate.
 *
 * @param {string} file
 * @returns {string}
 */
function readTextOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatId(n) {
  return `E-${String(n).padStart(3, '0')}`;
}

/**
 * Check a call's inputs, and hash every entry before anything is written.
 *
 * @param {unknown} entries
 * @param {unknown} source
 * @param {unknown} projectRoot
 * @returns {{ planned: Array<{ type: string, hash: string }> } | { reason: string }}
 */
function planEntries(entries, source, projectRoot) {
  if (!Array.isArray(entries)) return { reason: 'entries-not-array' };
  if (typeof source !== 'string' || !source.trim()) return { reason: 'source-missing' };
  if (typeof projectRoot !== 'string' || !projectRoot) return { reason: 'projectRoot-missing' };
  const planned = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { reason: `entry-not-object:${i}` };
    const kind = /** @type {Record<string, unknown>} */ (e).kind;
    if (typeof kind !== 'string' || !kind.trim()) return { reason: `entry-kind-missing:${i}` };
    let hash;
    try {
      hash = evidenceHash(e);
    } catch {
      return { reason: `entry-unserializable:${i}` };
    }
    planned.push({ type: kind, hash });
  }
  return { planned };
}

/**
 * Under the lock: read the rows, reuse or mint an id per planned entry, append
 * the new rows in one write.
 *
 * @param {string} file
 * @param {Array<{ type: string, hash: string }>} planned
 * @param {string} source
 * @param {string} createdAt
 * @returns {{ ids: string[], appended: number, reused: number }}
 */
function allocateLocked(file, planned, source, createdAt) {
  const text = readTextOrEmpty(file);
  const idByHash = new Map();
  let highest = 0;
  for (const row of parseRows(text)) {
    const n = Number(EVIDENCE_ID_RE.exec(/** @type {string} */ (row.id))[1]);
    if (n > highest) highest = n;
    if (typeof row.hash === 'string' && HASH_RE.test(row.hash) && !idByHash.has(row.hash)) {
      idByHash.set(row.hash, row.id);
    }
  }
  const ids = [];
  const fresh = [];
  let reused = 0;
  for (const { type, hash } of planned) {
    const known = idByHash.get(hash);
    if (known !== undefined) {
      ids.push(known);
      reused += 1;
      continue;
    }
    highest += 1;
    const id = formatId(highest);
    idByHash.set(hash, id);
    ids.push(id);
    fresh.push(JSON.stringify({ id, type, source, hash, created_at: createdAt }));
  }
  if (fresh.length > 0) {
    // A torn last line (a writer killed mid-append) has no newline. Starting on
    // a fresh line keeps the new row from being glued onto it and lost with it.
    const lead = text !== '' && !text.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${lead}${fresh.join('\n')}\n`, 'utf8');
  }
  return { ids, appended: fresh.length, reused };
}

/**
 * Register evidence entries and return one id per entry, in input order.
 *
 * NEVER THROWS. Any failure returns `ids: []` with a `reason`, and a refused
 * call writes nothing.
 *
 * @param {Array<Record<string, unknown>>} entries - Evidence entries.
 *   `type` on the row is each entry's `kind`.
 * @param {{ projectRoot?: string, source?: string,
 *   resolveGitCommonDir?: (projectRoot: string) => (string|null),
 *   now?: () => Date }} [opts]
 *   `source` names who registered the entries and is required. `now` defaults to
 *   the wall clock.
 * @returns {{ ids: string[], appended: number, reused: number, reason?: string }}
 *   `appended` counts rows written. `reused` counts entries answered by an
 *   existing row, or by an earlier entry of the same call.
 */
export function registerEvidence(entries, { projectRoot, source, resolveGitCommonDir, now } = {}) {
  const none = (reason) => ({ ids: [], appended: 0, reused: 0, reason });
  try {
    const plan = planEntries(entries, source, projectRoot);
    if ('reason' in plan) return none(plan.reason);
    if (plan.planned.length === 0) return { ids: [], appended: 0, reused: 0 };
    const at = typeof now === 'function' ? now() : new Date();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) return none('now-invalid');
    const file = evidenceRegistryPath(/** @type {string} */ (projectRoot), { resolveGitCommonDir });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withFileLock(file, () => allocateLocked(file, plan.planned, /** @type {string} */ (source), at.toISOString()));
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
    return none(`registry-io:${typeof code === 'string' ? code : 'error'}`);
  }
}

/**
 * Every id in the registry, in file order.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {{ resolveGitCommonDir?: (projectRoot: string) => (string|null) }} [opts]
 * @returns {string[]|null} `[]` when the registry does not exist: it is
 *   measured and empty. `null` when it exists but cannot be read: unmeasured.
 *   Torn and unparseable lines are skipped.
 */
export function readEvidenceIds(projectRoot, { resolveGitCommonDir } = {}) {
  let text;
  try {
    const file = evidenceRegistryPath(projectRoot, { resolveGitCommonDir });
    text = readTextOrEmpty(file);
  } catch {
    return null;
  }
  const ids = [];
  const seen = new Set();
  for (const row of parseRows(text)) {
    const id = /** @type {string} */ (row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
