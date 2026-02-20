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

import { atomicWriteSync, getPluginRoot, parseJSON, readStdin, toFileUrl } from '../utils/index.js';
import path from 'node:path';
import { logHookError, getStatePath, createErrorHandler } from '../../lib/core/hook-utils.js';

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
    logHookError('session-end', 'selfEvaluate failed', evalSettled.reason);
  }
  if (experiencesSettled.status === 'rejected') {
    logHookError('session-end', 'collectExperiences failed', experiencesSettled.reason);
  }

  // Stage 2: batchLearn depends on experiences being collected
  let learned = null;
  try {
    learned = await batchLearn(experiences);
  } catch (err) {
    logHookError('session-end', 'batchLearn failed', err);
  }

  // Stage 3: hotSwap depends on learning results
  let hotSwapped = null;
  try {
    hotSwapped = await hotSwap(learned);
  } catch (err) {
    logHookError('session-end', 'hotSwap failed', err);
  }

  return { evalResult, experiences, learned, hotSwapped };
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const statePath = getStatePath();

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
    logHookError('session-end', 'Failed to save state', err);
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
      logHookError('session-end', 'learning pipeline failed', err);
    }
  }
}

main().catch(createErrorHandler('session-end', { exit: true }));
