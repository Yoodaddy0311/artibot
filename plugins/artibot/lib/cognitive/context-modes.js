/**
 * Adaptive Context Modes.
 * Routes sessions into one of five modes (DEV, REVIEW, PLAN, DEBUG, RESEARCH)
 * based on intent keywords and complexity scoring. Each mode defines allowed
 * skills, tools, and guardrail levels.
 *
 * Pure function module — no file I/O, no network, no side effects.
 *
 * @module lib/cognitive/context-modes
 */

// ---------------------------------------------------------------------------
// MODES enum
// ---------------------------------------------------------------------------

export const MODES = Object.freeze({
  DEV:      'DEV',
  REVIEW:   'REVIEW',
  PLAN:     'PLAN',
  DEBUG:    'DEBUG',
  RESEARCH: 'RESEARCH',
});

// ---------------------------------------------------------------------------
// Mode configurations
// ---------------------------------------------------------------------------

const MODE_CONFIGS = Object.freeze({
  [MODES.DEV]: Object.freeze({
    skills: '*',
    tools: Object.freeze(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']),
    guardrails: 'standard',
  }),
  [MODES.REVIEW]: Object.freeze({
    skills: Object.freeze(['code-review', 'testing-standards']),
    tools: Object.freeze(['Read', 'Grep', 'Glob']),
    guardrails: 'write-restricted',
  }),
  [MODES.PLAN]: Object.freeze({
    skills: Object.freeze(['plan', 'estimate', 'design']),
    tools: Object.freeze(['Read', 'Grep', 'Glob']),
    guardrails: 'read-only',
  }),
  [MODES.DEBUG]: Object.freeze({
    skills: Object.freeze(['troubleshoot', 'systematic-debugging']),
    tools: Object.freeze(['Read', 'Bash', 'Grep']),
    guardrails: 'standard',
  }),
  [MODES.RESEARCH]: Object.freeze({
    skills: Object.freeze(['content', 'explain']),
    tools: Object.freeze(['Read', 'Grep', 'WebSearch']),
    guardrails: 'read-only',
  }),
});

// ---------------------------------------------------------------------------
// Intent keyword map (ordered by specificity — first match wins)
// ---------------------------------------------------------------------------

const INTENT_MODE_MAP = Object.freeze([
  { mode: MODES.REVIEW,   keywords: ['review', 'code review', '리뷰', '코드 리뷰', 'レビュー', '审查'] },
  { mode: MODES.PLAN,     keywords: ['plan', 'design', 'estimate', '설계', '계획', '플랜', '設計', '计划'] },
  { mode: MODES.DEBUG,    keywords: ['debug', 'error', 'bug', 'fix', '디버그', '에러', '버그', 'デバッグ', '调试'] },
  { mode: MODES.RESEARCH, keywords: ['research', 'explain', 'learn', '조사', '설명', '학습', '調査', '研究'] },
]);

const VALID_MODES = new Set(Object.values(MODES));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the appropriate context mode from intent text and routing metadata.
 * Keyword match takes priority; complexity score is used as fallback.
 *
 * @param {string} intent - User input or extracted intent string
 * @param {{ complexity?: number, system?: number, domain?: string }} [routing]
 * @returns {string} One of MODES values
 */
export function detectMode(intent, routing = {}) {
  const lower = (intent || '').toLowerCase();

  for (const entry of INTENT_MODE_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.mode;
    }
  }

  const complexity = routing.complexity ?? 0;
  if (complexity >= 0.7) return MODES.PLAN;
  return MODES.DEV;
}

/**
 * Get the frozen configuration for a given mode.
 * Returns a defensive shallow copy of arrays so callers cannot mutate internals.
 *
 * @param {string} mode - One of MODES values
 * @returns {{ skills: string | string[], tools: string[], guardrails: string }}
 * @throws {Error} If mode is not a valid MODES value
 */
export function getModeConfig(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode: "${mode}". Valid modes: ${[...VALID_MODES].join(', ')}`);
  }
  const cfg = MODE_CONFIGS[mode];
  return {
    skills: Array.isArray(cfg.skills) ? [...cfg.skills] : cfg.skills,
    tools: [...cfg.tools],
    guardrails: cfg.guardrails,
  };
}

/**
 * Apply a mode to a state object, returning a new state with context.mode set.
 * The original state is not mutated.
 *
 * @param {string} mode - One of MODES values
 * @param {object} state - Current session state
 * @returns {object} New state with context.mode added
 */
export function applyMode(mode, state) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode: "${mode}". Valid modes: ${[...VALID_MODES].join(', ')}`);
  }
  const context = state?.context || {};
  return {
    ...state,
    context: { ...context, mode },
  };
}

/**
 * Get the currently active mode from a state object.
 *
 * @param {object} state - Session state
 * @returns {string | null} Active mode or null if none set
 */
export function getActiveMode(state) {
  const mode = state?.context?.mode ?? null;
  if (mode !== null && !VALID_MODES.has(mode)) return null;
  return mode;
}
