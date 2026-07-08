#!/usr/bin/env node
/**
 * SessionStart hook — Auto-Learning Pipeline status check.
 * Reads autoLearning config and marker, reports registration method and status.
 * If schedule was registered as "hint-only" (install.sh fallback), prompts
 * the user to complete registration in the current session.
 * Runs once per session (hooks.json: once: true).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { createErrorHandler, getHomeDir } from '../../lib/core/hook-utils.js';
import { detectInstallMode, NATIVE_UPDATE_HINT } from '../../lib/core/install-mode.js';
import { isMainEntry } from './_dispatcher-utils.js';

/**
 * Read the registration marker if it exists.
 *
 * @param {string} artibotDir
 * @returns {{ method: string, schedule: string } | null}
 */
function readMarker(artibotDir) {
  const markerPath = path.join(artibotDir, 'auto-learning-registered.json');
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Determine if the registration method is actually active (vs hint-only).
 *
 * @param {string} method
 * @returns {boolean}
 */
function isActiveMethod(method) {
  return ['claude-schedule', 'crontab', 'schtasks'].includes(method);
}

/**
 * Build the marker-status guidance lines, branching the manual-registration
 * hints by install mode (B4). A NATIVE marketplace install must NOT be told to
 * run `~/.claude/artibot/install.sh` or the legacy setup script — those paths
 * do not exist under a marketplace install; the correct action is the native
 * update command. Ambiguous mode stays conservative and uses the legacy text.
 *
 * @param {{ method: string } | null} marker
 * @param {'native'|'legacy'|'ambiguous'} mode
 * @returns {string[]}
 */
export function buildRegistrationLines(marker, mode) {
  if (!marker) {
    // No marker at all — schedule was never registered.
    if (mode === 'native') {
      return [
        `[auto-learn] Schedule not registered. Update via: ${NATIVE_UPDATE_HINT}`,
        '[auto-learn]   or use the CronCreate tool in this session.',
      ];
    }
    return ['[auto-learn] Schedule not registered. Run: bash ~/.claude/artibot/install.sh'];
  }

  if (!isActiveMethod(marker.method)) {
    // Marker exists but schedule not actually registered (hint-only fallback).
    const lines = [
      `[auto-learn] Schedule pending (method: ${marker.method}). To activate:`,
      '[auto-learn]   Option 1: Use CronCreate tool in this session',
    ];
    lines.push(
      mode === 'native'
        ? `[auto-learn]   Option 2: ${NATIVE_UPDATE_HINT}`
        : '[auto-learn]   Option 2: node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule',
    );
    return lines;
  }

  // Active registration.
  return [`[auto-learn] Registered via ${marker.method}`];
}

/**
 * Build the pipeline status header line. The config being `enabled: true` does
 * NOT mean the nightly schedule is actually registered with the OS — that only
 * holds when the marker records an active method (claude-schedule|crontab|
 * schtasks). When there is no marker, or the marker is a hint-only/inactive
 * fallback, the header is honest about the gap and points at the manual runner
 * instead of implying an active nightly pipeline. Pipeline logic is unchanged;
 * this only fixes what the user is told.
 *
 * @param {{ method: string } | null} marker
 * @param {{ schedule: string, stages: string, maxChanges: number, dryRun: string }} meta
 * @returns {string}
 */
export function buildStatusHeader(marker, meta) {
  const { schedule, stages, maxChanges, dryRun } = meta;
  const tail = `schedule: ${schedule} | stages: ${stages} | max: ${maxChanges}${dryRun}`;
  const active = marker ? isActiveMethod(marker.method) : false;
  if (active) {
    return `[auto-learn] Pipeline ON | ${tail}`;
  }
  return (
    '[auto-learn] Pipeline enabled in config but nightly schedule is NOT OS-registered ' +
    '— run manually: node scripts/run-auto-learning.js | ' +
    tail
  );
}

async function main() {
  const raw = await readStdin();
  parseJSON(raw);

  // Load config
  const configPath = resolveConfigPath('artibot.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[auto-learn] config unreadable: ${err?.message || err}, pipeline status unknown\n`,
    );
    return;
  }

  const autoLearn = config.autoLearning;
  if (!autoLearn) return;

  if (!autoLearn.enabled) {
    process.stderr.write('[auto-learn] Pipeline disabled. Enable in artibot.config.json > autoLearning.enabled\n');
    return;
  }

  const stages = Array.isArray(autoLearn.pipeline)
    ? autoLearn.pipeline.join(', ')
    : 'all';
  const schedule = autoLearn.schedule || '0 3 * * *';
  const dryRun = autoLearn.dryRun ? ' (DRY RUN)' : '';
  const maxChanges = autoLearn.maxChangesPerRun ?? 10;

  const artibotDir = path.dirname(configPath);
  const marker = readMarker(artibotDir);

  // Branch manual-registration guidance by install mode (B4). artibotDir is the
  // running plugin root; under a native marketplace install it resolves inside
  // the plugin cache, so detectInstallMode returns 'native' and the hints point
  // at `/plugin marketplace update artibot` instead of the legacy install.sh.
  const { mode } = detectInstallMode({ pluginRoot: artibotDir, home: getHomeDir() });

  const lines = [
    buildStatusHeader(marker, { schedule, stages, maxChanges, dryRun }),
    ...buildRegistrationLines(marker, mode),
  ];

  writeStdout({ message: lines.join('\n') });
}

// Only drive stdin when invoked as a hook child process — importing the module
// (unit tests) must not consume stdin. Preserves never-throw/exit0 contract.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('auto-learning-check', { exit: true }));
}
