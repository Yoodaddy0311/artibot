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

  // Resolve home directory once for use throughout
  const home = process.env.USERPROFILE || process.env.HOME || '';

  // Restore previous session state via lib/context/session module
  let previousState = null;
  try {
    const sessionModPath = path.join(env.pluginRoot, 'lib', 'context', 'session.js');
    const { loadSessionState } = await import(
      `file://${sessionModPath.replace(/\\/g, '/')}`
    );
    const state = await loadSessionState();
    if (state && state.sessionId) {
      previousState = state;
    }
  } catch {
    // Fallback: manual state loading if session module fails
    const statePath = path.join(home, '.claude', 'artibot-state.json');
    if (existsSync(statePath)) {
      try {
        previousState = JSON.parse(readFileSync(statePath, 'utf-8'));
      } catch {
        // Ignore corrupted state
      }
    }
  }

  const version = config.version || '1.0.0';
  const restored = previousState ? ` | Session restored from ${previousState.startedAt || 'unknown'}` : '';

  // Detect Agent Teams capability
  const agentTeamsEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const hasAgentTeams = agentTeamsEnv === '1' || agentTeamsEnv === 'true';

  // Check settings.json for Agent Teams env configuration
  let settingsHasTeamEnv = false;
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const envSetting = settings?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      settingsHasTeamEnv = envSetting === '1' || envSetting === 'true';
    } catch {
      // Ignore parse errors
    }
  }

  // Determine orchestration mode
  let teamMode;
  let setupHint = '';
  if (hasAgentTeams) {
    teamMode = 'agent-teams (full)';
  } else if (settingsHasTeamEnv) {
    teamMode = 'agent-teams (restart required)';
    setupHint = '\n  Restart Claude Code to activate Agent Teams.';
  } else {
    teamMode = 'sub-agent (fallback)';
    setupHint = '\n  Enable full team mode: Add {"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}} to ~/.claude/settings.json';
  }

  const message = [
    `Artibot v${version} initialized`,
    `Platform: ${env.platform}/${env.arch} | Node ${env.nodeVersion} | Mode: ${teamMode}${restored}${setupHint}`,
  ].join('\n');

  writeStdout({ message });
}

main().catch((err) => {
  process.stderr.write(`[artibot:session-start] ${err.message}\n`);
  process.exit(0); // Don't block session start on errors
});
