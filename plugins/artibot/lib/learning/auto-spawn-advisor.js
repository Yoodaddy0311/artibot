/**
 * Auto-Spawn Advisor (AGO Track G6).
 *
 * Detects "unresolved" / "needs-follow-up" signals at session end and writes
 * next-session suggestions to `runtime/next-session-suggestions.json`.
 *
 * Key safety constraints (enforced here and by artibot.config.json):
 *   - Default ON (Wave 2): `ago.autoSpawn.enabled` defaults to true.
 *     Users can disable globally via `ago.selfControl.masterEnabled=false`
 *     or per-feature via `ago.autoSpawn.enabled=false`.
 *   - Kill-switch integration: a tripped kill-switch hard-blocks writes.
 *   - max recursion depth ({@link DEFAULT_MAX_DEPTH}) caps wakeup chains
 *   - each suggestion is inert: `requiresApproval: true`, never auto-executed
 *   - NEVER calls ScheduleWakeup or any spawn API — write-only
 *
 * Because this module is observation/suggestion-only, it also runs during
 * first-run observe mode — the marker file is informational and carries no
 * execution risk.
 *
 * Detection signals (all optional, graceful on missing files):
 *   - Unresolved TODOs (session transcript markers)
 *   - Test regressions (scripts/validate.js last run output)
 *   - Alignment drift warnings (drift-detector state dump)
 *   - Incomplete auto-learning cycles (learning-log.json)
 *   - Stale skills (skill-freshness scan)
 *
 * Zero runtime deps, ESM, Node >=18.
 *
 * @module lib/learning/auto-spawn-advisor
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const SUGGESTIONS_RELATIVE_PATH = path.join('runtime', 'next-session-suggestions.json');

const VALID_CATEGORIES = new Set([
  'test-regression',
  'drift',
  'skill-stale',
  'learning-incomplete',
  'unresolved-todo',
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Read config.ago.autoSpawn with defaults, coercing missing fields.
 *
 * Wave-2 policy: `enabled` defaults to `true` and `requireOptIn` defaults to
 * `false` so auto-spawn observation runs by default. Callers still honour
 * explicit user overrides (false stays false).
 *
 * @param {object|null|undefined} config
 * @returns {{masterEnabled: boolean, enabled: boolean, maxDepth: number, minConfidence: number, requireOptIn: boolean}}
 */
export function resolveAutoSpawnConfig(config) {
  const raw = config?.ago?.autoSpawn ?? {};
  const masterRaw = config?.ago?.selfControl?.masterEnabled;
  return {
    masterEnabled: masterRaw !== false,
    enabled: raw.enabled !== false,
    maxDepth: Number.isFinite(raw.maxDepth) ? raw.maxDepth : DEFAULT_MAX_DEPTH,
    minConfidence: Number.isFinite(raw.minConfidence) ? raw.minConfidence : DEFAULT_MIN_CONFIDENCE,
    requireOptIn: raw.requireOptIn === true,
  };
}

/**
 * Build a stable suggestion id.
 * @param {number} seq
 * @returns {string}
 */
function makeSuggestionId(seq) {
  const rand = crypto.randomBytes(3).toString('hex');
  return `sug-${Date.now()}-${seq}-${rand}`;
}

/**
 * Normalize a candidate signal into a Suggestion, or null if invalid.
 * Pure — no I/O.
 *
 * @param {object} signal
 * @param {{minConfidence: number, maxDepth: number, seq: number}} ctx
 * @returns {object|null}
 */
