/**
 * Auto Skill Registrar — AGO Self-Control Track 3.
 *
 * Promotes auto-researched skills from a staging area into the official
 * `skills/` directory after a configurable cool-down period. Self-control is
 * ON by default. The user may opt out via config. Additional safety:
 *
 *   1. masterEnabled respected (user opt-out)
 *   2. autoSkillRegister.enabled respected (per-feature opt-out)
 *   3. Kill switch (auto-OFF after 3 critical failures in 24h)
 *   4. First-Run Guard (first 5 runs observe-only)
 *
 * The staging area lives under <pluginRoot>/runtime/skills-staging/<name>/,
 * which is ignored by git. Promotion reuses `createSkill().commit()` from
 * artibot-sdk.js so the canonical validation + DATA POLICY scan runs again at
 * the moment of promotion (defense-in-depth).
 *
 * Design constraints:
 *   - Zero runtime deps
 *   - ESM
 *   - Functions < 50 lines
 *   - Pure helpers where possible; all disk I/O is awaited explicitly
 *   - DATA POLICY: all reads/writes stay inside <pluginRoot>. No network.
 *
 * @module lib/sdk/auto-skill-registrar
 */

import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSkill, scanDataPolicyViolations } from './artibot-sdk.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STAGING_PATH = 'runtime/skills-staging/';
const DEFAULT_STAGING_DAYS = 1;
const DEFAULT_MIN_CONFIDENCE = 0.85;
const METADATA_FILE = '.staging.json';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the user has opted out of auto-skill-registration.
 * Self-control is ON by default — only explicit `false` opts out.
 *
 * @param {object} config - artibot.config.json
 * @returns {{allowed: boolean, reason?: string}}
 */
export function isGateOpen(config) {
  const sc = config?.ago?.selfControl;
  if (sc && sc.masterEnabled === false) {
    return { allowed: false, reason: 'master-disabled' };
  }
  if (sc?.autoSkillRegister?.enabled === false) {
    return { allowed: false, reason: 'module-disabled' };
  }
  return { allowed: true };
}

/**
 * Check the dynamic kill-switch. Module import is tolerant to missing file.
 * @param {object} config
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<boolean>}
 */
async function isKillSwitchActive(config, opts = {}) {
  try {
    const mod = await import('../learning/kill-switch.js');
    return await mod.isKillSwitchTripped(config, { ...opts, feature: 'auto-skill-register' });
  } catch {
    return false;
  }
}

/**
 * Evaluate first-run guard state. Tolerant to missing module.
 * @param {object} config
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<boolean>} true when still in observe-only mode.
 */
async function isObserveOnly(config, opts = {}) {
  try {
    const mod = await import('../learning/first-run-guard.js');
    const state = await mod.shouldObserveOnly('auto-skill-register', config, opts);
    await mod.bumpRunCounter('auto-skill-register', config, opts);
    return Boolean(state?.shouldObserve);
  } catch {
    return false;
  }
}

/**
 * Report a critical failure to the kill switch (best-effort).
 * @param {string} error
 * @param {object} config
 * @param {{pluginRoot?: string}} [opts]
 */
async function recordCriticalFailure(error, config, opts = {}) {
  try {
    const mod = await import('../learning/kill-switch.js');
    await mod.recordFailure({ feature: 'auto-skill-register', error }, config, opts);
  } catch { /* ignore */ }
}

/**
 * Resolve options with defaults from config.
 * @param {object} config
 * @returns {{stagingDays: number, stagingPath: string, minConfidence: number}}
 */
function resolveOptions(config) {
  const cfg = config?.ago?.selfControl?.autoSkillRegister || {};
  return {
    stagingDays: Number.isFinite(cfg.stagingDays) ? cfg.stagingDays : DEFAULT_STAGING_DAYS,
    stagingPath: typeof cfg.stagingPath === 'string' && cfg.stagingPath
      ? cfg.stagingPath
      : DEFAULT_STAGING_PATH,
    minConfidence: Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : DEFAULT_MIN_CONFIDENCE,
  };
}

/**
 * Test path existence without throwing.
 * @param {string} p
 */
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the staging directory absolute path for a given skill name.
 */
function stagingDirFor(pluginRoot, stagingPath, name) {
  return path.join(pluginRoot, stagingPath, name);
}

/**
 * Read the staging metadata sidecar for a staged skill (if any).
 * @param {string} dir
 */
