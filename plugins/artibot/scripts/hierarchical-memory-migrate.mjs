#!/usr/bin/env node
/**
 * Hierarchical Memory Migration CLI (v3.4.0)
 *
 * Usage:
 *   node scripts/hierarchical-memory-migrate.mjs --dry-run
 *   node scripts/hierarchical-memory-migrate.mjs --apply
 *   node scripts/hierarchical-memory-migrate.mjs --status
 *   node scripts/hierarchical-memory-migrate.mjs --rollback
 *
 * Flags (mutually exclusive, pick exactly one):
 *   --dry-run   Report promotion/demotion candidates without writing.
 *   --apply     Run the actual migration (delegates to lib/learning/memory/migrate.js).
 *   --status    Print migratedAt + layer distribution for each legacy store.
 *   --rollback  Restore the most recent pre-migration backup.
 *
 * Optional:
 *   --memory-dir <path>   Override memory dir (defaults to ~/.claude/artibot/memory).
 *   --help                Print this banner.
 *
 * Safety model:
 *   Before --apply the CLI copies the current memory dir to
 *   <memory-dir>/backup-<ISO-timestamp>/. If the copy fails migration aborts.
 *   --rollback picks the newest backup dir and restores it atomically
 *   (backup -> <memory-dir>.pre-rollback.<ts>/ is kept for one-step undo).
 *
 * Zero deps. ESM. Exits non-zero on failure.
 *
 * @module scripts/hierarchical-memory-migrate
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isMainEntry } from './hooks/_main-entry.js';

const LEGACY_FILES = Object.freeze([
  'user-preferences.json',
  'project-contexts.json',
  'command-history.json',
  'error-patterns.json',
]);

const LAYERS = Object.freeze(['working', 'episodic', 'semantic']);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { mode: null, memoryDir: null, help: false };
  const modeFlags = {
    '--dry-run': 'dry-run',
    '--apply': 'apply',
    '--status': 'status',
    '--rollback': 'rollback',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (modeFlags[token]) {
      if (args.mode) {
        throw new Error(`conflicting mode flags: ${args.mode} and ${modeFlags[token]}`);
      }
      args.mode = modeFlags[token];
    } else if (token === '--memory-dir') {
      args.memoryDir = argv[i + 1];
      i += 1;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token.startsWith('--')) {
      throw new Error(`unknown flag: ${token}`);
    }
  }
  return args;
}

export function defaultMemoryDir() {
  return path.join(os.homedir(), '.claude', 'artibot', 'memory');
}

export function timestamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function copyDirRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
       
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
       
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Layer distribution + promotion/demotion preview
// ---------------------------------------------------------------------------

const TYPE_TO_LAYER = Object.freeze({
  preference: 'semantic',
  error: 'semantic',
  context: 'episodic',
  command: 'episodic',
});

function inferLayer(entry) {
  if (entry?.layer) return entry.layer;
  return TYPE_TO_LAYER[entry?.type] ?? 'episodic';
}

export function summarizeStore(store) {
  const summary = {
    total: 0,
    migrated: 0,
    byLayer: { working: 0, episodic: 0, semantic: 0 },
    promotionCandidates: 0,
    demotionCandidates: 0,
  };
  if (!store || !Array.isArray(store.entries)) return summary;
  for (const entry of store.entries) {
    if (!entry || typeof entry !== 'object') continue;
    summary.total += 1;
    if (entry.migratedAt) summary.migrated += 1;
    const layer = inferLayer(entry);
    if (LAYERS.includes(layer)) summary.byLayer[layer] += 1;
    // Promotion heuristic (dry-run preview): type=preference/error AND occurrences>=3
    if (
      (entry.type === 'preference' || entry.type === 'error') &&
      (entry.occurrences ?? 0) >= 3 &&
      entry.layer !== 'semantic'
    ) {
      summary.promotionCandidates += 1;
    }
    // Demotion heuristic: idle >= 180d AND layer=semantic
    if (entry.layer === 'semantic' && entry.lastUsedAt) {
      const idleDays = (Date.now() - Date.parse(entry.lastUsedAt)) / 864e5;
      if (idleDays >= 180) summary.demotionCandidates += 1;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export async function runStatus({ memoryDir, log = console.log }) {
  if (!(await pathExists(memoryDir))) {
    log(`[status] memory dir not found: ${memoryDir}`);
    return { ok: true, missing: true, reports: [] };
  }
  const reports = [];
  for (const name of LEGACY_FILES) {
    const p = path.join(memoryDir, name);
     
    const store = await readJsonSafe(p);
    const summary = summarizeStore(store);
    const migratedAt = store?.metadata?.migratedAt ?? null;
    reports.push({ file: name, migratedAt, ...summary });
    log(
      `[status] ${name} migratedAt=${migratedAt ?? 'never'} ` +
        `total=${summary.total} migrated=${summary.migrated} ` +
        `working=${summary.byLayer.working} episodic=${summary.byLayer.episodic} ` +
        `semantic=${summary.byLayer.semantic}`
    );
  }
  return { ok: true, reports };
}

export async function runDryRun({ memoryDir, log = console.log }) {
  if (!(await pathExists(memoryDir))) {
    log(`[dry-run] memory dir not found: ${memoryDir} (nothing to preview)`);
    return { ok: true, missing: true, reports: [] };
  }
  const reports = [];
  for (const name of LEGACY_FILES) {
    const p = path.join(memoryDir, name);
     
    const store = await readJsonSafe(p);
    const summary = summarizeStore(store);
    reports.push({ file: name, ...summary });
    log(
      `[dry-run] ${name} total=${summary.total} ` +
        `promotions=${summary.promotionCandidates} demotions=${summary.demotionCandidates}`
    );
  }
  log('[dry-run] no writes performed.');
  return { ok: true, reports };
}

async function makeBackup(memoryDir, ts) {
  const backupDir = path.join(memoryDir, `backup-${ts}`);
  if (!(await pathExists(memoryDir))) {
    // Nothing to back up; create the dir so apply() still has a target.
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    return backupDir;
  }
  await fs.mkdir(backupDir, { recursive: true });
  const entries = await fs.readdir(memoryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('backup-')) continue;
    const srcPath = path.join(memoryDir, entry.name);
    const destPath = path.join(backupDir, entry.name);
    if (entry.isDirectory()) {
       
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
       
      await fs.copyFile(srcPath, destPath);
    }
  }
  return backupDir;
}

export async function runApply({
  memoryDir,
  log = console.log,
  now = () => Date.now(),
  migrator = null,
}) {
  const ts = timestamp(now());
  let backup;
  try {
    backup = await makeBackup(memoryDir, ts);
    log(`[apply] backup created: ${backup}`);
  } catch (err) {
    log(`[apply] backup failed, aborting: ${err?.message ?? err}`);
    return { ok: false, error: 'backup-failed' };
  }

  let runMigration = migrator;
  if (!runMigration) {
    // Dynamic import so the script stays usable even when the plugin tree is
    // missing (e.g., uninstalled). The Korean path case is handled via
    // pathToFileURL — same pattern used by scripts/utils/index.js.
    const modulePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
      '..',
      'lib',
      'learning',
      'memory',
      'migrate.js'
    );
    try {
      const mod = await import(pathToFileURL(modulePath).href);
      runMigration = mod.runMigration;
    } catch (err) {
      log(`[apply] cannot load migrate.js: ${err?.message ?? err}`);
      return { ok: false, error: 'module-load-failed', backup };
    }
  }

  try {
    const result = await runMigration({ memoryDir, now });
    log(`[apply] migration completed: totalTagged=${result.totalTagged}`);
    for (const r of result.reports) {
      log(`[apply]   ${path.basename(r.file)} status=${r.status} tagged=${r.tagged}/${r.total}`);
    }
    return { ok: true, backup, result };
  } catch (err) {
    log(`[apply] migration failed: ${err?.message ?? err}`);
    return { ok: false, error: 'migration-failed', backup };
  }
}

export async function runRollback({ memoryDir, log = console.log, now = () => Date.now() }) {
  if (!(await pathExists(memoryDir))) {
    log(`[rollback] memory dir not found: ${memoryDir}`);
    return { ok: false, error: 'memory-dir-missing' };
  }
  const entries = await fs.readdir(memoryDir, { withFileTypes: true });
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
    .map((e) => e.name)
    .sort();
  if (backups.length === 0) {
    log('[rollback] no backups found.');
    return { ok: false, error: 'no-backups' };
  }
  const latest = backups[backups.length - 1];
  const backupPath = path.join(memoryDir, latest);
  const preRollbackPath = path.join(memoryDir, `pre-rollback-${timestamp(now())}`);
  await fs.mkdir(preRollbackPath, { recursive: true });

  // Move current legacy files + metadata into pre-rollback keeper.
  for (const name of LEGACY_FILES) {
    const current = path.join(memoryDir, name);
    if (await pathExists(current)) {
       
      await fs.rename(current, path.join(preRollbackPath, name));
    }
  }
  // Copy backup -> memoryDir root (legacy files only).
  for (const name of LEGACY_FILES) {
    const backupFile = path.join(backupPath, name);
    if (await pathExists(backupFile)) {
       
      await fs.copyFile(backupFile, path.join(memoryDir, name));
    }
  }
  log(`[rollback] restored from ${latest}; previous state kept at ${path.basename(preRollbackPath)}`);
  return { ok: true, backup: latest, preRollbackPath };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export function printHelp(log = console.log) {
  log(
    [
      'hierarchical-memory-migrate.mjs (v3.4.0)',
      '',
      'Usage:',
      '  --dry-run          Preview promotions/demotions (no writes)',
      '  --apply            Run migration with automatic backup',
      '  --status           Print migratedAt + layer distribution',
      '  --rollback         Restore the most recent backup',
      '',
      'Options:',
      '  --memory-dir <p>   Override memory dir (default: ~/.claude/artibot/memory)',
      '  --help             This help banner',
    ].join('\n')
  );
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const err = io.err ?? console.error;
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`[migrate] ${e.message}`);
    return 2;
  }
  if (args.help || !args.mode) {
    printHelp(log);
    return args.mode ? 0 : 2;
  }
  const memoryDir = args.memoryDir || defaultMemoryDir();
  switch (args.mode) {
    case 'status': {
      const out = await runStatus({ memoryDir, log });
      return out.ok ? 0 : 1;
    }
    case 'dry-run': {
      const out = await runDryRun({ memoryDir, log });
      return out.ok ? 0 : 1;
    }
    case 'apply': {
      const out = await runApply({ memoryDir, log });
      return out.ok ? 0 : 1;
    }
    case 'rollback': {
      const out = await runRollback({ memoryDir, log });
      return out.ok ? 0 : 1;
    }
    default:
      err(`[migrate] unknown mode: ${args.mode}`);
      return 2;
  }
}

// Execute when invoked directly (not when imported by tests).
const isDirectRun = isMainEntry(import.meta.url);

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error('[migrate] fatal:', e?.stack ?? e);
      process.exit(1);
    }
  );
}