export function buildSuggestion(signal, ctx) {
  if (!signal || typeof signal !== 'object') return null;
  if (!VALID_CATEGORIES.has(signal.category)) return null;

  const confidence = Number.isFinite(signal.confidence) ? signal.confidence : 0;
  if (confidence < ctx.minConfidence) return null;

  const depth = Number.isFinite(signal.depth) ? signal.depth : 0;
  if (depth > ctx.maxDepth) return null;

  const built = {
    id: makeSuggestionId(ctx.seq),
    createdAt: new Date().toISOString(),
    reason: String(signal.reason ?? '').slice(0, 500),
    category: signal.category,
    confidence: Math.min(1, Math.max(0, confidence)),
    suggestedAction: String(signal.suggestedAction ?? '').slice(0, 200),
    requiresApproval: true,
    depth,
    resolved: false,
  };

  // Preserve passthrough consumed-state fields when the caller re-builds an
  // existing suggestion (e.g., during a rewrite). `/save` writes these
  // markers so the suggestion is hidden from `readPendingSuggestions` without
  // mutating its `resolved` semantics — the two flags are orthogonal.
  if (signal.consumed === true) built.consumed = true;
  if (typeof signal.consumedAt === 'string') built.consumedAt = signal.consumedAt;
  if (typeof signal.consumedBy === 'string') built.consumedBy = signal.consumedBy;

  return built;
}

// ---------------------------------------------------------------------------
// Signal collection (each is best-effort; returns [] on any failure)
// ---------------------------------------------------------------------------

/**
 * Collect unresolved pending-item signals from session summary transcript markers.
 * @param {object} sessionSummary
 * @returns {Array<object>}
 */
function collectTodoSignals(sessionSummary) {
  const items = Array.isArray(sessionSummary?.unresolvedTodos) ? sessionSummary.unresolvedTodos : [];
  return items.slice(0, 10).map((item) => ({
    category: 'unresolved-todo',
    reason: `Pending item: ${String(item?.text ?? item).slice(0, 200)}`,
    confidence: Number.isFinite(item?.confidence) ? item.confidence : 0.85,
    suggestedAction: 'Review and resolve pending items before continuing related work',
    depth: 0,
  }));
}

/**
 * Collect test-regression signals.
 * @param {object} sessionSummary
 * @returns {Array<object>}
 */
function collectTestRegressions(sessionSummary) {
  const failures = sessionSummary?.testFailures;
  if (!Array.isArray(failures) || failures.length === 0) return [];
  return [{
    category: 'test-regression',
    reason: `${failures.length} test(s) failing at session end: ${failures.slice(0, 3).map((f) => f?.name ?? f).join(', ')}`,
    confidence: 0.95,
    suggestedAction: 'Run `npx vitest run` and address failing tests',
    depth: 0,
  }];
}

/**
 * Collect drift-warning signals.
 * @param {object} sessionSummary
 * @returns {Array<object>}
 */
function collectDriftSignals(sessionSummary) {
  const drift = sessionSummary?.driftWarnings;
  if (!Array.isArray(drift) || drift.length === 0) return [];
  return drift.slice(0, 5).map((warn) => ({
    category: 'drift',
    reason: `Alignment drift on ${warn?.agent ?? 'agent'}: avg ${warn?.avg ?? '?'} (threshold ${warn?.threshold ?? '?'})`,
    confidence: Number.isFinite(warn?.confidence) ? warn.confidence : 0.85,
    suggestedAction: `Investigate ${warn?.agent ?? 'agent'} behavior and recalibrate`,
    depth: 0,
  }));
}

/**
 * Collect skill-staleness signals.
 * @param {object} sessionSummary
 * @returns {Array<object>}
 */
function collectSkillStaleSignals(sessionSummary) {
  const stale = sessionSummary?.staleSkills;
  if (!Array.isArray(stale) || stale.length === 0) return [];
  return [{
    category: 'skill-stale',
    reason: `${stale.length} stale skill(s): ${stale.slice(0, 3).join(', ')}`,
    confidence: 0.82,
    suggestedAction: 'Refresh skill verification dates or update stale skills',
    depth: 0,
  }];
}

/**
 * Collect incomplete auto-learning cycle signals.
 * @param {object} sessionSummary
 * @returns {Array<object>}
 */
