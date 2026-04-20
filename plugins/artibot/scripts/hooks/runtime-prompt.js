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
  };

  try {
    const configPath = path.join(pluginRoot, 'artibot.config.json');
    return {
      ...defaults,
      ...JSON.parse(readFileSync(configPath, 'utf-8')),
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

  const baseMessage = prepared.message ?? '[runtime] prompt prepared';
  const finalMessage = effortMeta
    ? `${baseMessage} | cmd=/${effortMeta.command} effort=${effortMeta.effort}`
    : baseMessage;

  writeStdout({
    user_prompt: prepared.userPrompt ?? prompt,
    message: finalMessage,
  });
}

main().catch(createErrorHandler('runtime-prompt'));
