#!/usr/bin/env node
/**
 * Stop / SubagentStop hook — 사각지대 점검 (blindspot check).
 *
 * Advisory-only sibling of dev-verify-gate.js. When enabled, injects a
 * non-blocking directive AFTER a turn that modified code, asking the model to
 * decompose the original requirement into essential components, scan each for
 * real evidence, and report any gaps earliest-blocking-first (recommend-only,
 * never auto-fix). Never emits `decision: "block"` — always
 * `hookSpecificOutput.additionalContext`.
 *
 * Enabled iff config.postWork.blindspot.enabled === true (default false).
 * Env kill-switch ARTIBOT_DISABLE_BLINDSPOT=1 wins over config.
 *
 * Unlike dev-verify-gate, this pass is NOT scope-guarded to the Artibot repo —
 * when toggled on it applies to any project the user works in.
 *
 * @module scripts/hooks/blindspot-check
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import {
  buildBlindspotContext,
  loadArtibotConfig,
  resolvePassEnabled,
  runPostWorkPass,
} from '../../lib/core/post-work-pass.js';

const HOOK_NAME = 'blindspot-check';
const STATE_FILE = 'last-blindspot-sha.txt';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const config = loadArtibotConfig();
  if (!resolvePassEnabled(config, { section: 'blindspot', envVar: 'ARTIBOT_DISABLE_BLINDSPOT' })) {
    return;
  }

  const { fire, output } = runPostWorkPass({
    hookData,
    hookName: HOOK_NAME,
    stateFile: STATE_FILE,
    additionalContext: buildBlindspotContext(),
  });
  if (fire) writeStdout(output);
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
