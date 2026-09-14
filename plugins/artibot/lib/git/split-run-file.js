/**
 * `<parentRoot>/.artibot/split/run.json` — the leader's run ledger for one
 * `/split` campaign (stage times, window reuse map, suspend block).
 *
 * `plan.json` is written by `/split plan`; `limbs[].forkPoint` is the one field
 * `dispatch` fills in afterwards (the commit the limb's worktree was really
 * branched from, which is normally AHEAD of the plan-time `base`). `run.json`
 * is the mutable companion the scripts under `scripts/split/` read and update.
 * Writes are atomic (tmp + rename via `lib/core/file.js`), reads tolerate a
 * missing file (`null`) but NOT a corrupt one — a JSON parse error throws so
 * a damaged ledger is never silently replaced by `{}`.
 *
 * @module lib/git/split-run-file
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../core/file.js';

/**
 * Shape version stamped into `run.json` / `plan.json` on write. Bump only when
 * an OLD reader would misread a NEW file; adding an optional key does not
 * qualify. A file that already carries the key keeps its own value — a newer
 * writer must never silently relabel a file it did not create.
 */
export const SPLIT_FILE_SCHEMA_VERSION = 1;

/**
 * Add `schema_version` only when the key is absent. `Object.hasOwn`, not a
 * truthiness test, so an explicit `0`/`null` written by another tool survives.
 * Returns the input unchanged in that case; otherwise a new object with the
 * original key order preserved and the stamp appended.
 * @param {object} obj
 * @returns {object}
 */
function stampSchemaVersion(obj) {
  if (Object.hasOwn(obj, 'schema_version')) return obj;
  return { ...obj, schema_version: SPLIT_FILE_SCHEMA_VERSION };
}

/**
 * Read a JSON object file. Missing → `null`. Malformed or non-object → throws.
 * @param {string} p
 * @param {string} label - function name for the error message
 * @returns {object|null}
 */
function readJsonObject(p, label) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}: ${p} is not a JSON object`);
  }
  return parsed;
}

/**
 * `run.json` location for a parent root.
 *
 * @param {string} parentRoot
 * @returns {string}
 */
export function runJsonPath(parentRoot) {
  if (typeof parentRoot !== 'string' || !parentRoot) throw new TypeError('runJsonPath: parentRoot is required');
  return path.join(parentRoot, '.artibot', 'split', 'run.json');
}

/**
 * Read `run.json`. Missing file → `null`. Malformed JSON → throws.
 *
 * @param {string} parentRoot
 * @returns {object|null}
 */
export function readRunJson(parentRoot) {
  return readJsonObject(runJsonPath(parentRoot), 'readRunJson');
}

/**
 * Write `run.json` atomically (creates the split dir as needed), stamping
 * {@link SPLIT_FILE_SCHEMA_VERSION} when the object does not already carry one.
 *
 * @param {string} parentRoot
 * @param {object} obj
 * @returns {string} path written
 */
export function writeRunJson(parentRoot, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('writeRunJson: obj must be a plain object');
  const p = runJsonPath(parentRoot);
  atomicWriteJsonSync(p, stampSchemaVersion(obj));
  return p;
}

/**
 * Read-modify-write. `fn` receives the current object (`{}` when the file is
 * missing) and returns the object to store; returning `undefined` keeps the
 * (possibly mutated) input.
 *
 * @param {string} parentRoot
 * @param {(current: object) => object|undefined} fn
 * @returns {object} the object written
 */
export function updateRunJson(parentRoot, fn) {
  if (typeof fn !== 'function') throw new TypeError('updateRunJson: fn must be a function');
  const current = readRunJson(parentRoot) ?? {};
  const next = fn(current);
  const out = next === undefined ? current : next;
  writeRunJson(parentRoot, out);
  return out;
}

/**
 * `plan.json` location for a parent root — the sibling of {@link runJsonPath}.
 *
 * @param {string} parentRoot
 * @returns {string}
 */
export function planJsonPath(parentRoot) {
  if (typeof parentRoot !== 'string' || !parentRoot) throw new TypeError('planJsonPath: parentRoot is required');
  return path.join(parentRoot, '.artibot', 'split', 'plan.json');
}

/**
 * Read `plan.json`. Missing file → `null`. Malformed JSON → throws. Same rule
 * as {@link readRunJson}: a damaged plan must be loud, never an empty object.
 *
 * @param {string} parentRoot
 * @returns {object|null}
 */
export function readPlanJson(parentRoot) {
  return readJsonObject(planJsonPath(parentRoot), 'readPlanJson');
}

/**
 * Read-modify-write `plan.json` atomically. `fn` receives the current object
 * (`{}` when the file is missing) and returns the object to store; returning
 * `undefined` keeps the (possibly mutated) input.
 *
 * The plan is otherwise write-once, so this exists for exactly one caller
 * shape: recording `limbs[].forkPoint` after a worktree is created. It is not
 * a general editor for plan contents.
 *
 * @param {string} parentRoot
 * @param {(current: object) => object|undefined} fn
 * @returns {object} the object written
 */
export function updatePlanJson(parentRoot, fn) {
  if (typeof fn !== 'function') throw new TypeError('updatePlanJson: fn must be a function');
  const current = readPlanJson(parentRoot) ?? {};
  const next = fn(current);
  const out = next === undefined ? current : next;
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new TypeError('updatePlanJson: fn must yield a plain object');
  atomicWriteJsonSync(planJsonPath(parentRoot), stampSchemaVersion(out));
  return out;
}

/**
 * The fork point recorded for a limb, or `null` when none is recorded.
 *
 * This answers ONLY "was it recorded?". It deliberately does not fall back to
 * `plan.base`: the caller has to decide that, because the two are different
 * facts — a recorded fork point is where the worktree really branched, while
 * `plan.base` is where the plan was written, and a plan whose limbs predate
 * this field must be distinguishable from one whose fork point equals the base.
 * Pure.
 *
 * @param {object|null|undefined} planJson
 * @param {string} limb
 * @returns {string|null}
 */
export function forkPointForLimb(planJson, limb) {
  if (!planJson || typeof planJson !== 'object' || typeof limb !== 'string') return null;
  const limbs = Array.isArray(planJson.limbs) ? planJson.limbs : [];
  const entry = limbs.find((l) => l && typeof l === 'object' && l.limb === limb);
  const fp = entry?.forkPoint;
  return typeof fp === 'string' && fp.trim() ? fp.trim() : null;
}

/**
 * Session (window) name recorded for a limb, or `null`.
 *
 * Accepts the two shapes seen live: `run.json.windows[limb]` /
 * `run.json.windowReuse[limb]` as either a string `"<session> @ <path>"`
 * (Ontology 2026-08-31 form) or an object `{ session|name|to, worktreePath }`.
 * Pure.
 *
 * @param {object|null|undefined} runJson
 * @param {string} limb
 * @returns {string|null}
 */
export function windowForLimb(runJson, limb) {
  if (!runJson || typeof runJson !== 'object' || typeof limb !== 'string') return null;
  const table = (runJson.windows && typeof runJson.windows === 'object' && runJson.windows[limb] !== undefined)
    ? runJson.windows
    : runJson.windowReuse;
  const entry = table && typeof table === 'object' ? table[limb] : undefined;
  if (typeof entry === 'string') {
    const name = entry.split('@')[0].trim();
    return name || null;
  }
  if (entry && typeof entry === 'object') {
    const name = entry.session ?? entry.name ?? entry.to;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  }
  return null;
}
