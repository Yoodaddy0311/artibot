/**
 * Extension Manifest Loader — validates and discovers Artibot extensions.
 *
 * Loads `artibot.ext.json` manifests from extension directories under
 * `config.extensions.searchPaths`. Applies strict DATA POLICY enforcement:
 * only `local` and `artibot-swarm` data policies are permitted.
 *
 * DATA POLICY: External plugin connections, third-party DB access, and data
 * exports to non-Artibot endpoints are forbidden. Any extension declaring a
 * `dataPolicy` outside the allowed list is rejected.
 *
 * Zero runtime deps — Node built-ins only. ESM. Korean-path safe.
 *
 * @module lib/core/extension-loader
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Allowed dataPolicy values (MEMORY.md DATA POLICY). */
const ALLOWED_DATA_POLICIES = Object.freeze(['local', 'artibot-swarm']);

/** Required manifest fields. */
const REQUIRED_FIELDS = Object.freeze(['name', 'version', 'artibotVersion', 'dataPolicy']);

/** Optional manifest fields recognized by the loader. */
const OPTIONAL_FIELDS = Object.freeze([
  'agents', 'skills', 'hooks', 'middleware', 'description', 'author', 'homepage',
]);

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/;
const ARTIBOT_VERSION_PATTERN = /^[>=<~^\s]*\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/;

/**
 * Expand leading `~` to the user's home directory.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Validate an `artibot.ext.json` manifest object.
 *
 * @param {object} manifest - Parsed manifest
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
function checkPatterns(manifest, errors) {
  if (typeof manifest.name === 'string' && !NAME_PATTERN.test(manifest.name)) {
    errors.push(`invalid name "${manifest.name}": must match /^[a-z][a-z0-9-]{1,63}$/`);
  }
  if (typeof manifest.version === 'string' && !VERSION_PATTERN.test(manifest.version)) {
    errors.push(`invalid version "${manifest.version}": must be semver (e.g. 1.2.3)`);
  }
  if (typeof manifest.artibotVersion === 'string'
      && !ARTIBOT_VERSION_PATTERN.test(manifest.artibotVersion)) {
    errors.push(`invalid artibotVersion "${manifest.artibotVersion}": must be semver range (e.g. ">=2.8.0")`);
  }
  if (manifest.dataPolicy !== undefined
      && !ALLOWED_DATA_POLICIES.includes(manifest.dataPolicy)) {
    errors.push(
      `invalid dataPolicy "${manifest.dataPolicy}": must be one of ${ALLOWED_DATA_POLICIES.join(', ')}. `
      + `External data policies are forbidden by Artibot DATA POLICY.`
    );
  }
}

function checkArrays(manifest, errors) {
  for (const field of ['agents', 'skills', 'hooks', 'middleware']) {
    if (manifest[field] !== undefined && !Array.isArray(manifest[field])) {
      errors.push(`field "${field}" must be an array when present`);
    }
  }
}

export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be a JSON object'], warnings };
  }

  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      errors.push(`missing required field: "${field}"`);
    }
  }

  checkPatterns(manifest, errors);
  checkArrays(manifest, errors);

  const knownFields = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const key of Object.keys(manifest)) {
    if (!knownFields.has(key)) warnings.push(`unknown field "${key}" (ignored)`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Load and validate a single extension at the given directory.
 *
 * @param {string} extDir - Absolute path to extension dir (contains artibot.ext.json)
 * @returns {Promise<{manifest: object|null, agents: string[], skills: string[], hooks: string[], middleware: string[], errors: string[], warnings: string[], path: string}>}
 */
export async function loadExtension(extDir) {
  const manifestPath = path.join(extDir, 'artibot.ext.json');
  const result = {
    manifest: null, agents: [], skills: [], hooks: [], middleware: [],
    errors: [], warnings: [], path: extDir,
  };

  let raw;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    result.errors.push(`cannot read artibot.ext.json: ${err.message}`);
    return result;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    result.errors.push(`invalid JSON in artibot.ext.json: ${err.message}`);
    return result;
  }

  const validation = validateManifest(manifest);
  result.errors.push(...validation.errors);
  result.warnings.push(...validation.warnings);
  if (!validation.valid) return result;

  result.manifest = manifest;
  result.agents = Array.isArray(manifest.agents) ? [...manifest.agents] : [];
  result.skills = Array.isArray(manifest.skills) ? [...manifest.skills] : [];
  result.hooks = Array.isArray(manifest.hooks) ? [...manifest.hooks] : [];
  result.middleware = Array.isArray(manifest.middleware) ? [...manifest.middleware] : [];
  return result;
}

/**
 * Discover all extensions under config.extensions.searchPaths.
 * Directories are scanned for entries prefixed `artibot-ext-` that contain
 * a valid `artibot.ext.json`. Invalid extensions are returned with errors
 * attached so callers can surface them without crashing.
 *
 * @param {object} config - artibot.config.json parsed
 * @returns {Promise<Array<{manifest: object|null, path: string, errors: string[], warnings: string[], agents: string[], skills: string[], hooks: string[], middleware: string[]}>>}
 */
export async function discoverExtensions(config) {
  const ext = config?.extensions;
  if (!ext || ext.enabled === false) return [];
  const searchPaths = Array.isArray(ext.searchPaths) ? ext.searchPaths : [];
  if (searchPaths.length === 0) return [];

  const allowed = new Set(Array.isArray(ext.allowedDataPolicies) && ext.allowedDataPolicies.length
    ? ext.allowedDataPolicies
    : ALLOWED_DATA_POLICIES);

  const discovered = [];
  for (const rawPath of searchPaths) {
    const dir = path.resolve(expandHome(rawPath));
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('artibot-ext-')) continue;
      const extDir = path.join(dir, entry.name);
      const manifestPath = path.join(extDir, 'artibot.ext.json');
      try {
        const s = await stat(manifestPath);
        if (!s.isFile()) continue;
      } catch {
        continue;
      }
      const loaded = await loadExtension(extDir);
      if (loaded.manifest && !allowed.has(loaded.manifest.dataPolicy)) {
        loaded.errors.push(
          `dataPolicy "${loaded.manifest.dataPolicy}" not allowed by config.extensions.allowedDataPolicies`
        );
        loaded.manifest = null;
      }
      discovered.push(loaded);
    }
  }
  return discovered;
}

export const _internals = Object.freeze({
  ALLOWED_DATA_POLICIES,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  NAME_PATTERN,
  VERSION_PATTERN,
  ARTIBOT_VERSION_PATTERN,
  expandHome,
});
