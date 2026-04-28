#!/usr/bin/env node
/**
 * release-lock.js — Temporarily pause Artibot autopilot during a release window.
 *
 * During a release, autopilot's session-close auto-commit/push can fragment
 * the release commit. This tool backs up the current autopilot.enabled value
 * into a side-car lock file, forces enabled=false for the release window,
 * and restores the original value when released.
 *
 * CLI:
 *   node release-lock.js --acquire [--reason "cowork v0.4.0 release"]
 *   node release-lock.js --release
 *   node release-lock.js --status
 *
 * Exit codes:
 *   0 — success
 *   1 — general error (missing autopilot.json, JSON parse)
 *   2 — lock state conflict (acquire while already locked, release with no lock)
 *   3 — bad arguments
 *
 * Zero dependencies. Node 18+ built-ins only.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const AUTOPILOT_PATH = path.join(REPO_ROOT, '.git', 'autopilot.json');
const LOCK_PATH = path.join(REPO_ROOT, '.git', 'autopilot.lock.json');

const args = process.argv.slice(2);

function parseArgs() {
  const result = { mode: null, reason: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--acquire') result.mode = 'acquire';
    else if (a === '--release') result.mode = 'release';
    else if (a === '--status') result.mode = 'status';
    else if (a === '--reason') {
      result.reason = args[i + 1] || null;
      i += 1;
    }
  }
  return result;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[release-lock] Failed to parse ${file}: ${err.message}`);
    process.exit(1);
  }
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function requireAutopilot() {
  if (!existsSync(AUTOPILOT_PATH)) {
    console.error(`[release-lock] autopilot.json not found at ${AUTOPILOT_PATH}`);
    console.error('[release-lock] Is this a git repo with Artibot autopilot configured?');
    process.exit(1);
  }
  return readJson(AUTOPILOT_PATH);
}

function cmdAcquire(reason) {
  if (existsSync(LOCK_PATH)) {
    const existing = readJson(LOCK_PATH);
    console.error('[release-lock] Lock already exists:');
    console.error(`  acquired at: ${existing.acquiredAt}`);
    console.error(`  reason:      ${existing.reason || '(not specified)'}`);
    console.error('[release-lock] Run --release first, or inspect .git/autopilot.lock.json manually.');
    process.exit(2);
  }

  const autopilot = requireAutopilot();
  const backup = {
    acquiredAt: new Date().toISOString(),
    reason: reason || 'release window',
    previousEnabled: autopilot.enabled === true,
    previousAutoPushOnStop: autopilot.autoPushOnStop === true,
    previousSquashWipOnClose: autopilot.squashWipOnClose === true,
  };

  writeJson(LOCK_PATH, backup);

  const next = {
    ...autopilot,
    enabled: false,
    autoPushOnStop: false,
    squashWipOnClose: false,
  };
  writeJson(AUTOPILOT_PATH, next);

  console.log('RELEASE LOCK ACQUIRED');
  console.log(`  reason:     ${backup.reason}`);
  console.log(`  backup:     ${LOCK_PATH}`);
  console.log(`  autopilot:  enabled=false, autoPushOnStop=false, squashWipOnClose=false`);
  console.log('');
  console.log('To restore autopilot after release:');
  console.log('  node plugins/artibot-cowork/scripts/release-lock.js --release');
}

function cmdRelease() {
  if (!existsSync(LOCK_PATH)) {
    console.error('[release-lock] No lock file found — nothing to release.');
    console.error(`  expected: ${LOCK_PATH}`);
    process.exit(2);
  }

  const backup = readJson(LOCK_PATH);
  const autopilot = requireAutopilot();

  const restored = {
    ...autopilot,
    enabled: backup.previousEnabled === true,
    autoPushOnStop: backup.previousAutoPushOnStop === true,
    squashWipOnClose: backup.previousSquashWipOnClose === true,
  };
  writeJson(AUTOPILOT_PATH, restored);

  rmSync(LOCK_PATH);

  console.log('RELEASE LOCK RELEASED');
  console.log(`  restored:   enabled=${restored.enabled}, autoPushOnStop=${restored.autoPushOnStop}, squashWipOnClose=${restored.squashWipOnClose}`);
  console.log(`  reason was: ${backup.reason || '(not specified)'}`);
  console.log(`  held for:   ${backup.acquiredAt} → ${new Date().toISOString()}`);
}

function cmdStatus() {
  const locked = existsSync(LOCK_PATH);
  const autopilot = existsSync(AUTOPILOT_PATH) ? readJson(AUTOPILOT_PATH) : null;

  console.log('Release lock status');
  console.log(`  lock file:  ${locked ? 'PRESENT' : 'absent'} (${LOCK_PATH})`);
  if (locked) {
    const backup = readJson(LOCK_PATH);
    console.log(`  acquired:   ${backup.acquiredAt}`);
    console.log(`  reason:     ${backup.reason || '(not specified)'}`);
    console.log(`  backup:     enabled=${backup.previousEnabled}, autoPushOnStop=${backup.previousAutoPushOnStop}`);
  }
  if (autopilot) {
    console.log(`  autopilot:  enabled=${autopilot.enabled}, autoPushOnStop=${autopilot.autoPushOnStop}, squashWipOnClose=${autopilot.squashWipOnClose}`);
  } else {
    console.log('  autopilot:  autopilot.json not found');
  }
}

function main() {
  const { mode, reason } = parseArgs();
  if (!mode) {
    console.error('Usage:');
    console.error('  node release-lock.js --acquire [--reason "cowork v0.4.0 release"]');
    console.error('  node release-lock.js --release');
    console.error('  node release-lock.js --status');
    process.exit(3);
  }
  if (mode === 'acquire') cmdAcquire(reason);
  else if (mode === 'release') cmdRelease();
  else if (mode === 'status') cmdStatus();
}

main();
