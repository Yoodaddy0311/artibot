#!/usr/bin/env node
/**
 * UserPromptSubmit hook - Runtime Prompt Bridge.
 * Replaces the old cognitive-router hook as the second-stage prompt enricher.
 *
 * Flow:
 *   1. user-prompt-handler.js may rewrite special triggers like !rv
 *   2. this hook reads the rewritten prompt from hookData.user_prompt
 *   3. createArtibotAgent().preparePrompt() builds a runtime envelope
 *   4. the enriched prompt is returned to Claude Code via stdout
 */

import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  getPluginRoot,
  parseJSON,
  readStdin,
  toFileUrl,
  writeStdout,
} from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

/**
 * Detect a leading slash command in the prompt and return its name.
 * Matches the first whitespace-delimited token after an optional '/'.
 * @param {string} prompt
 * @returns {string|null}
 */
function detectSlashCommand(prompt) {
  const trimmed = String(prompt || '').trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.slice(1).match(/^([a-z][a-z0-9_-]{0,31})(?=\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resolve effort level for a detected slash command using EFFORT_POLICY.
 * Falls back to null on any import failure so the hook stays safe.
 * @param {string} commandName
 * @param {string} pluginRoot
 * @returns {Promise<'xhigh'|'high'|'medium'|'low'|null>}
 */
async function resolveCommandEffort(commandName, pluginRoot) {
  if (!commandName) return null;
  try {
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { getEffortForCommand } = await import(toFileUrl(routerPath));
    return getEffortForCommand(commandName);
  } catch {
    return null;
  }
}

/**
 * Persist the detected command + effort to runtime/ for downstream consumers
 * (statusline, observability, future native effort API wiring).
 * @param {{ command: string, effort: string } | null} meta
 * @param {string} pluginRoot
 */
function persistEffortMeta(meta, pluginRoot) {
  if (!meta) return;
  try {
    const runtimeDir = path.join(pluginRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      path.join(runtimeDir, 'current-effort.json'),
      JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }) + '\n',
    );
  } catch {
    // Non-critical: effort metadata is advisory
  }
}

/**
 * Notify the cognitive router of the current session-wide effort hint.
 * Only invoked when `runtime.effort.nativeApi` is enabled in config.
 * Swallows all errors — this is advisory-only wiring.
 *
 * @param {'xhigh'|'high'|'medium'|'low'|null} effortLevel
 * @param {string} pluginRoot
 * @returns {Promise<void>}
 */
async function applyNativeEffortHint(effortLevel, pluginRoot) {
  if (!effortLevel) return;
  try {
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { setNativeEffortHint } = await import(toFileUrl(routerPath));
    // Router maps 'xhigh' into the 'high' effort band (system 2 override).
    const normalized = effortLevel === 'xhigh' ? 'high' : effortLevel;
    setNativeEffortHint({ effortLevel: normalized });
  } catch {
    // Non-critical: fall back to heuristic routing
  }
}

/**
 * Build the effort prefix directive injected at the top of the user prompt.
 * Output format:
 *   [artibot:effort level=xhigh command=implement]
 *
 * Returns empty string when effort metadata is missing.
 *
 * @param {{ command: string, effort: string } | null} meta
 * @returns {string}
 */
function buildEffortDirective(meta) {
  if (!meta || !meta.effort) return '';
  const command = meta.command ? ` command=${meta.command}` : '';
  return `[artibot:effort level=${meta.effort}${command}]`;
}

/**
 * Prepend one or more artibot directives to the user prompt on a single
 * leading line, separated from the original prompt by a blank line.
 *
 * @param {string} basePrompt - Original (or already-prepared) user prompt.
 * @param {string[]} directives - Directive strings (empty entries are dropped).
 * @returns {string}
 */
function applyPromptPrefix(basePrompt, directives) {
  const valid = directives.filter((d) => typeof d === 'string' && d.length > 0);
  if (valid.length === 0) return basePrompt;
  const header = valid.join('');
  const body = String(basePrompt || '');
  return `${header}\n\n${body}`;
}

const FALLBACK_SYSTEM2_KEYWORDS = [
  'architecture',
  'security',
  'vulnerability',
  'audit',
  'refactor',
  'performance',
  'migration',
  'deploy',
  'production',
  'complex',
  'comprehensive',
  '--think',
  '--think-hard',
  '--ultrathink',
  '\uBCF4\uC548',
  '\uCDE8\uC57D\uC810',
  '\uAC10\uC0AC',
  '\uB9AC\uD329\uD130',
  '\uC131\uB2A5',
  '\uB9C8\uC774\uADF8\uB808\uC774\uC158',
  '\uBC30\uD3EC',
  '\uBCF5\uC7A1',
  '\uC885\uD569',
  '\uC544\uD0A4\uD14D\uCC98',
];

function loadRuntimeConfig(pluginRoot) {
  const defaults = {
    automation: {
      supportedLanguages: ['en', 'ko', 'ja'],
      ambiguityThreshold: 50,
    },
    runtime: {
      effort: {
        injectPrompt: true,
        nativeApi: false,
        budgetMap: {
          xhigh: 128000,
          high: 64000,
          medium: 32000,
          low: 16000,
        },
      },
      longContext: {
        enabled: false,
        betaHeader: 'context-1m-2025-08-01',
        activationThreshold: 180000,
      },
    },
  };

  try {
    const configPath = path.join(pluginRoot, 'artibot.config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      ...defaults,
      ...parsed,
      runtime: {
        ...defaults.runtime,
        ...(parsed.runtime || {}),
        effort: {
          ...defaults.runtime.effort,
          ...((parsed.runtime && parsed.runtime.effort) || {}),
        },
        longContext: {
          ...defaults.runtime.longContext,
          ...((parsed.runtime && parsed.runtime.longContext) || {}),
        },
      },
    };
  } catch {
    return defaults;
  }
}

function getCheckpointOptionsFromEnv() {
  const disabled = ['1', 'true'].includes(String(process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE || '').toLowerCase());
  const filePath = process.env.ARTIBOT_RUNTIME_CHECKPOINT_PATH;

  if (!disabled && !filePath) {
    return {};
  }

  return {
    persistToDisk: !disabled,
    ...(filePath ? { filePath } : {}),
  };
}

function getMiddlewareOptionsFromEnv() {
  const disableMemory = ['1', 'true'].includes(String(process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE || '').toLowerCase());
  if (!disableMemory) {
    return {};
  }

  return {
    memory: {
      enabled: false,
    },
  };
}

async function fallbackPreparePrompt(prompt, pluginRoot, hookData) {
  const config = loadRuntimeConfig(pluginRoot);

  try {
    const runtimePath = path.join(pluginRoot, 'lib', 'runtime', 'create-artibot-agent.js');
    const { createArtibotAgent } = await import(toFileUrl(runtimePath));
    const runtime = createArtibotAgent({
      pluginRoot,
      config,
      middlewareOptions: getMiddlewareOptionsFromEnv(),
      checkpointOptions: getCheckpointOptionsFromEnv(),
    });
    return await runtime.preparePrompt({ prompt, hookData });
  } catch {
    // Keep a tiny in-script fallback so the hook remains safe during upgrades.
  }

  let system = 'system1';
  const lower = prompt.toLowerCase();
  if (FALLBACK_SYSTEM2_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))) {
    system = 'system2';
  }

  let intentSummary = 'none';
  try {
    const intentPath = path.join(pluginRoot, 'lib', 'intent', 'index.js');
    const { detectIntent } = await import(toFileUrl(intentPath));
    const detected = detectIntent(prompt, {
      languages: config.automation.supportedLanguages,
      ambiguityThreshold: config.automation.ambiguityThreshold,
    });
    if (detected.best?.intent) {
      intentSummary = detected.best.intent;
    } else if (detected.intents.length > 0) {
      intentSummary = detected.intents.join(', ');
    }
  } catch {
    // Keep default summary.
  }

  return {
    userPrompt: prompt,
    message: `[runtime] ${system.toUpperCase()} | fallback | intent=${intentSummary}`,
    context: {
      system,
      intentSummary,
      fallback: true,
    },
  };
}

