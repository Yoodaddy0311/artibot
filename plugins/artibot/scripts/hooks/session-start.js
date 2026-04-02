#!/usr/bin/env node
/**
 * SessionStart hook.
 * Detects environment, loads config, restores previous session state.
 * Outputs a welcome message to stdout.
 */

import { getPluginRoot, parseJSON, readStdin, resolveConfigPath, toFileUrl, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkForUpdate } from '../../lib/core/version-checker.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

async function main() {
  const raw = await readStdin();
  parseJSON(raw);

  // Set auto-compact threshold for team sessions (lower = more aggressive)
  if (!process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS) {
    process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS = '180000';
  }

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
      toFileUrl(sessionModPath)
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

  // Session Memory: recall relevant context from past sessions
  let sessionRecall = null;
  try {
    const sessionMemoryPath = path.join(env.pluginRoot, 'lib', 'learning', 'session-memory.js');
    const { createSessionMemory } = await import(toFileUrl(sessionMemoryPath));
    const sessionMemory = createSessionMemory();
    sessionRecall = await sessionMemory.recall(process.cwd(), 5);
  } catch {
    // Non-critical: session memory recall is best-effort
  }

  // Collective Intelligence: load cross-project pattern recommendations
  let collectiveTop = null;
  try {
    const pluginRoot = env.pluginRoot;
    const hubPath = path.join(pluginRoot, 'lib', 'swarm', 'collective-hub.js');
    const persistPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-persistence.js');
    const { generateWeeklyTop } = await import(toFileUrl(hubPath));
    const { loadFromDisk } = await import(toFileUrl(persistPath));
    const store = await loadFromDisk();
    if (store?.patterns?.length > 0) {
      collectiveTop = generateWeeklyTop(store.patterns, 5);
    }
  } catch {
    // Non-critical: collective intelligence is best-effort
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

  // Determine orchestration mode (advisory only — never modify settings.json)
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
    process.stderr.write(
      '[artibot] Agent Teams not enabled. Add to ~/.claude/settings.json:\n' +
      '  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }\n'
    );
  }

  const lines = [
    `Artibot v${version} initialized`,
    `Platform: ${env.platform}/${env.arch} | Node ${env.nodeVersion} | Mode: ${teamMode}${restored}${setupHint}`,
  ];

  // Append session memory recall summary if available
  if (sessionRecall && sessionRecall.length > 0) {
    const topics = sessionRecall
      .map((r) => r.memory?.keywords?.slice(0, 3).join(', '))
      .filter(Boolean)
      .join(' | ');
    lines.push(`Session memory: ${sessionRecall.length} relevant memories recalled (${topics})`);
  }

  if (collectiveTop?.patterns?.length > 0) {
    lines.push(`| Collective: ${collectiveTop.patterns.length} cross-project patterns available`);
  }

  // Non-blocking update notification — any error is swallowed.
  // Wrapped with a 2000ms outer timeout so the update check never consumes
  // more than 2 seconds, leaving ample headroom within the 5000ms hook limit.
  try {
    const cacheDir = path.join(home, '.claude', 'artibot');
    const updatePromise = checkForUpdate(version, cacheDir);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 2000)
    );
    const updateInfo = await Promise.race([updatePromise, timeoutPromise]);
    if (updateInfo.hasUpdate) {
      lines.push(
        `\u2b06\ufe0f New version available: v${updateInfo.latestVersion} (current: v${version})`,
        `   Update: /artibot:update --force`
      );
    }
  } catch {
    // Never block session start on version-check failures
  }

  const message = lines.join('\n');

  writeStdout({ message });
}

main().catch(createErrorHandler('session-start', { exit: true }));
