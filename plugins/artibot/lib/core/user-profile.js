/**
 * User skill-level profile (D-dimension UX auto-detection).
 * Collects prompt signals and heuristically classifies the user as
 * 'novice' or 'pro'. Starts on the safe side ('novice') and self-promotes
 * once enough positive pro-signals accumulate.
 *
 * Persistence target: `config.ux.profilePath` (default `~/.claude/artibot/user-profile.json`).
 *
 * @module lib/core/user-profile
 */

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getHomeDir } from './platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SIGNALS_FOR_AUTO_DETECT = 10;
const MAX_STORED_SIGNALS = 200;

/** Jargon heuristic token list (lowercase ASCII). */
const JARGON_TOKENS = [
  'error', 'async', 'await', 'api', 'hook', 'lint',
  'commit', 'branch', 'merge', 'rebase', 'stash',
  'npm', 'pip', 'cargo', 'lint', 'regex', 'schema',
  'typescript', 'docker', 'kubernetes', 'k8s',
  'endpoint', 'payload', 'middleware', 'refactor',
  'mock', 'stub', 'assertion', 'webhook',
];

/** Novice-leaning natural-language phrase patterns (case-insensitive). */
const NOVICE_PHRASES = [
  /\uC5B4\uB5BB\uAC8C\s*\uD574\uC694/,        // 어떻게 해요
  /\uD574\uC918\s*\uC694?/,                   // 해줘(요)
  /\uB418\uB098\uC694\??/,                    // 되나요?
  /\uC65C\s*\uC548\s*\uB410/,                 // 왜 안 돼
  /how do i /i,
  /can you (please )?/i,
  /please help/i,
];

// ---------------------------------------------------------------------------
// Internal state (single profile instance per process)
// ---------------------------------------------------------------------------

/** @type {string|null} */
let cachedProfilePath = null;

/**
 * @typedef {object} Signal
 * @property {'slash-command'|'natural-language'} type
 * @property {string} value
 * @property {number} timestamp
 */

/**
 * @typedef {object} Profile
 * @property {'novice'|'pro'} skillLevel
 * @property {'detected'|'explicit'|'initial'} source
 * @property {Signal[]} signals
 * @property {string[]} evidence
 * @property {string} updatedAt
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Expand ~ at the start of a path to the user home directory.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(getHomeDir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the profile file path. Uses the override if `configureProfilePath`
 * has been called, otherwise falls back to the default under the home dir.
 *
 * @returns {string}
 */
function resolveProfilePath() {
  if (cachedProfilePath) return cachedProfilePath;
  const defaultPath = path.join(getHomeDir(), '.claude', 'artibot', 'user-profile.json');
  return defaultPath;
}

/**
 * Override the profile path (used by tests and by the runtime hook when
 * config.ux.profilePath differs from the default).
 *
 * @param {string|null} newPath
 */
