#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Auto-Team Trigger.
 * Detects multi-subtask / multi-domain / medium+ complexity prompts and
 * injects a `[auto-team-suggested]` hint via additionalContext so the main
 * Claude (orchestrator) auto-spawns a parallel team.
 *
 * ROLE (PRD command-improvement-verified-20260822 §T2 — decision-owner
 * unification). This hook is a RENDERER, not an evaluator. It does two things:
 *
 *   1. ADAPT — turn the raw prompt string into the `{ classification, intent }`
 *      shape that the canonical evaluator consumes (the hook is the only place
 *      that sees a prompt; the planner only ever sees a classified intent).
 *   2. RENDER — hand that to `lib/cognitive/workflow-plan.js#evaluateTrigger`
 *      and turn its decision object into `additionalContext` text.
 *
 * Every threshold and every precedence rule (`minSubtasks`, `minFiles`,
 * `minComplexity`, `logic`, `bypassIntents`, and their defaults) lives in the
 * canonical evaluator. This file MUST NOT re-derive any of them — that
 * duplication is exactly what made the pre-T2 hook silently ignore
 * `minComplexity`/`bypassIntents`/`logic` and compare `minFiles` against a
 * different unit than the canonical evaluator did.
 *
 * Prompt→signal adaptation (hook-owned, because the planner has no prompt):
 *   - subtask count      <- multi-verb conjunctions ("and"/"then"/"하고"/…)
 *   - domain count       <- domain keyword families (frontend/backend/db/…)
 *   - size proxy         <- max(subtasks, domains); the canonical evaluator
 *                           collapses minSubtasks/minFiles into one size
 *                           signal, so the adapter must supply one number.
 *   - complexity score   <- keyword hit -> high band, else multi-signal ->
 *                           medium band, else low band (numeric so that a
 *                           configured `minComplexity` of low/medium/high is
 *                           actually distinguishable).
 *   - intent labels      <- question/diagnose/explain/lookup detection, so
 *                           `bypassIntents` has something to match against.
 *
 * Opt-out:
 *   - `--no-team` anywhere in prompt
 *   - `team.autoApply: false` in artibot.config.json
 *   - any configured `team.autoApplyTriggers.bypassIntents` label
 *
 * Hot-path note: this runs on every UserPromptSubmit. Config is read with a
 * synchronous JSON read (no dynamic import for static JSON), and the canonical
 * evaluator is pulled in via a STATIC import so the module-resolution cost is
 * paid once at process/dispatcher start rather than on every prompt. Do not
 * convert this to `await import(...)`.
 *
 * @module scripts/hooks/auto-team-trigger
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { evaluateTrigger } from '../../lib/cognitive/workflow-plan.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'auto-team-trigger';
const NO_TEAM_FLAG = /--no-team\b/i;

/**
 * ROLLBACK TOGGLE (first release only — delete with the v+1 release).
 *
 * `false` = canonical path: the decision comes from
 * `workflow-plan.js#evaluateTrigger`. `true` = the pre-T2 hook-local evaluator
 * preserved verbatim in {@link legacyEvaluatePrompt}. Flip this one line to
 * restore the old behavior if the unified evaluator regresses in the field.
 *
 * @type {boolean}
 */
const USE_LEGACY_TRIGGER_EVALUATOR = false;

// Domain keywords (English + Korean). Each unique HIT counts once toward the
// domain set (Set semantics dedupe synonyms within the same family).
const DOMAIN_KEYWORDS = {
  frontend: /\b(frontend|front-?end|ui|ux|component|react|vue|svelte)\b|프론트|화면|컴포넌트/i,
  backend: /\b(backend|back-?end|server|handler|endpoint|route)\b|백엔드|서버/i,
  db: /\b(database|db|sql|schema|migration|prisma|orm)\b|디비|데이터베이스|스키마/i,
  api: /\b(api|rest|graphql|grpc|webhook)\b|에이피아이/i,
  test: /\b(test|spec|tdd|unit|integration|e2e|coverage)\b|테스트|커버리지/i,
  style: /\b(css|style|tailwind|theme|design)\b|스타일|디자인/i,
  auth: /\b(auth|login|jwt|oauth|rbac|permission)\b|인증|로그인|권한/i,
  config: /\b(config|env|settings|yaml|toml)\b|설정|환경/i,
  docs: /\b(docs?|readme|markdown|guide)\b|문서|가이드/i,
  hook: /\b(hook|webhook|listener|event)\b|훅/i,
};

