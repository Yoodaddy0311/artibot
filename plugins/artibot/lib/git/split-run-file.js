/**
 * `<parentRoot>/.artibot/split/run.json` — the leader's run ledger for one
 * `/split` campaign (stage times, window reuse map, suspend block).
 *
 * `plan.json` is what `/split plan` writes and never changes; `run.json` is
 * the mutable companion the scripts under `scripts/split/` read and update.
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
  const p = runJsonPath(parentRoot);
  let text;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`readRunJson: ${p} is not a JSON object`);
  }
  return parsed;
}

/**
 * Write `run.json` atomically (creates `.artibot/split/` as needed).
 *
 * @param {string} parentRoot
 * @param {object} obj
 * @returns {string} path written
 */
export function writeRunJson(parentRoot, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('writeRunJson: obj must be a plain object');
  const p = runJsonPath(parentRoot);
  atomicWriteJsonSync(p, obj);
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
