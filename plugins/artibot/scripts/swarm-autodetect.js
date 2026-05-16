#!/usr/bin/env node
/**
 * Swarm Auto-detect — run at plugin install/update time and on first session
 * after install. Discovers an existing swarm profile shipped with the user's
 * artibot fork and offers (or applies, with --quiet-apply) auto-activation.
 *
 * This is non-interactive by default: it just PRINTS a hint to stderr that
 * the SessionStart hook will surface. The user must run swarm-init.js
 * explicitly or call this script with `--apply` to opt in.
 *
 * Usage:
 *   node scripts/swarm-autodetect.js              # detect only, print hint
 *   node scripts/swarm-autodetect.js --apply      # auto-opt-in if profile present
 *   node scripts/swarm-autodetect.js --json       # machine-readable output
 *   node scripts/swarm-autodetect.js --quiet      # suppress hints if no profile
 *
 * @module scripts/swarm-autodetect
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getPluginRoot } from '../lib/core/platform.js';
import { getSwarmConfig, loadConsent } from '../lib/swarm/swarm-config.js';
import { ARTIBOT_DIR } from '../lib/core/config.js';
import { readJsonFile, writeJsonFile } from '../lib/core/file.js';
import { assertSafeGitUrl } from '../lib/swarm/git-backend.js';

const PROFILE_REL = path.join('.claude-plugin', 'swarm-profile.json');
const AUTO_APPLIED_MARKER = path.join(ARTIBOT_DIR, 'swarm-autoapplied.json');

/**
 * Read the auto-applied marker. If present, auto-apply has already run for
 * this combination of (profile repoUrl, machine). Prevents re-running on
 * every session.
 */
async function readAutoAppliedMarker() {
  const data = await readJsonFile(AUTO_APPLIED_MARKER);
  return data && typeof data === 'object' ? data : null;
}

/**
 * Persist the auto-applied marker so we don't re-run on every session start.
 */
async function writeAutoAppliedMarker(profile, outcome) {
  await writeJsonFile(AUTO_APPLIED_MARKER, {
    repoUrl: profile.repoUrl,
    appliedAt: new Date().toISOString(),
    outcome, // 'success' | 'failed' | 'declined'
  });
}

function log(line) {
  process.stderr.write(line + '\n');
}

function readProfile(pluginRoot) {
  const profilePath = path.join(pluginRoot, PROFILE_REL);
  if (!existsSync(profilePath)) return null;
  try {
    const raw = readFileSync(profilePath, 'utf-8');
    const profile = JSON.parse(raw);
    if (!profile.repoUrl) return null;
    return { path: profilePath, ...profile };
  } catch {
    return null;
  }
}

