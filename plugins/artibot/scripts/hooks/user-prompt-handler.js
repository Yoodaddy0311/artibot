#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 * Handles high-priority prompt rewrites such as !rv re-verification mode
 * and team auto-apply detection.
 * Standard prompt routing now happens in runtime-prompt.js.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot, parseJSON, readStdin, toFileUrl, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

const REVERIFY_TRIGGER_PREFIX = /^!rv\b|^!(?:\uC7AC\uAC80\uC99D)(?=\s|$)/iu;
const NO_TEAM_FLAG = /--no-team/i;

/**
 * Special trigger patterns that transform the user prompt.
 * Each entry: { pattern, handler(prompt, hookData) -> { newPrompt, message } | null }
 */
const SPECIAL_TRIGGERS = [
  {
    pattern: /^!rv\b/i,
    handler: buildReverifyPrompt,
  },
  {
    pattern: /^!(?:\uC7AC\uAC80\uC99D)(?:\s|$)/iu,
    handler: buildReverifyPrompt,
  },
];

/**
 * Build a re-verification prompt that instructs critical review of the previous response.
 * @param {string} prompt - Original user prompt (after the trigger keyword)
 * @param {object} _hookData - Full hook data (unused currently)
 * @returns {{ newPrompt: string, message: string }}
 */
function buildReverifyPrompt(prompt, _hookData) {
  const userContext = prompt.replace(REVERIFY_TRIGGER_PREFIX, '').trim();

  const instructions = [
    'CRITICAL RE-VERIFICATION MODE ACTIVATED.',
    'You MUST critically re-examine your previous response with extreme skepticism.',
    'Follow this verification protocol:',
    '',
    '1. CLAIM AUDIT: List every factual claim and completion assertion from your last response.',
    '2. EVIDENCE CHECK: For each claim, verify with actual evidence (re-read files, re-run commands).',
    '3. ASSUMPTION HUNT: Identify any assumptions made without verification.',
    '4. RED FLAGS: Flag any "should work", "probably", "likely" language as unverified claims.',
    '5. CORRECTION REPORT: For each issue found, provide the correction with evidence.',
    '',
    'Do NOT rationalize or defend previous claims. If something was wrong, say so directly.',
  ];

  if (userContext) {
    instructions.push('', `Additional context from user: ${userContext}`);
  }

  return {
    newPrompt: instructions.join('\n'),
    message: '[trigger] !rv re-verification mode activated',
  };
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const prompt = hookData?.user_prompt || hookData?.content || '';
  if (!prompt) return;

  const trimmedPrompt = prompt.trim();
  // Strip --no-team flag and pass through as a signal in the output
  if (NO_TEAM_FLAG.test(trimmedPrompt)) {
    const cleaned = trimmedPrompt.replace(NO_TEAM_FLAG, '').trim();
    writeStdout({
      user_prompt: cleaned,
      message: "[team] --no-team flag detected, auto-team disabled for this request",
    });
    return;
  }

  for (const { pattern, handler } of SPECIAL_TRIGGERS) {
    if (pattern.test(trimmedPrompt)) {
      const result = handler(trimmedPrompt, hookData);
      if (!result) return;

      writeStdout({
        user_prompt: result.newPrompt,
        message: result.message,
      });
      return;
    }
  }

  // Auto-team detection: if enabled, classify complexity and signal team mode
  const autoTeamResult = await checkAutoTeam(trimmedPrompt);
  if (autoTeamResult) {
    writeStdout({
      user_prompt: trimmedPrompt,
      message: autoTeamResult.message,
      autoTeam: true,
      classification: autoTeamResult.classification,
    });
    return;
  }
}

/**
 * Load team config from artibot.config.json.
 * @returns {{ enabled: boolean, autoApply: boolean } | null}
 */
function loadTeamConfig() {
  try {
    const pluginRoot = getPluginRoot();
    const configPath = path.join(pluginRoot, 'artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.team || null;
  } catch {
    return null;
  }
}

/**
 * Check if the prompt qualifies for automatic team mode.
 * Conditions: team.enabled + team.autoApply + classifyComplexity returns system 2.
 * @param {string} prompt
 * @returns {Promise<{ message: string, classification: object } | null>}
 */
async function checkAutoTeam(prompt) {
  const teamConfig = loadTeamConfig();
  if (!teamConfig?.enabled || !teamConfig?.autoApply) return null;

  try {
    const pluginRoot = getPluginRoot();
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { classifyComplexity } = await import(toFileUrl(routerPath));
    const classification = classifyComplexity(prompt);

    if (classification.system !== 2) return null;

    const { score, factors, confidence } = classification;
    return {
      message: `[team] auto-apply triggered (system2, score=${score}, domains=${factors.domains}, steps=${factors.steps}, confidence=${confidence})`,
      classification,
    };
  } catch {
    return null;
  }
}

main().catch(createErrorHandler('user-prompt-handler', { exit: true }));
