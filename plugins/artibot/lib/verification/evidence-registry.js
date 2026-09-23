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
 * registration's `source` is the one kept. Ids are minted under this module's
 * own lock (next section), which also covers the read of the existing rows, so
 * two writers cannot both read "highest is E-004" and both mint E-005.
 *
 * ── The lock, and why it is not `lib/core/file-lock.js#withFileLock` ─────────
 * `withFileLock` is not mutually exclusive. It waits until `existsSync` says
 * the lock is gone, then creates it with a plain `writeFileSync`. Two waiters
 * that both see "gone" both proceed. It also unlinks a lock whose JSON does not
 * parse, which is exactly what a racing reader sees between another holder's
 * create and its write. Measured 2026-09-23 13:54 KST with 4 and 8 writers
 * released together: duplicate ids in 44 of 50 and 30 of 30 rounds. CI hit the
 * same thing unsynchronised once (3 distinct ids from 4 writers). That module is
 * shared with other stores and not changed here.
 *
 * This lock is `<registry>.lock`, the same path, so a writer on the old code
 * still sees it:
 *   - ACQUIRE is `openSync(lock, 'wx')`, an atomic create-if-absent, retried
 *     every `retryMs` on "exists". On Windows a lock still being deleted
 *     answers EPERM or EBUSY, and those count as "held" too.
 *   - The holder writes `{token, pid, timestamp}` after creating the file. That
 *     content is for diagnostics and for release. Staleness NEVER reads it,
 *     because an empty or half-written lock is a live holder mid-write.
 *   - STALE means the file's mtime is older than `staleMs`, by age alone. A
 *     stale lock is renamed aside to a unique name and then unlinked. Two takers
 *     of one stranded lock race on the rename, and only one wins it. The
 *     residual: a taker that stat-ed the stale lock, then lost the CPU while
 *     the other taker replaced it, would rename the NEW, live lock aside. That
 *     taker re-checks what it moved. If the moved file is fresh, it links it
 *     back, and that link fails only when a third lock appeared in between.
 *     That three-way interleaving is the remaining window, and it needs a
 *     holder stranded for `staleMs` first.
 *   - TIMEOUT FAILS CLOSED. After `timeoutMs` the call returns
 *     `reason: 'lock-timeout'` and writes nothing. A missing registration is
 *     visible to whoever reads the result. A duplicate id is silent corruption.
 *     This is the same preference `./verify-writer.js` states for the ledger.
 *   - RELEASE unlinks the lock only if it still carries this holder's token. A
 *     holder that outlived `staleMs` and was taken over leaves the new holder's
 *     lock alone.
 *   - No signal handlers. A process killed mid-hold strands the lock, and the
 *     stale rule reclaims it after `staleMs`. `timeoutMs` exceeds `staleMs` by
 *     default, so a waiter can outlast one stranded lock rather than fail
 *     behind it.
 * A holder stalled past `staleMs` still shares the critical section with the
 * writer that took over. Nothing here detects that.
 *
 * ── Never throws on the write path ──────────────────────────────────────────
 * `registerEvidence`, `readEvidenceIds`, `lookupEvidenceIds` and
 * `citedEvidenceIds` turn every failure into a value: a
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

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sleepSync } from '../core/file.js';
import { resolveGitCommonDir as realResolveGitCommonDir } from '../project-state/git-common-dir.js';
import { resolveStoreLocation } from '../project-state/store-location.js';

/** File name of the registry inside the store directory. */
export const EVIDENCE_REGISTRY_FILE = 'evidence.jsonl';

/** An id this module minted. At least three digits, and it grows past E-999. */
const EVIDENCE_ID_RE = /^E-(\d{3,})$/;

/** A row's hash field, the shape `evidenceHash` produces. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Registry lock timings in ms. See "The lock" above. A holder's critical
 * section is one read plus one append, measured in milliseconds, so `staleMs`
 * is a strand detector, not a hold budget.
 */
export const REGISTRY_LOCK_DEFAULTS = Object.freeze({ timeoutMs: 6000, staleMs: 5000, retryMs: 20 });

/** Create errors that mean "someone holds it", not "this cannot work". */
const LOCK_HELD_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY']);

/**
 * @param {unknown} lock - Caller overrides; anything not a positive number falls back.
 * @returns {{ timeoutMs: number, staleMs: number, retryMs: number }}
 */