// Complexity / system-wide signal keywords -> medium+ complexity.
const COMPLEXITY_PATTERN =
  /\b(architecture|system-?wide|migration|refactor|redesign|overhaul|comprehensive|production)\b|전체|시스템|아키텍처|마이그레이션|리팩토링|재설계|종합/i;

// Multi-verb conjunction patterns. Matches "and|then|plus|또한|그리고|하고"
// boundaries so each separates two action clauses.
const VERB_CONJUNCTION_PATTERNS = [
  /\b(?:and|then|plus|also)\b/gi,
  /(하고|그리고|또한|및|후에|다음에)/g,
  /,\s*\S/g, // commas joining independent clauses (rough heuristic)
];

// Intent labels the adapter can detect from a bare prompt. Keys are the exact
// strings shipped in artibot.config.json#/team/autoApplyTriggers/bypassIntents,
// so `evaluateTrigger`'s substring match resolves against them directly.
// Adding a label here only ever gives `bypassIntents` more to match — it never
// fires the team on its own.
const INTENT_KEYWORDS = {
  question: /\?|뭐(야|니|죠)|무엇|어떻게|왜|어디|언제|인가요|일까요|\b(what|why|how|when|where|which|who)\b/i,
  diagnose: /\b(diagnose|debug|investigate|why is|root cause|triage)\b|진단|원인|디버깅|왜 안|안 되/i,
  explain: /\b(explain|describe|walk me through|summari[sz]e|overview)\b|설명|알려줘|요약|개요/i,
  lookup: /\b(find|search|locate|look ?up|list|show me|where is)\b|찾아|검색|보여줘|알려달라|조회/i,
};

// Numeric bands that `workflow-plan.js#complexityTier` maps to low/medium/high.
// Kept as named constants so the adapter's intent is legible; the tier
// BOUNDARIES themselves are owned by workflow-plan.js — these are the values
// the adapter emits, not a second copy of the comparison.
const SCORE_HIGH = 0.6;
const SCORE_MEDIUM = 0.35;
const SCORE_LOW = 0.1;

const TRIVIAL_MAX_CHARS = 30;

/**
 * Count distinct domains hit by prompt keywords.
 * @param {string} prompt
 * @returns {{ domains: string[], count: number }}
 */
function countDomains(prompt) {
  const hits = new Set();
  for (const [domain, pattern] of Object.entries(DOMAIN_KEYWORDS)) {
    if (pattern.test(prompt)) hits.add(domain);
  }
  return { domains: [...hits], count: hits.size };
}

/**
 * Estimate independent subtasks via verb conjunction patterns.
 * Each independent action verb (separated by "and"/"하고") adds 1.
 * Returns at minimum 1 (the prompt itself counts as one task).
 *
 * @param {string} prompt
 * @returns {number}
 */
function countSubtasks(prompt) {
  let conjunctions = 0;
  for (const pattern of VERB_CONJUNCTION_PATTERNS) {
    const matches = prompt.match(pattern);
    if (matches) conjunctions += matches.length;
  }
  // Heuristic dampener: each conjunction implies +1 subtask, but cap impact
  // so a comma-heavy sentence doesn't explode the score.
  const subtasks = 1 + Math.min(conjunctions, 5);
  return subtasks;
}

/** @returns {boolean} */
function hasComplexity(prompt) {
  return COMPLEXITY_PATTERN.test(prompt);
}

/**
 * Load team auto-apply config. Returns false if disabled or unreadable.
 * Uses synchronous JSON read (no dynamic import needed for static JSON).
 *
 * @param {string} pluginRoot
 * @returns {{ enabled: boolean, triggers: object }}
 */
