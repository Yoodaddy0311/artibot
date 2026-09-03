#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Auto Command Suggest.
 *
 * Non-developer / beginner UX: when a user phrases an architecture decision
 * or a system migration in natural language ("PostgreSQL vs MongoDB?",
 * "Redis 에서 Memcached 로 옮기자"), this hook injects a
 * `[command-suggested]` advisory hint so the orchestrator can confirm the
 * matching slash-command (/adr or /migrate) in one line.
 *
 * Suggestion only — never auto-executes. Coexists with auto-team-trigger and
 * autopilot-nlu-trigger because all three write to additionalContext, which
 * the dispatcher merges with blank-line separators.
 *
 * Detection design (false-positive minimisation):
 *   - ADR: "A vs B" comparison phrasing, explicit tech-choice keywords,
 *     bilingual "어떤 게 좋아 / which is better" question forms.
 *   - Migrate: explicit migration verbs in KR/EN, "X → Y" or "X 에서 Y 로"
 *     transition phrasing. Generic "디렉토리 이동" / "VS Code 설치" / file-move
 *     wording is excluded via negative patterns.
 *
 * Opt-out:
 *   - `--no-command-suggest` anywhere in prompt
 *   - `--no-team` umbrella opt-out
 *   - `team.autoApply: false` in artibot.config.json
 *   - `commandSuggest.enabled: false` in artibot.config.json
 *
 * @module scripts/hooks/auto-command-suggest
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractUserPromptFlagSurface, extractUserPromptText } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'auto-command-suggest';
const NO_COMMAND_SUGGEST_FLAG = /--no-command-suggest\b/i;
const NO_TEAM_FLAG = /--no-team\b/i;

// ─── ADR patterns ──────────────────────────────────────────────────────────
// "A vs B" comparison — case-insensitive, requires non-trivial tokens on both
// sides. The `\S{2,}` floor blocks single-char noise like "a vs b".
const ADR_VS_PATTERN = /\b\S{2,}\s+vs\.?\s+\S{2,}\b/i;
// Korean comparative question forms: "X 와 Y 중에", "X 쓸까 Y 쓸까", "어떤 게 좋아"
const ADR_KO_COMPARE_PATTERNS = [
  /(\S{2,})\s*(?:와|과)\s*(\S{2,})\s*(?:중에|중에서|중)/,
  /(\S{2,})\s*(?:쓸까|쓸지|할까|할지|좋을까|좋을지)\s*(\S{2,})\s*(?:쓸까|쓸지|할까|할지|좋을까|좋을지)/,
  /어떤\s*(?:게|것이|것을|걸|거를|라이브러리|프레임워크|스택|디비|db|기술|언어|툴|도구)[^\n]{0,40}?(?:좋(?:아|을|은)|쓰는?\s*게\s*좋|선택|골라|골랐|추천|괜찮)/i,
  /(?:기술|스택|아키텍처|라이브러리|프레임워크|디비|db|데이터베이스)\s*(?:선택|결정|고르|뭐|어떤)/i,
];
// English ADR triggers
const ADR_EN_PATTERNS = [
  /\bshould\s+(?:i|we)\s+use\s+\S{2,}\s+or\s+\S{2,}/i,
  /\bwhich\s+(?:is|one\s+is)\s+better\s+(?:for|between)?\b/i,
  /\b(?:tech|technology|stack|library|framework|database)\s+(?:choice|decision|selection)\b/i,
  /\bchoose\s+between\s+\S{2,}\s+(?:and|or)\s+\S{2,}/i,
];

// Negative ADR signals — phrases that contain "vs" or "선택" but mean something
// else. Subtract these before scoring so false-positives don't trigger.
const ADR_NEGATIVE_PATTERNS = [
  /\bdiff\s+vs\b/i,                  // "git diff vs ..."
  /\bcommit\s+vs\b/i,
  /파일\s*선택/i,                     // "파일 선택" = file picker, not tech
  /다중\s*선택/i,
];