async function readMetadata(dir) {
  const metaFile = path.join(dir, METADATA_FILE);
  if (!(await exists(metaFile))) return null;
  try {
    return JSON.parse(await readFile(metaFile, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write the staging metadata sidecar.
 */
async function writeMetadata(dir, data) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, METADATA_FILE), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * Determine whether a staged skill has ripened past its cool-down.
 * @param {object} meta
 * @param {number} nowMs
 */
function isRipened(meta, nowMs) {
  if (!meta || meta.rejected === true) return false;
  const stagedAt = Date.parse(meta.stagedAt || '');
  if (!Number.isFinite(stagedAt)) return false;
  const stagingDays = Number.isFinite(meta.stagingDays) ? meta.stagingDays : DEFAULT_STAGING_DAYS;
  return (nowMs - stagedAt) >= stagingDays * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stage a skill for later promotion. The SKILL.md content is generated via
 * createSkill() so the same validation + schema used at official registration
 * is applied up-front. DATA POLICY violations BLOCK staging (stricter than
 * commit's warn-only posture — auto-flows require stricter guards).
 *
 * @param {object} skillSpec - {name, description, category, body, confidence, ...}
 * @param {{pluginRoot: string, config: object, now?: number}} options
 * @returns {Promise<{staged: boolean, stagingPath?: string, scheduledPromotionAt?: string, reason?: string, errors?: string[]}>}
 */
export async function stageSkill(skillSpec, options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  if (!pluginRoot) return { staged: false, reason: 'invalid-args' };

  const gate = isGateOpen(config);
  if (!gate.allowed) return { staged: false, reason: gate.reason };
  if (await isKillSwitchActive(config, { pluginRoot })) {
    return { staged: false, reason: 'kill-switch-tripped' };
  }

  const { stagingDays, stagingPath, minConfidence } = resolveOptions(config);
  const confidence = Number.isFinite(skillSpec?.confidence) ? skillSpec.confidence : 0;
  if (confidence < minConfidence) {
    return { staged: false, reason: 'low-confidence' };
  }

  const skill = createSkill(skillSpec);
  if (!skill.valid) return { staged: false, reason: 'invalid-spec', errors: skill.errors };

  // DATA POLICY scan #1 (staging).
  const policyWarnings = scanDataPolicyViolations(skillSpec.body);
  if (policyWarnings.length > 0) {
    await recordCriticalFailure('data-policy-violation at staging', config, { pluginRoot });
    return { staged: false, reason: 'data-policy-violation', errors: policyWarnings };
  }

  const dir = stagingDirFor(pluginRoot, stagingPath, skill.dirName);
  if (await exists(dir)) {
    return { staged: false, reason: 'already-staged' };
  }

  const observeOnly = await isObserveOnly(config, { pluginRoot });
  const nowMs = Number.isFinite(options?.now) ? options.now : Date.now();
  const stagedAt = new Date(nowMs).toISOString();
  const scheduledPromotionAt = new Date(nowMs + stagingDays * MS_PER_DAY).toISOString();

  if (observeOnly) {
    return {
      staged: false,
      reason: 'observe-only',
      would: { stagingPath: dir, scheduledPromotionAt },
    };
  }

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), skill.skillMd, 'utf-8');
  await writeMetadata(dir, {
    name: skill.dirName,
    stagedAt,
    stagingDays,
    confidence,
    rejected: false,
    source: 'auto-research',
    spec: {
      description: skillSpec.description,
      category: skillSpec.category,
    },
  });

  return { staged: true, stagingPath: dir, scheduledPromotionAt };
}

/**
 * List all skills currently in the staging area.
 * @param {string} pluginRoot
 * @param {object} [config]
 * @returns {Promise<Array<{name: string, stagingPath: string, metadata: object | null}>>}
 */
export async function listStaging(pluginRoot, config = {}) {
  if (!pluginRoot) return [];
  const { stagingPath } = resolveOptions(config);
  const rootDir = path.join(pluginRoot, stagingPath);
  if (!(await exists(rootDir))) return [];
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    out.push({ name: entry.name, stagingPath: dir, metadata: await readMetadata(dir) });
  }
  return out;
}

/**
 * Reject a staged skill: marks metadata rejected so promoteRipened skips it.
 * Does not delete files (operators can inspect later).
 *
 * @param {string} skillId - staged skill name
 * @param {string} reason
 * @param {{pluginRoot: string, config?: object}} options
 * @returns {Promise<{rejected: boolean, reason?: string}>}
 */
export async function rejectStaging(skillId, reason, options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  if (!pluginRoot || !skillId) return { rejected: false, reason: 'invalid-args' };
  const { stagingPath } = resolveOptions(config);
  const dir = stagingDirFor(pluginRoot, stagingPath, skillId);
  if (!(await exists(dir))) return { rejected: false, reason: 'not-found' };
  const meta = (await readMetadata(dir)) || { name: skillId };
  meta.rejected = true;
  meta.rejectedAt = new Date().toISOString();
  meta.rejectReason = typeof reason === 'string' ? reason : 'unspecified';
  await writeMetadata(dir, meta);
  return { rejected: true };
}

/**
 * Evaluate a single staged skill for promotion. Pure-ish: returns the decision
 * and the read metadata. Caller performs the side-effectful move.
 *
 * @returns {Promise<{action: 'promote'|'pending'|'reject', skillName: string, reason?: string, meta?: object}>}
 */
async function evaluateStaged(pluginRoot, stagingPath, entryName, minConfidence, nowMs) {
  const dir = stagingDirFor(pluginRoot, stagingPath, entryName);
  const meta = await readMetadata(dir);
  if (!meta) return { action: 'reject', skillName: entryName, reason: 'missing-metadata' };
  if (meta.rejected === true) return { action: 'reject', skillName: entryName, reason: 'user-rejected' };
  if (!isRipened(meta, nowMs)) return { action: 'pending', skillName: entryName, meta };
  if (Number.isFinite(meta.confidence) && meta.confidence < minConfidence) {
    return { action: 'reject', skillName: entryName, reason: 'low-confidence', meta };
  }
  return { action: 'promote', skillName: entryName, meta };
}

/**
 * Promote a single ripened skill to the official skills/ directory.
 * Refuses to overwrite an existing official skill with the same name.
 */
async function promoteOne(pluginRoot, stagingPath, skillName) {
  const stagingDir = stagingDirFor(pluginRoot, stagingPath, skillName);
  const targetDir = path.join(pluginRoot, 'skills', skillName);
  if (await exists(targetDir)) {
    return { promoted: false, reason: 'target-exists' };
  }
  const skillMdSrc = path.join(stagingDir, 'SKILL.md');
  if (!(await exists(skillMdSrc))) {
    return { promoted: false, reason: 'missing-skill-md' };
  }
  const body = await readFile(skillMdSrc, 'utf-8');
  const policyWarnings = scanDataPolicyViolations(body);
  if (policyWarnings.length > 0) {
    return { promoted: false, reason: 'data-policy-violation' };
  }
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rename(stagingDir, targetDir);
  // Drop the staging metadata sidecar from the promoted directory.
  const metaPath = path.join(targetDir, METADATA_FILE);
  if (await exists(metaPath)) await rm(metaPath, { force: true });
  return { promoted: true, targetDir };
}

/**
 * Sweep the staging area and promote every skill whose cool-down has elapsed.
 * Rejects entries past the window that failed late-stage confidence/policy
 * checks. Callable from a cron or manually.
 *
 * @param {{pluginRoot: string, config: object, now?: number}} options
 * @returns {Promise<{promoted: string[], pending: string[], rejected: string[], skipped: string[], reason?: string}>}
 */
export async function promoteRipened(options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  const out = { promoted: [], pending: [], rejected: [], skipped: [] };
  if (!pluginRoot) return { ...out, reason: 'invalid-args' };

  const gate = isGateOpen(config);
  if (!gate.allowed) return { ...out, reason: gate.reason };
  if (await isKillSwitchActive(config, { pluginRoot })) {
    return { ...out, reason: 'kill-switch-tripped' };
  }
  const observeOnly = await isObserveOnly(config, { pluginRoot });

  const { stagingPath, minConfidence } = resolveOptions(config);
  const rootDir = path.join(pluginRoot, stagingPath);
  if (!(await exists(rootDir))) return out;

  const nowMs = Number.isFinite(options?.now) ? options.now : Date.now();
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) { out.skipped.push(entry.name); continue; }
    const decision = await evaluateStaged(pluginRoot, stagingPath, entry.name, minConfidence, nowMs);
    if (decision.action === 'pending') { out.pending.push(decision.skillName); continue; }
    if (decision.action === 'reject') { out.rejected.push(decision.skillName); continue; }
    if (observeOnly) { out.pending.push(decision.skillName); continue; }
    const result = await promoteOne(pluginRoot, stagingPath, decision.skillName);
    if (result.promoted) {
      out.promoted.push(decision.skillName);
    } else {
      out.rejected.push(decision.skillName);
      if (result.reason === 'data-policy-violation') {
        await recordCriticalFailure('data-policy-violation at promote', config, { pluginRoot });
      }
    }
  }
  if (observeOnly) out.reason = 'observe-only';
  return out;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  DEFAULT_STAGING_PATH as _DEFAULT_STAGING_PATH,
  DEFAULT_STAGING_DAYS as _DEFAULT_STAGING_DAYS,
  DEFAULT_MIN_CONFIDENCE as _DEFAULT_MIN_CONFIDENCE,
  METADATA_FILE as _METADATA_FILE,
  isRipened as _isRipened,
  evaluateStaged as _evaluateStaged,
};