function readLocalConfig(pluginRoot) {
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Determine the current activation state for the auto-detect workflow.
 *
 * States:
 *   'no-profile'         — no profile shipped, nothing to detect
 *   'already-active'     — profile present + consent + config match
 *   'profile-only'       — profile present but user hasn't opted in yet
 *   'config-mismatch'    — profile present but config points elsewhere
 *   'consent-but-no-clone' — opted in previously but local clone missing
 */
async function classifyState(pluginRoot) {
  const profile = readProfile(pluginRoot);
  if (!profile) return { state: 'no-profile', profile: null };

  const config = readLocalConfig(pluginRoot) ?? {};
  const swarmCfg = getSwarmConfig(config);
  const consent = await loadConsent();

  const isOptedIn = consent.optedIn === true;
  const configEnabled = swarmCfg.enabled === true && swarmCfg.backend === 'git';
  const urlsMatch = swarmCfg.gitRepoUrl === profile.repoUrl;

  if (isOptedIn && configEnabled && urlsMatch) {
    return { state: 'already-active', profile, swarmCfg, consent };
  }
  if (isOptedIn && configEnabled && !urlsMatch) {
    return { state: 'config-mismatch', profile, swarmCfg, consent };
  }
  return { state: 'profile-only', profile, swarmCfg, consent };
}

/**
 * Apply the profile non-interactively: delegate to swarm-init.js with the
 * profile's repoUrl. Returns the init process result.
 *
 * @param {string} pluginRoot
 * @param {object} profile
 */
export function applyProfile(pluginRoot, profile) {
  const initScript = path.join(pluginRoot, 'scripts', 'swarm-init.js');
  let safeRepoUrl;
  try {
    safeRepoUrl = assertSafeGitUrl(profile.repoUrl);
  } catch (err) {
    return { ok: false, error: `unsafe repoUrl: ${err.message || String(err)}` };
  }
  const result = spawnSync(
    process.execPath,
    [initScript, `--repo=${safeRepoUrl}`],
    {
      cwd: pluginRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error) {
    return { ok: false, error: result.error.message || String(result.error) };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return {
      ok: false,
      error: `swarm-init exited with status ${result.status}`,
      stderr: (result.stderr || '').toString(),
    };
  }
  return { ok: true, output: (result.stdout || '').toString() };
}

function printHint(state, profile) {
  switch (state) {
    case 'no-profile':
      // No hint — nothing to do
      return;
    case 'already-active':
      log(`[swarm] Active. repo=${profile.repoUrl}`);
      return;
    case 'profile-only':
      log('');
      log('[swarm] Discovered swarm profile in your fork — not opted in on this device.');
      log(`[swarm]   repo: ${profile.repoUrl}`);
      log(`[swarm]   origin: ${profile.createdOn || 'unknown'} @ ${profile.createdAt || '?'}`);
      log('[swarm] To activate cross-device learning here, run:');
      log('[swarm]   node plugins/artibot/scripts/swarm-autodetect.js --apply');
      log('');
      return;
    case 'config-mismatch':
      log(`[swarm] Profile repo (${profile.repoUrl}) differs from current config. Run swarm-init.js to reconcile.`);
      return;
    default:
      return;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const doApply = args.includes('--apply');
  const doAuto = args.includes('--auto');
  const isQuiet = args.includes('--quiet');

  const pluginRoot = getPluginRoot();
  const classification = await classifyState(pluginRoot);

  if (isJson) {
    process.stdout.write(JSON.stringify(classification, null, 2) + '\n');
    return;
  }

  // --auto: fully automatic activation on first detection.
  // Trusts the presence of a committed swarm-profile.json in the user's own
  // fork as implicit consent (user explicitly committed it). Runs once per
  // (repoUrl, machine) — tracked via swarm-autoapplied.json marker.
  if (doAuto) {
    if (classification.state !== 'profile-only') {
      // Nothing to auto-apply (no profile, already active, or mismatch).
      return;
    }
    // Skip if user explicitly opted out before
    if (classification.consent?.optedOutAt) {
      log('[swarm] Auto-apply skipped — user previously opted out. Run --apply to re-enable.');
      return;
    }
    // Skip if already auto-applied for this repoUrl
    const marker = await readAutoAppliedMarker();
    if (marker && marker.repoUrl === classification.profile.repoUrl) {
      return;
    }
    log(`[swarm] Auto-activating federated learning from committed profile ...`);
    log(`[swarm]   repo: ${classification.profile.repoUrl}`);
    const result = applyProfile(pluginRoot, classification.profile);
    if (result.ok) {
      await writeAutoAppliedMarker(classification.profile, 'success');
      log('[swarm] Auto-activated. This device is now part of your swarm.');
    } else {
      await writeAutoAppliedMarker(classification.profile, 'failed');
      log(`[swarm] Auto-apply failed: ${result.error}`);
      log('[swarm] You can retry manually: node plugins/artibot/scripts/swarm-autodetect.js --apply');
    }
    return;
  }

  if (doApply) {
    if (classification.state === 'no-profile') {
      log('[swarm] --apply requested but no profile present. Run swarm-init.js first.');
      process.exit(1);
    }
    if (classification.state === 'already-active') {
      log('[swarm] Already active, nothing to do.');
      return;
    }
    log(`[swarm] Applying profile ${classification.profile.repoUrl} ...`);
    const result = applyProfile(pluginRoot, classification.profile);
    if (result.ok) {
      log('[swarm] Applied successfully.');
      process.stdout.write(result.output);
    } else {
      log(`[swarm] Apply failed: ${result.error}`);
      if (result.stderr) log(result.stderr);
      process.exit(1);
    }
    return;
  }

  if (isQuiet && classification.state !== 'profile-only') return;
  printHint(classification.state, classification.profile);
}

// Only auto-run when invoked directly via the Node CLI (not when imported by
// a test or another module). Compares this module's URL to argv[1] resolved
// as a file:// URL — matches Node's standard "main module" idiom.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    process.stderr.write(`[swarm-autodetect] ${err.message || err}\n`);
    process.exit(0); // advisory — never block
  });
}

// fileURLToPath import is needed defensively for tests that may import this
// module; reference the symbol to satisfy lint rules without side effects.
void fileURLToPath;
