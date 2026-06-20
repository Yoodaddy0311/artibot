/**
 * Native Effort Signal Reader (cognitive layer, pure L4 leaf — no imports).
 *
 * PRODUCER half of TODO (#30806). The router.js CONSUMER half
 * (`setNativeEffortHint` / `nativeEffortHint` blending in `classifyComplexity`)
 * was already in place; this module supplies the missing signal source.
 *
 * Scope & safety contract (see #30806):
 *   - LOCAL ONLY. Reads `process.env` exclusively. No network, no external API,
 *     no 3rd-party calls, no data egress. Claude Code (the host) sets these env
 *     vars in-process; reading host-provided locals is not an external call.
 *   - SAFE FALLBACK. When the env var is absent / empty / an unrecognized level,
 *     `readNativeEffortLevel()` returns `null`. Callers treat `null` as "no
 *     signal" and fall through to the existing heuristic with byte-identical
 *     behavior. If a Claude Code build never sets these vars, this stays dormant
 *     (regression-zero).
 *
 * @module lib/cognitive/native-effort
 */

/**
 * Environment variable names Claude Code exposes for a native effort signal.
 *
 * OFFICIAL: `CLAUDE_EFFORT` (values low|medium|high|xhigh|max) — confirmed in
 * code.claude.com/docs/en/hooks.md. It is inherited by EVERY hook process, so
 * it is the operative source for non-tool-use hooks (e.g. UserPromptSubmit)
 * where the stdin `effort.level` field is NOT present.
 *
 * The remaining entries are UNOFFICIAL defensive fallbacks only (some Claude
 * Code / SDK builds have historically used alias names). They are probed AFTER
 * the official var so they can never shadow it. Probe order = list order; first
 * var that normalizes to a known level wins. The official var is the single
 * source of truth — fallbacks may be pruned without behavior change once we are
 * confident no build emits them.
 *
 * @type {ReadonlyArray<string>}
 */
export const NATIVE_EFFORT_ENV_VARS = Object.freeze([
  'CLAUDE_EFFORT',          // OFFICIAL (hooks.md): low|medium|high|xhigh|max
  'CLAUDE_EFFORT_LEVEL',    // unofficial defensive fallback
  'CLAUDE_CODE_EFFORT',     // unofficial defensive fallback
  'ANTHROPIC_EFFORT',       // unofficial defensive fallback (SDK-style prefix)
]);

/**
 * Map a raw env value to a canonical effort level. Tolerates case, surrounding
 * whitespace, and a few common aliases. Returns null for anything unrecognized.
 *
 * Canonical levels mirror EFFORT_POLICY / effort-resolver: max | xhigh | high |
 * medium | low.
 *
 * @param {string} raw
 * @returns {'max'|'xhigh'|'high'|'medium'|'low'|null}
 */
export function normalizeEffortLevel(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  switch (v) {
    case 'max':
    case 'maximum':
      return 'max';
    case 'xhigh':
    case 'x-high':
    case 'extra-high':
    case 'veryhigh':
    case 'very-high':
      return 'xhigh';
    case 'high':
      return 'high';
    case 'medium':
    case 'med':
    case 'mid':
      return 'medium';
    case 'low':
    case 'min':
    case 'minimum':
      return 'low';
    default:
      return null;
  }
}

/**
 * Read the native effort level from the environment, if present and valid.
 *
 * @param {NodeJS.ProcessEnv} [env] - Defaults to `process.env`. Injectable for tests.
 * @returns {'max'|'xhigh'|'high'|'medium'|'low'|null} Canonical level, or null
 *   when no recognized native signal is present (caller falls back to heuristic).
 */
export function readNativeEffortLevel(env = process.env) {
  if (!env || typeof env !== 'object') return null;
  for (const name of NATIVE_EFFORT_ENV_VARS) {
    const level = normalizeEffortLevel(env[name]);
    if (level) return level;
  }
  return null;
}

/**
 * Read the native effort level from a parsed hook stdin payload.
 *
 * OFFICIAL shape (hooks.md): `{ "effort": { "level": "high" } }`. This field is
 * only delivered on TOOL-USE hook events — PreToolUse | PostToolUse | Stop |
 * SubagentStop. It is ABSENT on UserPromptSubmit / SessionStart / etc., so
 * non-tool-use hooks must rely on the env-var path (`CLAUDE_EFFORT`) instead.
 * Shares the exact same normalization as the env reader.
 *
 * @param {{ effort?: { level?: string } } | null | undefined} payload - Parsed hook stdin JSON.
 * @returns {'max'|'xhigh'|'high'|'medium'|'low'|null} Canonical level, or null
 *   when the field is absent / empty / unrecognized (caller falls back).
 */
export function readNativeEffortFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeEffortLevel(payload.effort?.level);
}

/**
 * Resolve the effective native effort level using the canonical precedence:
 *   1) stdin `effort.level`  (tool-use hooks only — most authoritative)
 *   2) `$CLAUDE_EFFORT` env  (inherited by all hooks)
 *   3) null                  (no signal → caller uses the heuristic)
 *
 * Either input may be omitted. With both absent/invalid the result is null, so
 * the heuristic path is preserved byte-for-byte (regression-zero).
 *
 * @param {object} [opts]
 * @param {{ effort?: { level?: string } } | null} [opts.payload] - Parsed hook stdin JSON.
 * @param {NodeJS.ProcessEnv} [opts.env] - Defaults to `process.env`.
 * @returns {'max'|'xhigh'|'high'|'medium'|'low'|null}
 */
export function resolveNativeEffort({ payload, env = process.env } = {}) {
  return readNativeEffortFromPayload(payload) ?? readNativeEffortLevel(env);
}

/**
 * Convenience: which source (if any) currently supplies the native signal.
 * Returns `'stdin:effort.level'`, the env var name, or null. For observability.
 *
 * @param {object} [opts]
 * @param {{ effort?: { level?: string } } | null} [opts.payload] - Parsed hook stdin JSON.
 * @param {NodeJS.ProcessEnv} [opts.env] - Defaults to `process.env`.
 * @returns {string|null}
 */
export function getNativeEffortSource({ payload, env = process.env } = {}) {
  if (readNativeEffortFromPayload(payload)) return 'stdin:effort.level';
  if (env && typeof env === 'object') {
    for (const name of NATIVE_EFFORT_ENV_VARS) {
      if (normalizeEffortLevel(env[name])) return name;
    }
  }
  return null;
}
