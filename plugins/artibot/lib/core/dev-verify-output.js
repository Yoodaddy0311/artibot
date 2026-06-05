/**
 * DEV-verify Stop-hook output shaping.
 *
 * Builds the stdout envelope the dev-verify gate returns to Claude Code,
 * abstracting the two enforcement modes and the Claude Code schema migration
 * (2.1.163) that added non-blocking `hookSpecificOutput.additionalContext`
 * feedback for Stop / SubagentStop hooks.
 *
 * Two modes:
 *   - 'enforce'  (default) → `{ decision: 'block', reason }`. Blocks the stop so
 *                            the model must address the DEV verify checklist
 *                            before finalising. This is the always-supported
 *                            shape (works on every Claude Code version), so it
 *                            doubles as the version-compat-safe path.
 *   - 'advisory'           → `{ hookSpecificOutput: { hookEventName,
 *                            additionalContext } }`. Surfaces the same checklist
 *                            as soft, non-blocking feedback (no "Stop hook
 *                            blocking error" label) on Claude Code ≥ 2.1.163.
 *                            On older versions that ignore additionalContext the
 *                            feedback is silently dropped rather than erroring —
 *                            an acceptable degradation for an advisory note.
 *
 * Keeping this in lib/core (not the hook script) makes the mode/version logic
 * unit-testable without spinning up git + stdin.
 *
 * @module lib/core/dev-verify-output
 */

/** Recognized enforcement modes. */
export const DEV_VERIFY_MODES = Object.freeze(['enforce', 'advisory']);

/** Default mode when config/env specify nothing. Preserves prior behavior. */
export const DEFAULT_DEV_VERIFY_MODE = 'enforce';

/**
 * Resolve the effective DEV-verify mode from an env override and config value.
 *
 * Precedence (highest first):
 *   1. `ARTIBOT_DEV_VERIFY_MODE` env var (explicit operator override)
 *   2. `config.devProtocol.verifyMode` (project config)
 *   3. {@link DEFAULT_DEV_VERIFY_MODE}
 *
 * Unrecognized values fall back to the default rather than throwing — a
 * malformed toggle must never break the Stop slot.
 *
 * @param {object} [config] - Parsed artibot.config.json (or a slice of it)
 * @param {object} [env] - Environment object (defaults to process.env)
 * @returns {'enforce'|'advisory'}
 */
export function resolveDevVerifyMode(config, env = process.env) {
  const fromEnv = env?.ARTIBOT_DEV_VERIFY_MODE;
  if (DEV_VERIFY_MODES.includes(fromEnv)) return fromEnv;

  const fromConfig = config?.devProtocol?.verifyMode;
  if (DEV_VERIFY_MODES.includes(fromConfig)) return fromConfig;

  return DEFAULT_DEV_VERIFY_MODE;
}

/**
 * Build the Stop-hook stdout envelope for the given mode.
 *
 * @param {string} reason - The DEV verify checklist text.
 * @param {object} [opts]
 * @param {'enforce'|'advisory'} [opts.mode='enforce'] - Enforcement mode.
 * @param {string} [opts.hookEventName='Stop'] - Event name for the
 *   hookSpecificOutput envelope (Stop | SubagentStop).
 * @returns {object} stdout payload object (caller JSON-stringifies / writeStdout)
 */
export function buildDevVerifyOutput(reason, opts = {}) {
  const { mode = DEFAULT_DEV_VERIFY_MODE, hookEventName = 'Stop' } = opts;

  if (mode === 'advisory') {
    return {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: reason,
      },
    };
  }

  // enforce (default) — always-supported blocking shape.
  return { decision: 'block', reason };
}
