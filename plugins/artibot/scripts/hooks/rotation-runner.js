#!/usr/bin/env node
/**
 * Retention / rotation runner.
 *
 * Runs once per session (SessionEnd) to keep state files bounded:
 *   - daily-experiences.json        → keep last 30 days
 *   - skill-injection-log.json      → keep last 90 days
 *   - patterns/auto-learn-*.json    → keep last 14 days (delete older files)
 *   - learning-log.json             → keep last 200 entries (already capped, but enforce)
 *
 * Settings come from `artibot.config.json.retention`. Defaults below are used
 * when missing. Failures are logged to stderr but never block.
 *
 * Hook attachment: SessionEnd (low-priority, observability)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIBOT_DIR } from '../../lib/core/config.js';
import { rotateJsonArray, rotatePatternFiles } from '../../lib/core/rotation.js';
import { resolveConfigPath } from '../utils/index.js';
import { isMainEntry } from './_main-entry.js';

const DEFAULTS = Object.freeze({
  dailyExperiencesMaxDays: 30,
  skillInjectionLogMaxDays: 90,
  patternFilesMaxDays: 14,
  learningLogMaxEntries: 200,
});

function loadRetentionConfig() {
  try {
    const cfg = JSON.parse(readFileSync(resolveConfigPath('artibot.config.json'), 'utf-8'));
    return { ...DEFAULTS, ...(cfg?.retention ?? {}) };
  } catch {
    return DEFAULTS;
  }
}

function rotateExperiences(cfg) {
  const p = path.join(ARTIBOT_DIR, 'daily-experiences.json');
  return { file: 'daily-experiences', ...rotateJsonArray(p, { maxAgeDays: cfg.dailyExperiencesMaxDays }) };
}

function rotateInjectionLog(cfg) {
  const p = path.join(ARTIBOT_DIR, 'skill-injection-log.json');
  return {
    file: 'skill-injection-log',
    ...rotateJsonArray(p, { maxAgeDays: cfg.skillInjectionLogMaxDays, timestampField: 'injectedAt' }),
  };
}

function rotatePatterns(cfg) {
  const dir = path.join(ARTIBOT_DIR, 'patterns');
  return { file: 'patterns/', ...rotatePatternFiles(dir, { maxAgeDays: cfg.patternFilesMaxDays }) };
}

function rotateLearningLog(cfg) {
  const p = path.join(ARTIBOT_DIR, 'learning-log.json');
  return {
    file: 'learning-log',
    ...rotateJsonArray(p, { maxEntries: cfg.learningLogMaxEntries, timestampField: 'timestamp' }),
  };
}

export async function main() {
  const cfg = loadRetentionConfig();
  const reports = [
    rotateExperiences(cfg),
    rotateInjectionLog(cfg),
    rotatePatterns(cfg),
    rotateLearningLog(cfg),
  ];

  // Stderr summary (visible in debug log only)
  const summary = reports
    .map((r) => {
      if (r.deleted) return `${r.file}: -${r.deleted.length} files`;
      if (r.rotated) return `${r.file}: -${r.removed} entries`;
      return `${r.file}: no-op`;
    })
    .join(', ');
  process.stderr.write(`[rotation] ${summary}\n`);
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[rotation] failed: ${err?.message ?? err}\n`);
  });
}
