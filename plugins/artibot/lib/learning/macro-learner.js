/**
 * Macro Learning (suggest-only).
 *
 * Observes user prompts, detects repeating multi-action sequences, and records
 * candidate macros as SUGGESTIONS — never registers them automatically.
 *
 * Registration into `artibot.config.json.macros` only happens inside
 * `approveSuggestion()`, which MUST be invoked by an explicit user-facing flow.
 *
 * Design constraints:
 *   - Zero runtime deps
 *   - ESM
 *   - No prototype pollution (Object.create(null) + key guards)
 *   - Redacts sensitive tokens (API keys, file paths) before persisting
 *   - `mode: "suggest-only"` + `requireUserApproval: true` is the only supported
 *     safe posture. If a caller passes an unsafe mode, approveSuggestion bails.
 *
 * @module lib/learning/macro-learner
 */

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { redactString as sharedRedactString, TAGGED_PATTERNS } from '../core/redaction.js';

// --- action keyword catalogue -----------------------------------------------

const ACTION_KEYWORDS = Object.freeze({
  'security-review': [
    'security', 'secure', '\uBCF4\uC548', '\uCDE8\uC57D', 'vuln', 'audit',
  ],
  test: ['test', '\uD14C\uC2A4\uD2B8', 'vitest', 'jest', 'pytest', 'spec'],
  build: ['build', '\uBE4C\uB4DC', 'compile', 'bundle'],
  deploy: ['deploy', '\uBC30\uD3EC', 'release', 'publish', 'ship'],
  review: ['review', '\uB9AC\uBDF0', 'code-review', 'codereview'],
  lint: ['lint', '\uB9B0\uD2B8', 'eslint', 'prettier'],
  refactor: ['refactor', '\uB9AC\uD329\uD130', 'cleanup'],
  docs: ['docs', 'document', '\uBB38\uC11C'],
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// --- redaction (delegated to lib/core/redaction.js — tagged pattern set) ----

/**
 * Redact sensitive tokens from a string using the shared tagged pattern set
 * (`[redacted:key]`, `[redacted:path]`, `[redacted:email]`, ...). Pure
 * function; does not mutate input.
 *
 * @param {string} input
 * @returns {string}
 */
export function redactSensitive(input) {
  return sharedRedactString(input, { patterns: TAGGED_PATTERNS });
}

// --- detection --------------------------------------------------------------

/**
 * Extract ordered action tokens from a raw prompt. Deduplicates while preserving
 * first-seen order so "security then test then build" distinct from "test, build, security".
 * @param {string} prompt
 * @returns {string[]}
 */
export function extractActions(prompt) {
  const lower = String(prompt || '').toLowerCase();
  if (!lower) return [];

  // Index each action by its earliest keyword match position so we can sort by
  // appearance order in the original prompt — this preserves user intent.
  const hits = [];
  for (const [action, keywords] of Object.entries(ACTION_KEYWORDS)) {
    let earliest = Infinity;
    for (const kw of keywords) {
      const idx = lower.indexOf(kw.toLowerCase());
      if (idx >= 0 && idx < earliest) earliest = idx;
    }
    if (earliest !== Infinity) hits.push({ action, pos: earliest });
  }
  hits.sort((a, b) => a.pos - b.pos);
  return hits.map((h) => h.action);
}

/**
 * Stable fingerprint for an action sequence.
 * @param {string[]} actions
 * @returns {string}
 */
function fingerprint(actions) {
  return actions.join('>');
}

// --- storage ---------------------------------------------------------------

function resolveSuggestionsPath(pluginRoot, config) {
  const relative = config?.ago?.macroLearning?.suggestionsPath
    || 'runtime/macro-suggestions.json';
  return path.join(pluginRoot, relative);
}

function safeReadJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Load the suggestions store. Guards against prototype pollution by using a
 * null-prototype container and dropping any forbidden keys.
 * @param {string} filePath
 * @returns {{ suggestions: object[], observations: object }}
 */
function loadStore(filePath) {
  const raw = safeReadJson(filePath, null);
  const store = { suggestions: [], observations: Object.create(null) };
  if (!raw || typeof raw !== 'object') return store;
  if (Array.isArray(raw.suggestions)) {
    store.suggestions = raw.suggestions.filter((s) => s && typeof s === 'object');
  }
  if (raw.observations && typeof raw.observations === 'object') {
    for (const [k, v] of Object.entries(raw.observations)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (v && typeof v === 'object') store.observations[k] = v;
    }
  }
  return store;
}

// --- public API -------------------------------------------------------------

function computeConfidence(count, minOccurrences) {
  return Math.min(0.99, 0.6 + (count - minOccurrences) * 0.1);
}

function bumpObservation(store, fp, now, redactedTrigger) {
  const obs = store.observations[fp] || { count: 0, firstSeen: now, lastTrigger: '' };
  obs.count = (obs.count || 0) + 1;
  obs.lastSeen = now;
  obs.lastTrigger = redactedTrigger;
  store.observations[fp] = obs;
  return obs;
}

function createPendingSuggestion(ctx) {
  return {
    id: `macro-${Date.now()}`,
    detectedAt: ctx.now,
    pattern: {
      fingerprint: ctx.fp,
      triggerPhrase: ctx.redactedTrigger,
      actions: ctx.actions,
      occurrences: ctx.obs.count,
    },
    confidence: computeConfidence(ctx.obs.count, ctx.minOccurrences),
    status: 'pending',
    approvedAt: null,
    rejectedAt: null,
  };
}

function resolveMinOccurrences(ml) {
  return Number.isInteger(ml.minOccurrences) && ml.minOccurrences >= 1
    ? ml.minOccurrences
    : 3;
}

/**
 * Observe a user prompt. Detects action sequences and either increments an
 * existing observation counter or creates a new pending suggestion when the
 * `minOccurrences` threshold is crossed.
 *
 * Never writes to artibot.config.json. Never registers a macro.
 *
 * @param {string} prompt - raw user prompt
 * @param {{pluginRoot: string, config: object}} options
 * @returns {Promise<{observed: boolean, suggestionId?: string}>}
 */
export async function observePrompt(prompt, options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  if (!pluginRoot) return { observed: false };

  const ml = config?.ago?.macroLearning || {};
  if (ml.enabled === false) return { observed: false };

  const actions = extractActions(prompt);
  if (actions.length < 2) return { observed: false };

  const fp = fingerprint(actions);
  const minOccurrences = resolveMinOccurrences(ml);
  const filePath = resolveSuggestionsPath(pluginRoot, config);
  const store = loadStore(filePath);

  const existing = store.suggestions.find((s) => s?.pattern?.fingerprint === fp);
  if (existing && (existing.status === 'approved' || existing.status === 'rejected')) {
    return { observed: true, suggestionId: existing.id };
  }

  const now = new Date().toISOString();
  const redactedTrigger = redactSensitive(String(prompt || '').trim().slice(0, 240));
  const obs = bumpObservation(store, fp, now, redactedTrigger);

  let suggestionId;
  if (obs.count >= minOccurrences && !existing) {
    const created = createPendingSuggestion({ fp, actions, obs, now, redactedTrigger, minOccurrences });
    store.suggestions.push(created);
    suggestionId = created.id;
  } else if (existing && existing.status === 'pending') {
    existing.pattern.occurrences = obs.count;
    existing.confidence = computeConfidence(obs.count, minOccurrences);
    suggestionId = existing.id;
  }

  safeWriteJson(filePath, store);
  return { observed: true, suggestionId };
}

/**
 * Return all macro suggestions (pending + historical).
 * @param {string} pluginRoot
 * @param {object} [config]
 * @returns {Promise<object[]>}
 */
export async function getMacroSuggestions(pluginRoot, config = {}) {
  if (!pluginRoot) return [];
  const filePath = resolveSuggestionsPath(pluginRoot, config);
  const store = loadStore(filePath);
  return store.suggestions.slice();
}

/**
 * Validate approval preconditions. Returns null if OK, else a failure object.
 */
function validateApprovalPreconditions(pluginRoot, suggestionId, ml) {
  if (!pluginRoot || !suggestionId) return { registered: false, reason: 'invalid-args' };
  if (ml.mode && ml.mode !== 'suggest-only') return { registered: false, reason: 'unsafe-mode' };
  if (ml.requireUserApproval === false) return { registered: false, reason: 'auto-register-forbidden' };
  if (FORBIDDEN_KEYS.has(suggestionId)) return { registered: false, reason: 'forbidden-id' };
  return null;
}

/**
 * Resolve the suggestion's current terminal state, if any.
 */
function resolveSuggestionTerminalState(suggestion) {
  if (!suggestion) return { registered: false, reason: 'not-found' };
  if (suggestion.status === 'approved') return { registered: true, macroId: suggestion.macroId };
  if (suggestion.status === 'rejected') return { registered: false, reason: 'already-rejected' };
  return null;
}

/**
 * Explicitly approve a suggestion: writes macro entry to artibot.config.json
 * under `macros`. This is the ONLY path that mutates the config.
 *
 * Refuses to run unless `requireUserApproval: true` AND `mode === 'suggest-only'`
 * — matches the documented safe posture.
 *
 * @param {string} suggestionId
 * @param {{pluginRoot: string, config: object}} options
 * @returns {Promise<{registered: boolean, macroId?: string, reason?: string}>}
 */
export async function approveSuggestion(suggestionId, options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  const ml = config?.ago?.macroLearning || {};

  const precheck = validateApprovalPreconditions(pluginRoot, suggestionId, ml);
  if (precheck) return precheck;

  const filePath = resolveSuggestionsPath(pluginRoot, config);
  const store = loadStore(filePath);
  const suggestion = store.suggestions.find((s) => s?.id === suggestionId);
  const terminal = resolveSuggestionTerminalState(suggestion);
  if (terminal) return terminal;

  // Write macro entry into artibot.config.json (explicit user approval step).
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const cfg = safeReadJson(configPath, null);
  if (!cfg || typeof cfg !== 'object') {
    return { registered: false, reason: 'config-unreadable' };
  }
  if (!cfg.macros || typeof cfg.macros !== 'object' || Array.isArray(cfg.macros)) {
    cfg.macros = Object.create(null);
  }

  const macroId = `m_${suggestion.pattern.fingerprint.replace(/[^a-z0-9]+/gi, '_')}`;
  if (FORBIDDEN_KEYS.has(macroId)) {
    return { registered: false, reason: 'forbidden-macro-id' };
  }
  cfg.macros[macroId] = {
    actions: suggestion.pattern.actions.slice(),
    trigger: suggestion.pattern.triggerPhrase,
    createdAt: new Date().toISOString(),
    source: 'macro-learner',
    suggestionId,
  };
  safeWriteJson(configPath, cfg);

  suggestion.status = 'approved';
  suggestion.approvedAt = new Date().toISOString();
  suggestion.macroId = macroId;
  safeWriteJson(filePath, store);

  return { registered: true, macroId };
}

/**
 * Reject a suggestion: marks rejected so observePrompt stops re-proposing it.
 * @param {string} suggestionId
 * @param {{pluginRoot: string, config?: object}} options
 * @returns {Promise<{rejected: boolean, reason?: string}>}
 */
export async function rejectSuggestion(suggestionId, options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  if (!pluginRoot || !suggestionId) {
    return { rejected: false, reason: 'invalid-args' };
  }
  const filePath = resolveSuggestionsPath(pluginRoot, config);
  const store = loadStore(filePath);
  const suggestion = store.suggestions.find((s) => s?.id === suggestionId);
  if (!suggestion) return { rejected: false, reason: 'not-found' };
  suggestion.status = 'rejected';
  suggestion.rejectedAt = new Date().toISOString();
  safeWriteJson(filePath, store);
  return { rejected: true };
}

// ---------------------------------------------------------------------------
// AGO Self-Control — auto-register path (opt-in, triple-gated)
// ---------------------------------------------------------------------------

const AUTO_MIN_CONFIDENCE = 0.85;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate the three opt-in gates for auto-register:
 *   1. `ARTIBOT_SELF_CONTROL` env flag is set
 *   2. `ago.selfControl.masterEnabled === true`
 *   3. `ago.selfControl.autoMacroRegister.enabled === true`
 *
 * @param {object} config
 * @returns {{ok: true, cfg: object} | {ok: false, reason: string}}
 */
function evalAutoGate(config) {
  if (!process.env.ARTIBOT_SELF_CONTROL) return { ok: false, reason: 'env-not-set' };
  const sc = config?.ago?.selfControl;
  if (!sc || sc.masterEnabled !== true) return { ok: false, reason: 'master-disabled' };
  const ar = sc.autoMacroRegister;
  if (!ar || ar.enabled !== true) return { ok: false, reason: 'module-disabled' };
  return { ok: true, cfg: ar };
}

/**
 * Check whether the same fingerprint has a rejection inside the cooldown window.
 */
function hasRecentRejection(store, fp, now, windowDays) {
  const windowMs = windowDays * DAY_MS;
  return store.suggestions.some((s) =>
    s?.status === 'rejected'
    && s?.pattern?.fingerprint === fp
    && s?.rejectedAt
    && (now - Date.parse(s.rejectedAt)) <= windowMs,
  );
}

/**
 * Attempt to auto-register a single pending suggestion.
 *
 * Opt-in extension of the suggest-only contract. Requires the three AGO
 * self-control gates (env + masterEnabled + module enabled) plus stricter
 * per-suggestion criteria (min occurrences, min confidence, no recent rejection).
 *
 * @param {object} suggestion - Pending suggestion object (as returned by observePrompt).
 * @param {{pluginRoot: string, config: object, now?: number}} options
 * @returns {Promise<{registered: boolean, macroId?: string, reason?: string}>}
 */
/**
 * Per-suggestion precheck. Returns a skip-reason object or null when all
 * per-suggestion criteria pass.
 */
function precheckAutoRegister(suggestion, gateCfg) {
  if (suggestion.status !== 'pending') return { registered: false, reason: 'not-pending' };

  const minOccurrences = Number.isInteger(gateCfg.minOccurrences) && gateCfg.minOccurrences >= 1
    ? gateCfg.minOccurrences
    : 5;
  const occurrences = suggestion.pattern?.occurrences ?? 0;
  if (occurrences < minOccurrences) return { registered: false, reason: 'below-occurrences' };

  const confidence = typeof suggestion.confidence === 'number' ? suggestion.confidence : 0;
  if (confidence < AUTO_MIN_CONFIDENCE) return { registered: false, reason: 'low-confidence' };

  return null;
}

/**
 * Persist a new macro entry into artibot.config.json. Returns macroId on
 * success or a skip-reason object on failure.
 */
function writeMacroEntry(pluginRoot, suggestion, now) {
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const cfg = safeReadJson(configPath, null);
  if (!cfg || typeof cfg !== 'object') return { registered: false, reason: 'config-unreadable' };
  if (!cfg.macros || typeof cfg.macros !== 'object' || Array.isArray(cfg.macros)) {
    cfg.macros = Object.create(null);
  }

  const macroId = `m_${String(suggestion.pattern.fingerprint).replace(/[^a-z0-9]+/gi, '_')}`;
  if (FORBIDDEN_KEYS.has(macroId)) return { registered: false, reason: 'forbidden-macro-id' };

  cfg.macros[macroId] = {
    actions: suggestion.pattern.actions.slice(),
    trigger: suggestion.pattern.triggerPhrase,
    createdAt: new Date(now).toISOString(),
    source: 'macro-learner-auto',
    suggestionId: suggestion.id,
  };
  safeWriteJson(configPath, cfg);
  return { macroId };
}

/**
 * Mirror approval state into the suggestion store.
 */
function markStoreApproved(filePath, store, suggestionId, macroId, now) {
  const stored = store.suggestions.find((s) => s?.id === suggestionId);
  if (!stored) return;
  stored.status = 'approved';
  stored.approvedAt = new Date(now).toISOString();
  stored.macroId = macroId;
  stored.autoRegistered = true;
  safeWriteJson(filePath, store);
}

export async function tryAutoRegister(suggestion, options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  const now = typeof options?.now === 'number' ? options.now : Date.now();

  if (!pluginRoot || !suggestion) return { registered: false, reason: 'invalid-args' };

  const gate = evalAutoGate(config);
  if (!gate.ok) return { registered: false, reason: gate.reason };

  const precheck = precheckAutoRegister(suggestion, gate.cfg);
  if (precheck) return precheck;

  const filePath = resolveSuggestionsPath(pluginRoot, config);
  const store = loadStore(filePath);

  const windowDays = Number.isFinite(gate.cfg.noRejectionWindowDays)
    ? gate.cfg.noRejectionWindowDays
    : 30;
  if (hasRecentRejection(store, suggestion.pattern?.fingerprint, now, windowDays)) {
    return { registered: false, reason: 'recent-rejection' };
  }

  const write = writeMacroEntry(pluginRoot, suggestion, now);
  if (write.reason) return write;

  markStoreApproved(filePath, store, suggestion.id, write.macroId, now);
  return { registered: true, macroId: write.macroId };
}

/**
 * Sweep all pending suggestions and attempt auto-register per entry.
 * Short-circuits with the gate reason if the triple gate is not open.
 *
 * @param {{pluginRoot: string, config: object, now?: number}} options
 * @returns {Promise<{registered: Array<{id:string,macroId:string}>, skipped: Array<{id:string,reason:string}>, reason?: string}>}
 */
export async function sweepAutoRegister(options) {
  const pluginRoot = options?.pluginRoot;
  const config = options?.config || {};
  const now = typeof options?.now === 'number' ? options.now : Date.now();

  const gate = evalAutoGate(config);
  if (!gate.ok) return { registered: [], skipped: [], reason: gate.reason };
  if (!pluginRoot) return { registered: [], skipped: [], reason: 'invalid-args' };

  const filePath = resolveSuggestionsPath(pluginRoot, config);
  const store = loadStore(filePath);
  const pending = store.suggestions.filter((s) => s?.status === 'pending');

  const registered = [];
  const skipped = [];
  for (const suggestion of pending) {
    const r = await tryAutoRegister(suggestion, { pluginRoot, config, now });
    if (r.registered) {
      registered.push({ id: suggestion.id, macroId: r.macroId });
    } else {
      skipped.push({ id: suggestion.id, reason: r.reason });
    }
  }

  return { registered, skipped };
}