// ─── Migrate patterns ─────────────────────────────────────────────────────
// Korean migration verbs / nouns
const MIGRATE_KO_PATTERNS = [
  /마이그레이션|마이그레이트/i,
  /(?:DB|데이터베이스|디비|시스템|서버|스택|인프라|서비스|라이브러리|프레임워크)\s*(?:이전|이관|전환|교체|갈아|옮기)/i,
  /(\S{2,})\s*에서\s*(\S{2,})\s*(?:로|으로)\s*(?:이전|이관|전환|교체|갈아|옮기|마이그|migrate|이동)/i,
  /(\S{2,})\s*(?:→|->)\s*(\S{2,})\s*(?:이전|이관|전환|교체|마이그|migrate)/i,
  /(?:점진적|단계적|무중단|zero[-\s]?downtime)\s*(?:이전|이관|전환|교체|배포|롤아웃)/i,
];
// English migration triggers
const MIGRATE_EN_PATTERNS = [
  /\bmigrate\s+from\s+\S{2,}\s+to\s+\S{2,}/i,
  /\bmigration\s+(?:from|to|plan|strategy|path)\b/i,
  /\b(?:roll\s?out|rollout)\s+(?:plan|strategy)\b/i,
  /\bswitch\s+from\s+\S{2,}\s+to\s+\S{2,}/i,
  /\bmove\s+from\s+\S{2,}\s+to\s+\S{2,}\s+(?:database|db|stack|service|provider|system)/i,
  /\b(?:zero[-\s]?downtime|blue[-\s]?green|canary)\s+(?:deployment|rollout|migration)/i,
];

// Negative Migrate signals — innocuous "move" / "이동" wording that should
// not trigger /migrate. These cover the user-requested false-positives.
const MIGRATE_NEGATIVE_PATTERNS = [
  /디렉토리\s*(?:이동|옮기)/i,
  /폴더\s*(?:이동|옮기)/i,
  /파일\s*(?:이동|옮기|이전)(?!\s*(?:정책|전략))/i,
  /(?:VS\s*Code|vscode|vim|emacs|cursor|ide|에디터)\s*(?:설치|이전|이동|옮기)/i,
  /(?:커서|마우스|포커스|focus|cursor)\s*(?:이동|move)/i,
  /git\s*(?:branch\s+)?(?:이전|이동|switch|checkout)/i,
  /(?:다음|이전)\s*(?:페이지|화면|섹션)\s*(?:로|으로)?\s*이동/i,
];

/**
 * Load command-suggest config. Returns disabled=true if config is malformed
 * (fail-closed) so a typo never silently overrides user intent.
 * @param {string} pluginRoot
 * @returns {{ enabled: boolean }}
 */
function loadConfig(pluginRoot) {
  const cfgPath = path.join(pluginRoot, 'artibot.config.json');
  try {
    if (!existsSync(cfgPath)) return { enabled: true };
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const team = cfg?.team ?? {};
    const suggest = cfg?.commandSuggest ?? {};
    if (suggest.enabled === false) return { enabled: false };
    if (team.autoApply === false || team.enabled === false) return { enabled: false };
    return { enabled: true };
  } catch {
    // Fail-closed on malformed config: if a user wrote a config file at all,
    // they intended to control behavior. Defaulting to enabled silently
    // overrides their intent — the safer side is to disable until config is
    // valid.
    process.stderr.write(
      `[artibot:${HOOK_NAME}] WARN: malformed config at ${cfgPath}, disabling hook\n`,
    );
    return { enabled: false };
  }
}

/**
 * Returns true when any pattern in the list matches the prompt.
 * @param {string} prompt
 * @param {Array<RegExp>} patterns
 * @returns {boolean}
 */
function anyMatch(prompt, patterns) {
  for (const re of patterns) {
    if (re.test(prompt)) return true;
  }
  return false;
}

/**
 * Collect the first few pattern fragments that matched, for the suggestion
 * advisory. Returns up to 3 matched substrings (trimmed) for debuggability.
 * @param {string} prompt
 * @param {Array<RegExp>} patterns
 * @returns {string[]}
 */
