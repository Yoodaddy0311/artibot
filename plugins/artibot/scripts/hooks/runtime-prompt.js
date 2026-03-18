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
import { readFileSync } from 'node:fs';
import {
  getPluginRoot,
  parseJSON,
  readStdin,
  toFileUrl,
  writeStdout,
} from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

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

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const prompt = hookData?.user_prompt || hookData?.content || '';
  if (!prompt) return;

  const pluginRoot = getPluginRoot();
  const prepared = await fallbackPreparePrompt(prompt, pluginRoot, hookData);

  if (!prepared) return;

  writeStdout({
    user_prompt: prepared.userPrompt ?? prompt,
    message: prepared.message ?? '[runtime] prompt prepared',
  });
}

main().catch(createErrorHandler('runtime-prompt'));
