#!/usr/bin/env node
/**
 * SessionStart hook.
 * Detects environment, loads config, restores previous session state.
 * Outputs a welcome message to stdout.
 */

import { getPluginRoot, parseJSON, readStdin, resolveConfigPath, toFileUrl, writeStdout } from '../utils/index.js';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkForUpdate } from '../../lib/core/version-checker.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { getLastTestStatus } from '../../lib/core/test-status.js';
import {
  countWipCommits,
  formatAdvisoryLine as formatWipAdvisory,
  getOldestWipAgeMs,
  resolveThresholdsFromEnv,
} from '../../lib/autopilot/wip-stats.js';
import { fileURLToPath } from 'node:url';

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
 * v4.8.0 P1 (Task #12): surface accumulated WIP commits so the user can run
 * `/squash` before pushing. Mirrors the appendTestStatus pattern — fully
 * defensive: any git/IO failure resolves silently so SessionStart is never
 * blocked. Threshold defaults: 10 commits OR oldest >= 4h; both overridable
 * via ARTIBOT_WIP_COUNT_THRESHOLD / ARTIBOT_WIP_AGE_HOURS env vars.
 *
 * @param {string[]} lines
 */
function appendWipAdvisory(lines) {
  try {
    const count = countWipCommits('HEAD');
    if (count <= 0) return;
    const ageMs = getOldestWipAgeMs('HEAD');
    const thresholds = resolveThresholdsFromEnv();
    const advisory = formatWipAdvisory(count, ageMs, thresholds);
    if (advisory) lines.push(advisory);
  } catch {
    // Never block session start on git errors or missing repo.
  }
}

// Max bytes to read from .artibot/HANDOFF.md when extracting banner fields.
// Real handoffs are 4-16 KB; cap defensively so a corrupt/huge file never
// blows session-start latency budget.
const HANDOFF_HEAD_READ_BYTES = 32 * 1024;

// Hard ceiling for banner extraction (read + regex). The /save flow runs at
// session END, so a banner read at session START should never collide with
// an in-flight writer — but the 800ms guard absorbs any FS hiccup and stays
// well within the 5s hook budget shared with the rest of session-start.
const HANDOFF_BANNER_TIMEOUT_MS = 800;

/**
 * Read the first N bytes of a file synchronously. Returns '' on any failure
 * — never throws, since this runs inside the non-blocking banner path.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string}
 */
function readHeadSync(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Parse the head of a HANDOFF.md to extract the three banner fields:
 *   - next P0 line (## 4. 다음 P0 → first non-empty body line)
 *   - unresolved count (## 5. 미해결 결정/질문 → count bullet items)
 *   - WIP/uncommitted count (## 1. 지금 상태 → "변경 파일: N" or "WIP: N")
 *
 * Pure function (exported for unit testing); regex-driven, no I/O.
 * @param {string} head
 * @returns {{ p0: string|null, unresolved: number, wip: number }}
 */
export function parseHandoffBannerFields(head) {
  if (typeof head !== 'string' || head.length === 0) {
    return { p0: null, unresolved: 0, wip: 0 };
  }

  // v4.13.0 Safety #2: handoff markdown now starts with a YAML frontmatter
  // block (`---\n…\n---\n`). Strip it before scanning so the `## N.` section
  // regex never accidentally matches a frontmatter key/value. Frontmatter is
  // optional — older handoffs without it remain parseable.
  let body = head;
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    // Match closing fence on its own line. Cap the search to the first 8 KB
    // of input so a malformed handoff (no closing fence) cannot stall the
    // regex engine.
    const fenceRe = /\r?\n---\s*(?:\r?\n|$)/;
    const slice = body.slice(0, 8192);
    const close = slice.search(fenceRe);
    if (close >= 0) {
      const m = slice.slice(close).match(fenceRe);
      if (m) body = body.slice(close + m[0].length);
    }
  }

  // Section delimiter: a heading starting with `## ` at line start. Capture
  // body until the next `## ` heading or end of slice.
  function sliceSection(re) {
    const m = body.match(re);
    if (!m) return '';
    const start = m.index + m[0].length;
    const rest = body.slice(start);
    const nextHeading = rest.match(/^##\s+/m);
    return nextHeading ? rest.slice(0, nextHeading.index) : rest;
  }

  // Next P0: prefer the top-of-document `> 다음 …` summary line written by
  // handoff-builder.renderHandoffMarkdown(); fall back to first non-empty
  // line under `## 4. 즉시 진행할 일` / `## 4. 다음 P0` / `## 4. Next P0`.
  let p0 = null;
  const summaryMatch = body.match(/^>\s*(다음\s+P\d+\s*:.*|Next\s+P\d+\s*:.*)$/m);
  if (summaryMatch) {
    p0 = summaryMatch[1].trim().slice(0, 160);
  }
  if (!p0) {
    const p0Section = sliceSection(/^##\s+4\.[^\n]*?(?:즉시\s*진행|다음\s*P0|Next\s*P0|Immediate)[^\n]*$/im);
    if (p0Section) {
      const firstLine = p0Section
        .split(/\r?\n/)
        .map((l) => l.replace(/^[\s>*\-|]+/, '').trim())
        .find((l) => l.length > 0 && !l.startsWith('우선순위') && !l.startsWith('---'));
      if (firstLine) p0 = firstLine.slice(0, 160);
    }
  }

  // Unresolved count: bullet items under `## 5. 미해결`. Count lines starting with - or * (after trim).
  let unresolved = 0;
  const unresolvedSection = sliceSection(/^##\s+5\.[^\n]*?(?:미해결|Unresolved)[^\n]*$/im);
  if (unresolvedSection) {
    unresolved = unresolvedSection
      .split(/\r?\n/)
      .filter((l) => /^\s*[-*]\s+\S/.test(l))
      .length;
  }

  // WIP / uncommitted: look in `## 1. 지금 상태` for "WIP: N" or "변경 파일: N" or "Uncommitted: N".
  let wip = 0;
  const statusSection = sliceSection(/^##\s+1\.[^\n]*?(?:지금\s*상태|Now|Status)[^\n]*$/im);
  if (statusSection) {
    const wipMatch = statusSection.match(/(?:WIP|변경\s*파일|Uncommitted|미커밋)\D*?(\d+)/i);
    if (wipMatch) wip = Math.max(0, Number.parseInt(wipMatch[1], 10) || 0);
  }

  return { p0, unresolved, wip };
}

/**
 * Append `[artibot:handoff] …` banner line when `.artibot/HANDOFF.md` exists
 * AND was not written during this process (mtime < startTimeMs). Reads only
 * the first 32 KB to defend against unbounded files; 800ms outer timeout.
 *
 * Returns true if a banner line was pushed (so the caller can suppress the
 * duplicate `[artibot:pending-suggestions count=N]` line — those signals are
 * already absorbed into the handoff).
 *
 * @param {string[]} lines
 * @param {object} [options]
 * @param {number} [options.startTimeMs] - Reference start time (Date.now()).
 * @returns {Promise<boolean>}
 */
async function appendHandoffBanner(lines, { startTimeMs = Date.now() } = {}) {
  // Use Promise.race so a slow disk never stalls session-start. The inner
  // work is fully sync; we wrap it in a microtask to participate in race.
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), HANDOFF_BANNER_TIMEOUT_MS);
  });

  const workPromise = (async () => {
    try {
      const handoffPath = path.join(process.cwd(), '.artibot', 'HANDOFF.md');
      if (!existsSync(handoffPath)) return false;

      // Skip when the file was just written by THIS process (avoid noise on
      // a /save -> immediately /resume cycle inside the same session).
      let stat;
      try { stat = statSync(handoffPath); } catch { return false; }
      if (stat.mtimeMs >= startTimeMs) return false;
      if (stat.size === 0) return false;

      const head = readHeadSync(handoffPath, HANDOFF_HEAD_READ_BYTES);
      const { p0, unresolved, wip } = parseHandoffBannerFields(head);

      // Compute age string for context (∞ never possible — we already
      // checked mtime, but guard against system-clock skew).
      const ageMs = Math.max(0, startTimeMs - stat.mtimeMs);
      const ageStr = ageMs < 60_000
        ? `${Math.round(ageMs / 1000)}s ago`
        : ageMs < 3_600_000
          ? `${Math.round(ageMs / 60_000)}m ago`
          : `${Math.round(ageMs / 3_600_000)}h ago`;

      const p0Display = p0 ?? '(미정 — /resume 으로 확인)';
      lines.push(
        `[artibot:handoff] Next P0: ${p0Display} · 미해결 ${unresolved} · 미커밋 ${wip} · saved ${ageStr} — /resume 으로 전체 보기`,
      );
      return true;
    } catch {
      return false;
    }
  })();

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
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
          `   Update: /update --force`
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

// Captured once at module evaluation. Used by appendHandoffBanner to detect
// "freshly written this session" handoffs (mtime >= SESSION_START_MS) and
// to compute a human-readable "saved Nh ago" suffix in the banner.
const SESSION_START_MS = Date.now();

export async function main() {
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
  appendWipAdvisory(lines);

  // /save handoff banner: surfaces a single one-line summary of the previous
  // session's /save snapshot. When present, the older `[artibot:pending-suggestions count=N]`
  // line is suppressed — those advisor signals have already been absorbed
  // into the handoff (marked `consumed: true` by `/save`'s markConsumed call),
  // and re-surfacing the count would be misleading double-counting.
  const handoffPushed = await appendHandoffBanner(lines, { startTimeMs: SESSION_START_MS });
  if (handoffPushed) {
    for (let i = lines.length - 2; i >= 0; i -= 1) {
      if (typeof lines[i] === 'string' && lines[i].startsWith('[artibot:pending-suggestions')) {
        lines.splice(i, 1);
        break;
      }
    }
  }

  await checkUpdateBounded(version, home, lines);
  await primeSkillCache(env.pluginRoot);
  await maybeInjectSkillDiscovery(env.pluginRoot, lines);
  await maybeSwarmAutodetect(env.pluginRoot);

  writeStdout({ message: lines.join('\n') });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler('session-start', { exit: true }));
}
