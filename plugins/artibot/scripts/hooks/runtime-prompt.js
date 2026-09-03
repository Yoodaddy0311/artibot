#!/usr/bin/env node
/**
 * UserPromptSubmit hook - Runtime Prompt Bridge.
 * Replaces the old cognitive-router hook as the second-stage prompt enricher.
 *
 * Flow:
 *   1. user-prompt-handler.js may rewrite special triggers like !rv
 *   2. this hook reads that rewritten prompt via `extractUserPromptText` —
 *      `hookData.user_prompt` when the rewriter set it, else the host's own
 *      `hookData.prompt` (measured; see hook-utils.js)
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
import { createErrorHandler, extractUserPromptText } from '../../lib/core/hook-utils.js';
// T-50 #10 — `detectSlashCommand` used to be duplicated here, byte-identical to
// the L2 copy. That copy's own JSDoc explains the duplication as "an L2 module
// may not import" the hook layer — true, but the dependency runs the other way:
// this is a hook (L5), so importing L2 is downward and allowed. One definition
// now, so the two cannot drift apart.
//
// STATIC, not the dynamic `import(toFileUrl(...))` this file uses elsewhere. The
// dynamic form exists so a module resolves under the plugin root observed at
// call time; that matters for modules that read the root or its config. This one
// is a pure string function, and its whole dependency chain is two leaf modules
// with no imports of their own (`mission-id.js` → `contract.js`) and no
// top-level side effects, so there is nothing for a sandboxed root to change.
import { detectSlashCommand } from '../../lib/mission/mission-id.js';
import { isMainEntry } from './_main-entry.js';

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
 * @param {{ command: string, effort: string, baseline?: string, shift?: number, reason?: string } | null} meta
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

/**
 * Read the native effort band Claude Code (the host) may expose. PRODUCER half
 * of TODO (#30806). Precedence (native-effort.js#resolveNativeEffort):
 *   1) stdin `effort.level`  — ONLY present on tool-use hook events
 *      (PreToolUse|PostToolUse|Stop|SubagentStop), per hooks.md.
 *   2) `$CLAUDE_EFFORT` env  — inherited by every hook process; this is the
 *      operative source for runtime-prompt (a UserPromptSubmit hook, where the
 *      stdin effort field is absent).
 *   3) null → caller falls back to the heuristic (byte-identical, regression-0).
 *
 * LOCAL ONLY: reads process.env + the already-parsed stdin payload via
 * lib/cognitive/native-effort.js. No network, no external API. Any import
 * failure is swallowed and treated as "no signal".
 *
 * @param {string} pluginRoot
 * @param {object} [hookData] - Parsed hook stdin JSON (may carry `effort.level`).
 * @returns {Promise<'max'|'xhigh'|'high'|'medium'|'low'|null>}
 */
async function readNativeEffortBand(pluginRoot, hookData = {}) {
  try {
    const modPath = path.join(pluginRoot, 'lib', 'cognitive', 'native-effort.js');
    const { resolveNativeEffort } = await import(toFileUrl(modPath));
    return resolveNativeEffort({ payload: hookData, env: process.env });
  } catch {
    // Non-critical: absence of the producer module = no native signal.
    return null;
  }
}

/**
 * Notify the cognitive router of the current session-wide effort hint.
 * Only invoked when `runtime.effort.nativeApi` is enabled in config.
 * Swallows all errors — this is advisory-only wiring.
 *
 * @param {'max'|'xhigh'|'high'|'medium'|'low'|null} effortLevel
 * @param {string} pluginRoot
 * @returns {Promise<void>}
 */
async function applyNativeEffortHint(effortLevel, pluginRoot) {
  if (!effortLevel) return;
  try {
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { setNativeEffortHint } = await import(toFileUrl(routerPath));
    const NATIVE_API_FALLBACK = { max: 'high', xhigh: 'high', high: 'high', medium: 'medium', low: 'low' };
    const known = NATIVE_API_FALLBACK[effortLevel] ?? 'high';
    setNativeEffortHint({ effortLevel: known, band: effortLevel });
  } catch {
    // Non-critical: fall back to heuristic routing
  }
}

/**
 * Build the effort prefix directive injected at the top of the user prompt.
 * Output format:
 *   [artibot:effort level=xhigh command=implement]
 *
 * Returns empty string when effort metadata is missing.
 *
 * @param {{ command: string, effort: string } | null} meta
 * @returns {string}
 */
