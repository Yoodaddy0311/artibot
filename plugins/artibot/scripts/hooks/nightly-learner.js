#!/usr/bin/env node
/**
 * SessionEnd hook - Nightly Learner.
 * Triggers the unified learning pipeline at session end:
 *   1. Collect session experiences → daily-experiences.json
 *   2. GRPO batch learning → pattern extraction
 *   3. Knowledge transfer → System 1 hot-swap
 *
 * Delegates to lib/learning/index.js shutdownLearning() for all learning logic.
 * No independent GRPO or knowledge transfer implementations.
 *
 * Data directory: ~/.claude/artibot/ (shared with all lib modules)
 */

import { readStdin, parseJSON, getPluginRoot, toFileUrl } from '../utils/index.js';
import path from 'node:path';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  // Build session data from hook payload
  const sessionData = {
    sessionId: hookData.session_id || `session-${Date.now()}`,
    toolUsage: hookData.tool_usage || {},
    errors: hookData.errors || [],
    completedTasks: hookData.completed_tasks || [],
    teamConfig: hookData.team_config || null,
  };

  // Raw experiences passed directly from hook event
  const rawExperiences = hookData.experiences || [];

  // Dynamically import the unified learning pipeline
  const pluginRoot = getPluginRoot();
  const learningPath = path.join(pluginRoot, 'lib', 'learning', 'index.js');

  try {
    const { shutdownLearning, collectExperience } = await import(
      toFileUrl(learningPath)
    );

    // Collect any raw experiences first (backward compat with old hook data format)
    for (const exp of rawExperiences) {
      await collectExperience({
        type: exp.type || 'general',
        category: exp.category || exp.routed_to || 'unknown',
        data: exp,
        sessionId: sessionData.sessionId,
      });
    }

    // Run the full learning pipeline:
    //   summarizeSession → collectDailyExperiences → batchLearn → hotSwap
    const result = await shutdownLearning(sessionData);

    // Summary log
    const parts = ['[learning] SessionEnd pipeline complete'];
    if (result.summarized) parts.push('session summarized');
    if (result.learned) {
      parts.push(`groups: ${result.learned.groupsProcessed ?? 0}`);
      parts.push(`patterns: ${result.learned.patternsExtracted ?? 0}`);
    }
    if (result.hotSwapped) {
      parts.push(`promoted: ${result.hotSwapped.promoted?.length ?? 0}`);
      parts.push(`demoted: ${result.hotSwapped.demoted?.length ?? 0}`);
    }

    process.stderr.write(`${parts.join(' | ')}\n`);
  } catch (err) {
    process.stderr.write(`[artibot:nightly-learner] ${err.message}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:nightly-learner] ${err.message}\n`);
  process.exit(0);
});
