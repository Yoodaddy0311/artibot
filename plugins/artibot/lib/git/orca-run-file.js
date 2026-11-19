/**
 * `<parentRoot>/.artibot/orca/run.json` — the leader's state file for one
 * `/orca` run: the planned limbs, what Orca created for each (worktree id, path,
 * branch, fork point) and the add-only dispatch receipts. Contract: design
 * section 11.3 (IC-1) / 11.4 (IC-2).
 *
 * Differences from the `/split` sibling (`split-run-file.js`) that are on
 * purpose:
 *  - every function RETURNS a result (`{ ok: true, ... }` / `{ ok: false,
 *    reason }`) instead of throwing, so a damaged ledger is a reported state the
 *    caller must look at, never an exception that a catch-all swallows;
 *  - a file that does not parse or does not satisfy {@link validateOrcaRun} is
 *    never "repaired" or replaced by `{}` — `readOrcaRun` says `unparseable` or
 *    `schema`, and `updateOrcaRun` then writes nothing;
 *  - the previous bytes go to `run.json.bak` BEFORE every write (a failed backup
 *    refuses the write), and the write itself is tmp + rename
 *    (`lib/core/file.js#atomicWriteJsonSync`), so a crash leaves either the old
 *    file or the new one;
 *  - read-modify-write runs under `withFileLock(run.json)`, so two scripts
 *    updating at the same instant take turns instead of one silently losing its
 *    change (the `/split` run.json update has no such lock).
 *
 * What the lock does not cover: a writer that bypasses this module (an inline
 * `node -e` once truncated a state file to ""), and a holder that stays inside
 * the lock longer than the lock's stale window — see `lib/core/file-lock.js`.
 *
 * @module lib/git/orca-run-file
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../core/file.js';
import { withFileLock } from '../core/file-lock.js';
import { ORCA_RUN_SCHEMA_VERSION, validateLimbRow } from './orca-plan.js';

export { ORCA_RUN_SCHEMA_VERSION };

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFilled = (value) => typeof value === 'string' && value.trim() !== '';
const present = (record, key) => record[key] !== undefined;
const messageOf = (err) => String(err?.message ?? err);
const MAX_ERRORS_SHOWN = 5;

function checkHeader(run) {
  const errors = [];
  if (present(run, 'schema_version')) {
    const version = run.schema_version;
    if (!Number.isInteger(version) || version < 1) errors.push('schema_version: must be a positive integer');
    else if (version > ORCA_RUN_SCHEMA_VERSION) errors.push(`schema_version: ${version} is newer than this reader (${ORCA_RUN_SCHEMA_VERSION})`);
  }
  if (run.provider !== 'orca') errors.push("provider: must be 'orca'");
  if (present(run, 'runId') && run.runId !== null && !isFilled(run.runId)) errors.push('runId: must be a non-empty string or null');
  for (const key of ['tag', 'objective', 'integrationRef', 'createdAt']) {
    if (present(run, key) && !isFilled(run[key])) errors.push(`${key}: must be a non-empty string`);
  }
  if (present(run, 'orca')) {
    const meta = run.orca;
    const bad = !isRecord(meta) || ['appVersion', 'environment', 'repoId'].some((key) => present(meta, key) && meta[key] !== null && !isFilled(meta[key]));
    if (bad) errors.push('orca: must be an object whose appVersion, environment and repoId are non-empty strings or null');
  }
  return errors;
}

function checkLimbs(run) {
  if (!Array.isArray(run.limbs)) return ['limbs: must be an array'];
  const names = run.limbs.map((row) => (isRecord(row) ? row.limb : undefined));
  const duplicates = [...new Set(names.filter((name, index) => typeof name === 'string' && names.indexOf(name) !== index))];
  return [
    ...run.limbs.flatMap((row, index) => validateLimbRow(row, { allowUnbound: true }).errors
      .map((error) => `limbs[${index}]${isRecord(row) && typeof row.limb === 'string' ? ` (${row.limb})` : ''}: ${error}`)),
    ...duplicates.map((name) => `limbs: duplicate limb name ${name}`),
  ];
}

/**
 * Shape check of a whole `run.json` (design section 11.4) — what
 * {@link readOrcaRun} and {@link writeOrcaRun} enforce. Rows are checked with
 * `validateLimbRow(row, { allowUnbound: true })`. `schema_version` may be absent
 * (an unstamped file is read as-is and stamped on the next write) but never
 * newer than {@link ORCA_RUN_SCHEMA_VERSION}. Cross-limb integrity (unknown
 * `deps`, cycles) is not checked: `readyLimbs` reports an unlanded unknown
 * dependency as waiting, which is the fail-closed answer and stays visible.
 *
 * @param {unknown} run
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOrcaRun(run) {
  if (!isRecord(run)) return { ok: false, errors: ['run must be a JSON object'] };
  const errors = [...checkHeader(run), ...checkLimbs(run)];
  return { ok: errors.length === 0, errors };
}

/**
 * State file location for a parent root. The segments are joined, never spelled
 * as one literal, so the location has a single definition.
 *
 * @param {string} parentRoot
 * @returns {string}
 * @throws {TypeError} when `parentRoot` is not a non-empty string (the other
 *   functions here turn that into `{ ok: false, reason: 'bad-root' }`)
 */