function buildEffortDirective(meta) {
  if (!meta || !meta.effort) return '';
  const command = meta.command ? ` command=${meta.command}` : '';
  return `[artibot:effort level=${meta.effort}${command}]`;
}

/**
 * Build the team directive injected when the unified workflow plan elects a
 * parallel runner. Mirrors the effort/budget prefix pattern so the spawn
 * signal reaches the model on the same leading line:
 *   [artibot:team runner=team teammates=N][artibot:effort level=X][artibot:task-budget max_tokens=Y]…
 *
 * One effort+budget pair is serialized per teammate from the SAME source as the
 * trigger decision (workflow-plan.js). Returns '' for non-team plans, an empty
 * teammates list, or a missing/invalid plan so non-team prompts are untouched.
 *
 * @param {object|null|undefined} workflowPlan - tasks.meta.workflowPlan
 * @returns {string}
 */
export function buildTeamDirective(workflowPlan) {
  if (!workflowPlan || workflowPlan.runner !== 'team') return '';
  const teammates = Array.isArray(workflowPlan.teammates) ? workflowPlan.teammates : [];
  if (teammates.length === 0) return '';
  const head = `[artibot:team runner=team teammates=${teammates.length}]`;
  const perTeammate = teammates
    .map((tm) => {
      const effort = tm?.effort ? `[artibot:effort level=${tm.effort}]` : '';
      const budget = typeof tm?.budget === 'number' && tm.budget > 0
        ? `[artibot:task-budget max_tokens=${tm.budget}]`
        : '';
      return `${effort}${budget}`;
    })
    .join('');
  return `${head}${perTeammate}`;
}

/**
 * Recommendation values this hook will render. Allowlist, not denylist: a
 * value the classifier starts emitting tomorrow does not reach the prompt
 * until someone adds it here AND writes its surfacing sentence
 * (`CLAUDE.md` "Recommend-hint surfacing rule"). Mirrors
 * `lib/cognitive/workflow-plan.js#deriveRecommendation` return values.
 */
export const RECOMMENDATION_HINTS = Object.freeze(['workflow', 'split', 'autopilot']);

/**
 * Build the ADVISORY recommendation directive injected when the unified
 * workflow plan elects to SUGGEST (but not auto-fire) a heavier runner.
 *
 * Mirrors buildTeamDirective's style. Output format:
 *   [artibot:hint recommend=workflow] | [artibot:hint recommend=split]
 *   | [artibot:hint recommend=autopilot]
 *
 * This is advisory ONLY — it surfaces workflowPlan.recommendation as text so the
 * model/user can choose to opt in. It must NEVER spawn or auto-fire anything:
 * the harness rule is that only inline|team auto-fire, while
 * workflow|split|autopilot require explicit user opt-in (`/split` opens N
 * human-attended windows — the model may only suggest it, never run it).
 * Returns '' when there is no plan, no recommendation, or a value outside
 * `RECOMMENDATION_HINTS`, so non-recommending prompts stay byte-identical.
 *
 * @param {object|null|undefined} workflowPlan - tasks.meta.workflowPlan
 * @returns {string}
 */
export function buildRecommendationDirective(workflowPlan) {
  const rec = workflowPlan?.recommendation;
  if (!rec || !RECOMMENDATION_HINTS.includes(rec)) return '';
  return `[artibot:hint recommend=${rec}]`;
}

/**
 * Detect a YouTube link in the user's prompt and surface an ADVISORY hint that
 * the `/watch` ingest command fits. Deterministic (regex) counterpart to the
 * probabilistic skill/description activation — the model still surfaces a
 * recommendation and waits for intent; this never auto-fires `/watch`.
 *
 * Matches youtube.com / *.youtube.com (www/m/music) watch·shorts·embed URLs and
 * youtu.be short links — the same host contract watch-ingest.js enforces; the
 * host boundary rejects spoofs like youtube.com.evil.com. A bare 11-char id is
 * NOT matched (too ambiguous for a front-door hint). On a hit, the first matched
 * URL rides along as `url=<URL>`. Returns '' when no link is present so
 * non-YouTube prompts stay byte-identical.
 *
 * @param {string} text - The user prompt text.
 * @returns {string} `[artibot:hint recommend=watch url=<URL>]` or ''.
 */
