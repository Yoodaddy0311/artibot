#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 * Handles high-priority prompt rewrites such as !rv re-verification mode.
 * Standard prompt routing now happens in runtime-prompt.js.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

const REVERIFY_TRIGGER_PREFIX = /^!rv\b|^!(?:재검증)(?=\s|$)/iu;
const NO_TEAM_FLAG = /--no-team\b/i;

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
    pattern: /^!(?:재검증)(?:\s|$)/iu,
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

/**
 * Pure handler for UserPromptSubmit. Used both by the in-process dispatcher
 * (via named export) and by the legacy stdin/stdout main() entry point.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {{ user_prompt?: string, message?: string } | null}
 *   - object when the prompt was rewritten or a flag was stripped (caller should
 *     replace `payload.prompt`/`payload.user_prompt` with the returned value)
 *   - null when the prompt should pass through unchanged
 */
export function handleUserPromptSubmit(hookData) {
  const prompt = hookData?.user_prompt || hookData?.content || '';
  if (!prompt) return null;

  const trimmedPrompt = prompt.trim();
  // Strip --no-team flag and pass through as a signal in the output
  if (NO_TEAM_FLAG.test(trimmedPrompt)) {
    const cleaned = trimmedPrompt.replace(NO_TEAM_FLAG, "").trim();
    return {
      user_prompt: cleaned,
      message: "[team] --no-team flag detected, auto-team disabled for this request",
    };
  }

  for (const { pattern, handler } of SPECIAL_TRIGGERS) {
    if (pattern.test(trimmedPrompt)) {
      const result = handler(trimmedPrompt, hookData);
      if (!result) return null;

      return {
        user_prompt: result.newPrompt,
        message: result.message,
      };
    }
  }

  return null;
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  const result = handleUserPromptSubmit(hookData ?? {});
  if (result) writeStdout(result);
}

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('user-prompt-handler', { exit: true }));
}