export function orcaRunPath(parentRoot) {
  if (typeof parentRoot !== 'string' || !parentRoot) throw new TypeError('orcaRunPath: parentRoot is required');
  return path.join(parentRoot, '.artibot', 'orca', 'run.json');
}

function locate(parentRoot) {
  try {
    return { ok: true, file: orcaRunPath(parentRoot) };
  } catch {
    return { ok: false, reason: 'bad-root', detail: 'parentRoot must be a non-empty string' };
  }
}

function summarize(errors) {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).join('; ');
  return errors.length > MAX_ERRORS_SHOWN ? `${shown}; (+${errors.length - MAX_ERRORS_SHOWN} more)` : shown;
}

function backupHint(file) {
  return fs.existsSync(`${file}.bak`) ? ` — the previous copy is ${file}.bak` : '';
}

function parseRunText(text, file) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return { ok: false, reason: 'unparseable', detail: `empty file${backupHint(file)}` };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: 'unparseable', detail: `${messageOf(err)}${backupHint(file)}` };
  }
  const verdict = validateOrcaRun(parsed);
  if (!verdict.ok) return { ok: false, reason: 'schema', detail: `${summarize(verdict.errors)}${backupHint(file)}` };
  return { ok: true, run: parsed };
}

/**
 * Read and validate `run.json`.
 *
 * `absent` — no file (the only state a first run starts in); `unparseable` —
 * empty or not JSON; `schema` — JSON that fails {@link validateOrcaRun}
 * (including a `schema_version` newer than this reader); `unreadable` — the file
 * exists but cannot be read; `bad-root` — an unusable `parentRoot`. `detail` is
 * a one-line human string and names `run.json.bak` when one exists. A file
 * without `schema_version` is accepted as-is (it is stamped on the next write).
 *
 * @param {string} parentRoot
 * @returns {{ ok: true, run: object } | { ok: false, reason: 'absent'|'unparseable'|'schema'|'unreadable'|'bad-root', detail?: string }}
 */
export function readOrcaRun(parentRoot) {
  const target = locate(parentRoot);
  if (!target.ok) return target;
  let text;
  try {
    text = fs.readFileSync(target.file, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, reason: 'absent' };
    return { ok: false, reason: 'unreadable', detail: messageOf(err) };
  }
  return parseRunText(text, target.file);
}

function stamped(run) {
  return Object.hasOwn(run, 'schema_version') ? run : { schema_version: ORCA_RUN_SCHEMA_VERSION, ...run };
}

function lockFailure(err) {
  if (err?.code === 'ELOCKTIMEOUT') return { ok: false, reason: 'lock-timeout', detail: messageOf(err) };
  if (err?.code === 'ELOCKREENTRANT') return { ok: false, reason: 'lock-reentrant', detail: messageOf(err) };
  return { ok: false, reason: 'lock-failed', detail: messageOf(err) };
}