export function buildWatchDirective(text) {
  if (typeof text !== 'string' || !text) return '';
  const yt = /https?:\/\/(?:(?:www|m|music)\.)?youtube\.com\/(?:watch\?[\w=&%-]*\bv=|shorts\/|embed\/)[\w-]{11}|https?:\/\/youtu\.be\/[\w-]{11}/i;
  const hit = text.match(yt);
  return hit ? `[artibot:hint recommend=watch url=${hit[0]}]` : '';
}

/**
 * Prepend one or more artibot directives to the user prompt on a single
 * leading line, separated from the original prompt by a blank line.
 *
 * @param {string} basePrompt - Original (or already-prepared) user prompt.
 * @param {string[]} directives - Directive strings (empty entries are dropped).
 * @returns {string}
 */
function applyPromptPrefix(basePrompt, directives) {
  const valid = directives.filter((d) => typeof d === 'string' && d.length > 0);
  if (valid.length === 0) return basePrompt;
  const header = valid.join('');
  const body = String(basePrompt || '');
  return `${header}\n\n${body}`;
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
    runtime: {
      effort: {
        injectPrompt: true,
        nativeApi: false,
        budgetMap: {
          xhigh: 128000,
          high: 64000,
          medium: 32000,
          low: 16000,
        },
      },
      longContext: {
        enabled: false,
        betaHeader: 'context-1m-2025-08-01',
        activationThreshold: 180000,
      },
    },
  };

  try {
    const configPath = path.join(pluginRoot, 'artibot.config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      ...defaults,
      ...parsed,
      runtime: {
        ...defaults.runtime,
        ...(parsed.runtime || {}),
        effort: {
          ...defaults.runtime.effort,
          ...((parsed.runtime && parsed.runtime.effort) || {}),
        },
        longContext: {
          ...defaults.runtime.longContext,
          ...((parsed.runtime && parsed.runtime.longContext) || {}),
        },
      },
    };
  } catch (err) {
    process.stderr.write(
      `[runtime-prompt] config parse failed, using defaults: ${err?.message || err}\n`,
    );
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

/**
 * Build the minimal in-script fallback envelope used when the real runtime
 * module cannot be loaded (fresh checkouts, CI, upgrades). Classifies the
 * prompt into system1/system2 via keyword sniffing and attempts a lightweight
 * intent detection. All errors are swallowed.
 *
 * @param {string} prompt
 * @param {string} pluginRoot
 * @param {object} config
 * @returns {Promise<object>}
 */
async function buildFallbackEnvelope(prompt, pluginRoot, config) {
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
    context: { system, intentSummary, fallback: true },
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

  return buildFallbackEnvelope(prompt, pluginRoot, config);
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

/**
 * Derive Score-Aware effort signals from the prompt + hook payload.
 * Both inputs are best-effort: a missing context_window simply omits the
 * remainingContextRatio, and any router import failure yields an empty score.
 *
 * @param {string} prompt
 * @param {object} hookData - Parsed hook payload (may lack context_window).
 * @param {string} pluginRoot
 * @returns {Promise<{ score?: number, remainingContextRatio?: number }>}
 */
async function deriveEffortSignals(prompt, hookData, pluginRoot) {
  const signals = {};
  const cw = hookData?.context_window;
  if (cw && typeof cw.max_tokens === 'number' && cw.max_tokens > 0 && typeof cw.current_tokens === 'number') {
    signals.remainingContextRatio = Math.max(0, (cw.max_tokens - cw.current_tokens) / cw.max_tokens);
  }
  try {
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { classifyComplexity } = await import(toFileUrl(routerPath));
    const c = classifyComplexity(prompt);
    if (typeof c?.score === 'number') signals.score = c.score;
  } catch { /* heuristic-free fallback */ }
  return signals;
}

/**
 * Resolve a Score-Aware effort decision for a command. Falls back to the
 * baseline EFFORT_POLICY effort when the resolver import fails.
 *
 * @param {string} commandName
 * @param {object} signals
 * @param {string} pluginRoot
 * @returns {Promise<{ effort: string, baseline: string, shift: number, reason: string } | null>}
 */
async function resolveScoredEffort(commandName, signals, pluginRoot) {
  try {
    const routerPath = path.join(pluginRoot, 'lib', 'cognitive', 'router.js');
    const { resolveEffort } = await import(toFileUrl(routerPath));
    return resolveEffort(commandName, signals);
  } catch {
    const effort = await resolveCommandEffort(commandName, pluginRoot);
    return effort ? { effort, baseline: effort, shift: 0, reason: 'baseline' } : null;
  }
}

/**
 * Resolve the effort metadata for a prompt. Persists the result to
 * runtime/current-effort.json and returns
 * `{ command, effort, baseline, shift, reason } | null`.
 *
 * Native-signal priority (TODO #30806): when Claude Code exposes a native
 * effort band via a local env var, it OVERRIDES the heuristic-resolved band
 * before the result is persisted to runtime/current-effort.json. Because hooks
 * run in isolated processes, the in-memory router setter does not propagate
 * across hook invocations — so the file write is where cross-process priority
 * must be applied. When no native signal is present the heuristic result is
 * passed through unchanged (regression-zero).
 *
 * @param {string} prompt
 * @param {string} pluginRoot
 * @param {object} [hookData] - Hook payload used to derive Score-Aware signals.
 * @returns {Promise<{ command: string, effort: string, baseline: string, shift: number, reason: string } | null>}
 */
async function resolveEffortMeta(prompt, pluginRoot, hookData = {}) {
  const commandName = detectSlashCommand(prompt);
  if (!commandName) {
    persistEffortMeta(null, pluginRoot);
    return null;
  }
  const signals = await deriveEffortSignals(prompt, hookData, pluginRoot);
  const resolved = await resolveScoredEffort(commandName, signals, pluginRoot);
  let effortMeta = resolved
    ? {
      command: commandName,
      effort: resolved.effort,
      baseline: resolved.baseline,
      shift: resolved.shift,
      reason: resolved.reason,
    }
    : null;

  // Native effort signal (if any) wins over the heuristic band. Absent/empty/
  // unrecognized → readNativeEffortBand() returns null → heuristic untouched.
  if (effortMeta) {
    const nativeBand = await readNativeEffortBand(pluginRoot, hookData);
    if (nativeBand) {
      effortMeta = { ...effortMeta, effort: nativeBand, reason: 'native-effort' };
    }
  }

  persistEffortMeta(effortMeta, pluginRoot);
  return effortMeta;
}

/**
 * AGO G3 — record effort classification for Explainability (observe-only).
 * Wrapped in try/catch so Decision Trail failures never break the prompt.
 * @param {{ command: string, effort: string } | null} effortMeta
 * @param {string} pluginRoot
 */
async function recordEffortDecision(effortMeta, pluginRoot) {
  if (!effortMeta) return;
  try {
    const trailPath = path.join(pluginRoot, 'lib', 'core', 'decision-trail.js');
    const { recordDecision } = await import(toFileUrl(trailPath));
    await recordDecision({
      subsystem: 'runtime-prompt',
      action: 'effort-classified',
      reason: `slash command '/${effortMeta.command}' matched EFFORT_POLICY`,
      inputs: { command: effortMeta.command },
      outputs: { effort: effortMeta.effort },
    });
  } catch {
    // Non-critical: decision trail is advisory
  }
}

/**
 * T-37 — OBSERVE-ONLY records go to `<projectRoot>/.artibot/runtime/decisions/`,
 * NOT the central ledger: that writer refuses both named events from a `hook`
 * source and writes a `ledger.rejected` line instead of passing silently. The
 * measurement, the allowlist reasoning, the receipt-schema conflict, the store
 * location and the parser `measureMemoryInjection` all live at the destination
 * (`lib/observability/decision-events.js`); only the call sites remain here,
 * because keeping the parser put this file over the 800-line standard. Tripwire:
 * `tests/hooks/runtime-prompt-memory-instrumentation.test.js`.
 */

/**
 * Load a lib module under the plugin root observed NOW. Dynamic like every
 * other lib import here, so a sandboxed root resolves to that sandbox.
 * @param {string} pluginRoot
 * @param {...string} segments
 * @returns {Promise<object>}
 */
function loadLibModule(pluginRoot, ...segments) {
  return import(toFileUrl(path.join(pluginRoot, 'lib', ...segments)));
}

/**
 * T-37 — record the topology sighting, then the memory measurement. OBSERVE
 * ONLY: `routeTopology` selects nothing and both results are discarded here.
 *
 * `evidence.promptText` is supplied because T-36 measured that the router's
 * natural-language activation is dead without it: `detectIntent` carries no
 * source text, and the router reads the prompt only through this port. The text
 * stays IN MEMORY — `topology-router.js#firstMatch` returns the `pattern.id` of
 * a fixed table (`#FAST_PATTERNS` / `#SPLIT_PATTERNS`), never the matched text,
 * so no prompt text reaches disk.
 *
 * One try/catch covers all three — each is advisory and must leave the hook's
 * already-computed output untouched.
 *
 * @param {{prompt: string, prepared: object, runtimeConfig: object,
 *   hookData: object, pluginRoot: string}} params
 * @returns {Promise<void>}
 */
async function recordObserveOnlyDecisions({
  prompt, prepared, runtimeConfig, hookData, pluginRoot,
}) {
  try {
    const { routeTopology } = await loadLibModule(pluginRoot, 'topology', 'topology-router.js');
    const {
      flushRecorderStats, measureMemoryInjection, recordMemoryInjection,
      recordTopologyRecommended, resolveDecisionRunId,
    } = await loadLibModule(pluginRoot, 'observability', 'decision-events.js');

    const runId = resolveDecisionRunId({ hookData });
    // One raw `cwd` for all four writers; the recorder resolves the store from it.
    const store = { cwd: hookData?.cwd };
    recordTopologyRecommended(runId, routeTopology({
      intent: prepared?.context?.intent,
      workflowPlan: prepared?.context?.tasks?.meta?.workflowPlan,
      config: runtimeConfig,
      evidence: { promptText: typeof prompt === 'string' ? prompt : undefined },
    }), store);
    recordMemoryInjection(runId, measureMemoryInjection(prepared), store);

    // LAST: this per-prompt process dies with its counters, and every recorder
    // call has happened by now (two in preparePrompt, two above). No-op if clean.
    flushRecorderStats(runId, store);
  } catch {
    // Observe-only: these records must never affect the hook's output.
  }
}

/**
 * P3-8: record user signal for skill-level auto-detection + G10 macro
 * observation. Both are non-critical and observe-only.
 *
 * @param {string} prompt
 * @param {string|null} commandName
 * @param {string} pluginRoot
 * @param {object} runtimeConfig
 */
async function recordPromptSignals(prompt, commandName, pluginRoot, runtimeConfig) {
  try {
    const profileModPath = path.join(pluginRoot, 'lib', 'core', 'user-profile.js');
    const { recordSignal, configureProfilePath } = await import(toFileUrl(profileModPath));
    const uxProfilePath = runtimeConfig?.ux?.profilePath;
    if (uxProfilePath) configureProfilePath(uxProfilePath);
    await recordSignal({
      type: commandName ? 'slash-command' : 'natural-language',
      value: commandName || String(prompt).slice(0, 60),
      timestamp: Date.now(),
    });
  } catch {
    // Non-critical: profile tracking is advisory
  }

  try {
    const macroPath = path.join(pluginRoot, 'lib', 'learning', 'macro-learner.js');
    const { observePrompt } = await import(toFileUrl(macroPath));
    await observePrompt(prompt, { pluginRoot, config: runtimeConfig });
  } catch {
    // Non-critical: macro learning is advisory
  }
}

/**
 * Task Budget auto-wire (P3-2): derive max_tokens per effort and persist
 * runtime/current-task-budget.json + build the [artibot:task-budget …]
 * directive that is injected alongside the effort prefix.
 *
 * @param {{ command: string, effort: string } | null} effortMeta
 * @param {string} pluginRoot
 * @param {object} runtimeConfig
 * @returns {Promise<string>}
 */
async function resolveTaskBudgetDirective(effortMeta, pluginRoot, runtimeConfig) {
  if (!effortMeta) return '';
  try {
    const tbPath = path.join(pluginRoot, 'lib', 'runtime', 'task-budget.js');
    const {
      getTaskBudgetForEffort,
      buildTaskBudgetDirective,
      persistTaskBudget,
    } = await import(toFileUrl(tbPath));

    const budget = getTaskBudgetForEffort(effortMeta.effort, runtimeConfig);
    if (!budget) return '';
    const directive = buildTaskBudgetDirective(effortMeta.effort, budget, runtimeConfig);
    persistTaskBudget(
      { command: effortMeta.command, effort: effortMeta.effort, budget },
      pluginRoot,
    );
    return directive;
  } catch {
    // Non-critical: task budget is advisory
    return '';
  }
}

/**
 * Compose the final user prompt and hook message. When `injectPrompt` is
 * disabled we return the base prompt untouched.
 *
 * @param {object} params
 * @returns {{ user_prompt: string, message: string }}
 */
export function composePromptOutput({ prepared, prompt, effortMeta, taskBudgetDirective, injectPrompt }) {
  const basePrompt = prepared.userPrompt ?? prompt;
  const effortDirective = buildEffortDirective(effortMeta);
  // P2: the pipeline's tasks middleware derives a unified workflow plan
  // (team trigger + per-teammate effort/budget). When it elects a parallel
  // runner, surface the team directive on the same leading line so the spawn
  // signal actually reaches the model — without this the plan was built then
  // discarded ("parallel-not-spawned" symptom).
  const teamDirective = buildTeamDirective(prepared.context?.tasks?.meta?.workflowPlan);
  // P3: surface an ADVISORY runner recommendation (workflow|split|autopilot) at
  // the front door. Same source as buildTeamDirective. This only adds text so the
  // user/model can opt in — it never auto-fires (honors the harness opt-in rule).
  const recommendationDirective = buildRecommendationDirective(prepared.context?.tasks?.meta?.workflowPlan);
  // P4: deterministic front-door hint — a YouTube link in the prompt suggests the
  // /watch ingest command. Advisory only (the model surfaces it and waits); never
  // auto-fires. Built from the user text, so it's '' for non-YouTube prompts.
  const watchDirective = buildWatchDirective(basePrompt);
  const finalUserPrompt = injectPrompt
    ? applyPromptPrefix(basePrompt, [teamDirective, effortDirective, taskBudgetDirective, recommendationDirective, watchDirective])
    : basePrompt;

  const baseMessage = prepared.message ?? '[runtime] prompt prepared';
  const finalMessage = effortMeta
    ? `${baseMessage} | cmd=/${effortMeta.command} effort=${effortMeta.effort}`
    : baseMessage;

  return { user_prompt: finalUserPrompt, message: finalMessage };
}

/**
 * Pure handler for UserPromptSubmit. Used by the in-process dispatcher
 * (named export) and the legacy stdin/stdout main() entry point.
 *
 * @param {object} hookData - Parsed hook payload (already JSON-decoded).
 * @returns {Promise<{ user_prompt: string, message: string } | null>}
 *   - object when a runtime envelope was prepared
 *   - null when no prompt was present
 */
export async function handleUserPromptSubmit(hookData) {
  const prompt = extractUserPromptText(hookData);
  if (!prompt) return null;

  const pluginRoot = getPluginRoot();
  const runtimeConfig = loadRuntimeConfig(pluginRoot);
  const effortConfig = runtimeConfig?.runtime?.effort || {};
  const injectPrompt = effortConfig.injectPrompt !== false; // default true
  const useNativeApi = effortConfig.nativeApi === true;     // default false

  // Resolve + persist effort BEFORE preparing the prompt: the runtime pipeline's
  // tasks middleware reads runtime/current-effort.json to attach effort meta and
  // build the workflow plan. If preparePrompt ran first it would read the PRIOR
  // prompt's effort file (stale off-by-one), so the write must precede the read.
  const effortMeta = await resolveEffortMeta(prompt, pluginRoot, hookData);
  await recordEffortDecision(effortMeta, pluginRoot);
  await recordPromptSignals(prompt, effortMeta?.command || null, pluginRoot, runtimeConfig);

  const taskBudgetDirective = await resolveTaskBudgetDirective(effortMeta, pluginRoot, runtimeConfig);

  const prepared = await fallbackPreparePrompt(prompt, pluginRoot, hookData);
  if (!prepared) return null;

  persistTokenUsage(prepared.context, pluginRoot);

  if (useNativeApi && effortMeta) {
    // Prefer a real native signal (stdin effort.level > $CLAUDE_EFFORT) over the
    // heuristic band for the in-process router hint. readNativeEffortBand()
    // returns null when no signal is present, so this falls back to the
    // heuristic-resolved effort (regression-zero).
    const nativeBand = await readNativeEffortBand(pluginRoot, hookData);
    await applyNativeEffortHint(nativeBand ?? effortMeta.effort, pluginRoot);
  }

  const output = composePromptOutput({
    prepared, prompt, effortMeta, taskBudgetDirective, injectPrompt,
  });

  // T-37 — observe-only records, placed AFTER `output` is already final. The
  // position is the guarantee: the call does not receive `output` and cannot
  // reach it, so byte-identical stdout is structural rather than a promise.
  await recordObserveOnlyDecisions({
    prompt, prepared, runtimeConfig, hookData, pluginRoot,
  });

  return output;
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  const result = await handleUserPromptSubmit(hookData ?? {});
  if (result) writeStdout(result);
}

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('runtime-prompt'));
}
