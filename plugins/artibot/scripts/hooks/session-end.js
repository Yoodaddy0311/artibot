#!/usr/bin/env node
/**
 * SessionEnd hook.
 * Saves current session state to ~/.claude/artibot-state.json
 * and runs the learning pipeline with parallelized independent stages.
 *
 * Pipeline: delegates to shutdownLearning() which handles the full cycle:
 *   1. summarizeSession (memory)
 *   2. self-evaluation (evaluateResult + collectExperience)
 *   3. experience collection + batch learning
 *   4. knowledge transfer hot-swap
 */

import { atomicWriteSync, getPluginRoot, parseJSON, readStdin, toFileUrl } from '../utils/index.js';
import path from 'node:path';
import { createErrorHandler, getStatePath, logHookError } from '../../lib/core/hook-utils.js';

/**
 * Run the learning pipeline using shutdownLearning() which includes:
 *   1. Session summarization (memory)
 *   2. Self-evaluation (evaluateResult via getImprovementSuggestions + collectExperience)
 *   3. Experience collection + batch learning (collectDailyExperiences + batchLearn)
 *   4. Knowledge transfer hot-swap (hotSwap - no args, reads patterns internally)
 *
 * @param {object} sessionData - Session context data
 * @param {object} learningModule - The imported learning module
 * @returns {Promise<{ summarized: boolean, evaluated: object|null, learned: object|null, hotSwapped: object|null }>}
 */
export async function runLearningPipeline(sessionData, learningModule) {
  const { shutdownLearning } = learningModule;
  return shutdownLearning(sessionData);
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
      const parts = ['[learning] SessionEnd pipeline complete (shutdownLearning)'];
      if (result.summarized) parts.push('summarized');
      if (result.evaluated) parts.push('evaluated');
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

    // Self-Evolution Loop: compress → knowledge-graph → skill-evolver → auto-research → contribute
    try {
      const plugRoot = getPluginRoot();
      const evolutionPath = path.join(plugRoot, 'lib', 'learning', 'evolution-loop.js');
      const configPath = path.join(plugRoot, 'artibot.config.json');
      const { createEvolutionLoop } = await import(toFileUrl(evolutionPath));

      // Read swarm config so Stage 5 (collective contribution) respects install-time opt-in
      let hubConfig = { optIn: false, minSuccessRate: 0.6, minUsageCount: 5 };
      try {
        const { readFileSync } = await import('node:fs');
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (cfg.swarm) {
          hubConfig = {
            optIn: Boolean(cfg.swarm.optIn && cfg.swarm.enabled),
            minSuccessRate: cfg.swarm.minSuccessRate ?? 0.6,
            minUsageCount: cfg.swarm.minUsageCount ?? 5,
          };
        }
      } catch {
        // Config read failure — use safe defaults (optIn: false)
      }

      const loop = createEvolutionLoop({ hubConfig });
      const evolutionResult = await loop.run({
        events: hookData.events || [],
        skillUsages: hookData.skill_usages || [],
        routingResult: hookData.routing_result || null,
      });

      if (evolutionResult.errors.length > 0) {
        for (const err of evolutionResult.errors) {
          logHookError('session-end', `evolution-loop ${err.stage}: ${err.message}`);
        }
      }
    } catch (err) {
      logHookError('session-end', `evolution-loop failed: ${err.message || err}`);
    }
  }
}

main().catch(createErrorHandler('session-end', { exit: true }));
