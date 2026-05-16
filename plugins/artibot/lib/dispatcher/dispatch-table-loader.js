/**
 * Dispatch table loader.
 *
 * Reads `hooks/dispatch-table.json` (single source of truth) and resolves
 * handler `script` strings to absolute paths under `scripts/hooks/`. Each
 * dispatcher imports this module at startup and calls `loadDispatchTable(slot)`
 * to obtain its `HOOKS` array — no more drift between five hand-maintained
 * tables.
 *
 * Design contract:
 *
 *   1. Single read, single parse, in-memory cache. Module-level resolution is
 *      idempotent — repeated `loadDispatchTable()` calls hit the cache and
 *      never re-read disk.
 *   2. Fail-fast at load. A malformed JSON / missing required field throws
 *      synchronously during the dispatcher's import phase. This surfaces
 *      configuration bugs at startup rather than mid-flight, exactly what the
 *      "hook errors first" policy requires.
 *   3. Backward-compatible shape. The returned objects mirror the in-source
 *      `HOOKS` arrays the dispatchers historically used:
 *        { name, script (absolute path), timeoutMs, args?, tools? }
 *      so dispatcher logic stays a one-line swap.
 *   4. NEVER mutates the parsed table — every call returns fresh handler
 *      objects (defensive cloning) so a dispatcher cannot corrupt the cache
 *      for another slot.
 *
 * @module lib/dispatcher/dispatch-table-loader
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// plugins/artibot/lib/dispatcher → plugins/artibot
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const TABLE_PATH = path.join(PLUGIN_ROOT, 'hooks', 'dispatch-table.json');
const HOOKS_DIR = path.join(PLUGIN_ROOT, 'scripts', 'hooks');

const REQUIRED_HANDLER_FIELDS = ['name', 'script', 'timeoutMs'];

let _cache = null;

/**
 * Read + parse + validate the dispatch table from disk exactly once.
 * @returns {object} parsed table with the original JSON shape
 */
function readTable() {
  if (_cache) return _cache;

  let raw;
  try {
    raw = fs.readFileSync(TABLE_PATH, 'utf-8');
  } catch (err) {
    throw new Error(
      `dispatch-table-loader: cannot read ${TABLE_PATH}: ${err.message}`,
      { cause: err },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `dispatch-table-loader: invalid JSON in ${TABLE_PATH}: ${err.message}`,
      { cause: err },
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('dispatch-table-loader: table must be an object');
  }
  if (!parsed.slots || typeof parsed.slots !== 'object') {
    throw new Error('dispatch-table-loader: table.slots must be an object');
  }

  _cache = parsed;
  return parsed;
}

/**
 * Validate a single handler entry. Throws on first violation.
 * @param {object} h
 * @param {string} slotName
 * @param {number} index
 */
function validateHandler(h, slotName, index) {
  if (!h || typeof h !== 'object') {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers[${index}] is not an object`,
    );
  }
  for (const f of REQUIRED_HANDLER_FIELDS) {
    if (h[f] === undefined || h[f] === null) {
      throw new Error(
        `dispatch-table-loader: ${slotName}.handlers[${index}] missing required field "${f}"`,
      );
    }
  }
  if (typeof h.name !== 'string' || h.name.length === 0) {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers[${index}].name must be non-empty string`,
    );
  }
  if (typeof h.script !== 'string' || h.script.length === 0) {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers[${index}].script must be non-empty string`,
    );
  }
  if (typeof h.timeoutMs !== 'number' || h.timeoutMs <= 0) {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers[${index}].timeoutMs must be a positive number`,
    );
  }
  if (h.args !== undefined && !Array.isArray(h.args)) {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers[${index}].args must be an array when present`,
    );
  }
  if (h.tools !== undefined && !Array.isArray(h.tools)) {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers[${index}].tools must be an array when present`,
    );
  }
}

/**
 * Load a slot's handler array. Each returned handler is a fresh object whose
 * `script` is an absolute path under `scripts/hooks/`.
 *
 * @param {string} slotName e.g. "SessionStart"
 * @returns {Array<{name: string, script: string, timeoutMs: number, args?: string[], tools?: string[]}>}
 */
export function loadDispatchTable(slotName) {
  if (typeof slotName !== 'string' || !slotName) {
    throw new Error('dispatch-table-loader: slotName must be a non-empty string');
  }

  const table = readTable();
  const slot = table.slots[slotName];
  if (!slot) {
    throw new Error(`dispatch-table-loader: unknown slot "${slotName}"`);
  }
  if (!Array.isArray(slot.handlers)) {
    throw new Error(
      `dispatch-table-loader: ${slotName}.handlers must be an array`,
    );
  }

  return slot.handlers.map((h, i) => {
    validateHandler(h, slotName, i);
    const resolved = {
      name: h.name,
      script: path.join(HOOKS_DIR, h.script),
      timeoutMs: h.timeoutMs,
    };
    if (h.args) resolved.args = [...h.args];
    if (h.tools) resolved.tools = [...h.tools];
    return resolved;
  });
}

/**
 * Return the raw slot metadata (label, strategy, dispatcher path) without
 * resolving handler paths. Useful for tests and tooling.
 * @param {string} slotName
 * @returns {object}
 */
export function getSlotMetadata(slotName) {
  const table = readTable();
  const slot = table.slots[slotName];
  if (!slot) {
    throw new Error(`dispatch-table-loader: unknown slot "${slotName}"`);
  }
  const { handlers, ...meta } = slot;
  void handlers;
  return { ...meta };
}

/**
 * List every slot name declared in the table.
 * @returns {string[]}
 */
export function listSlots() {
  const table = readTable();
  return Object.keys(table.slots);
}

/**
 * Absolute path to the dispatch-table.json file. Tests use this to verify
 * the file location contract.
 * @returns {string}
 */
export function getTablePath() {
  return TABLE_PATH;
}

/**
 * Absolute path to the hooks script directory (scripts/hooks).
 * @returns {string}
 */
export function getHooksDir() {
  return HOOKS_DIR;
}

/**
 * Reset the in-memory cache. Test-only helper — production code reads once
 * at module load and never invalidates.
 */
export function _resetCacheForTests() {
  _cache = null;
}
