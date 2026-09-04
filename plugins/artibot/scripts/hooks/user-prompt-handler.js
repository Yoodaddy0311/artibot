#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 * Handles high-priority prompt rewrites such as !rv re-verification mode.
 * Standard prompt routing now happens in runtime-prompt.js.
 *
 * TWO OUTPUT SURFACES, and the difference is the whole design:
 *
 *   - `user_prompt` / `message` are DISPATCHER-INTERNAL. The dispatcher writes
 *     `user_prompt` back onto the payload so the parallel contributors classify
 *     the rewritten text, then its HOST_STDOUT_KEYS allowlist strips both keys
 *     before stdout. The host has never read them (2.1.259 measured — see
 *     .artibot/guides/v5-design/PROBE-effort-directive-delivery.md).
 *   - `hookSpecificOutput.additionalContext` is what reaches the model.
 *
 * So this hook cannot REPLACE the user's prompt, and never could: the host
 * always delivers the original text and puts hook output beside it. `!rv` and
 * `--no-team` therefore emit an INSTRUCTION as additionalContext instead of
 * relying on a substitution that was silently discarded.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractUserPromptText } from '../../lib/core/hook-utils.js';
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
 * The `--no-team` opt-out, stated to the model.
 *
 * Stripping the flag from `user_prompt` never reached the model and never
 * could. What it DOES do stays useful and is kept: the auto-team suppression
 * itself runs off `extractUserPromptFlagSurface` (union of `user_prompt`,
 * `prompt`, `content`) in `auto-team-trigger.js`, so it is unaffected either
 * way. This line is the half that was missing — telling the model.
 */
const NO_TEAM_DIRECTIVE =
  '[artibot:team opt-out] --no-team: do not spawn a team for this request; '
  + 'handle it on the main thread.';

/**
 * Wrap a value in the host's UserPromptSubmit envelope.
 * @param {string} additionalContext
 * @returns {{ hookEventName: string, additionalContext: string }}
 */
function hookContext(additionalContext) {
  return { hookEventName: 'UserPromptSubmit', additionalContext };
}

/**
 * Pure handler for UserPromptSubmit. Used both by the in-process dispatcher
 * (via named export) and by the legacy stdin/stdout main() entry point.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {{ user_prompt?: string, message?: string, hookSpecificOutput?: object } | null}
 *   - object when the prompt was rewritten or a flag was stripped.
 *     `user_prompt`/`message` are internal (the dispatcher consumes them and
 *     then drops them); `hookSpecificOutput.additionalContext` is what the host
 *     delivers to the model.
 *   - null when the prompt should pass through unchanged
 */
export function handleUserPromptSubmit(hookData) {
  const prompt = extractUserPromptText(hookData);
  if (!prompt) return null;

  const trimmedPrompt = prompt.trim();
  // Strip --no-team flag and pass through as a signal in the output
  if (NO_TEAM_FLAG.test(trimmedPrompt)) {
    const cleaned = trimmedPrompt.replace(NO_TEAM_FLAG, "").trim();
    return {
      user_prompt: cleaned,
      message: "[team] --no-team flag detected, auto-team disabled for this request",
      hookSpecificOutput: hookContext(NO_TEAM_DIRECTIVE),
    };
  }

  for (const { pattern, handler } of SPECIAL_TRIGGERS) {
    if (pattern.test(trimmedPrompt)) {
      const result = handler(trimmedPrompt, hookData);
      if (!result) return null;

      return {
        user_prompt: result.newPrompt,
        message: result.message,
        // The same protocol the rewrite used to carry. The user's `!rv …` text
        // still reaches the model verbatim (the host sends it); this arrives
        // alongside it as the instruction for how to treat it.
        hookSpecificOutput: hookContext(result.newPrompt),
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