function collectLearningIncomplete(sessionSummary) {
  const incomplete = sessionSummary?.learningIncomplete;
  if (!incomplete) return [];
  return [{
    category: 'learning-incomplete',
    reason: `Auto-learning cycle incomplete: ${incomplete.stage ?? 'unknown'} — ${incomplete.reason ?? 'no detail'}`,
    confidence: Number.isFinite(incomplete.confidence) ? incomplete.confidence : 0.8,
    suggestedAction: 'Re-run learning pipeline to finish incomplete stage',
    depth: 0,
  }];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze current session state and write suggestions to disk.
 * Does NOT execute or schedule anything.
 *
 * @param {object} sessionSummary - Aggregated signals (see collect* helpers).
 * @param {object} options
 * @param {string} options.pluginRoot - Absolute path to plugin root.
 * @param {object} [options.config]   - Parsed artibot.config.json.
 * @returns {Promise<{suggestions: object[], written: boolean, reason?: string}>}
 */
export async function analyzeNextSession(sessionSummary, options) {
  const { pluginRoot, config } = options ?? {};
  if (!pluginRoot) {
    return { suggestions: [], written: false, reason: 'missing-pluginRoot' };
  }

  const cfg = resolveAutoSpawnConfig(config);

  // Master user opt-out always wins.
  if (!cfg.masterEnabled) {
    return { suggestions: [], written: false, reason: 'master-disabled' };
  }

  // Per-feature opt-out.
  if (!cfg.enabled) {
    return { suggestions: [], written: false, reason: 'feature-disabled' };
  }

  // Legacy strict opt-in path (callers may still set requireOptIn=true).
  if (cfg.requireOptIn && !(config?.ago?.autoSpawn?.enabled === true)) {
    return { suggestions: [], written: false, reason: 'opt-in-required' };
  }

  // Kill-switch hard-block (graceful import; never throws if module missing).
  try {
    const ks = await import('./kill-switch.js');
    if (await ks.isKillSwitchTripped(config, { feature: 'auto-spawn', pluginRoot })) {
      return { suggestions: [], written: false, reason: 'kill-switch-tripped' };
    }
  } catch {
    // Best-effort: missing kill-switch module must not break the advisor.
  }

  const summary = sessionSummary ?? {};
  const rawSignals = [
    ...collectTestRegressions(summary),
    ...collectDriftSignals(summary),
    ...collectSkillStaleSignals(summary),
    ...collectLearningIncomplete(summary),
    ...collectTodoSignals(summary),
  ];

  const suggestions = [];
  let seq = 0;
  for (const signal of rawSignals) {
    const built = buildSuggestion(signal, {
      minConfidence: cfg.minConfidence,
      maxDepth: cfg.maxDepth,
      seq: seq++,
    });
    if (built) suggestions.push(built);
  }

  if (suggestions.length === 0) {
    return { suggestions: [], written: false, reason: 'no-signals' };
  }

  const targetPath = path.join(pluginRoot, SUGGESTIONS_RELATIVE_PATH);
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      count: suggestions.length,
      suggestions,
    };
    await writeFile(targetPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return { suggestions, written: true };
  } catch (err) {
    return { suggestions, written: false, reason: `write-failed: ${err?.message ?? err}` };
  }
}

/**
 * Read pending (unresolved) suggestions from previous session.
 *
 * @param {string} pluginRoot
 * @returns {Promise<object[]>}
 */
