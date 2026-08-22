/**
 * Unified Effort × Team-Trigger workflow planner (cognitive layer, pure L4).
 *
 * Computes the complexity-derived team trigger AND per-teammate effort/budget
 * from a single source so the auto-team decision and each teammate's
 * `[artibot:effort][artibot:task-budget]` prefix stay consistent.
 *
 * Layer integrity: imports effort-policy.js ONLY (the static effort mapping;
 * no routing-graph dependency). `resolveEffort`/`budgetResolver` are injected
 * via `deps` by the L5 composition root (tasks.js); when absent the planner
 * falls back to the static `getEffortForCommand` mapping and a zero budget so
 * it runs standalone.
 *
 * Live-intent note: the runtime `intent` object has no `subObjectives` field.
 * Each `intent.recommendations[]` entry is treated as one sub-objective, and
 * `recommendations.length` is used as the proxy for BOTH subtask count and
 * file count (the trigger config keys `minSubtasks`/`minFiles`).
 *
 * @module lib/cognitive/workflow-plan
 */

import { getEffortForCommand } from './effort-policy.js';

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
 * Resolve the parent command from either intent shape:
 * - raw detectIntent shape: `best` is an object → `best.commands[0]`
 * - router-middleware shallow shape: `best` is a string, `commands` is a
 *   top-level array → `intent.commands[0]`
 * Falls back to 'team' (→ xhigh baseline) when neither carries a command.
 * @param {object} intent
 * @returns {string}
 */
function parentCommand(intent) {
  const fromBestObject = intent?.best && typeof intent.best === 'object'
    ? (Array.isArray(intent.best.commands) ? intent.best.commands[0] : undefined)
    : undefined;
  const fromTopLevel = Array.isArray(intent?.commands) ? intent.commands[0] : undefined;
  return fromBestObject || fromTopLevel || 'team';
}

/**
 * Evaluate whether the auto-team trigger fires for this classification/intent.
 * Numeric thresholds live in config (`team.autoApplyTriggers`); this is a pure
 * evaluator. `subtasks`/`files` both proxy off `recommendations.length`.
 *
 * SOLE OWNER of the auto-team decision (PRD command-improvement-verified
 * 20260822 §T2). `scripts/hooks/auto-team-trigger.js` no longer re-implements
 * the thresholds: it adapts a raw prompt into `{ classification, intent }` and
 * RENDERS whatever this function returns. Any threshold/precedence change must
 * happen here and only here — a second evaluator is how the pre-T2 hook drifted
 * into ignoring `minComplexity`/`bypassIntents`/`logic`.
 *
 * Defaults applied when a key is absent from `triggers` (this is the single
 * source for them — callers MUST NOT pre-fill their own copies):
 *   minSubtasks=3, minFiles=3, minComplexity='high', logic='OR', bypassIntents=[]
 *
 * @param {{ score?: number }} classification
 * @param {object} intent
 * @param {object} triggers - config team.autoApplyTriggers (may be partial).
 * @returns {{ fired: boolean, runner: 'inline'|'team', reasons: string[], bypassed: boolean }}
 */
export function evaluateTrigger(classification, intent, triggers) {
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

  // Three thresholds, but only TWO distinct signals: `subtasks` and `files`
  // both proxy off recommendations.length (the live intent has no separate
  // file count), so they collapse into one "size" signal. Counting them as two
  // double-counts and makes the AND path (which needs every distinct signal)
  // unreachable whenever minSubtasks !== minFiles. We gate AND on distinct
  // signals met, not on the length of the human-readable reasons[] array.
  const sizeThreshold = Math.max(minSubtasks, minFiles);
  const sizeSignal = proxy >= sizeThreshold;
  const complexitySignal = TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minComplexity);

  const reasons = [];
  if (proxy >= minSubtasks) reasons.push(`subtasks>=${minSubtasks}`);
  if (proxy >= minFiles) reasons.push(`files>=${minFiles}`);
  if (complexitySignal) reasons.push(`complexity>=${minComplexity}`);

  const logic = String(t.logic || 'OR').toUpperCase();
  const signalsMet = (sizeSignal ? 1 : 0) + (complexitySignal ? 1 : 0);
  const fired = !isBypassed && (logic === 'AND' ? signalsMet === 2 : signalsMet > 0);
  return { fired, runner: fired ? 'team' : 'inline', reasons, bypassed: isBypassed };
}

/**
 * Derive an ADVISORY runner recommendation (NOT an auto-fire decision).
 *
 * Purely additive signal for the classifier to SURFACE to the user; it never
 * changes runner selection. Only `inline`/`team` auto-fire — `workflow` and
 * `autopilot` require explicit user opt-in, so this layer can only suggest.
 *
 * - Homogeneous fan-out (>=3 sub-objectives, largest same-command group >=3)
 *   → 'workflow' (a deterministic pipeline fits a repeated-command batch).
 * - Else a big multi-domain high-tier job (tier 'high', >=6 sub-objectives)
 *   → 'autopilot' (worth an unattended session).
 * - Else → null (no signal).
 *
 * @param {{ command: string }[]} subObjectives
 * @param {'low'|'medium'|'high'} tier
 * @returns {'workflow'|'autopilot'|null}
 */
function deriveRecommendation(subObjectives, tier) {
  const subs = Array.isArray(subObjectives) ? subObjectives : [];
  const counts = new Map();
  for (const sub of subs) {
    const cmd = sub?.command || '';
    counts.set(cmd, (counts.get(cmd) || 0) + 1);
  }
  const maxRepeat = counts.size > 0 ? Math.max(...counts.values()) : 0;
  if (subs.length >= 3 && maxRepeat >= 3) return 'workflow';
  if (tier === 'high' && subs.length >= 6) return 'autopilot';
  return null;
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

  const parentCmd = parentCommand(safeIntent);
  const parentEffort = resolveFn(parentCmd);
  const trigger = evaluateTrigger(cls, safeIntent, triggers);

  const subObjectives = extractSubObjectives(safeIntent);
  const recommendation = deriveRecommendation(subObjectives, complexityTier(cls.score));

  if (trigger.runner !== 'team') {
    return Object.freeze({
      runner: 'inline',
      effort: parentEffort,
      perAgentBudget: 0,
      teammates: Object.freeze([]),
      trigger: Object.freeze({ ...trigger }),
      recommendation,
      autoFire: false,
    });
  }

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
    recommendation,
    autoFire: true,
  });
}