/** Copy the current file to `.bak`. No current file is fine; any other failure refuses the write. */
function backUp(file) {
  try {
    fs.copyFileSync(file, `${file}.bak`);
    return { ok: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true };
    return { ok: false, reason: 'backup-failed', detail: messageOf(err) };
  }
}

/** Backup first, then tmp + rename. Must run under the file lock. */
function persist(file, run) {
  const backup = backUp(file);
  if (!backup.ok) return backup;
  try {
    atomicWriteJsonSync(file, run);
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: `${messageOf(err)} — ${file} is unchanged` };
  }
  return { ok: true, path: file };
}

function checked(run) {
  if (!isRecord(run)) return { ok: false, reason: 'schema', detail: 'run must be a JSON object' };
  const next = stamped(run);
  const verdict = validateOrcaRun(next);
  return verdict.ok ? { ok: true, run: next } : { ok: false, reason: 'schema', detail: summarize(verdict.errors) };
}

/**
 * Replace `run.json` with `run`: validate, copy the previous file to
 * `run.json.bak`, then write atomically. `schema_version` is stamped when the
 * object has none; the input is never mutated. Nothing is written when the
 * object fails {@link validateOrcaRun} (`schema`), when the backup fails
 * (`backup-failed`) or when the lock is not obtained (`lock-timeout`,
 * `lock-reentrant`, `lock-failed`); a failed write (`write-failed`) leaves the
 * old file in place and the `.bak` beside it.
 *
 * @param {string} parentRoot
 * @param {object} run
 * @returns {{ ok: true, path: string } | { ok: false, reason: string, detail?: string }}
 */
export function writeOrcaRun(parentRoot, run) {
  const target = locate(parentRoot);
  if (!target.ok) return target;
  const verdict = checked(run);
  if (!verdict.ok) return verdict;
  try {
    return withFileLock(target.file, () => persist(target.file, verdict.run));
  } catch (err) {
    return lockFailure(err);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/**
 * Run the mutator on a DEEP-FROZEN copy of the run, so "return a new object" is
 * enforced rather than hoped for: an in-place edit throws and is reported as
 * `mutate-failed` with nothing written.
 */
function applyMutator(mutate, run) {
  let next;
  try {
    next = mutate(deepFreeze(structuredClone(run)));
  } catch (err) {
    return { ok: false, reason: 'mutate-failed', detail: messageOf(err) };
  }
  return isRecord(next) ? { ok: true, next } : { ok: false, reason: 'mutate-invalid', detail: 'mutate must return the new run object' };
}

function readModifyWrite(file, parentRoot, mutate) {
  const current = readOrcaRun(parentRoot);
  if (!current.ok) return current;
  const produced = applyMutator(mutate, current.run);
  if (!produced.ok) return produced;
  const verdict = checked(produced.next);
  if (!verdict.ok) return verdict;
  const written = persist(file, verdict.run);
  // A fresh copy: the mutator's result shares rows with the frozen copy it was given, and the caller must get an ordinary object.
  return written.ok ? { ok: true, run: structuredClone(verdict.run) } : written;
}

/**
 * Read-modify-write under the file lock. `mutate(run)` receives a deep-frozen
 * copy of the current run and must return the NEW run object; to refuse, throw
 * (reported as `mutate-failed` with the message in `detail`, nothing written).
 * The result is validated before it is written, so a mutator that drops
 * `limbs` cannot leave an unreadable file behind. The `run` handed back is a
 * fresh, ordinary (unfrozen) copy of what was written.
 *
 * A file that is `absent`, `unparseable` or fails the schema is returned as that
 * reason and left untouched — use {@link writeOrcaRun} to create or replace.
 *
 * @param {string} parentRoot
 * @param {(run: object) => object} mutate
 * @returns {{ ok: true, run: object } | { ok: false, reason: string, detail?: string }}
 */
export function updateOrcaRun(parentRoot, mutate) {
  if (typeof mutate !== 'function') return { ok: false, reason: 'bad-mutator', detail: 'mutate must be a function' };
  const target = locate(parentRoot);
  if (!target.ok) return target;
  try {
    return withFileLock(target.file, () => readModifyWrite(target.file, parentRoot, mutate));
  } catch (err) {
    return lockFailure(err);
  }
}
