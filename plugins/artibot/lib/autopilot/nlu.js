/**
 * Autopilot NLU classifier (PRD docs/PRD/autopilot-mode.md §12).
 *
 * Pure regex + keyword scoring. NO external API calls (DATA POLICY compliance).
 * Detects natural-language signals that the user wants long-running autonomous
 * work, then proposes (does not auto-run) an `/autopilot` mode.
 *
 * Scoring tiers (cap 1.0):
 *   - Tier 1 (high signal):   +0.50 each — sleep/away/overnight phrases
 *   - Tier 2 (medium signal): +0.30 each — explicit duration / autonomy intent
 *   - Tier 3 (low signal):    +0.15 each — broad-scope phrasing
 *   - Negative signal:        -0.50    — "right now / interactive" markers
 *
 * Suggestion mode picked from keyword class:
 *   - night  : 자고 / 잘 / 밤 / overnight
 *   - plan   : 검토부터 / PRD만 / plan only
 *   - default: anything else above threshold
 *
 * Threshold: score >= 0.7. Below threshold returns suggestion=null (no trigger).
 *
 * @module lib/autopilot/nlu
 */

 

const TIER1_PATTERNS = [
  /자고\s*올(?:게|\b)/u,
  /자고\s*올\s*동안/u,
  /잠깐\s*자리/u,
  /퇴근하고/u,
  /내일\s*아침/u,
  /밤사이/u,
  /going\s+to\s+sleep/i,
  /be\s+away\s+for/i,
  /while\s+i'?m\s+gone/i,
  /\bovernight\b/i,
];

const TIER2_PATTERNS = [
  // explicit duration / long-task signals
  /\d+\s*시간/u,
  /밤새/u,
  /장기\s*작업/u,
  /긴\s*작업/u,
  /\blong-?running\b/i,
  /\blong\s+task\b/i,
  // autonomy intent
  /혼자\s*진행/u,
  /알아서/u,
  /자동으로\s*다/u,
  /\bautonomous\b/i,
  // broad-scope completion intent (paired with sleep signal -> strong autopilot)
  /다\s*구현/u,
  /모두\s*구현/u,
  /통째로/u,
  /한\s*번에\s*다/u,
  // plan-only intent: explicit handoff to user review
  /검토부터/u,
  /검토만/u,
  /PRD만/iu,
  /\bplan\s+only\b/i,
];

const TIER3_PATTERNS = [
  /전체/u,
  /결과\s*(?:로\s*)?(?:봐|보여|보고)/u,
  /\ball\s+at\s+once\b/i,
  /\bcomplete\b/i,
];

const NEGATIVE_PATTERNS = [
  /지금\s*바로/u,
  /당장/u,
  /즉시/u,
  /\bright\s+now\b/i,
  /\bnow\b(?!\s*(?:that|i'?m|what))/i,
  /\binteractive\b/i,
];

const NIGHT_PATTERNS = [/자고/u, /\b잘\b/u, /밤/u, /\bovernight\b/i];
const PLAN_PATTERNS = [/검토부터/u, /검토만/u, /PRD만/iu, /\bplan\s+only\b/i];

const TIER1_WEIGHT = 0.5;
const TIER2_WEIGHT = 0.3;
const TIER3_WEIGHT = 0.15;
const NEGATIVE_WEIGHT = -0.5;
const SCORE_CAP = 1.0;
const THRESHOLD = 0.7;

/**
 * Apply a tier of patterns, returning matched-source strings and weighted delta.
 * @param {string} text
 * @param {RegExp[]} patterns
 * @param {number} weight
 * @returns {{ matches: string[], delta: number }}
 */
function scoreTier(text, patterns, weight) {
  const matches = [];
  let delta = 0;
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      matches.push(m[0]);
      delta += weight;
    }
  }
  return { matches, delta };
}

/**
 * Pick suggestion mode from matched text. Order matters: night > plan > default.
 * @param {string} text
 * @returns {'default'|'night'|'plan'}
 */
function pickMode(text) {
  if (PLAN_PATTERNS.some((p) => p.test(text))) return 'plan';
  if (NIGHT_PATTERNS.some((p) => p.test(text))) return 'night';
  return 'default';
}

/**
 * Classify a user prompt for autopilot intent.
 *
 * @param {string} promptText
 * @returns {{ score: number, matched: string[], suggestion: 'default'|'night'|'plan'|null }}
 */
export function classifyAutopilotIntent(promptText) {
  const text = String(promptText || '');
  if (!text.trim()) {
    return { score: 0, matched: [], suggestion: null };
  }

  const t1 = scoreTier(text, TIER1_PATTERNS, TIER1_WEIGHT);
  const t2 = scoreTier(text, TIER2_PATTERNS, TIER2_WEIGHT);
  const t3 = scoreTier(text, TIER3_PATTERNS, TIER3_WEIGHT);
  const neg = scoreTier(text, NEGATIVE_PATTERNS, NEGATIVE_WEIGHT);

  // Plan-only co-occurrence bonus: multiple plan markers together imply
  // an explicit handoff for review (e.g., "PRD만" + "검토만" + "할게").
  const planHits = PLAN_PATTERNS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  const planBonus = planHits >= 2 ? 0.2 : 0;

  const raw = t1.delta + t2.delta + t3.delta + neg.delta + planBonus;
  const score = Math.max(0, Math.min(SCORE_CAP, Number(raw.toFixed(4))));
  const matched = [...t1.matches, ...t2.matches, ...t3.matches];

  if (score < THRESHOLD) {
    return { score, matched, suggestion: null };
  }
  return { score, matched, suggestion: pickMode(text) };
}

export const __test = {
  TIER1_PATTERNS,
  TIER2_PATTERNS,
  TIER3_PATTERNS,
  NEGATIVE_PATTERNS,
  THRESHOLD,
};