function lockSettings(lock) {
  const l = lock && typeof lock === 'object' ? /** @type {Record<string, unknown>} */ (lock) : {};
  const pick = (k) => {
    const v = l[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : REGISTRY_LOCK_DEFAULTS[k];
  };
  return { timeoutMs: pick('timeoutMs'), staleMs: pick('staleMs'), retryMs: pick('retryMs') };
}

/**
 * One atomic create attempt.
 *
 * @param {string} lockPath
 * @param {string} token
 * @returns {boolean} `true` when this call now holds the lock.
 */
function tryCreateLock(lockPath, token) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (LOCK_HELD_CODES.has(/** @type {NodeJS.ErrnoException} */ (err).code ?? '')) return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, timestamp: Date.now() }));
  } catch (err) {
    // A lock without the token could never be released by its holder, so
    // it must not be left behind.
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * Take over a lock whose file is older than `staleMs`. The age comes from
 * mtime alone, never from the content.
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean} `true` when a stale lock was removed.
 */
function takeOverIfStale(lockPath, staleMs) {
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - st.mtimeMs <= staleMs) return false;
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return false;
  }
  let movedFresh = false;
  try {
    movedFresh = Date.now() - fs.statSync(aside).mtimeMs <= staleMs;
  } catch { /* already gone */ }
  if (movedFresh) {
    // Another taker replaced the stale lock between the stat and the rename,
    // so the file just moved is a LIVE holder's lock. Put it back.
    try { fs.linkSync(aside, lockPath); } catch { /* a newer lock exists: the documented residual */ }
  }
  try { fs.unlinkSync(aside); } catch { /* best effort */ }
  return !movedFresh;
}

/**
 * @param {string} lockPath
 * @param {{ timeoutMs: number, staleMs: number, retryMs: number }} settings
 * @returns {string|null} The holder token, or `null` on timeout.
 */
function acquireLock(lockPath, settings) {
  const token = randomUUID();
  const deadline = Date.now() + settings.timeoutMs;
  for (;;) {
    if (tryCreateLock(lockPath, token)) return token;
    if (takeOverIfStale(lockPath, settings.staleMs)) continue;
    if (Date.now() >= deadline) return null;
    sleepSync(settings.retryMs);
  }
}

/**
 * Unlink the lock only while it still carries this holder's token.
 *
 * Exported so the token check is testable on its own: nothing else makes a
 * holder outlive `staleMs` deterministically.
 *
 * @param {string} lockPath
 * @param {string} token
 * @returns {void}
 */
export function releaseLock(lockPath, token) {
  try {
    if (fs.readFileSync(lockPath, 'utf8').includes(token)) fs.unlinkSync(lockPath);
  } catch { /* gone or unreadable: nothing of ours to remove */ }
}

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
 *   now?: () => Date,
 *   lock?: { timeoutMs?: number, staleMs?: number, retryMs?: number } }} [opts]
 *   `source` names who registered the entries and is required. `now` defaults to
 *   the wall clock. `lock` overrides {@link REGISTRY_LOCK_DEFAULTS} one field at a
 *   time. It exists so tests can time out in milliseconds.
 * @returns {{ ids: string[], appended: number, reused: number, reason?: string }}
 *   `appended` counts rows written. `reused` counts entries answered by an
 *   existing row, or by an earlier entry of the same call. `reason:
 *   'lock-timeout'` means the lock stayed held for `timeoutMs` and nothing was
 *   written.
 */