function loadTeamConfig(pluginRoot) {
  // NOTE: this deliberately does NOT pre-fill threshold defaults. An absent key
  // is passed through as absent so that `workflow-plan.js#evaluateTrigger`
  // applies its own fallbacks (3/3/high/OR/[]) — one owner for the defaults
  // too. A previous revision kept a local copy here under a comment
  // guaranteeing the two evaluators agreed; the copy silently rotted and the
  // guarantee turned out to be false on four axes.
  const defaults = { enabled: true, triggers: {} };
  const cfgPath = path.join(pluginRoot, 'artibot.config.json');
  try {
    if (!existsSync(cfgPath)) return defaults;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const team = cfg?.team ?? {};
    return {
      enabled: team.autoApply !== false && team.enabled !== false,
      triggers: team.autoApplyTriggers || {},
    };
  } catch {
    // Fail-closed on malformed config: if a user wrote a config file at all,
    // they intended to control behavior. Defaulting to enabled silently
    // overrides their intent — the safer side is to disable until config is
    // valid.
    process.stderr.write(
      `[artibot:auto-team-trigger] WARN: malformed config at ${cfgPath}, disabling hook\n`,
    );
    return { ...defaults, enabled: false };
  }
}

/**
 * Detect coarse intent labels so `bypassIntents` has something to match.
 * @param {string} prompt
 * @returns {string[]}
 */
function detectIntents(prompt) {
  const hits = [];
  for (const [label, pattern] of Object.entries(INTENT_KEYWORDS)) {
    if (pattern.test(prompt)) hits.push(label);
  }
  return hits;
}

/**
 * Adapt a raw prompt into the `{ classification, intent }` pair that
 * `workflow-plan.js#evaluateTrigger` consumes. Pure; no config awareness — the
 * adapter must never look at thresholds, or it becomes a second evaluator.
 *
 * `recommendations` is a length-carrier only: the canonical evaluator uses
 * `recommendations.length` as its single size proxy for BOTH `minSubtasks` and
 * `minFiles`, so the adapter emits `max(subtasks, domains)` entries. (Feeding
 * `domains` alone was the pre-T2 unit mismatch: the hook compared `minFiles`
 * against a domain count while the canonical evaluator compared it against a
 * sub-objective count.)
 *
 * WHEN THIS DIVERGES FROM THE PRE-T2 HOOK: only when
 * `minSubtasks !== minFiles`. At the shipped 3/3 the two are equivalent (a
 * 36-combination sweep found 0 divergence). With unequal thresholds the
 * canonical evaluator is STRICTER, because it gates on
 * `max(minSubtasks, minFiles)` instead of treating each as an independent OR
 * branch — that is the canonical semantics and is intended, not a regression.
 *
 * @param {string} prompt
 * @returns {{ classification: {score:number}, intent: object, signals: object }}
 */
function adaptPrompt(prompt) {
  const subtasks = countSubtasks(prompt);
  const { domains, count: domainCount } = countDomains(prompt);
  const complexity = hasComplexity(prompt);

  const size = Math.max(subtasks, domainCount);
  let score = SCORE_LOW;
  if (complexity) score = SCORE_HIGH;
  else if (subtasks >= 2 || domainCount >= 2) score = SCORE_MEDIUM;

  const intents = detectIntents(prompt);
  return {
    classification: { score },
    intent: {
      intents,
      best: { intent: intents[0] || '' },
      recommendations: Array.from({ length: size }, () => ({ commands: [], agents: [] })),
    },
    signals: { subtasks, domains, domainCount, size, complexity, intents },
  };
}

/**
 * Render the canonical decision for this prompt.
 * Returns null when the trigger does not fire; otherwise the reason text.
 *
 * The only decision made HERE is the trivial-prompt pre-filter — a prompt-shape
 * check the planner cannot make (it never sees a prompt). It can only SUPPRESS;
 * it can never fire the team on its own.
 *
 * HONESTY NOTE: the thresholds below are HARD-CODED, not config-driven. The
 * shipped `team.autoApplyTriggers.excludeTrivial` ({maxLines, singleFile}) has
 * zero consumers repo-wide — same defect class as the four T2 divergences, but
 * out of T2's scope because `maxLines`/`singleFile` have no defined meaning
 * against a prompt string. Do not silently "wire it up" without deciding that
 * mapping first.
 *
 * @param {string} prompt
 * @param {object} triggers - raw config team.autoApplyTriggers (may be partial)
 * @returns {string|null}
 */
