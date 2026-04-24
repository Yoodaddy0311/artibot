/**
 * Skill Trigger Middleware (GRPO v3.5 §5.5).
 *
 * Decides which candidate skills actually fire for a given request. When the
 * GRPO-trained skill policy is enabled (`config.learning.grpoRouting.skillPolicy.enabled`),
 * scores come from `lib/learning/grpo/skill-policy.js`; otherwise we fall back
 * to the supplied regex/keyword matcher.
 *
 * The middleware runs AFTER the `skills` middleware has populated
 * `state.context.skills.suggested`, trimming that list to the set that
 * either crosses the learned threshold or matches a regex trigger. It never
 * adds skills that were not candidates, and never throws on policy read
 * failure (falls back silently).
 *
 * @module lib/runtime/middleware/skill-trigger
 */

// ---------------------------------------------------------------------------
// Defaults / config
// ---------------------------------------------------------------------------

export const DEFAULT_TRIGGER_OPTIONS = Object.freeze({
  threshold: 0.5,
  maxTriggers: 3,
});

/**
 * @typedef {Object} SkillPolicyLike
 * @property {(intent: string, context: object, opts: { candidates: string[] }) =>
 *   Promise<Record<string, number>>} scoreSkills
 * @property {(intent: string, context: object, opts: {
 *   candidates: string[], threshold?: number, maxTriggers?: number,
 * }) => Promise<{ name: string, score: number }[]>} selectSkills
 */

/**
 * @typedef {Object} RegexFallback
 * @property {(state: object) => string[]} match - returns selected skill names
 */

/**
 * Default regex fallback: returns every candidate already in
 * `state.context.skills.suggested`, preserving insertion order. Behavioral
 * equivalent of "keep the upstream decision" — safe no-op.
 *
 * @returns {RegexFallback}
 */
export function createIdentityFallback() {
  return {
    match(state) {
      const suggested = state?.context?.skills?.suggested;
      return Array.isArray(suggested) ? [...suggested] : [];
    },
  };
}

function readEnabled(config) {
  return Boolean(config?.learning?.grpoRouting?.skillPolicy?.enabled);
}

function readThreshold(config) {
  const v = config?.learning?.grpoRouting?.skillPolicy?.threshold;
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_TRIGGER_OPTIONS.threshold;
}

function readMaxTriggers(config) {
  const v = config?.learning?.grpoRouting?.skillPolicy?.maxTriggers;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return DEFAULT_TRIGGER_OPTIONS.maxTriggers;
}

// ---------------------------------------------------------------------------
// Intent / context extraction
// ---------------------------------------------------------------------------

function pickIntent(state) {
  const intent = state?.context?.intent ?? {};
  if (typeof intent.best === 'string' && intent.best) return intent.best;
  const firstCmd = Array.isArray(intent.commands) ? intent.commands[0] : null;
  if (typeof firstCmd === 'string' && firstCmd) return firstCmd;
  if (typeof state?.userPrompt === 'string') return state.userPrompt;
  return '';
}

function buildContext(state) {
  const intent = state?.context?.intent ?? {};
  return {
    commands: Array.isArray(intent.commands) ? intent.commands : [],
    intents: Array.isArray(intent.intents) ? intent.intents : [],
    domains: Array.isArray(intent.domains) ? intent.domains : [],
  };
}

// ---------------------------------------------------------------------------
// Selection modes
// ---------------------------------------------------------------------------

/**
 * Score-based selection: pull scores from the policy, threshold + cap.
 *
 * @param {SkillPolicyLike} skillPolicy
 * @param {object} state
 * @param {string[]} candidates
 * @param {{threshold: number, maxTriggers: number}} opts
 * @returns {Promise<{ selected: { name: string, score: number }[], scores: Record<string, number>, source: 'policy' }>}
 */
async function selectByPolicy(skillPolicy, state, candidates, opts) {
  const intent = pickIntent(state);
  const ctx = buildContext(state);
  const scores = await skillPolicy.scoreSkills(intent, ctx, { candidates });
  const selected = await skillPolicy.selectSkills(intent, ctx, {
    candidates,
    threshold: opts.threshold,
    maxTriggers: opts.maxTriggers,
  });
  return { selected, scores, source: 'policy' };
}

/**
 * Regex / baseline selection via supplied fallback. Output keeps input order
 * and caps at `maxTriggers`.
 *
 * @param {RegexFallback} fallback
 * @param {object} state
 * @param {string[]} candidates
 * @param {{maxTriggers: number}} opts
 * @returns {{ selected: { name: string, score: number }[], scores: Record<string, number>, source: 'regex' }}
 */
function selectByRegex(fallback, state, candidates, opts) {
  const matched = fallback.match(state) ?? [];
  const candidateSet = new Set(candidates);
  const out = [];
  for (const name of matched) {
    if (!candidateSet.has(name)) continue;
    if (out.find((e) => e.name === name)) continue;
    out.push({ name, score: 1 });
    if (out.length >= opts.maxTriggers) break;
  }
  const scores = Object.create(null);
  for (const name of candidates) scores[name] = 0;
  for (const { name } of out) scores[name] = 1;
  return { selected: out, scores, source: 'regex' };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the skill-trigger middleware.
 *
 * @param {object} [options]
 * @param {SkillPolicyLike} [options.skillPolicy] - pre-built policy (usually
 *   from `createSkillPolicy`). When absent, middleware always takes the regex path.
 * @param {RegexFallback} [options.fallback] - regex/keyword matcher; defaults
 *   to {@link createIdentityFallback}.
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {(state: object) => Promise<object>}
 */
export function createSkillTriggerMiddleware(options = {}) {
  const policy = options.skillPolicy ?? null;
  const fallback = options.fallback ?? createIdentityFallback();
  const logger = options.logger ?? { info() {}, warn() {} };

  return async function skillTriggerMiddleware(state) {
    if (!state || typeof state !== 'object') return state;
    const config = state.config ?? {};
    const candidates = Array.isArray(state?.context?.skills?.suggested)
      ? [...state.context.skills.suggested]
      : [];

    if (candidates.length === 0) {
      applyTriggerState(state, [], {}, 'none');
      return state;
    }

    const enabled = readEnabled(config) && Boolean(policy);
    const opts = {
      threshold: readThreshold(config),
      maxTriggers: readMaxTriggers(config),
    };

    if (!enabled) {
      const res = selectByRegex(fallback, state, candidates, opts);
      applyTriggerState(state, res.selected, res.scores, res.source);
      return state;
    }

    try {
      const res = await selectByPolicy(policy, state, candidates, opts);
      if (res.selected.length === 0) {
        // Policy had no confident pick — keep regex baseline so the run never
        // silently drops all skills after enabling learning.
        const fb = selectByRegex(fallback, state, candidates, opts);
        applyTriggerState(state, fb.selected, res.scores, 'regex-fallback-empty');
        return state;
      }
      applyTriggerState(state, res.selected, res.scores, res.source);
    } catch (err) {
      logger.warn?.(`skill-trigger policy failure: ${err?.message ?? err}`);
      const res = selectByRegex(fallback, state, candidates, opts);
      applyTriggerState(state, res.selected, res.scores, 'regex-on-error');
    }
    return state;
  };
}

function applyTriggerState(state, selected, scores, source) {
  const triggered = selected.map((s) => s.name);
  state.context.skills = {
    ...(state.context.skills ?? {}),
    triggered,
    triggerScores: scores,
    triggerSource: source,
  };
  state.messageParts = Array.isArray(state.messageParts) ? state.messageParts : [];
  state.messageParts.push(`triggered=${triggered.length}`);
}