export function registerEvidence(entries, { projectRoot, source, resolveGitCommonDir, now, lock } = {}) {
  const none = (reason) => ({ ids: [], appended: 0, reused: 0, reason });
  try {
    const plan = planEntries(entries, source, projectRoot);
    if ('reason' in plan) return none(plan.reason);
    if (plan.planned.length === 0) return { ids: [], appended: 0, reused: 0 };
    const at = typeof now === 'function' ? now() : new Date();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) return none('now-invalid');
    const file = evidenceRegistryPath(/** @type {string} */ (projectRoot), { resolveGitCommonDir });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lockPath = `${file}.lock`;
    const token = acquireLock(lockPath, lockSettings(lock));
    if (token === null) return none('lock-timeout');
    try {
      return allocateLocked(file, plan.planned, /** @type {string} */ (source), at.toISOString());
    } finally {
      releaseLock(lockPath, token);
    }
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

/**
 * The ids of entries that are already registered, found by content hash.
 * READ-ONLY: it mints nothing and appends nothing, so an unregistered entry is
 * simply absent from the answer.
 *
 * LOCK-FREE BY DESIGN. The writer (`allocateLocked`) only ever appends whole
 * rows, each in one `appendFileSync`, and never rewrites or truncates. So a read
 * racing an append sees a prefix of the file: every complete row is final, and
 * at most the last line is torn. A torn line is a strict prefix of one
 * `JSON.stringify`d object, which never parses, and `parseRows` skips it. The
 * race therefore costs an omitted id, never a wrong one. Waiting on the lock
 * would instead put a 6 s stall on a reader that can live with the omission.
 *
 * Each hash answers with the FIRST row's id, the one `allocateLocked` reuses.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {Array<unknown>} entries - Evidence entries, as the ledger stores them.
 *   An entry that cannot be hashed is skipped.
 * @param {{ resolveGitCommonDir?: (projectRoot: string) => (string|null) }} [opts]
 * @returns {string[]|null} Distinct ids in entry order. `[]` for no entries, an
 *   absent registry, or no match. `null` when the registry exists but cannot be
 *   read. Never throws.
 */
export function lookupEvidenceIds(projectRoot, entries, { resolveGitCommonDir } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  let text;
  try {
    text = readTextOrEmpty(evidenceRegistryPath(projectRoot, { resolveGitCommonDir }));
  } catch {
    return null;
  }
  const idByHash = new Map();
  for (const row of parseRows(text)) {
    if (typeof row.hash === 'string' && HASH_RE.test(row.hash) && !idByHash.has(row.hash)) {
      idByHash.set(row.hash, row.id);
    }
  }
  const ids = [];
  for (const entry of entries) {
    let hash;
    try {
      hash = evidenceHash(entry);
    } catch {
      continue;
    }
    const id = idByHash.get(hash);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The ledger event whose `data.evidence` the registry holds (`./verify-writer.js#VERIFY_COMPLETED_EVENT`). */
const VERIFY_EVENT = 'verify.completed';

/**
 * `command` of the entry `./verify-writer.js#fitLine` puts in place of evidence
 * it dropped to fit the ledger line cap. That entry is a COUNT of what went, not
 * evidence, so it is registered like any entry but never cited. Spelled here
 * rather than imported because the writer does not export it. The test builds a
 * real trimmed line through the writer and matches this against it.
 */
export const EVIDENCE_BOUND_COMMAND = 'verify-writer:evidence-bound';

/**
 * @param {unknown} entry
 * @returns {boolean} true for the writer's drop marker
 */
function isDropMarker(entry) {
  const e = /** @type {Record<string, unknown>|null} */ (entry);
  return e?.kind === 'command' && e.command === EVIDENCE_BOUND_COMMAND;
}

/**
 * The registry ids one verification's evidence resolves to: the ids an outcome
 * cites (§23). Read-only, through {@link lookupEvidenceIds}.
 *
 * EVERY `verify.completed` row carrying `verificationId` counts, across all
 * layers. The last row alone would not do: it is usually the `:operational`
 * line with `evidence: []`. A row the ledger FOLDED has lost `verification_id`
 * (`lib/runtime/event-writer.js#foldOversized` keeps only required keys), so its
 * evidence is omitted rather than cited under a guess. The drop marker is
 * never cited ({@link EVIDENCE_BOUND_COMMAND}).
 *
 * The rows must be the ledger's STORED rows, as `readAllEvents` returns them.
 * The production ports register the stored, redacted form, so that is the form
 * whose hash has a row.
 *
 * @param {object[]} history - Ledger rows, in ledger order.
 * @param {string} verificationId
 * @param {{ projectRoot?: string,
 *   resolveGitCommonDir?: (projectRoot: string) => (string|null) }} [opts]
 * @returns {string[]|null} As {@link lookupEvidenceIds}; `[]` for no
 *   verification id or no evidence. Never throws.
 */
export function citedEvidenceIds(history, verificationId, { projectRoot, resolveGitCommonDir } = {}) {
  if (typeof verificationId !== 'string' || !verificationId.trim() || !Array.isArray(history)) return [];
  const entries = [];
  try {
    for (const row of history) {
      if (row?.event !== VERIFY_EVENT || row.data?.verification_id !== verificationId) continue;
      if (!Array.isArray(row.data.evidence)) continue;
      for (const entry of row.data.evidence) if (!isDropMarker(entry)) entries.push(entry);
    }
  } catch {
    return null;
  }
  return lookupEvidenceIds(/** @type {string} */ (projectRoot), entries, { resolveGitCommonDir });
}
