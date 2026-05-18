/**
 * Cognitive Intent Auto-Routing for Autopilot (v4.11.0 Track I).
 *
 * Detects user intent in plain prompts to silently auto-apply Track E/F/G/H
 * features WITHOUT the user typing any slash command. Pure regex/keyword
 * matching — deterministic, no LLM calls, no external I/O.
 *
 * Supported intents (5):
 *   - queue     : multi-goal FIFO ("이거 3개 다", numbered lists, conjunction chains)
 *   - schedule  : time-window run ("오늘 밤", "overnight", "내일 아침까지")
 *   - dry-run   : preview/simulate without side effects
 *   - template  : bugfix | refactor | feature
 *   - rollback  : revert / undo / restore
 *
 * Confidence range: [0.0, 1.0]. Detection thresholds tuned so that one
 * strong signal yields ~0.7 (the orchestrator's default auto-trigger gate).
 *
 * DATA POLICY: pure in-memory regex. No file I/O, no network, no LLM.
 *
 * @module lib/cognitive/autopilot-intent
 */

const CONFIDENCE_CAP = 1.0;
const NO_INTENT = Object.freeze({ found: false, confidence: 0 });

// ---------------------------------------------------------------------------
// Queue intent — multi-goal / batch
// ---------------------------------------------------------------------------

const QUEUE_BATCH_PATTERNS = [
  // Korean batch markers
  /이거\s*\d+\s*개\s*다/u,
  /이것들\s*(?:다|모두|처리|진행)/u,
  /이\s*\d+\s*개\s*(?:다|모두|전부)/u,
  /한\s*번에\s*\d+/u,
  /다\s*한\s*번에/u,
  // English batch markers
  /\ball\s+\d+\s+(?:of\s+these|tasks|items|goals)\b/i,
  /\b(?:these|those)\s+(?:all|\d+)\b/i,
  /\bbatch\s+(?:these|all)\b/i,
  /\bqueue\s+(?:these|up|all)\b/i,
];

const KOREAN_CONJ_RE = /그리고/gu;
const ENGLISH_CONJ_RE = /\band\b/gi;
const COMMA_TASK_RE = /[^,\n]{6,},\s*[^,\n]{6,},\s*[^,\n]{6,}/u;

/**
 * Count occurrences of conjunction connectors. Two or more linking phrases
 * (e.g., "A 그리고 B 그리고 C") signal a chained task list.
 * @param {string} text
 * @returns {number}
 */
function countConjunctions(text) {
  const ko = (text.match(KOREAN_CONJ_RE) || []).length;
  const en = (text.match(ENGLISH_CONJ_RE) || []).length;
  return ko + en;
}

/**
 * Detect multi-goal queue intent in a prompt.
 * @param {string} prompt - Raw user input.
 * @returns {{ found: boolean, goals: string[], confidence: number }}
 */
export function detectQueueIntent(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ...NO_INTENT, goals: [] };
  }

  const goals = [];
  let confidence = 0;

  // Numbered list (strongest signal)
  const numbered = extractNumberedItems(prompt);
  if (numbered.length >= 2) {
    goals.push(...numbered);
    confidence += 0.6 + Math.min(0.2, (numbered.length - 2) * 0.05);
  }

  // Batch phrase
  for (const pat of QUEUE_BATCH_PATTERNS) {
    if (pat.test(prompt)) {
      confidence += 0.5;
      break;
    }
  }

  // Conjunction chain ("X 그리고 Y 그리고 Z" or English "and ... and")
  const conjCount = countConjunctions(prompt);
  if (conjCount >= 2) {
    confidence += 0.5;
  } else if (conjCount === 1) {
    confidence += 0.15;
  }

  // Comma-separated task list
  if (goals.length === 0 && COMMA_TASK_RE.test(prompt)) {
    const parts = prompt.split(/,\s*/).map((p) => p.trim()).filter((p) => p.length >= 6);
    if (parts.length >= 3) {
      goals.push(...parts);
      confidence += 0.4;
    }
  }

  const final = Math.min(CONFIDENCE_CAP, confidence);
  return {
    found: final >= 0.3,
    goals: dedupeShortlist(goals, 20),
    confidence: round2(final),
  };
}

