#!/usr/bin/env node
/**
 * UserPromptSubmit hook - Cognitive Router.
 * Delegates to lib/cognitive/router.js for unified complexity classification.
 * Configures router with artibot.config.json values before each classification.
 *
 * Fallback: if router module import fails, uses simple keyword-based detection.
 */

import { readStdin, writeStdout, parseJSON, getPluginRoot, toFileUrl } from '../utils/index.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Fallback System 2 keywords (used only when router.js import fails)
const SYSTEM2_KEYWORDS = [
  'architecture', 'security', 'vulnerability', 'audit', 'refactor',
  'performance', 'scalability', 'migration', 'deploy', 'production',
  'critical', 'complex', 'comprehensive', 'system-wide', 'enterprise',
  '--think', '--think-hard', '--ultrathink',
  '아키텍처', '보안', '취약점', '감사', '리팩터', '성능', '마이그레이션',
  '배포', '프로덕션', '복잡', '종합', '시스템',
];

/**
 * Load cognitive config from artibot.config.json.
 */
function loadConfig() {
  const defaults = {
    router: { threshold: 0.4, adaptRate: 0.05 },
    system1: { maxLatency: 100, minConfidence: 0.6 },
    system2: { maxRetries: 3, sandboxEnabled: true },
  };

  try {
    const configPath = path.join(getPluginRoot(), 'artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return { ...defaults, ...config.cognitive };
  } catch {
    return defaults;
  }
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const prompt = hookData?.user_prompt || hookData?.content || '';
  if (!prompt) return;

  const config = loadConfig();
  const pluginRoot = getPluginRoot();

  // Delegate to the unified cognitive router module + intent detection
  try {
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { configure, classifyComplexity } = await import(
      toFileUrl(routerPath)
    );

    // Sync config values (threshold, adaptRate) from artibot.config.json
    configure({
      threshold: config.router?.threshold,
      adaptRate: config.router?.adaptRate,
    });

    // Classify using the unified 5-factor model
    const result = classifyComplexity(prompt);
    const system = result.system === 1 ? 'system1' : 'system2';

    // Enrich with intent detection from lib/intent
    let intentInfo = '';
    try {
      const intentPath = path.join(pluginRoot, 'lib', 'intent', 'index.js');
      const { detectIntent } = await import(
        toFileUrl(intentPath)
      );

      const configPath = path.join(pluginRoot, 'artibot.config.json');
      const fullConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      const intentResult = detectIntent(prompt, {
        ambiguityThreshold: fullConfig.automation?.ambiguityThreshold ?? 50,
        languages: fullConfig.automation?.supportedLanguages,
      });

      if (intentResult.best) {
        intentInfo = ` | intent=${intentResult.best.intent} route=${intentResult.best.commands?.[0] || 'none'} agents=[${(intentResult.best.agents || []).join(',')}]`;
      }
      if (intentResult.ambiguity?.ambiguous) {
        intentInfo += ` | ambiguous score=${intentResult.ambiguity.score}`;
      }
    } catch {
      // Intent module unavailable — continue without it
    }

    writeStdout({
      message: `[cognitive] ${system.toUpperCase()} | complexity=${result.score} confidence=${result.confidence} factors=${JSON.stringify(result.factors)} | threshold=${result.threshold}${intentInfo}`,
    });
  } catch (err) {
    // Fallback: simple keyword-based routing if router module fails
    const lower = prompt.toLowerCase();
    const hasThinkFlag = ['--think', '--think-hard', '--ultrathink'].some((f) => lower.includes(f));
    const hasS2Keywords = SYSTEM2_KEYWORDS.some((kw) => lower.includes(kw));
    const system = hasThinkFlag || hasS2Keywords ? 'system2' : 'system1';

    writeStdout({
      message: `[cognitive] ${system.toUpperCase()} | fallback | ${err.message}`,
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:cognitive-router] ${err.message}\n`);
});
