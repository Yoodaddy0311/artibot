#!/usr/bin/env node
/**
 * SessionStart hook.
 * Detects environment, loads config, restores previous session state.
 * Outputs a welcome message to stdout.
 */

import { readStdin, writeStdout, getPluginRoot, resolveConfigPath, parseJSON } from '../utils/index.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  // Environment detection
  const env = {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    pluginRoot: getPluginRoot(),
  };

  // Load artibot.config.json
  let config = {};
  const configPath = resolveConfigPath('artibot.config.json');
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // Use defaults if config missing
  }

  // Restore previous session state
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const statePath = path.join(home, '.claude', 'artibot-state.json');
  let previousState = null;
  if (existsSync(statePath)) {
    try {
      previousState = JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch {
      // Ignore corrupted state
    }
  }

  const version = config.version || '1.0.0';
  const teamEnabled = config.team?.enabled ? 'ON' : 'OFF';
  const restored = previousState ? ` | Session restored from ${previousState.startedAt || 'unknown'}` : '';

  const message = [
    `Artibot v${version} initialized`,
    `Platform: ${env.platform}/${env.arch} | Node ${env.nodeVersion} | Team: ${teamEnabled}${restored}`,
  ].join('\n');

  writeStdout({ message });
}

main().catch((err) => {
  process.stderr.write(`[artibot:session-start] ${err.message}\n`);
  process.exit(0); // Don't block session start on errors
});
