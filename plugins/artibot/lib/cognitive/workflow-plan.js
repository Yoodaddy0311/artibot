/**
 * Unified Effort × Team-Trigger workflow planner (cognitive layer, pure L4).
 *
 * Computes the complexity-derived team trigger AND per-teammate effort/budget
 * from a single source so the auto-team decision and each teammate's
 * `[artibot:effort][artibot:task-budget]` prefix stay consistent.
 *
 * Layer integrity: imports router.js ONLY. `resolveEffort`/`budgetResolver`
 * are injected via `deps` by the L5 composition root (tasks.js); when absent
 * the planner falls back to the static `getEffortForCommand` mapping and a
 * zero budget so it runs standalone.
 *
 * Live-intent note: the runtime `intent` object has no `subObjectives` field.
 * Each `intent.recommendations[]` entry is treated as one sub-objective, and
 * `recommendations.length` is used as the proxy for BOTH subtask count and
 * file count (the trigger config keys `minSubtasks`/`minFiles`).
 *
 * @module lib/cognitive/workflow-plan
 */

import { getEffortForCommand } from './router.js';

/** Ordered effort ladder (low → max). Index used for clamping. */
export const EFFORT_LADDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** Complexity-tier ordering for `minComplexity` comparison. */
const TIER_ORDER = Object.freeze(['low', 'medium', 'high']);

/**
 * Ladder index for an effort level; unknown levels default to 'medium' (1).
 * @param {string} level
 * @returns {number}
 */
function idx(level) {
  const i = EFFORT_LADDER.indexOf(level);
  return i < 0 ? 1 : i;
}

/**
 * Map a complexity score to a coarse tier.
 * @param {number} score
 * @returns {'low'|'medium'|'high'}
 */
function complexityTier(score) {
  const s = typeof score === 'number' && !Number.isNaN(score) ? score : 0;
  if (s >= 0.6) return 'high';
  if (s >= 0.35) return 'medium';
  return 'low';
}

/**
 * Clamp an effort level to the band [parent−1, parent].
 * @param {string} level
 * @param {string} parent
 * @returns {string}
 */
function clampEffort(level, parent) {
  const parentIdx = idx(parent);
  const lo = Math.max(0, parentIdx - 1);
  const clamped = Math.max(lo, Math.min(parentIdx, idx(level)));
  return EFFORT_LADDER[clamped];
}

/**
 * Derive sub-objectives from the live intent's recommendations.
 * Each recommendation → one sub-objective driving one teammate.
 * @param {object} intent
 * @returns {{ command: string, agent: string, intent: string }[]}
 */
function extractSubObjectives(intent) {
  const recs = Array.isArray(intent?.recommendations) ? intent.recommendations : [];
  return recs.map((rec) => ({
    command: (Array.isArray(rec?.commands) && rec.commands[0]) || '',
    agent: (Array.isArray(rec?.agents) && rec.agents[0]) || '',
    intent: rec?.intent || '',
  }));
}

/**
 * Evaluate whether the auto-team trigger fires for this classification/intent.
 * Numeric thresholds live in config (`team.autoApplyTriggers`); this is a pure
 * evaluator. `subtasks`/`files` both proxy off `recommendations.length`.
 *
 * @param {{ score?: number }} classification
 * @param {object} intent
 * @param {object} triggers - config team.autoApplyTriggers (may be partial).
 * @returns {{ fired: boolean, runner: 'inline'|'team', reasons: string[], bypassed: boolean }}
 */
function evaluateTrigger(classification, intent, triggers) {
  const t = triggers || {};
  const bypass = Array.isArray(t.bypassIntents) ? t.bypassIntents : [];
  const intents = Array.isArray(intent?.intents) ? intent.intents : [];
  const bestIntent = intent?.best?.intent || '';
  const isBypassed = bypass.some((b) => bestIntent.includes(b) || intents.some((i) => i.includes(b)));

  const proxy = extractSubObjectives(intent).length;
  const minSubtasks = typeof t.minSubtasks === 'number' ? t.minSubtasks : 3;
  const minFiles = typeof t.minFiles === 'number' ? t.minFiles : 3;
  const minComplexity = typeof t.minComplexity === 'string' ? t.minComplexity : 'high';
  const tier = complexityTier(classification?.score);

  const reasons = [];
  if (proxy >= minSubtasks) reasons.push(`subtasks>=${minSubtasks}`);
  if (proxy >= minFiles) reasons.push(`files>=${minFiles}`);
  if (TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minComplexity)) reasons.push(`complexity>=${minComplexity}`);

  const logic = String(t.logic || 'OR').toUpperCase();
  const fired = !isBypassed && (logic === 'AND' ? reasons.length === 3 : reasons.length > 0);
  return { fired, runner: fired ? 'team' : 'inline', reasons, bypassed: isBypassed };
}

