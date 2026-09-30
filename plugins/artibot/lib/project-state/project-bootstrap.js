/**
 * SessionStart project bootstrap — what Artibot does for a project that got the
 * plugin from the marketplace and nothing else.
 *
 * Two jobs, both of them about the plugin working in a project that is NOT this
 * repository:
 *
 *   1. `gitExclude` — keep the `.artibot/` runtime files out of the user's
 *      commits ({@link module:lib/project-state/runtime-exclude}).
 *   2. `rulesDigest` — when `~/.claude/rules/artibot/` holds no rules, hand the
 *      model a ≤1,500-byte digest of them ({@link module:lib/project-state/rules-digest}).
 *
 * The SessionStart hook (`scripts/hooks/project-bootstrap.js`) is a thin wrapper
 * around {@link runProjectBootstrap}; every decision lives here so it can be
 * tested without a spawn.
 *
 * ── Opting out ────────────────────────────────────────────────────────────
 * Precedence, the same shape as `lib/core/version-checker.js#resolveUpdateCheckPolicy`:
 *
 *     env ARTIBOT_PROJECT_BOOTSTRAP  >  artibot.config.json projectBootstrap.<key>  >  ON
 *
 * The env value is an ALLOWLIST (`0|false|off|no` off, `1|true|on|yes` on, anything
 * else falls through to config) and is ONE switch for both jobs. It exists because
 * the config file sits in the plugin cache, which a plugin update replaces: an
 * edit there does not survive, an environment variable in the user's settings does.
 * The config keys are per job, and only a literal `false` turns one off — a missing
 * key, a misspelling or the string "false" leaves it on.
 *
 * ── Failure ───────────────────────────────────────────────────────────────
 * Never throws. A job that fails is reported in the result and the other still runs.
 *
 * Layer: L2.
 *
 * @module lib/project-state/project-bootstrap
 */

import path from 'node:path';
import { readJsonFileSync } from '../core/file.js';
import { getHomeDir, getPluginRoot } from '../core/platform.js';
import { ensureRuntimeExclude } from './runtime-exclude.js';
import { buildRulesDigest, hasInstalledUserRules } from './rules-digest.js';

/** One switch for the whole bootstrap; beats the config keys in either direction. */
export const PROJECT_BOOTSTRAP_ENV = 'ARTIBOT_PROJECT_BOOTSTRAP';

// Allowlists, not denylists: an unrecognised value falls through to config
// instead of being read as an opt-out (`ARTIBOT_PROJECT_BOOTSTRAP=disabled`).
const ENV_DISABLE_VALUES = new Set(['0', 'false', 'off', 'no']);
const ENV_ENABLE_VALUES = new Set(['1', 'true', 'on', 'yes']);

/**
 * @typedef {object} Decision
 * @property {boolean} enabled - Whether the job may run.
 * @property {'env'|'config'|'default'} source - Which layer decided.
 * @property {string} reason - Human-readable cause, echoing the raw setting.
 */

/** The env switch as `{enabled, reason}`, or `null` when unset or unrecognised. */
function readEnvSwitch(env) {
  const raw = env?.[PROJECT_BOOTSTRAP_ENV];
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  // `reason` echoes the RAW value so an operator sees the stray space or odd casing they set.
  if (ENV_DISABLE_VALUES.has(normalized)) return { enabled: false, reason: `${PROJECT_BOOTSTRAP_ENV}=${raw}` };
  if (ENV_ENABLE_VALUES.has(normalized)) return { enabled: true, reason: `${PROJECT_BOOTSTRAP_ENV}=${raw}` };
  return null;
}

/** The `projectBootstrap` section of a config of any shape, as an object. */
function readSection(config) {
  const section = config !== null && typeof config === 'object' ? config.projectBootstrap : null;
  return section !== null && typeof section === 'object' ? section : {};
}

/**
 * Decide one job: env, then config, then the default (on).
 *
 * @param {string} key - `gitExclude` or `rulesDigest`.
 * @param {{enabled: boolean, reason: string}|null} fromEnv - Env switch, if any.
 * @param {object} section - The config's `projectBootstrap` object.
 * @returns {Decision} The decision.
 */
function decide(key, fromEnv, section) {
  if (fromEnv !== null) return { enabled: fromEnv.enabled, source: 'env', reason: fromEnv.reason };
  if (section[key] === false) {
    return { enabled: false, source: 'config', reason: `artibot.config.json projectBootstrap.${key}=false` };
  }
  return { enabled: true, source: 'default', reason: 'default' };
}

/**
 * Resolve which bootstrap jobs may run. Pure — reads no file, runs nothing.
 *
 * @param {object} [opts] - Inputs.
 * @param {NodeJS.ProcessEnv} [opts.env] - Environment; defaults to `process.env`.
 * @param {object} [opts.config] - Parsed `artibot.config.json`; any shape, never throws.
 * @returns {{gitExclude: Decision, rulesDigest: Decision}} One decision per job.
 */
export function resolveProjectBootstrapPolicy({ env = process.env, config = {} } = {}) {
  const fromEnv = readEnvSwitch(env);
  const section = readSection(config);
  return {
    gitExclude: decide('gitExclude', fromEnv, section),
    rulesDigest: decide('rulesDigest', fromEnv, section),
  };
}

/** Run `fn`; a throw becomes `fallback(err)` instead of escaping into a hook. */
function guarded(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback(err);
  }
}

/**
 * Run the bootstrap for one session start.
 *
 * @param {object} [params] - Inputs; everything but `payload` is an injection point.
 * @param {{cwd?: string}} [params.payload] - The hook payload; `cwd` is the project directory.
 * @param {NodeJS.ProcessEnv} [params.env] - Environment; defaults to `process.env`.
 * @param {string} [params.homeDir] - User home; defaults to `getHomeDir()`.
 * @param {string} [params.pluginRoot] - Plugin root; defaults to `getPluginRoot()`.
 * @param {object} [params.config] - Parsed config; read from `<pluginRoot>/artibot.config.json` when omitted.
 * @param {(args: string[], options: object) => string} [params.execGit] - Git runner (test seam).
 * @returns {{
 *   policy: ReturnType<typeof resolveProjectBootstrapPolicy>,
 *   exclude: ReturnType<typeof ensureRuntimeExclude>|null,
 *   additionalContext: string|null,
 * }} What was decided, what the exclude job reported (`null` when it did not run),
 *   and the digest text to inject (`null` when there is none).
 */
export function runProjectBootstrap({
  payload, env = process.env, homeDir = getHomeDir(), pluginRoot = getPluginRoot(), config, execGit,
} = {}) {
  const loaded = config ?? readJsonFileSync(path.join(pluginRoot, 'artibot.config.json'), {});
  const policy = resolveProjectBootstrapPolicy({ env, config: loaded });
  const cwd = typeof payload?.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd();

  const exclude = policy.gitExclude.enabled
    ? guarded(
      () => ensureRuntimeExclude({ cwd, env, execGit }),
      (err) => ({ ok: false, reason: 'threw', error: err?.message }),
    )
    : null;

  const additionalContext = policy.rulesDigest.enabled && !hasInstalledUserRules(homeDir)
    ? guarded(() => buildRulesDigest({ pluginRoot }), () => null)
    : null;

  return { policy, exclude, additionalContext };
}
