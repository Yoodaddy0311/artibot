#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 * Detects user intent from the prompt text (team summon, build, review, etc.).
 * Also handles special triggers like !rv (re-verification mode).
 */

import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

// Inline lightweight intent detection to avoid heavy module imports for speed.
const KEYWORDS = {
  'team': 'team:summon',
  'summon': 'team:summon',
  'spawn': 'team:summon',
  '팀': 'team:summon',
  '소환': 'team:summon',
  'build': 'action:build',
  'create': 'action:build',
  '빌드': 'action:build',
  'implement': 'action:implement',
  '구현': 'action:implement',
  'review': 'action:review',
  'audit': 'action:review',
  '리뷰': 'action:review',
  'test': 'action:test',
  '테스트': 'action:test',
  'fix': 'action:fix',
  'debug': 'action:fix',
  '수정': 'action:fix',
  'refactor': 'action:refactor',
  '리팩터': 'action:refactor',
  'deploy': 'action:deploy',
  '배포': 'action:deploy',
  'document': 'action:document',
  '문서': 'action:document',
  'analyze': 'action:analyze',
  '분석': 'action:analyze',
  'plan': 'action:plan',
  '계획': 'action:plan',
  'design': 'action:design',
  '설계': 'action:design',
};

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
    pattern: /^!재검증(?:\s|$)/,
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
  // Strip the trigger keyword from the rest of the prompt
  const userContext = prompt.replace(/^!rv\b|^!재검증/i, '').trim();

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

  // Check for special triggers first (they take priority)
  const trimmedPrompt = prompt.trim();
  for (const { pattern, handler } of SPECIAL_TRIGGERS) {
    if (pattern.test(trimmedPrompt)) {
      const result = handler(trimmedPrompt, hookData);
      if (result) {
        writeStdout({
          user_prompt: result.newPrompt,
          message: result.message,
        });
        return;
      }
    }
  }

  // Standard intent detection
  const lower = prompt.toLowerCase();
  const detected = new Set();

  for (const [keyword, intent] of Object.entries(KEYWORDS)) {
    if (lower.includes(keyword)) {
      detected.add(intent);
    }
  }

  const intents = [...detected];
  if (intents.length === 0) return;

  // Load config for agent mapping
  let agentMap = {};
  try {
    const configPath = path.join(getPluginRoot(), 'artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    agentMap = config.agents?.taskBased || {};
  } catch {
    // Proceed without agent mapping
  }

  const intentLabels = intents.map((i) => i.split(':').pop());
  const suggestedAgents = intentLabels
    .map((label) => agentMap[label])
    .filter(Boolean);

  const parts = [`[intent] Detected: ${intents.join(', ')}`];
  if (suggestedAgents.length > 0) {
    parts.push(`Suggested agents: ${suggestedAgents.join(', ')}`);
  }

  writeStdout({ message: parts.join(' | ') });
}

main().catch(createErrorHandler('user-prompt-handler', { exit: true }));