export async function readPendingSuggestions(pluginRoot) {
  if (!pluginRoot) return [];
  const targetPath = path.join(pluginRoot, SUGGESTIONS_RELATIVE_PATH);
  try {
    const raw = await readFile(targetPath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    // Hide both user-resolved AND `/save`-consumed suggestions. The two flags
    // are independent: `resolved` records explicit user action, `consumed`
    // records absorption by a handoff snapshot (so the suggestion will not
    // be re-surfaced as a session-start banner).
    return list.filter((s) => s && s.resolved !== true && s.consumed !== true);
  } catch {
    return [];
  }
}

/**
 * Mark a suggestion resolved (user explicit action).
 * No-op if file missing or id unknown. Preserves `resolved: true` across rewrites.
 *
 * @param {string} pluginRoot
 * @param {string} suggestionId
 * @returns {Promise<{resolved: boolean}>}
 */
export async function resolveSuggestion(pluginRoot, suggestionId) {
  if (!pluginRoot || !suggestionId) return { resolved: false };
  const targetPath = path.join(pluginRoot, SUGGESTIONS_RELATIVE_PATH);
  let parsed;
  try {
    const raw = await readFile(targetPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return { resolved: false };
  }

  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  let found = false;
  const next = list.map((s) => {
    if (s?.id === suggestionId) {
      found = true;
      return { ...s, resolved: true, resolvedAt: new Date().toISOString() };
    }
    return s;
  });

  if (!found) return { resolved: false };

  try {
    await writeFile(
      targetPath,
      JSON.stringify({ ...parsed, suggestions: next }, null, 2) + '\n',
      'utf8',
    );
    return { resolved: true };
  } catch {
    return { resolved: false };
  }
}

/**
 * Mark suggestions as `consumed` by a handoff snapshot (e.g., `/save`).
 *
 * Distinct from `resolveSuggestion`: `consumed` indicates the suggestion was
 * absorbed into a handoff document, not that the user took action. The
 * `/save` flow calls this AFTER a successful `writeHandoff` so that:
 *   - the next session-start banner does not re-surface the same item
 *   - `resolved`-state is preserved (a consumed item can still be resolved
 *     later, and a resolved item is already hidden anyway)
 *
 * The write follows a read+merge+write pattern (atomic at the OS level via
 * a single writeFile call). Unknown ids are silently skipped — callers
 * should treat skip count as a soft signal, not an error.
 *
 * Behavior:
 *   - Returns `{ marked: 0, skipped: 0 }` when file missing or list empty.
 *   - Idempotent: re-marking an already-consumed id increments `marked`
 *     but the timestamp/by fields are only set on the first transition.
 *   - Preserves all other fields (including `resolved`) untouched.
 *
 * @param {string} pluginRoot
 * @param {string[]} suggestionIds
 * @param {object} [options]
 * @param {Date}   [options.now] - Override clock for tests.
 * @returns {Promise<{marked: number, skipped: number}>}
 */
export async function markConsumed(pluginRoot, suggestionIds, { now = new Date() } = {}) {
  if (!pluginRoot) return { marked: 0, skipped: 0 };
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    return { marked: 0, skipped: 0 };
  }

  const targetPath = path.join(pluginRoot, SUGGESTIONS_RELATIVE_PATH);
  let parsed;
  try {
    const raw = await readFile(targetPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    // File missing or corrupt — every requested id is a skip.
    return { marked: 0, skipped: suggestionIds.length };
  }

  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const idIndex = new Map();
  list.forEach((s, i) => {
    if (s && typeof s.id === 'string') idIndex.set(s.id, i);
  });

  let marked = 0;
  let skipped = 0;
  const consumedAt = now.toISOString();
  const next = list.slice();

  for (const id of suggestionIds) {
    const idx = idIndex.get(id);
    if (idx === undefined) {
      skipped += 1;
      continue;
    }
    const prev = next[idx];
    // Only stamp metadata on first transition; idempotent re-marks count
    // toward `marked` but preserve the original consumedAt/by.
    next[idx] = prev.consumed === true
      ? prev
      : { ...prev, consumed: true, consumedAt, consumedBy: 'save' };
    marked += 1;
  }

  if (marked === 0) {
    return { marked: 0, skipped };
  }

  // Atomic write: tmp + rename. Guarantees no partial reader observes a
  // half-written advisor file, and on rename failure the original is intact.
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      tmp,
      JSON.stringify({ ...parsed, suggestions: next }, null, 2) + '\n',
      'utf8',
    );
    await rename(tmp, targetPath);
    return { marked, skipped };
  } catch {
    // Write failed — surface as fully skipped so caller does not assume
    // durability. Advisor file remains untouched. Clean stray tmp.
    try { await rm(tmp, { force: true }); } catch { /* noop */ }
    return { marked: 0, skipped: suggestionIds.length };
  }
}

// Export constants for tests / callers that want to introspect defaults.
export const _internals = {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_CONFIDENCE,
  SUGGESTIONS_RELATIVE_PATH,
  VALID_CATEGORIES,
};