function collectMatches(prompt, patterns) {
  const hits = [];
  for (const re of patterns) {
    const m = prompt.match(re);
    if (m && hits.length < 3) hits.push(m[0].trim().slice(0, 40));
  }
  return hits;
}

/**
 * Classify the prompt into ADR / Migrate / null.
 *
 * Decision order:
 *   1. Negative patterns short-circuit the corresponding category.
 *   2. Migrate wins ties over ADR because migration phrasing is more specific
 *      (e.g. "PostgreSQL 에서 MongoDB 로 마이그" matches both families but the
 *      action is clearly migrate). ADR is the catch-all comparison family.
 *
 * @param {string} prompt
 * @returns {{ command: 'adr'|'migrate', matched: string[] }|null}
 */
export function classifyCommandIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;

  const migrateBlocked = anyMatch(prompt, MIGRATE_NEGATIVE_PATTERNS);
  const adrBlocked = anyMatch(prompt, ADR_NEGATIVE_PATTERNS);

  const migrateAll = [...MIGRATE_KO_PATTERNS, ...MIGRATE_EN_PATTERNS];
  const adrAll = [
    ADR_VS_PATTERN,
    ...ADR_KO_COMPARE_PATTERNS,
    ...ADR_EN_PATTERNS,
  ];

  const migrateHit = !migrateBlocked && anyMatch(prompt, migrateAll);
  const adrHit = !adrBlocked && anyMatch(prompt, adrAll);

  if (migrateHit) {
    return { command: 'migrate', matched: collectMatches(prompt, migrateAll) };
  }
  if (adrHit) {
    return { command: 'adr', matched: collectMatches(prompt, adrAll) };
  }
  return null;
}

/**
 * Build the additionalContext payload for a classified intent.
 * @param {{ command: 'adr'|'migrate', matched: string[] }} cls
 * @returns {object}
 */
function buildOutput(cls) {
  const matchedFmt = cls.matched.slice(0, 3).join(', ');
  const cmdLabel = cls.command === 'adr' ? '/adr' : '/migrate';
  const purpose =
    cls.command === 'adr'
      ? '기술/스택 비교 결정 (Architecture Decision Record)'
      : '시스템 이전/교체 계획 (Zero-downtime migration)';
  const guidance =
    `[command-suggested] 감지된 의도='${cls.command}', 매칭=[${matchedFmt}]. ` +
    `사용자에게 1줄 확인 권장: "${purpose}로 보입니다. \`${cmdLabel}\` 커맨드로 ` +
    `진행할까요?" 명시적 동의 없이 자동 실행 금지. ` +
    `Opt-out: --no-command-suggest.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: guidance,
    },
  };
}

/**
 * Pure handler for UserPromptSubmit. Named export consumed by the in-process
 * dispatcher; the legacy stdin/stdout main() entry point is gated behind
 * isMain so importing this module is side-effect-free.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {object|null} hookSpecificOutput envelope, or null to pass through.
 */
export function handleUserPromptSubmit(hookData) {
  const prompt = extractUserPromptText(hookData).trim();
  if (!prompt) return null;

  // Opt-outs are tested on the FLAG SURFACE, not on `prompt`: the rewriter
  // strips `--no-team` before this hook runs, so the rewritten text no longer
  // carries it. (`--no-command-suggest` is not stripped, but both are read from
  // the same surface so a future rewrite of either cannot reopen this hole.)
  const flagSurface = extractUserPromptFlagSurface(hookData);
  if (NO_COMMAND_SUGGEST_FLAG.test(flagSurface) || NO_TEAM_FLAG.test(flagSurface)) return null;
  const { enabled } = loadConfig(getPluginRoot());
  if (!enabled) return null;

  const cls = classifyCommandIntent(prompt);
  if (!cls) return null;

  return buildOutput(cls);
}

async function main() {
  const raw = await readStdin();
  if (!raw) return;
  const hookData = parseJSON(raw) ?? {};
  const result = handleUserPromptSubmit(hookData);
  if (result) writeStdout(result);
}

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}