/**
 * Resolve a per-teammate effort for each sub-objective, clamped to
 * [parent−1, parent] so teammates never exceed the parent's effort band.
 *
 * @param {{ command: string }[]} subObjectives
 * @param {string} parentEffort
 * @param {(command: string) => string} resolveFn - command → effort level.
 * @returns {string[]}
 */
export function deriveTeammateEfforts(subObjectives, parentEffort, resolveFn) {
  const subs = Array.isArray(subObjectives) ? subObjectives : [];
  return subs.map((sub) => clampEffort(resolveFn(sub.command || ''), parentEffort));
}

/**
 * Build a unified workflow plan from a single complexity classification.
 *
 * @param {{ score?: number, factors?: object }} classification
 * @param {object} intent - live intent ({ intents, recommendations, best, ... }).
 * @param {object} config - artibot.config.json object.
 * @param {object} [deps] - injected ports.
 * @param {(command: string, signals?: object) => ({effort:string}|string)} [deps.resolveEffort]
 * @param {(effort: string) => number} [deps.budgetResolver]
 * @returns {Readonly<{ runner:'inline'|'team', effort:string, perAgentBudget:number,
 *   teammates: ReadonlyArray<object>, trigger: object }>}
 */
/**
 * Build the resolveEffort port: P1's score-aware resolver if injected, else the
 * static EFFORT_POLICY map. Normalizes the resolver's return ({effort}|string)
 * to a plain band string.
 * @param {object} deps @param {object} cls @returns {(cmd:string)=>string}
 */
function makeResolveFn(deps, cls) {
  if (typeof deps.resolveEffort !== 'function') return (cmd) => getEffortForCommand(cmd);
  return (cmd) => {
    const r = deps.resolveEffort(cmd, { score: cls.score });
    if (r && typeof r === 'object' && r.effort) return r.effort;
    return typeof r === 'string' ? r : getEffortForCommand(cmd);
  };
}

export function buildWorkflowPlan(classification, intent, config, deps = {}) {
  const cls = classification || {};
  const safeIntent = intent || {};
  const triggers = config?.team?.autoApplyTriggers || {};

  const resolveFn = makeResolveFn(deps, cls);
  const budgetResolver = typeof deps.budgetResolver === 'function' ? deps.budgetResolver : () => 0;

  const parentCmd = safeIntent.best?.commands?.[0] || 'team';
  const parentEffort = resolveFn(parentCmd);
  const trigger = evaluateTrigger(cls, safeIntent, triggers);

  if (trigger.runner !== 'team') {
    return Object.freeze({
      runner: 'inline',
      effort: parentEffort,
      perAgentBudget: 0,
      teammates: Object.freeze([]),
      trigger: Object.freeze({ ...trigger }),
    });
  }

  const subObjectives = extractSubObjectives(safeIntent);
  const efforts = deriveTeammateEfforts(subObjectives, parentEffort, resolveFn);
  const teammates = subObjectives.map((sub, i) => Object.freeze({
    agent: sub.agent,
    command: sub.command,
    intent: sub.intent,
    effort: efforts[i],
    budget: budgetResolver(efforts[i]),
  }));

  const parentBudget = budgetResolver(parentEffort);
  const perAgentBudget = teammates.length > 0
    ? Math.floor(parentBudget / teammates.length)
    : 0;

  return Object.freeze({
    runner: 'team',
    effort: parentEffort,
    perAgentBudget,
    teammates: Object.freeze(teammates),
    trigger: Object.freeze({ ...trigger }),
  });
}
