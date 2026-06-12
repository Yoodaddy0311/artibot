/**
 * Preset packs — purpose-grouped activation presets of in-plugin skills and
 * commands. A "pack" lets a vibe-coder verify/activate a curated bundle in one
 * shot (`/install --pack vibe`) instead of hunting individual members.
 *
 * DATA POLICY (CRITICAL): 100% local. This module performs ZERO network I/O and
 * ZERO file copying. A pack is NOT a downloadable bundle — it is a named list of
 * skills/commands that ALREADY ship inside the Artibot plugin. "Applying" a pack
 * here means: (a) confirm each member exists on disk, (b) report members that
 * are missing (warn + skip, never throw), (c) return a structured summary. If a
 * future remote-extension installer is added, pack application can be extended
 * to drive it — but that is an explicit separate task, not this module.
 *
 * Design constraints (mirror lib/core/model-catalog.js):
 *   - Reads frozen pack DATA from `config.packs` (injected by the caller); the
 *     module never loads config itself.
 *   - Only filesystem touch is read-only existence checks under the plugin root.
 *   - Never throws: malformed input yields safe empty results / nulls.
 *   - Immutable: returned objects are deep-frozen.
 *   - Functions < 50 lines, file < 800 lines.
 *
 * @module lib/core/preset-packs
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { getPluginRoot } from './platform.js';

/**
 * Recursively freeze an object/array so callers can read but never mutate the
 * returned report data.
 *
 * @param {*} obj - Value to freeze (non-objects pass through unchanged).
 * @returns {*} The same reference, now deeply frozen.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Extract the `packs` data object from a config, skipping the `_comment` key and
 * any non-object entries. Returns an empty object when packs are absent so older
 * configs (no `packs` section) degrade to "no packs" rather than throwing.
 *
 * @param {object} [config] - The loaded artibot config (or any shape).
 * @returns {Record<string, {description?: string, skills?: string[], commands?: string[]}>}
 */
function readPacksData(config) {
  const raw = config && typeof config === 'object' ? config.packs : null;
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [name, def] of Object.entries(raw)) {
    if (name.startsWith('_')) continue; // skip `_comment` and friends
    if (!def || typeof def !== 'object') continue;
    out[name] = def;
  }
  return out;
}

/**
 * Absolute on-disk path for a pack member of a given kind.
 *
 * @param {'skill'|'command'} kind
 * @param {string} member - Bare member name (e.g. "vibe-coding", "doctor").
 * @param {string} [pluginRoot] - Override for tests; defaults to getPluginRoot().
 * @returns {string} Absolute path to the member's SKILL.md or command markdown.
 */
function memberPath(kind, member, pluginRoot = getPluginRoot()) {
  if (kind === 'skill') {
    return path.join(pluginRoot, 'skills', member, 'SKILL.md');
  }
  return path.join(pluginRoot, 'commands', `${member}.md`);
}

/**
 * List available packs as lightweight summaries (no disk access). Safe on a
 * config that has no `packs` section — returns `[]`.
 *
 * @param {object} [config] - Loaded artibot config.
 * @returns {ReadonlyArray<{name: string, description: string, skillCount: number, commandCount: number}>}
 */
export function listPacks(config) {
  const packs = readPacksData(config);
  const out = Object.entries(packs).map(([name, def]) => ({
    name,
    description: typeof def.description === 'string' ? def.description : '',
    skillCount: Array.isArray(def.skills) ? def.skills.length : 0,
    commandCount: Array.isArray(def.commands) ? def.commands.length : 0,
  }));
  return deepFreeze(out);
}

/**
 * Resolve a single pack by name into its full member list, with each member
 * tagged by whether it currently exists on disk. Unknown pack → `null`. Missing
 * members are reported (`exists: false`), never thrown.
 *
 * @param {string} name - Pack name (e.g. "vibe").
 * @param {object} [config] - Loaded artibot config.
 * @param {{pluginRoot?: string}} [options] - `pluginRoot` override for tests.
 * @returns {Readonly<{
 *   name: string,
 *   description: string,
 *   skills: ReadonlyArray<{name: string, exists: boolean}>,
 *   commands: ReadonlyArray<{name: string, exists: boolean}>
 * }> | null}
 */
export function resolvePack(name, config, options = {}) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const def = readPacksData(config)[name];
  if (!def) return null;
  const root = options.pluginRoot || getPluginRoot();
  const tag = (kind) => (member) => ({
    name: member,
    exists: existsSync(memberPath(kind, member, root)),
  });
  const skills = (Array.isArray(def.skills) ? def.skills : []).map(tag('skill'));
  const commands = (Array.isArray(def.commands) ? def.commands : []).map(tag('command'));
  return deepFreeze({
    name,
    description: typeof def.description === 'string' ? def.description : '',
    skills,
    commands,
  });
}

/**
 * "Apply" a pack: verify every member exists and produce a structured summary.
 * In the current (local-only) architecture this performs NO file copy and NO
 * network call — applying == verifying + reporting. `dryRun` is accepted for
 * forward-compatibility and currently has no behavioral difference (there are no
 * side effects to suppress); it is echoed back in the report for callers/tests.
 *
 * @param {string} name - Pack name.
 * @param {object} [config] - Loaded artibot config.
 * @param {{dryRun?: boolean, pluginRoot?: string}} [options]
 * @returns {Readonly<{
 *   ok: boolean,
 *   pack: string | null,
 *   dryRun: boolean,
 *   description: string,
 *   applied: ReadonlyArray<{kind: 'skill'|'command', name: string}>,
 *   missing: ReadonlyArray<{kind: 'skill'|'command', name: string}>,
 *   warnings: ReadonlyArray<string>
 * }>}
 */
export function applyPack(name, config, options = {}) {
  const dryRun = options.dryRun !== false; // default true: no side effects ever here
  const resolved = resolvePack(name, config, { pluginRoot: options.pluginRoot });
  if (!resolved) {
    return deepFreeze({
      ok: false,
      pack: typeof name === 'string' ? name : null,
      dryRun,
      description: '',
      applied: [],
      missing: [],
      warnings: [`unknown pack: ${typeof name === 'string' ? name : '(invalid)'}`],
    });
  }
  const applied = [];
  const missing = [];
  const warnings = [];
  const sort = (kind) => (m) => {
    const entry = { kind, name: m.name };
    if (m.exists) {
      applied.push(entry);
    } else {
      missing.push(entry);
      warnings.push(`${kind} not found on disk, skipped: ${m.name}`);
    }
  };
  resolved.skills.forEach(sort('skill'));
  resolved.commands.forEach(sort('command'));
  return deepFreeze({
    ok: true,
    pack: resolved.name,
    dryRun,
    description: resolved.description,
    applied,
    missing,
    warnings,
  });
}

export const _internals = Object.freeze({
  readPacksData,
  memberPath,
  deepFreeze,
});
