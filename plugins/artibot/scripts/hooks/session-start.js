#!/usr/bin/env node
/**
 * SessionStart hook.
 * Detects environment, loads config, restores previous session state.
 * Outputs a welcome message to stdout.
 */

import { getPluginRoot, parseJSON, readStdin, resolveConfigPath, toFileUrl, writeStdout } from '../utils/index.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkForUpdate } from '../../lib/core/version-checker.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { getLastTestStatus } from '../../lib/core/test-status.js';

/**
 * Build the environment descriptor used in the welcome banner and downstream
 * helpers. Snapshots platform/arch/node/plugin-root at session start.
 * @returns {{ platform: string, arch: string, nodeVersion: string, pluginRoot: string }}
 */
function detectEnvironment() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    pluginRoot: getPluginRoot(),
  };
}

/**
 * Load artibot.config.json. Returns `{}` when missing/unreadable so callers
 * never need to guard against null.
 * @returns {object}
 */
function loadConfig() {
  try {
    const configPath = resolveConfigPath('artibot.config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * P3-3: 1M context opt-in. When `runtime.longContext.enabled` is true in
 * artibot.config.json, append the beta header to ANTHROPIC_BETA (advisory,
 * child-process only — Claude Code picks it up when spawned from this env)
 * and persist runtime/long-context-active.json so statusline/observability
 * surfaces the activated state.
 * @param {object} config
 * @param {string} pluginRoot
 */
function activateLongContext(config, pluginRoot) {
  try {
    const longContext = config?.runtime?.longContext;
    if (!longContext || longContext.enabled !== true) return;

    const betaHeader = longContext.betaHeader || 'context-1m-2025-08-01';
    const existing = process.env.ANTHROPIC_BETA || '';
    process.env.ANTHROPIC_BETA = existing
      ? Array.from(new Set(existing.split(',').map((s) => s.trim()).filter(Boolean).concat(betaHeader))).join(',')
      : betaHeader;

    const runtimeDir = path.join(pluginRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      path.join(runtimeDir, 'long-context-active.json'),
      JSON.stringify({
        enabled: true,
        betaHeader,
        activatedAt: new Date().toISOString(),
      }) + '\n',
    );
  } catch {
    // Non-critical: long-context activation is advisory
  }
}

/**
 * Restore previous session state. Tries lib/context/session module first;
 * falls back to manual state file read.
 * @param {string} pluginRoot
 * @param {string} home
 * @returns {Promise<object|null>}
 */
async function loadPreviousState(pluginRoot, home) {
  try {
    const sessionModPath = path.join(pluginRoot, 'lib', 'context', 'session.js');
    const { loadSessionState } = await import(toFileUrl(sessionModPath));
    const state = await loadSessionState();
    if (state && state.sessionId) return state;
  } catch {
    // Fall through to manual loading
  }
  const statePath = path.join(home, '.claude', 'artibot-state.json');
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch {
      // Ignore corrupted state
    }
  }
  return null;
}

/**
 * Session Memory: recall relevant context from past sessions.
 * @param {string} pluginRoot
 * @returns {Promise<Array|null>}
 */
async function recallSessionMemory(pluginRoot) {
  try {
    const sessionMemoryPath = path.join(pluginRoot, 'lib', 'learning', 'session-memory.js');
    const { createSessionMemory } = await import(toFileUrl(sessionMemoryPath));
    const sessionMemory = createSessionMemory();
    return await sessionMemory.recall(process.cwd(), 5);
  } catch {
    return null;
  }
}

/**
 * Collective Intelligence: load cross-project pattern recommendations.
 * @param {string} pluginRoot
 * @returns {Promise<object|null>}
 */
async function loadCollectiveTop(pluginRoot) {
  try {
    const hubPath = path.join(pluginRoot, 'lib', 'swarm', 'collective-hub.js');
    const persistPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-persistence.js');
    const { generateWeeklyTop } = await import(toFileUrl(hubPath));
    const { loadFromDisk } = await import(toFileUrl(persistPath));
    const store = await loadFromDisk();
    if (store?.patterns?.length > 0) {
      return generateWeeklyTop(store.patterns, 5);
    }
  } catch {
    // Non-critical
  }
  return null;
}

/**
 * Detect Agent Teams orchestration mode. Reads env + settings.json and
 * emits a stderr advisory when the env is not configured. Never modifies
 * settings.json.
 * @param {string} home
 * @returns {{ teamMode: string, setupHint: string }}
 */
function detectTeamMode(home) {
  const agentTeamsEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const hasAgentTeams = agentTeamsEnv === '1' || agentTeamsEnv === 'true';

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

  if (hasAgentTeams) {
    return { teamMode: 'agent-teams (full)', setupHint: '' };
  }
  if (settingsHasTeamEnv) {
    return {
      teamMode: 'agent-teams (restart required)',
      setupHint: '\n  Restart Claude Code to activate Agent Teams.',
    };
  }
  process.stderr.write(
    '[artibot] Agent Teams not enabled. Add to ~/.claude/settings.json:\n' +
    '  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }\n'
  );
  return {
    teamMode: 'sub-agent (fallback)',
    setupHint: '\n  Enable full team mode: Add {"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}} to ~/.claude/settings.json',
  };
}

/**
 * Build the initial banner lines including version, platform, team mode,
 * session-memory summary, and collective-intelligence teaser.
 * @param {object} params
 * @returns {string[]}
 */
function buildBannerLines({ version, env, teamMode, setupHint, previousState, sessionRecall, collectiveTop }) {
  const restored = previousState ? ` | Session restored from ${previousState.startedAt || 'unknown'}` : '';
  const lines = [
    `Artibot v${version} initialized`,
    `Platform: ${env.platform}/${env.arch} | Node ${env.nodeVersion} | Mode: ${teamMode}${restored}${setupHint}`,
  ];
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
  return lines;
}

/**
 * AGO Track G6/G10: surface pending advisor suggestions + macro suggestions.
 * Best-effort, never blocks start.
 * @param {string} pluginRoot
 * @param {object} config
 * @param {string[]} lines
 */
async function surfaceAdvisoryMessages(pluginRoot, config, lines) {
  try {
    const advisorPath = path.join(pluginRoot, 'lib', 'learning', 'auto-spawn-advisor.js');
    const { readPendingSuggestions } = await import(toFileUrl(advisorPath));
    const pending = await readPendingSuggestions(pluginRoot);
    if (pending.length > 0) {
      lines.push(`[artibot:pending-suggestions count=${pending.length}]`);
    }
  } catch {
    // Non-critical
  }
  try {
    const macroPath = path.join(pluginRoot, 'lib', 'learning', 'macro-learner.js');
    const { getMacroSuggestions } = await import(toFileUrl(macroPath));
    const macroSuggestions = await getMacroSuggestions(pluginRoot, config);
    const macroPending = macroSuggestions.filter((s) => s && s.status === 'pending');
    if (macroPending.length > 0) {
      lines.push(`[artibot:macro-suggestions count=${macroPending.length}]`);
    }
  } catch {
    // Non-critical
  }
}

/**
 * AGO Self-Control Wave 2: First-Run Safe Mode welcome + active-mode banner.
 * Non-blocking. Only emits banners when masterEnabled is true (default).
 * @param {string} pluginRoot
 * @param {object} config
 * @param {string[]} lines
 */
async function maybeEmitFirstRunBanner(pluginRoot, config, lines) {
  try {
    const masterEnabled = config?.ago?.selfControl?.masterEnabled !== false;
    if (!masterEnabled) return;

    const firstRunPath = path.join(pluginRoot, 'lib', 'learning', 'first-run-guard.js');
    const { getFirstRunState } = await import(toFileUrl(firstRunPath));
    const firstRunState = await getFirstRunState(config);
    const threshold = config?.ago?.selfControl?.firstRunMode?.observeRuns || 5;

    const runtimeDir = path.join(pluginRoot, 'runtime');
    const welcomeMarker = path.join(runtimeDir, 'self-control-welcomed.marker');
    if (!existsSync(welcomeMarker)) {
      lines.push(
        '[artibot:welcome] Artibot은 기본 ON 모드로 시작됐어요. 처음 5회는 관찰만 하며 학습합니다. 끄려면 artibot.config.json의 ago.selfControl.masterEnabled=false.',
      );
      try {
        mkdirSync(runtimeDir, { recursive: true });
        writeFileSync(welcomeMarker, new Date().toISOString() + '\n', 'utf-8');
      } catch {
        // ignore marker write failure
      }
    }

    if (firstRunState.mode === 'observe') {
      lines.push(
        `[artibot:first-run-mode runs=${firstRunState.runsSoFar}/${threshold} — 자가 통제가 관찰 모드입니다. ${threshold}회 실행 후 자동 활성화됩니다.]`,
      );
    } else {
      lines.push('[artibot:active-mode] 자가 관리 엔진 활성 상태 (masterEnabled=true)');
    }
  } catch {
    // Non-critical
  }
}

/**
 * AGO Self-Control Wave 2: Emergency Kill Switch status. Appends a warning
 * line when the kill switch is tripped.
 * @param {string} pluginRoot
 * @param {object} config
 * @param {string[]} lines
 */
async function appendKillSwitchStatus(pluginRoot, config, lines) {
  try {
    const ksPath = path.join(pluginRoot, 'lib', 'learning', 'kill-switch.js');
    const { getKillSwitchState } = await import(toFileUrl(ksPath));
    const ksState = await getKillSwitchState(config);
    if (ksState.tripped) {
      lines.push(
        `[artibot:kill-switch-tripped — 연속 실패로 자가 통제가 일시 중지됐습니다. /artibot:reset-kill-switch로 재활성하세요.]`,
      );
    }
  } catch {
    // Non-critical
  }
}

/**
 * Surface the last vitest result on SessionStart. Best-effort: any failure
 * is silently swallowed so a missing/corrupt status file never blocks start.
 * Output goes to stderr (banner) AND the lines array (visible to the user).
 *
 * @param {string} pluginRoot
 * @param {string[]} lines
 */
function appendTestStatus(pluginRoot, lines) {
  try {
    const { warning } = getLastTestStatus(pluginRoot);
    if (warning) lines.push(warning);
  } catch {
    // Never block session start on test-status read errors
  }
}

/**
 * Non-blocking update notification — any error is swallowed. Wrapped with a
 * 2000ms outer timeout so the update check never consumes more than 2 seconds,
 * leaving ample headroom within the 5000ms hook limit. CRITICAL: the timer
 * MUST be cleared after Promise.race settles, otherwise the unreferenced
 * pending timer keeps Node's event loop alive for the full 2000ms.
 * @param {string} version
 * @param {string} home
 * @param {string[]} lines
 */
async function checkUpdateBounded(version, home, lines) {
  try {
    const cacheDir = path.join(home, '.claude', 'artibot');
    const updatePromise = checkForUpdate(version, cacheDir);
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('timeout')), 2000);
    });
    try {
      const updateInfo = await Promise.race([updatePromise, timeoutPromise]);
      if (updateInfo.hasUpdate) {
        lines.push(
          `\u2b06\ufe0f New version available: v${updateInfo.latestVersion} (current: v${version})`,
          `   Update: /artibot:update --force`
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch {
    // Never block session start on version-check failures
  }
}

/**
 * Phase 1 Quick Win: refresh skill hash cache if stale. Wrapped in try/catch
 * — must NEVER block session start. Only writes to stderr; stdout JSON
 * contract is preserved.
 * @param {string} pluginRoot
 */
async function primeSkillCache(pluginRoot) {
  try {
    const cacheModPath = path.join(pluginRoot, 'lib', 'core', 'skill-hash-cache.js');
    const { refreshIfStale } = await import(toFileUrl(cacheModPath));
    const cache = await refreshIfStale();
    if (cache && cache.skills) {
      const count = Object.keys(cache.skills).length;
      process.stderr.write(`[artibot] skill-hash cache: ${count} skills indexed\n`);
    }
  } catch (err) {
    process.stderr.write(`[artibot] skill-hash cache refresh skipped: ${err.message}\n`);
  }
}

/**
 * AD-23: First-of-day skill discovery inject. Calls the in-process helper
 * from skill-discovery-inject.js so the using-agent-skills meta-skill
 * appears in systemContext exactly once per local-day. Best-effort: any
 * failure is swallowed so session start never fails.
 * @param {string} pluginRoot
 * @param {string[]} lines
 */
async function maybeInjectSkillDiscovery(pluginRoot, lines) {
  try {
    const modPath = path.join(pluginRoot, 'scripts', 'hooks', 'skill-discovery-inject.js');
    const { maybeInject } = await import(toFileUrl(modPath));
    const injected = await maybeInject(pluginRoot);
    if (injected) {
      lines.push('[artibot:skill-discovery] using-agent-skills meta-skill surfaced (first session today).');
    }
  } catch {
    // Non-critical: discovery inject must never block session start
  }
}

/**
 * Swarm auto-detect: if this device has a swarm profile shipped with the
 * fork but isn't opted in yet, automatically activate it. Fire-and-forget
 * background spawn, stderr only.
 * @param {string} pluginRoot
 */
async function maybeSwarmAutodetect(pluginRoot) {
  try {
    const autodetectPath = path.join(pluginRoot, 'scripts', 'swarm-autodetect.js');
    const { existsSync: fsExists } = await import('node:fs');
    if (!fsExists(autodetectPath)) return;
    const { spawn } = await import('node:child_process');
    const proc = spawn(process.execPath, [autodetectPath, '--auto'], {
      cwd: pluginRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      detached: false,
      windowsHide: true,
    });
    proc.unref();
  } catch {
    // Never block session start on swarm autodetect failures
  }
}

async function main() {
  const raw = await readStdin();
  parseJSON(raw);

  if (!process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS) {
    process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS = '180000';
  }

  const env = detectEnvironment();
  const config = loadConfig();
  activateLongContext(config, env.pluginRoot);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const previousState = await loadPreviousState(env.pluginRoot, home);
  const sessionRecall = await recallSessionMemory(env.pluginRoot);
  const collectiveTop = await loadCollectiveTop(env.pluginRoot);

  const version = config.version || '1.0.0';
  const { teamMode, setupHint } = detectTeamMode(home);

  const lines = buildBannerLines({
    version, env, teamMode, setupHint, previousState, sessionRecall, collectiveTop,
  });

  await surfaceAdvisoryMessages(env.pluginRoot, config, lines);
  await maybeEmitFirstRunBanner(env.pluginRoot, config, lines);
  await appendKillSwitchStatus(env.pluginRoot, config, lines);
  appendTestStatus(env.pluginRoot, lines);
  await checkUpdateBounded(version, home, lines);
  await primeSkillCache(env.pluginRoot);
  await maybeInjectSkillDiscovery(env.pluginRoot, lines);
  await maybeSwarmAutodetect(env.pluginRoot);

  writeStdout({ message: lines.join('\n') });
}

main().catch(createErrorHandler('session-start', { exit: true }));
