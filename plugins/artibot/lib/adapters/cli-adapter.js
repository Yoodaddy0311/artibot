/**
 * CLI adapter for standalone Artibot execution.
 * Provides a stdin/stdout interface for running prompts through the runtime pipeline
 * without requiring Claude Code or any other AI coding assistant host.
 *
 * @module lib/adapters/cli-adapter
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createArtibotAgent } from '../runtime/create-artibot-agent.js';

/**
 * Load artibot.config.json from the plugin root.
 * Returns a frozen default config if the file cannot be read.
 *
 * @param {string} pluginRoot - Absolute path to plugin root
 * @returns {object} Parsed config
 */
function loadCliConfig(pluginRoot) {
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {
      version: '0.0.0',
      automation: { supportedLanguages: ['en', 'ko', 'ja'], ambiguityThreshold: 50 },
      team: { enabled: false },
      cognitive: { router: { threshold: 0.4 } },
    };
  }
}

/**
 * Create a CLI adapter for standalone Artibot execution.
 *
 * @param {object} options
 * @param {string} options.pluginRoot - Absolute path to plugin root
 * @param {boolean} [options.teamMode=false] - Enable team delegation mode
 * @param {object} [options.config] - Optional config override
 * @returns {{ runPrompt: (prompt: string) => Promise<{ userPrompt: string, message: string, context: object }> }}
 */
export function createCliAdapter(options = {}) {
  const { pluginRoot, teamMode = false } = options;
  const baseConfig = options.config || loadCliConfig(pluginRoot);
  const config = teamMode
    ? { ...baseConfig, team: { ...baseConfig.team, enabled: true } }
    : baseConfig;

  const agent = createArtibotAgent({
    config,
    now: Date.now,
    checkpointStore: new Map(),
    checkpointOptions: { persistToDisk: false },
  });

  return {
    /** @returns {string} */
    get platformId() {
      return 'cli';
    },

    /** @returns {string} */
    get platformName() {
      return 'Artibot CLI';
    },

    /**
     * Process a prompt through the full runtime middleware pipeline.
     *
     * @param {string} prompt - User prompt to process
     * @returns {Promise<{ userPrompt: string, message: string, context: object }>}
     */
    async runPrompt(prompt) {
      return agent.preparePrompt({
        prompt,
        hookData: {
          event: 'UserPromptSubmit',
          source: 'cli',
          teamMode,
        },
      });
    },
  };
}
