/**
 * Shared child_process mocking helpers for vitest.
 *
 * Extracted from 17 in-line `vi.mock('node:child_process', ...)` blocks
 * (see backlog #7, v4.8.0). Tests opt in by importing these factories —
 * existing inline mocks continue to work unchanged.
 *
 * Usage:
 *   import { vi } from 'vitest';
 *   import { commandRouter, mockChildProcess } from '../utils/spawn-mock.js';
 *
 *   vi.mock('node:child_process', () => mockChildProcess({
 *     execSync: vi.fn(commandRouter({
 *       'git rev-parse HEAD': 'abc1234',
 *       'git status --porcelain': '',
 *     }, '')),
 *   }));
 *
 * @module tests/utils/spawn-mock
 */

/**
 * Normalise routes input into a Map.
 *
 * @param {Record<string, unknown> | Map<string, unknown>} routes
 * @returns {Map<string, unknown>}
 */
function toMap(routes) {
  if (routes instanceof Map) return routes;
  return new Map(Object.entries(routes ?? {}));
}

/**
 * Resolve a route value: if it's a function, call it with the supplied args;
 * otherwise return it as-is.
 *
 * @param {unknown} value
 * @param {unknown[]} args
 * @returns {unknown}
 */
function resolveValue(value, args) {
  return typeof value === 'function' ? value(...args) : value;
}

/**
 * Build an execSync-compatible router.
 *
 * @param {Record<string, unknown> | Map<string, unknown>} routes
 *   Command string → response (string) or function `(cmd) => string`.
 * @param {string | ((cmd: string) => string) | (() => never)} [fallback]
 *   Returned (or thrown) when no route matches. Defaults to empty string.
 * @returns {(cmd: string) => string}
 */
export function commandRouter(routes, fallback = '') {
  const table = toMap(routes);
  return (cmd) => {
    if (table.has(cmd)) {
      return /** @type {string} */ (resolveValue(table.get(cmd), [cmd]));
    }
    return /** @type {string} */ (resolveValue(fallback, [cmd]));
  };
}

/**
 * Build an execFileSync-compatible router. Matches on `${file} ${args.join(' ')}`.
 *
 * @param {Record<string, unknown> | Map<string, unknown>} routes
 * @param {string | ((file: string, args: string[]) => string)} [fallback]
 * @returns {(file: string, args?: string[]) => string}
 */
export function execFileRouter(routes, fallback = '') {
  const table = toMap(routes);
  return (file, args = []) => {
    const key = args.length ? `${file} ${args.join(' ')}` : file;
    if (table.has(key)) {
      return /** @type {string} */ (resolveValue(table.get(key), [file, args]));
    }
    return /** @type {string} */ (resolveValue(fallback, [file, args]));
  };
}

/**
 * Build a spawnSync-compatible router. Returns the canonical
 * `{ status, stdout, stderr }` shape that callers expect.
 *
 * Route values may be:
 *   - string                                 → stdout, status 0
 *   - { status?, stdout?, stderr? }          → merged on top of defaults
 *   - (file, args) => string | object        → resolved then normalised
 *
 * @param {Record<string, unknown> | Map<string, unknown>} routes
 * @param {unknown} [fallback]
 * @returns {(file: string, args?: string[]) => { status: number, stdout: string, stderr: string }}
 */
export function spawnSyncRouter(routes, fallback = '') {
  const table = toMap(routes);
  return (file, args = []) => {
    const key = args.length ? `${file} ${args.join(' ')}` : file;
    const raw = table.has(key)
      ? resolveValue(table.get(key), [file, args])
      : resolveValue(fallback, [file, args]);
    return normaliseSpawnResult(raw);
  };
}

/**
 * @param {unknown} raw
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function normaliseSpawnResult(raw) {
  if (typeof raw === 'string') {
    return { status: 0, stdout: raw, stderr: '' };
  }
  if (raw && typeof raw === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (raw);
    return {
      status: typeof obj.status === 'number' ? obj.status : 0,
      stdout: obj.stdout != null ? String(obj.stdout) : '',
      stderr: obj.stderr != null ? String(obj.stderr) : '',
    };
  }
  return { status: 0, stdout: '', stderr: '' };
}

/**
 * Build the factory object passed to `vi.mock('node:child_process', () => ...)`.
 * Only the keys explicitly provided appear on the result, so callers can leave
 * untouched exports referring to the real implementation.
 *
 * @param {{ execSync?: unknown, execFileSync?: unknown, spawnSync?: unknown }} spies
 * @returns {Record<string, unknown>}
 */
export function mockChildProcess(spies) {
  /** @type {Record<string, unknown>} */
  const factory = {};
  if (spies.execSync !== undefined) factory.execSync = spies.execSync;
  if (spies.execFileSync !== undefined) factory.execFileSync = spies.execFileSync;
  if (spies.spawnSync !== undefined) factory.spawnSync = spies.spawnSync;
  return factory;
}