export function evaluatePrompt(prompt, triggers) {
  if (USE_LEGACY_TRIGGER_EVALUATOR) return legacyEvaluatePrompt(prompt, triggers);

  const { classification, intent, signals } = adaptPrompt(prompt);

  // excludeTrivial: short + single-domain + single-verb -> skip
  const trivial = prompt.length < TRIVIAL_MAX_CHARS
    && signals.domainCount <= 1
    && signals.subtasks <= 1;
  if (trivial) return null;

  let decision;
  try {
    decision = evaluateTrigger(classification, intent, triggers);
  } catch (err) {
    // Never throw out of a UserPromptSubmit hook — a broken evaluator must not
    // block the user's prompt. But do NOT exit silently: stderr is the only
    // operator signal this hook has.
    process.stderr.write(
      `[artibot:${HOOK_NAME}] WARN: canonical evaluator threw (${err?.message || err}); no suggestion emitted\n`,
    );
    return null;
  }

  if (!decision || typeof decision !== 'object') {
    process.stderr.write(
      `[artibot:${HOOK_NAME}] WARN: canonical evaluator returned no decision; no suggestion emitted\n`,
    );
    return null;
  }
  if (!decision.fired) return null;

  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
  const observed = `subtasks=${signals.subtasks}, domains=[${signals.domains.join(',')}], `
    + `size=${signals.size}, complexity=${signals.complexity}`;
  return `${reasons.join(' | ') || 'trigger fired'} (observed: ${observed})`;
}

/**
 * PRE-T2 hook-local evaluator, preserved verbatim for one release behind
 * {@link USE_LEGACY_TRIGGER_EVALUATOR}. Known-divergent from the canonical
 * evaluator on four axes and kept ONLY as a one-line rollback:
 *   1. ignores `minComplexity` (keyword boolean fires at any configured tier)
 *   2. ignores `bypassIntents`
 *   3. ignores `logic` (always OR)
 *   4. compares `minFiles` against a domain count, not a sub-objective count
 *
 * @param {string} prompt
 * @param {object} triggers
 * @returns {string|null}
 */
export function legacyEvaluatePrompt(prompt, triggers) {
  const length = prompt.length;
  const subtasks = countSubtasks(prompt);
  const { domains, count: domainCount } = countDomains(prompt);
  const complexity = hasComplexity(prompt);

  const trivial = length < TRIVIAL_MAX_CHARS && domainCount <= 1 && subtasks <= 1;
  if (trivial) return null;

  const minSubtasks = triggers?.minSubtasks ?? 3;
  const minFiles = triggers?.minFiles ?? 3;

  const reasons = [];
  if (subtasks >= minSubtasks) reasons.push(`subtasks=${subtasks}`);
  if (domainCount >= minFiles) reasons.push(`domains=[${domains.join(',')}]`);
  if (complexity) reasons.push('complexity=medium+');

  if (reasons.length === 0) return null;
  return reasons.join(' | ');
}

/**
 * Build the JSON output payload for UserPromptSubmit additionalContext.
 * @param {string} reason
 * @returns {object}
 */
function buildOutput(reason) {
  const guidance =
    `[auto-team-suggested] reason: ${reason}. ` +
    'Per CLAUDE.md auto-team DNA: spawn parallel teammates with Agent(name=…) ' +
    'instead of running inline on the main thread. Opt-out: --no-team flag.';
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: guidance,
    },
  };
}

/**
 * Pure handler for UserPromptSubmit. Used by the in-process dispatcher
 * (named export) and the legacy stdin/stdout main() entry point.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {object|null} hookSpecificOutput envelope, or null to pass through.
 */
export function handleUserPromptSubmit(hookData) {
  const prompt = String(hookData?.user_prompt || hookData?.content || '').trim();
  if (!prompt) return null;

  // Hard opt-outs first.
  if (NO_TEAM_FLAG.test(prompt)) return null;
  const { enabled, triggers } = loadTeamConfig(getPluginRoot());
  if (!enabled) return null;

  const reason = evaluatePrompt(prompt, triggers);
  if (!reason) return null;

  return buildOutput(reason);
}

async function main() {
  const raw = await readStdin();
  if (!raw) return; // graceful empty stdin
  const hookData = parseJSON(raw) ?? {};
  const result = handleUserPromptSubmit(hookData);
  if (result) writeStdout(result);
}

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}
