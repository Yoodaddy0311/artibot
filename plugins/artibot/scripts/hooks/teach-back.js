#!/usr/bin/env node
/**
 * Stop / SubagentStop hook — 교육적 학습 루프 (teach-back).
 *
 * Advisory-only sibling of dev-verify-gate.js. When enabled, appends a learning
 * corner AFTER the work report: a 12-year-old-level summary of the core
 * principle (never omitted), the reasoning behind the approach, and a short
 * comprehension quiz. Wrong answers get answer+explanation only — no retry
 * demand, no perfect-score gate; answering is never forced. Never emits
 * `decision: "block"` — always `hookSpecificOutput.additionalContext`.
 *
 * Enabled iff config.postWork.teachBack.enabled === true (default false).
 * Env kill-switch ARTIBOT_DISABLE_TEACHBACK=1 wins over config. Quiz question
 * count comes from config.postWork.teachBack.questions (default 3).
 *
 * Unlike dev-verify-gate, this pass is NOT scope-guarded to the Artibot repo —
 * when toggled on it applies to any project the user works in.
 *
 * @module scripts/hooks/teach-back
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import {
  buildTeachBackContext,
  loadArtibotConfig,
  resolvePassEnabled,
  resolveTeachBackQuestions,
  runPostWorkPass,
} from '../../lib/core/post-work-pass.js';

const HOOK_NAME = 'teach-back';
const STATE_FILE = 'last-teachback-sha.txt';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const config = loadArtibotConfig();
  if (!resolvePassEnabled(config, { section: 'teachBack', envVar: 'ARTIBOT_DISABLE_TEACHBACK' })) {
    return;
  }

  const { fire, output } = runPostWorkPass({
    hookData,
    hookName: HOOK_NAME,
    stateFile: STATE_FILE,
    additionalContext: buildTeachBackContext(resolveTeachBackQuestions(config)),
  });
  if (fire) writeStdout(output);
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
