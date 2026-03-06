#!/usr/bin/env node
/**
 * InstructionsLoaded hook.
 * Fires when CLAUDE.md or .claude/rules files are loaded by Claude Code.
 * Uses this precise timing to initialize Artibot context and validate
 * that the plugin environment is correctly configured.
 *
 * Hook attachment (hooks.json): InstructionsLoaded
 * Stdin: Claude Code hook data JSON
 * Stdout: JSON { message } - informational only
 */

import { getPluginRoot, parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createErrorHandler, getArtibotDataDir, logHookError } from '../../lib/core/hook-utils.js';

/**
 * Validate that essential plugin directories and files exist.
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validatePluginStructure() {
  const pluginRoot = getPluginRoot();
  const requiredPaths = [
    'hooks/hooks.json',
    'lib/core/hook-utils.js',
    'lib/learning/tool-learner.js',
    'agents',
    'commands',
    'skills',
  ];

  const missing = requiredPaths.filter(
    (rel) => !existsSync(path.join(pluginRoot, rel))
  );

  return { valid: missing.length === 0, missing };
}

/**
 * Load the plugin version from artibot.config.json.
 * @returns {string}
 */
function loadVersion() {
  try {
    const configPath = resolveConfigPath('artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  // Extract instruction source info from hook data
  const source = hookData?.source || hookData?.file || 'unknown';
  const instructionType = hookData?.type || 'instructions';

  const version = loadVersion();
  const { valid, missing } = validatePluginStructure();

  const parts = [`[artibot] Instructions loaded (v${version})`];

  if (source !== 'unknown') {
    const basename = typeof source === 'string' ? path.basename(source) : String(source);
    parts.push(`source: ${basename}`);
  }

  if (!valid) {
    parts.push(`WARNING: missing plugin paths: ${missing.join(', ')}`);
    logHookError('instructions-loaded', `missing paths: ${missing.join(', ')}`);
  }

  // Check if artibot data directory exists (learning data, state, etc.)
  const dataDir = getArtibotDataDir();
  if (!existsSync(dataDir)) {
    parts.push('data dir not found - first run or reset');
  }

  writeStdout({
    message: parts.join(' | '),
  });
}

main().catch(createErrorHandler('instructions-loaded', { exit: true }));
