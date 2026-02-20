#!/usr/bin/env node
/**
 * SessionEnd hook.
 * Saves current session state to ~/.claude/artibot-state.json
 * and runs the learning pipeline with parallelized independent stages.
 *
 * Pipeline stages:
 *   1. [parallel] selfEvaluate(session) + collectExperiences(session)
 *   2. [sequential] batchLearn(experiences) -- depends on collected experiences
 *   3. [sequential] hotSwap(learned) -- depends on batch learning result
 */

import { readStdin, parseJSON, atomicWriteSync, getPluginRoot, toFileUrl } from '../utils/index.js';
import path from 'node:path';

/**
 * Run the learning pipeline with parallelized independent operations.
 * selfEvaluate and collectExperiences are independent and run concurrently.
 * batchLearn depends on experiences; hotSwap depends on learned results.
 *
 * @param {object} sessionData - Session context data
 * @param {object} learningModule - The imported learning module
 * @returns {Promise<{ evalResult: object|null, experiences: object[]|null, learned: object|null, hotSwapped: object|null }>}
 */
export async function runLearningPipeline(sessionData, learningModule) {
  const {
    getImprovementSuggestions,
    collectDailyExperiences,
    batchLearn,
    hotSwap,
  } = learningModule;

  // Stage 1: Run independent operations in parallel
  const [evalSettled, experiencesSettled] = await Promise.allSettled([
    getImprovementSuggestions(),
    collectDailyExperiences(sessionData),
  ]);

  const evalResult = evalSettled.status === 'fulfilled' ? evalSettled.value : null;
  const experiences = experiencesSettled.status === 'fulfilled' ? experiencesSettled.value : null;

  if (evalSettled.status === 'rejected') {
    process.stderr.write(`[artibot:session-end] selfEvaluate failed: ${evalSettled.reason?.message ?? evalSettled.reason}\n`);
  }
  if (experiencesSettled.status === 'rejected') {
    process.stderr.write(`[artibot:session-end] collectExperiences failed: ${experiencesSettled.reason?.message ?? experiencesSettled.reason}\n`);
  }

  // Stage 2: batchLearn depends on experiences being collected
  let learned = null;
  try {
    learned = await batchLearn(experiences);
  } catch (err) {
    process.stderr.write(`[artibot:session-end] batchLearn failed: ${err?.message ?? err}\n`);
  }

  // Stage 3: hotSwap depends on learning results
  let hotSwapped = null;
  try {
    hotSwapped = await hotSwap(learned);
  } catch (err) {
    process.stderr.write(`[artibot:session-end] hotSwap failed: ${err?.message ?? err}\n`);
  }

  return { evalResult, experiences, learned, hotSwapped };
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeDir = path.join(home, '.claude');
  const statePath = path.join(claudeDir, 'artibot-state.json');

  const state = {
    sessionId: hookData?.session_id || null,
    endedAt: new Date().toISOString(),
    startedAt: hookData?.started_at || null,
    cwd: process.cwd(),
    metadata: {
      platform: process.platform,
      nodeVersion: process.version,
    },
  };

  try {
    atomicWriteSync(statePath, state);
  } catch (err) {
    process.stderr.write(`[artibot:session-end] Failed to save state: ${err.message}\n`);
  }

  // Run learning pipeline if session data is available
  if (hookData) {
    const sessionData = {
      sessionId: hookData.session_id || `session-${Date.now()}`,
      toolUsage: hookData.tool_usage || {},
      errors: hookData.errors || [],
      completedTasks: hookData.completed_tasks || [],
      teamConfig: hookData.team_config || null,
    };

    try {
      const pluginRoot = getPluginRoot();
      const learningPath = path.join(pluginRoot, 'lib', 'learning', 'index.js');
      const learningModule = await import(toFileUrl(learningPath));

      const result = await runLearningPipeline(sessionData, learningModule);

      // Summary log
      const parts = ['[learning] SessionEnd pipeline complete (parallel)'];
      if (result.evalResult) parts.push('evaluated');
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
      process.stderr.write(`[artibot:session-end] learning pipeline failed: ${err?.message ?? err}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:session-end] ${err.message}\n`);
  process.exit(0);
});
