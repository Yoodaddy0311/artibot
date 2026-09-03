#!/usr/bin/env node
/**
 * UserPromptSubmit guard — surface a clarification reminder when the user's
 * prompt is short AND contains a destructive verb. Adoption AD-38 (TRANSFORM
 * of phd-skills UserPromptSubmit type:prompt block, ported to ESM).
 *
 * Heuristic: word-count < 5 AND prompt contains one of the destructive
 * verbs/typo-prone tokens. The guard never blocks — it injects a
 * systemContext nudge so the model reflects before acting on commands like
 * "delete it", "drop everything", or "kill it".
 *
 * @module scripts/hooks/ambiguity-guard
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractUserPromptText } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'ambiguity-guard';

/**
 * Tokens that indicate destructive or irreversible intent. Lowercase only;
 * the guard normalises before matching. `done`/`dont` catch common typos
 * for `delete it now`/`don't` that lead to scope confusion.
 */
const DESTRUCTIVE_TOKENS = new Set([
  'done', 'dont', 'delete', 'remove', 'drop', 'kill', 'force', 'reset', 'nuke',
  'wipe', 'purge', 'erase', 'trash',
]);

const SHORT_PROMPT_THRESHOLD = 5;

/**
 * Extract the prompt text from the hook stdin payload.
 *
 * Delegates to the shared `extractUserPromptText`. This guard's own five-key
 * list was the only one in the UserPromptSubmit chain that happened to include
 * the host's real key (`prompt`), which is why it kept firing while the other
 * five contributors ran dead — see the measurement in `hook-utils.js`. The
 * list is not promoted as-is: `userPrompt`, `message` and `text` appear in no
 * UserPromptSubmit payload in Claude Code 2.1.259 (`message` belongs to the
 * Notification event), so keeping them would spread three dead keys to six
 * more call sites.
 *
 * TWO BEHAVIOR CHANGES, both deliberate:
 *   - `user_prompt` now takes precedence over `prompt`, so this guard reads
 *     the prompt as REWRITTEN by `user-prompt-handler` rather than the raw
 *     one. That is the contract `_userprompt-dispatcher.js` already documents
 *     for its parallel contributors ("they see the rewritten prompt"); this
 *     guard was the one contributor that quietly did not honour it.
 *   - `userPrompt` / `message` / `text` are no longer read.
 *
 * @param {*} hookData
 * @returns {string}
 */
export function extractPrompt(hookData) {
  return extractUserPromptText(hookData);
}

/**
 * Decide whether the prompt is short and destructive.
 * Pure function — exported for unit tests.
 * @param {string} prompt
 * @returns {{ ambiguous: boolean, hits: string[], wordCount: number }}
 */
export function evaluatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { ambiguous: false, hits: [], wordCount: 0 };
  }
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length >= SHORT_PROMPT_THRESHOLD) {
    return { ambiguous: false, hits: [], wordCount: words.length };
  }
  const lower = prompt.toLowerCase();
  const hits = [];
  for (const token of DESTRUCTIVE_TOKENS) {
    // Word-boundary match so `don't` and `delete-me` both register.
    const pattern = new RegExp(`(^|[^a-z])${token}([^a-z]|$)`);
    if (pattern.test(lower)) hits.push(token);
  }
  return {
    ambiguous: hits.length > 0,
    hits,
    wordCount: words.length,
  };
}

/**
 * Build the systemContext reminder.
 * @param {string[]} hits
 * @param {number} wordCount
 * @returns {string}
 */
export function formatReminder(hits, wordCount) {
  return [
    '[artibot:ambiguity-guard] Short prompt with destructive verb detected.',
    `Prompt length: ${wordCount} word(s). Triggers: ${hits.join(', ')}.`,
    'Before acting: confirm the target (which file, which branch, which scope?).',
    'If anything is unclear, ASK ONE clarifying question instead of guessing.',
  ].join('\n');
}

/**
 * Build the hook output. Pure function — uses the evaluation result.
 * @param {ReturnType<typeof evaluatePrompt>} ev
 * @returns {object}
 */
export function buildOutput(ev) {
  if (!ev.ambiguous) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: formatReminder(ev.hits, ev.wordCount),
    },
  };
}

/**
 * Pure handler for UserPromptSubmit. Used by the in-process dispatcher
 * (named export) and the legacy stdin/stdout main() entry point.
 *
 * Returns the buildOutput envelope (always non-null because buildOutput
 * always returns either { continue: true } or { continue: true, hookSpecificOutput }).
 * Callers may inspect `additionalContext` presence to know whether to merge.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {object} buildOutput envelope.
 */
export function handleUserPromptSubmit(hookData) {
  const prompt = extractPrompt(hookData);
  const ev = evaluatePrompt(prompt);
  return buildOutput(ev);
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};
  writeStdout(handleUserPromptSubmit(hookData));
}

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
