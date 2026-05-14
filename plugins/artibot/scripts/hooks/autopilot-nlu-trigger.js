#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Autopilot NLU Trigger (PRD §12).
 *
 * Detects natural-language signals that the user wants long-running autonomous
 * work ("자고 올 동안...", "3시간 후에...", "퇴근하고...") and injects an
 * `[autopilot-suggested]` advisory hint via additionalContext. The main Claude
 * confirms with the user in one line before invoking `/autopilot`.
 *
 * Suggestion only — never auto-runs anything. Coexists with auto-team-trigger
 * because both write to hookSpecificOutput.additionalContext.
 *
 * Opt-out:
 *   - `--no-autopilot` anywhere in prompt
 *   - `--no-team` anywhere in prompt (umbrella opt-out)
 *   - `team.autoApply: false` in artibot.config.json
 *
 * @module scripts/hooks/autopilot-nlu-trigger
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getPluginRoot, parseJSON, readStdin, toFileUrl, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'autopilot-nlu-trigger';
const NO_AUTOPILOT_FLAG = /--no-autopilot\b/i;
const NO_TEAM_FLAG = /--no-team\b/i;

/**
 * Read team + autopilot config (single source of truth: artibot.config.json).
 * Suggestion is gated by both: team-level kill switches AND a dedicated
 * `autopilot.enabled` so users can disable autopilot suggestion without
 * also disabling team auto-apply. Documented in `commands/autopilot.md`.
 * @param {string} pluginRoot
 * @returns {boolean} true when autopilot suggestion is enabled
 */
function isEnabled(pluginRoot) {
  const cfgPath = path.join(pluginRoot, 'artibot.config.json');
  try {
    if (!existsSync(cfgPath)) return true;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const team = cfg?.team ?? {};
    const autopilot = cfg?.autopilot ?? {};
    if (autopilot.enabled === false) return false;
    return team.autoApply !== false && team.enabled !== false;
  } catch {
    // Fail-closed on malformed config: if a user wrote a config file at all,
    // they intended to control behavior. Defaulting to enabled silently
    // overrides their intent — the safer side is to disable until config is
    // valid.
    process.stderr.write(
      `[artibot:autopilot-nlu-trigger] WARN: malformed config at ${cfgPath}, disabling hook\n`,
    );
    return false;
  }
}

/**
 * Build additionalContext payload for an above-threshold classification.
 * @param {{ score: number, matched: string[], suggestion: string }} cls
 * @returns {object}
 */
function buildOutput(cls) {
  const scoreFmt = cls.score.toFixed(2);
  const matchedFmt = cls.matched.slice(0, 6).map((m) => m.trim()).join(', ');
  const cmd = cls.suggestion === 'default' ? '/autopilot' : `/autopilot:${cls.suggestion}`;
  const guidance =
    `[autopilot-suggested] 점수=${scoreFmt}, 추천 모드='${cls.suggestion}', ` +
    `매칭=[${matchedFmt}]. ` +
    `사용자에게 1줄로 확인 권장: "장시간 자율 모드로 진행할까요? \`${cmd}\` ` +
    `또는 \`/autopilot\` 추천드립니다." ` +
    `명시적 동의 없이 자동 실행 금지. Opt-out: --no-autopilot.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: guidance,
    },
  };
}

/**
 * Dynamically import lib/autopilot/nlu.js using a Korean-path-safe file:// URL.
 * @returns {Promise<{ classifyAutopilotIntent: Function }>}
 */
async function loadNlu() {
  const nluPath = path.join(getPluginRoot(), 'lib', 'autopilot', 'nlu.js');
  return import(toFileUrl(nluPath));
}

/**
 * Pure handler for UserPromptSubmit. Used by the in-process dispatcher
 * (named export) and the legacy stdin/stdout main() entry point.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {Promise<object|null>} hookSpecificOutput envelope, or null to pass through.
 */
export async function handleUserPromptSubmit(hookData) {
  const prompt = String(hookData?.user_prompt || hookData?.content || '').trim();
  if (!prompt) return null;

  if (NO_AUTOPILOT_FLAG.test(prompt) || NO_TEAM_FLAG.test(prompt)) return null;
  if (!isEnabled(getPluginRoot())) return null;

  const { classifyAutopilotIntent } = await loadNlu();
  const result = classifyAutopilotIntent(prompt);
  if (!result.suggestion || result.score < 0.7) return null;

  return buildOutput(result);
}

async function main() {
  const raw = await readStdin();
  if (!raw) return;
  const hookData = parseJSON(raw) ?? {};
  const result = await handleUserPromptSubmit(hookData);
  if (result) writeStdout(result);
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}