/**
 * Persist token usage session stats to a temp file for statusline.sh.
 * @param {object} context - prepared.context from preparePrompt
 * @param {string} pluginRoot
 */
function persistTokenUsage(context, pluginRoot) {
  const tokenUsage = context?.tokenUsage;
  if (!tokenUsage?.enabled) return;

  const session = tokenUsage.session || {};
  const data = {
    totalTokens: session.totalTokens || 0,
    totalInput: session.totalInput || 0,
    totalOutput: session.totalOutput || 0,
    requestCount: session.requestCount || 0,
    updatedAt: new Date().toISOString(),
  };

  try {
    const runtimeDir = path.join(pluginRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      path.join(runtimeDir, 'token-usage-session.json'),
      JSON.stringify(data) + '\n',
    );
  } catch {
    // Non-critical: statusline will just not show tokens
  }
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const prompt = hookData?.user_prompt || hookData?.content || '';
  if (!prompt) return;

  const pluginRoot = getPluginRoot();
  const runtimeConfig = loadRuntimeConfig(pluginRoot);
  const effortConfig = runtimeConfig?.runtime?.effort || {};
  const injectPrompt = effortConfig.injectPrompt !== false; // default true
  const useNativeApi = effortConfig.nativeApi === true;     // default false

  const prepared = await fallbackPreparePrompt(prompt, pluginRoot, hookData);

  if (!prepared) return;

  // Persist token usage for statusline
  persistTokenUsage(prepared.context, pluginRoot);

  // Detect slash command and auto-inject effort hint (Claude 4.7 effort_level).
  // Advisory only — stored to runtime/current-effort.json for observability
  // and appended to the hook message so the router surfaces the decision.
  const commandName = detectSlashCommand(prompt);
  const effort = await resolveCommandEffort(commandName, pluginRoot);
  const effortMeta = commandName && effort
    ? { command: commandName, effort }
    : null;
  persistEffortMeta(effortMeta, pluginRoot);

  // AGO G3 — record effort classification for Explainability (observe-only).
  // Wrapped in try/catch so Decision Trail failures never break the prompt.
  if (effortMeta) {
    try {
      const trailPath = path.join(pluginRoot, 'lib', 'core', 'decision-trail.js');
      const { recordDecision } = await import(toFileUrl(trailPath));
      await recordDecision({
        subsystem: 'runtime-prompt',
        action: 'effort-classified',
        reason: `slash command '/${effortMeta.command}' matched EFFORT_POLICY`,
        inputs: { command: effortMeta.command },
        outputs: { effort: effortMeta.effort },
      });
    } catch {
      // Non-critical: decision trail is advisory
    }
  }

  // P3-8: record user signal for skill-level auto-detection.
  // Non-critical — any failure is swallowed so the prompt flow is unaffected.
  try {
    const profileModPath = path.join(pluginRoot, 'lib', 'core', 'user-profile.js');
    const { recordSignal, configureProfilePath } = await import(toFileUrl(profileModPath));
    const uxProfilePath = runtimeConfig?.ux?.profilePath;
    if (uxProfilePath) configureProfilePath(uxProfilePath);
    await recordSignal({
      type: commandName ? 'slash-command' : 'natural-language',
      value: commandName || String(prompt).slice(0, 60),
      timestamp: Date.now(),
    });
  } catch {
    // Non-critical: profile tracking is advisory
  }

  // Task Budget auto-wire (P3-2): derive max_tokens per effort and persist
  // runtime/current-task-budget.json + build the [artibot:task-budget …]
  // directive that is injected alongside the effort prefix.
  let taskBudgetDirective = '';
  try {
    const tbPath = path.join(pluginRoot, 'lib', 'runtime', 'task-budget.js');
    const {
      getTaskBudgetForEffort,
      buildTaskBudgetDirective,
      persistTaskBudget,
    } = await import(toFileUrl(tbPath));

    if (effortMeta) {
      const budget = getTaskBudgetForEffort(effortMeta.effort, runtimeConfig);
      if (budget) {
        taskBudgetDirective = buildTaskBudgetDirective(
          effortMeta.effort,
          budget,
          runtimeConfig,
        );
        persistTaskBudget(
          { command: effortMeta.command, effort: effortMeta.effort, budget },
          pluginRoot,
        );
      }
    }
  } catch {
    // Non-critical: task budget is advisory
  }

  // Optional: native effort hint → cognitive router (session-wide)
  if (useNativeApi && effortMeta) {
    await applyNativeEffortHint(effortMeta.effort, pluginRoot);
  }

  // G10: Macro Learning (suggest-only). Observe the prompt to detect
  // repeating multi-action patterns. Never auto-registers macros — only
  // writes to runtime/macro-suggestions.json for later user approval.
  try {
    const macroPath = path.join(pluginRoot, 'lib', 'learning', 'macro-learner.js');
    const { observePrompt } = await import(toFileUrl(macroPath));
    await observePrompt(prompt, { pluginRoot, config: runtimeConfig });
  } catch {
    // Non-critical: macro learning is advisory
  }

  // Build the prompt to return. When injectPrompt is enabled and an
  // effort was resolved, prepend [artibot:effort …][artibot:task-budget …]
  // on the first line followed by a blank line, then the (possibly
  // prepared) user prompt. This mirrors the 4.7 "advisory directive"
  // pattern from the official effort guide.
  const basePrompt = prepared.userPrompt ?? prompt;
  const effortDirective = buildEffortDirective(effortMeta);
  const finalUserPrompt = injectPrompt
    ? applyPromptPrefix(basePrompt, [effortDirective, taskBudgetDirective])
    : basePrompt;

  const baseMessage = prepared.message ?? '[runtime] prompt prepared';
  const finalMessage = effortMeta
    ? `${baseMessage} | cmd=/${effortMeta.command} effort=${effortMeta.effort}`
    : baseMessage;

  writeStdout({
    user_prompt: finalUserPrompt,
    message: finalMessage,
  });
}

main().catch(createErrorHandler('runtime-prompt'));