/**
 * Extract numbered list items (e.g., "1. foo\n2. bar").
 * @param {string} text
 * @returns {string[]}
 */
function extractNumberedItems(text) {
  const items = [];
  const lines = text.split(/\n+/);
  for (const line of lines) {
    const m = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (m && m[1].trim().length >= 2) items.push(m[1].trim());
  }
  return items;
}

// ---------------------------------------------------------------------------
// Schedule intent — time window
// ---------------------------------------------------------------------------

const SCHEDULE_NIGHT_PATTERNS = [
  /오늘\s*밤/u,
  /오늘밤/u,
  /내일\s*아침\s*까지/u,
  /잠자는\s*동안/u,
  /자는\s*동안/u,
  /자고\s*올\s*동안/u,
  /야간\s*에\s*만/u,
  /야간에만/u,
  /밤사이/u,
  /밤새/u,
  /\bovernight\b/i,
  /\btonight\b/i,
  /\bwhile\s+i'?m\s+(?:sleeping|asleep|away)\b/i,
  /\bby\s+(?:tomorrow|morning)\b/i,
];

const SCHEDULE_MORNING_PATTERNS = [
  /내일\s*아침/u,
  /\btomorrow\s+morning\b/i,
];

const NIGHT_WINDOW = '22:00-07:00';
const MORNING_WINDOW = '06:00-09:00';

/**
 * Detect schedule-window intent in a prompt.
 * @param {string} prompt
 * @returns {{ found: boolean, window: string|null, confidence: number }}
 */
export function detectScheduleIntent(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ...NO_INTENT, window: null };
  }

  let nightHits = 0;
  for (const pat of SCHEDULE_NIGHT_PATTERNS) {
    if (pat.test(prompt)) nightHits++;
  }

  if (nightHits > 0) {
    const confidence = Math.min(CONFIDENCE_CAP, 0.75 + (nightHits - 1) * 0.1);
    return { found: true, window: NIGHT_WINDOW, confidence: round2(confidence) };
  }

  for (const pat of SCHEDULE_MORNING_PATTERNS) {
    if (pat.test(prompt)) {
      return { found: true, window: MORNING_WINDOW, confidence: 0.55 };
    }
  }

  return { found: false, window: null, confidence: 0 };
}

// ---------------------------------------------------------------------------
// Dry-run intent — preview only
// ---------------------------------------------------------------------------

const DRY_RUN_PATTERNS = [
  /한\s*번\s*봐\s*줘/u,
  /한번\s*봐\s*줘/u,
  /테스트\s*만/u,
  /테스트만/u,
  /미리\s*보기/u,
  /미리보기/u,
  /시뮬레이션/u,
  /시뮬레/u,
  /어떻게\s*될지\s*만/u,
  /어떻게\s*될지만/u,
  /어찌\s*되는지/u,
  /확인\s*만/u,
  /확인만/u,
  /\bdry[\s-]?run\b/i,
  /\bpreview\b/i,
  /\bsimulate\b/i,
  /\bwhat[\s-]?if\b/i,
  /\bno[\s-]?op\b/i,
];

/**
 * Detect dry-run / preview intent.
 * @param {string} prompt
 * @returns {{ found: boolean, confidence: number }}
 */
export function detectDryRunIntent(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return NO_INTENT;

  let hits = 0;
  for (const pat of DRY_RUN_PATTERNS) {
    if (pat.test(prompt)) hits++;
  }
  if (hits === 0) return NO_INTENT;

  const confidence = Math.min(CONFIDENCE_CAP, 0.7 + (hits - 1) * 0.1);
  return { found: true, confidence: round2(confidence) };
}

// ---------------------------------------------------------------------------
// Template intent — bugfix / refactor / feature
// ---------------------------------------------------------------------------

