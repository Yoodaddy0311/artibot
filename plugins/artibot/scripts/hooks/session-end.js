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

/**
 * Read the Artibot config JSON best-effort. Returns `{}` on any failure so
 * callers can safely destructure without defensive checks.
 * @returns {Promise<object>}
 */
async function readArtibotConfig() {
  try {
    const { readFileSync } = await import('node:fs');
    const cfgPath = path.join(getPluginRoot(), 'artibot.config.json');
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Emit the one-shot first-run welcome message (observe mode only).
 * Writes `welcomedAt` into the first-run state file so the message never
 * repeats. No-ops when firstRunMode is disabled or we've already welcomed.
 */
async function maybeEmitFirstRunWelcome() {
  const cfg = await readArtibotConfig();
  if (cfg?.ago?.selfControl?.firstRunMode?.enabled === false) return;

  const firstRunModPath = path.join(getPluginRoot(), 'lib', 'learning', 'first-run-guard.js');
  const { getFirstRunState, _internals } = await import(toFileUrl(firstRunModPath));
  const st = await getFirstRunState(cfg);
  if (st.mode !== 'observe') return;

  const frStatePath = _internals.resolveStatePath(cfg);
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  let raw = {};
  try {
    if (existsSync(frStatePath)) raw = JSON.parse(readFileSync(frStatePath, 'utf-8'));
  } catch { /* treat as fresh */ }
  if (raw.welcomedAt) return;

  process.stderr.write(
    `[artibot:welcome — 자가 관리 엔진이 관찰 모드로 시작되었어요. ${st.runsRemaining}회 후 자동으로 활성화됩니다. 끄고 싶으면 artibot.config.json에서 masterEnabled: false로 바꾸세요.]\n`,
  );
  raw.welcomedAt = new Date().toISOString();
  try { writeFileSync(frStatePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8'); } catch { /* ignore */ }
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

    // AGO Self-Control Wave 2: one-shot welcome notice for first-run observe mode.
    // Delegates to maybeEmitFirstRunWelcome() to avoid deep nesting; writes a
    // `welcomedAt` marker into the state file so the message only appears once.
    // Never blocks session-end.
    try {
      await maybeEmitFirstRunWelcome();
    } catch (err) {
      logHookError('session-end', `first-run welcome skipped: ${err.message || err}`);
    }

    // AGO Track G6: auto-spawn advisor (next-session suggestions).
    // Opt-in, write-only, never executes or schedules anything.
    // Failure is graceful — must never block session-end.
    try {
      const plugRoot = getPluginRoot();
      const advisorPath = path.join(plugRoot, 'lib', 'learning', 'auto-spawn-advisor.js');
      const cfgPath = path.join(plugRoot, 'artibot.config.json');
      const { analyzeNextSession } = await import(toFileUrl(advisorPath));

      let agoConfig = {};
      try {
        const { readFileSync } = await import('node:fs');
        agoConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      } catch {
        // Missing/unreadable config → advisor will treat as opt-in=false.
      }

      const advisorSummary = {
        unresolvedTodos: Array.isArray(hookData.unresolved_todos) ? hookData.unresolved_todos : [],
        testFailures: Array.isArray(hookData.test_failures) ? hookData.test_failures : [],
        driftWarnings: Array.isArray(hookData.drift_warnings) ? hookData.drift_warnings : [],
        staleSkills: Array.isArray(hookData.stale_skills) ? hookData.stale_skills : [],
        learningIncomplete: hookData.learning_incomplete ?? null,
      };

      const advisorResult = await analyzeNextSession(advisorSummary, {
        pluginRoot: plugRoot,
        config: agoConfig,
      });
      if (advisorResult.written) {
        process.stderr.write(
          `[artibot] auto-spawn-advisor: ${advisorResult.suggestions.length} suggestion(s) written\n`,
        );
      }
    } catch (err) {
      logHookError('session-end', `auto-spawn-advisor failed: ${err.message || err}`);
    }

    // B1: AGO Self-Control — sweep pending macro suggestions for auto-registration.
    // Triple-gated inside `sweepAutoRegister`: masterEnabled + autoMacroRegister.enabled
    // + kill-switch. Observe-only runs return `reason: 'observe-only'` per suggestion.
    // Non-critical — must never block session-end.
    try {
      await runMacroAutoRegister();
    } catch (err) {
      logHookError('session-end', `macro-auto-register failed: ${err.message || err}`);
    }
  }
}

/**
 * Load macro-learner and sweep pending suggestions. Reads config fresh to
 * respect user edits made during the session. Runs the sweep unconditionally
 * (the macro-learner enforces gates itself) so the hook stays one-line simple.
 *
 * @returns {Promise<void>}
 */
export async function runMacroAutoRegister(deps = {}) {
  const pluginRoot = deps.pluginRoot || getPluginRoot();
  let sweep = deps.sweepAutoRegister;
  if (!sweep) {
    const macroPath = path.join(pluginRoot, 'lib', 'learning', 'macro-learner.js');
    const mod = await import(toFileUrl(macroPath));
    sweep = mod.sweepAutoRegister;
  }
  const config = deps.config || (await readArtibotConfig());
  const result = await sweep({ pluginRoot, config });
  const count = Array.isArray(result?.registered) ? result.registered.length : 0;
  if (count > 0) {
    process.stderr.write(`[artibot:macros-auto-registered count=${count}]\n`);
  }
  return { registered: count };
}

main().catch(createErrorHandler('session-end', { exit: true }));