export function configureProfilePath(newPath) {
  cachedProfilePath = newPath ? expandHome(newPath) : null;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/**
 * Build a fresh default profile object.
 * @returns {Profile}
 */
function defaultProfile() {
  return {
    skillLevel: 'novice',
    source: 'initial',
    signals: [],
    evidence: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read and parse the on-disk profile. Returns a fresh default when the file
 * is absent, unreadable, or malformed.
 *
 * @returns {Promise<Profile>}
 */
async function readProfile() {
  const p = resolveProfilePath();
  if (!existsSync(p)) return defaultProfile();
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      skillLevel: parsed.skillLevel === 'pro' ? 'pro' : 'novice',
      source: parsed.source === 'explicit' || parsed.source === 'detected'
        ? parsed.source
        : 'initial',
      signals: Array.isArray(parsed.signals) ? parsed.signals.slice(-MAX_STORED_SIGNALS) : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(-20) : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return defaultProfile();
  }
}

/**
 * Atomically persist a profile to disk. Failures are swallowed because
 * profile tracking is advisory only.
 *
 * @param {Profile} profile
 * @returns {Promise<void>}
 */
async function writeProfile(profile) {
  const p = resolveProfilePath();
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf-8');
    renameSync(tmp, p);
  } catch {
    // Non-critical: profile persistence is advisory
  }
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Compute the ratio of signals whose type is 'slash-command'.
 * @param {Signal[]} signals
 * @returns {number}
 */
function slashRatio(signals) {
  if (signals.length === 0) return 0;
  const slash = signals.filter((s) => s.type === 'slash-command').length;
  return slash / signals.length;
}

/**
 * Compute jargon density (fraction of signals whose text contains >=1 jargon token).
 * @param {Signal[]} signals
 * @returns {number}
 */
function jargonDensity(signals) {
  if (signals.length === 0) return 0;
  let hits = 0;
  for (const s of signals) {
    const lowered = String(s.value || '').toLowerCase();
    if (JARGON_TOKENS.some((tok) => lowered.includes(tok))) {
      hits += 1;
    }
  }
  return hits / signals.length;
}

/**
 * Count natural-language novice-phrase matches across signals.
 * @param {Signal[]} signals
 * @returns {number}
 */
function novicePhraseHits(signals) {
  let hits = 0;
  for (const s of signals) {
    const text = String(s.value || '');
    if (NOVICE_PHRASES.some((re) => re.test(text))) {
      hits += 1;
    }
  }
  return hits;
}

/**
 * Classify a profile's signals into a skill level with evidence list.
 * Heuristic summary:
 *   - Need at least MIN_SIGNALS_FOR_AUTO_DETECT signals to promote away from novice
 *   - slash-command ratio >= 0.3 AND jargon density >= 0.2 AND few novice phrases -> pro
 *   - Otherwise stays novice
 *
 * @param {Signal[]} signals
 * @returns {{ level: 'novice'|'pro', evidence: string[] }}
 */
function classify(signals) {
  const evidence = [];
  if (signals.length < MIN_SIGNALS_FOR_AUTO_DETECT) {
    evidence.push(`insufficient signals (${signals.length}/${MIN_SIGNALS_FOR_AUTO_DETECT})`);
    return { level: 'novice', evidence };
  }

  const sr = slashRatio(signals);
  const jd = jargonDensity(signals);
  const np = novicePhraseHits(signals);

  evidence.push(`slash-ratio=${sr.toFixed(2)}`);
  evidence.push(`jargon-density=${jd.toFixed(2)}`);
  evidence.push(`novice-phrase-hits=${np}`);

  const isPro = sr >= 0.3 && jd >= 0.2 && np <= Math.max(1, Math.floor(signals.length * 0.1));
  return {
    level: isPro ? 'pro' : 'novice',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the current stored profile with a freshly derived skillLevel.
 * If the stored source is 'explicit', the explicit value wins.
 *
 * @returns {Promise<{ skillLevel: 'novice'|'pro', evidence: string[], updatedAt: string }>}
 */
export async function getProfile() {
  const profile = await readProfile();
  if (profile.source === 'explicit') {
    return {
      skillLevel: profile.skillLevel,
      evidence: profile.evidence.length > 0 ? profile.evidence : ['explicit override'],
      updatedAt: profile.updatedAt,
    };
  }
  const { level, evidence } = classify(profile.signals);
  return { skillLevel: level, evidence, updatedAt: profile.updatedAt };
}

/**
 * Record a signal (slash usage, free-form text, etc.). The oldest signals
 * are evicted once the ring-buffer hits MAX_STORED_SIGNALS.
 *
 * @param {{ type: 'slash-command'|'natural-language', value: string, timestamp?: number }} signal
 * @returns {Promise<void>}
 */
export async function recordSignal(signal) {
  if (!signal || typeof signal !== 'object') return;
  const { type, value, timestamp } = signal;
  if (type !== 'slash-command' && type !== 'natural-language') return;
  const profile = await readProfile();
  if (profile.source === 'explicit') {
    // still record for future re-evaluation but don't change level
    profile.signals.push({
      type,
      value: String(value || '').slice(0, 200),
      timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
    });
    if (profile.signals.length > MAX_STORED_SIGNALS) {
      profile.signals = profile.signals.slice(-MAX_STORED_SIGNALS);
    }
    profile.updatedAt = new Date().toISOString();
    await writeProfile(profile);
    return;
  }

  profile.signals.push({
    type,
    value: String(value || '').slice(0, 200),
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
  });
  if (profile.signals.length > MAX_STORED_SIGNALS) {
    profile.signals = profile.signals.slice(-MAX_STORED_SIGNALS);
  }

  const { level, evidence } = classify(profile.signals);
  profile.skillLevel = level;
  profile.source = profile.signals.length >= MIN_SIGNALS_FOR_AUTO_DETECT ? 'detected' : 'initial';
  profile.evidence = evidence;
  profile.updatedAt = new Date().toISOString();
  await writeProfile(profile);
}

/**
 * Apply an explicit skill-level override. Explicit values persist until
 * cleared by calling this with a falsy argument or by deleting the file.
 *
 * @param {'novice'|'pro'|null} level
 * @returns {Promise<void>}
 */
export async function setSkillLevel(level) {
  const profile = await readProfile();
  if (!level) {
    profile.source = 'initial';
    profile.evidence = [];
  } else if (level === 'novice' || level === 'pro') {
    profile.skillLevel = level;
    profile.source = 'explicit';
    profile.evidence = [`explicit override -> ${level}`];
  } else {
    return;
  }
  profile.updatedAt = new Date().toISOString();
  await writeProfile(profile);
}

/**
 * Convenience: classify-only entry point. Returns the auto-detected level
 * (or the explicit override) without mutating state.
 *
 * @returns {Promise<'novice'|'pro'>}
 */
export async function detectSkillLevel() {
  const { skillLevel } = await getProfile();
  return skillLevel;
}

/**
 * Test helper: reset runtime-cached profile path. Not exported in public
 * types — intentionally prefixed with underscore.
 */
export function _resetPathCache() {
  cachedProfilePath = null;
}