const TEMPLATE_PATTERNS = Object.freeze({
  bugfix: [
    /버그/u,
    /고쳐/u,
    /고쳐줘/u,
    /에러/u,
    /오류/u,
    /깨졌/u,
    /\bfix\b/i,
    /\bbug\b/i,
    /\bbroken\b/i,
    /\berror\b/i,
    /\bissue\b/i,
  ],
  refactor: [
    /정리/u,
    /리팩/u,
    /리팩토링/u,
    /클린업/u,
    /깔끔하게/u,
    /\brefactor\b/i,
    /\bclean[\s-]?up\b/i,
    /\btidy\b/i,
    /\brestructure\b/i,
  ],
  feature: [
    /추가\s*(?:해|로|기능)/u,
    /신기능/u,
    /새\s*기능/u,
    /만들어/u,
    /만들어줘/u,
    /구현해/u,
    /\bnew\s+feature\b/i,
    /\badd\s+(?:a\s+)?(?:new\s+)?(?:feature|endpoint|page)\b/i,
    /\bimplement\b/i,
    /\bbuild\s+(?:a\s+)?new\b/i,
  ],
});

/**
 * Detect template hint (bugfix / refactor / feature).
 * Returns the highest-confidence single template; ties broken by priority
 * order: bugfix > refactor > feature.
 *
 * @param {string} prompt
 * @returns {{ found: boolean, template: 'bugfix'|'refactor'|'feature'|null, confidence: number }}
 */
export function detectTemplateHint(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ...NO_INTENT, template: null };
  }

  const scores = scoreTemplates(prompt);
  let best = null;
  let bestScore = 0;
  for (const name of ['bugfix', 'refactor', 'feature']) {
    if (scores[name] > bestScore) {
      best = name;
      bestScore = scores[name];
    }
  }

  if (!best) return { found: false, template: null, confidence: 0 };
  return {
    found: bestScore >= 0.5,
    template: best,
    confidence: round2(Math.min(CONFIDENCE_CAP, bestScore)),
  };
}

/**
 * Compute per-template hit-based confidence scores.
 * @param {string} prompt
 * @returns {Record<'bugfix'|'refactor'|'feature', number>}
 */
function scoreTemplates(prompt) {
  const out = { bugfix: 0, refactor: 0, feature: 0 };
  for (const [name, patterns] of Object.entries(TEMPLATE_PATTERNS)) {
    let hits = 0;
    for (const pat of patterns) {
      if (pat.test(prompt)) hits++;
    }
    if (hits > 0) {
      out[name] = Math.min(CONFIDENCE_CAP, 0.5 + (hits - 1) * 0.15);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rollback intent — undo / restore
// ---------------------------------------------------------------------------

const ROLLBACK_PATTERNS = [
  /되돌려/u,
  /되돌리기/u,
  /롤백/u,
  /복구/u,
  /복원/u,
  /취소(?:해|하기)/u,
  /원상\s*복구/u,
  /이전\s*상태/u,
  /\brollback\b/i,
  /\brevert\b/i,
  /\bundo\b/i,
  /\brestore\b/i,
];

/**
 * Detect rollback / undo intent.
 * @param {string} prompt
 * @returns {{ found: boolean, confidence: number }}
 */
export function detectRollbackIntent(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return NO_INTENT;

  let hits = 0;
  for (const pat of ROLLBACK_PATTERNS) {
    if (pat.test(prompt)) hits++;
  }
  if (hits === 0) return NO_INTENT;

  const confidence = Math.min(CONFIDENCE_CAP, 0.7 + (hits - 1) * 0.15);
  return { found: true, confidence: round2(confidence) };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Run all five intent detectors and return a combined map.
 *
 * @param {string} prompt
 * @returns {{
 *   queue: ReturnType<typeof detectQueueIntent>,
 *   schedule: ReturnType<typeof detectScheduleIntent>,
 *   dryRun: ReturnType<typeof detectDryRunIntent>,
 *   template: ReturnType<typeof detectTemplateHint>,
 *   rollback: ReturnType<typeof detectRollbackIntent>,
 * }}
 */
export function detectAllIntents(prompt) {
  return {
    queue: detectQueueIntent(prompt),
    schedule: detectScheduleIntent(prompt),
    dryRun: detectDryRunIntent(prompt),
    template: detectTemplateHint(prompt),
    rollback: detectRollbackIntent(prompt),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Round to 2 decimal places (display precision used across cognitive layer).
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Dedupe a string list (case-insensitive) and cap length.
 * @param {string[]} items
 * @param {number} cap
 * @returns {string[]}
 */
function dedupeShortlist(items, cap) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= cap) break;
  }
  return out;
}
