/**
 * One-shot Phase A migration helper.
 *
 * Walks the legacy memory-manager stores and tags every entry with a `layer`
 * attribute based on its type:
 *   - preference | error → semantic
 *   - context | command  → episodic
 *
 * Idempotent: entries already carrying `migratedAt` are skipped. On a
 * corrupt store the helper backs up the file to `*.corrupted.json` and
 * writes a fresh empty store in its place, so migration never blocks
 * subsequent runs.
 *
 * Zero external deps. Atomic writes only.
 *
 * @module lib/learning/memory/migrate
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  atomicWriteJson,
  ensureDir,
  readJsonFile,
} from '../../core/file.js';

const TYPE_TO_LAYER = Object.freeze({
  preference: 'semantic',
  error: 'semantic',
  context: 'episodic',
  command: 'episodic',
});

const LEGACY_FILES = Object.freeze([
  'user-preferences.json',
  'project-contexts.json',
  'command-history.json',
  'error-patterns.json',
]);

/**
 * Shape of a per-file migration report returned by runMigration.
 * @typedef {object} MigrationFileReport
 * @property {string} file
 * @property {string} status — 'migrated' | 'skipped' | 'corrupted' | 'missing'
 * @property {number} tagged
 * @property {number} total
 * @property {string} [backup]
 * @property {string} [error]
 */

/**
 * Pick the layer for a legacy entry based on its `type` field.
 * @param {object} entry
 * @returns {string}
 */
function inferLayer(entry) {
  if (entry?.layer) return entry.layer;
  return TYPE_TO_LAYER[entry?.type] ?? 'episodic';
}

/**
 * Tag an entry with layer + migratedAt. Immutable.
 * @param {object} entry
 * @param {string} iso
 * @returns {object}
 */
function tagEntry(entry, iso) {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.migratedAt) return entry;
  return {
    ...entry,
    layer: inferLayer(entry),
    migratedAt: iso,
  };
}

/**
 * Back up a corrupt file next to itself as `.corrupted.json` and write a
 * fresh empty store at the original path. Best-effort.
 * @param {string} filePath
 * @param {string} iso
 * @returns {Promise<string|null>} backup path on success
 */
async function quarantineCorrupt(filePath, iso) {
  const backup = filePath.replace(/\.json$/, '') + `.corrupted.${iso.slice(0, 10)}.json`;
  try {
    await fs.copyFile(filePath, backup);
  } catch {
    /* source may not exist — fine, we'll still write a fresh store */
  }
  try {
    await atomicWriteJson(filePath, {
      entries: [],
      metadata: { createdAt: iso, recoveredAt: iso },
    });
  } catch {
    /* last-ditch: swallow */
  }
  return backup;
}

/**
 * Migrate a single legacy store file in place. Idempotent.
 * @param {string} filePath
 * @param {() => number} [now]
 * @returns {Promise<MigrationFileReport>}
 */
export async function migrateFile(filePath, now = () => Date.now()) {
  const iso = new Date(now()).toISOString();
  let raw;
  try {
    raw = await readJsonFile(filePath);
  } catch (err) {
    const backup = await quarantineCorrupt(filePath, iso);
    return {
      file: filePath,
      status: 'corrupted',
      tagged: 0,
      total: 0,
      backup,
      error: err?.message ?? String(err),
    };
  }

  if (raw === null) {
    return { file: filePath, status: 'missing', tagged: 0, total: 0 };
  }

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
    const backup = await quarantineCorrupt(filePath, iso);
    return {
      file: filePath,
      status: 'corrupted',
      tagged: 0,
      total: 0,
      backup,
      error: 'malformed store (entries not array)',
    };
  }

  const total = raw.entries.length;
  if (total === 0) {
    return { file: filePath, status: 'skipped', tagged: 0, total: 0 };
  }

  let tagged = 0;
  const migrated = raw.entries.map((entry) => {
    if (entry?.migratedAt) return entry;
    tagged += 1;
    return tagEntry(entry, iso);
  });

  if (tagged === 0) {
    return { file: filePath, status: 'skipped', tagged: 0, total };
  }

  const nextStore = {
    ...raw,
    entries: migrated,
    metadata: {
      ...(raw.metadata ?? {}),
      migratedAt: iso,
      migrationVersion: 'phase-a-v1',
    },
  };
  await atomicWriteJson(filePath, nextStore);
  return { file: filePath, status: 'migrated', tagged, total };
}

/**
 * Run the full Phase A migration across all legacy memory store files under
 * a directory. Safe to call on every process start — entries already bearing
 * `migratedAt` are left untouched.
 *
 * @param {object} options
 * @param {string} options.memoryDir - Absolute path to memory dir (containing the four legacy files)
 * @param {() => number} [options.now]
 * @returns {Promise<{reports: MigrationFileReport[], totalTagged: number}>}
 */
export async function runMigration({ memoryDir, now = () => Date.now() } = {}) {
  if (!memoryDir || typeof memoryDir !== 'string') {
    throw new Error('runMigration: memoryDir required');
  }
  await ensureDir(memoryDir);

  const reports = [];
  let totalTagged = 0;
  for (const name of LEGACY_FILES) {
    const p = path.join(memoryDir, name);
     
    const report = await migrateFile(p, now);
    reports.push(report);
    totalTagged += report.tagged;
  }
  return { reports, totalTagged };
}

export const MIGRATION_TYPE_TO_LAYER = TYPE_TO_LAYER;
