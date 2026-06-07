#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Auto-Team Trigger.
 * Detects multi-subtask / multi-domain / medium+ complexity prompts and
 * injects a `[auto-team-suggested]` hint via additionalContext so the main
 * Claude (orchestrator) auto-spawns a parallel team.
 *
 * Algorithm (PRD docs/PRD/autopilot-mode.md §5.2):
 *   - Count multi-verb patterns (Korean "~하고 ~하고", English "and"/"then")
 *   - Count domain keywords (frontend/backend/db/test/ui/api/style/auth ...)
 *   - Detect complexity keywords (전체/system/architecture/refactor/migration)
 *   - excludeTrivial: single verb + single domain + <30 chars  -> skip
 *   - OR logic: subtasks>=2 OR domains>=2 OR complexity=medium+ -> trigger
 *
 * Opt-out:
 *   - `--no-team` anywhere in prompt
 *   - `team.autoApply: false` in artibot.config.json
 *
 * @module scripts/hooks/auto-team-trigger
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'auto-team-trigger';
const NO_TEAM_FLAG = /--no-team\b/i;

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
  // Defaults MUST match lib/cognitive/workflow-plan.js#evaluateTrigger so the two
  // trigger evaluators never disagree on the same prompt. Config
  // (team.autoApplyTriggers) is the single source of truth; these defaults only
  // apply when a key is absent there.
  const defaults = {
    enabled: true,
    triggers: { minSubtasks: 3, minFiles: 3, minComplexity: 'high' },
  };
  const cfgPath = path.join(pluginRoot, 'artibot.config.json');
  try {
    if (!existsSync(cfgPath)) return defaults;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const team = cfg?.team ?? {};
    return {
      enabled: team.autoApply !== false && team.enabled !== false,
      triggers: { ...defaults.triggers, ...(team.autoApplyTriggers || {}) },
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
 * Decide whether the prompt should trigger auto-team.
 * Returns null when triggered=false; otherwise returns reason text.
 *
 * @param {string} prompt
 * @param {object} triggers
 * @returns {string|null}
 */
function evaluatePrompt(prompt, triggers) {
  const length = prompt.length;
  const subtasks = countSubtasks(prompt);
  const { domains, count: domainCount } = countDomains(prompt);
  const complexity = hasComplexity(prompt);

  // excludeTrivial: short + single-domain + single-verb -> skip
  const trivial = length < TRIVIAL_MAX_CHARS && domainCount <= 1 && subtasks <= 1;
  if (trivial) return null;

  // Fallbacks mirror loadTeamConfig defaults (== workflow-plan.js) so callers
  // that pass a partial triggers object stay consistent with the canonical
  // evaluator.
  const minSubtasks = triggers.minSubtasks ?? 3;
  const minFiles = triggers.minFiles ?? 3;

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
    'Per CLAUDE.md auto-team DNA: invoke TeamCreate or parallel Task() ' +
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

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(fileURLToPath(import.meta.url));
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}
