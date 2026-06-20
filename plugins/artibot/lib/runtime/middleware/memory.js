/**
 * Runtime memory middleware.
 * Pulls lightweight relevant context from memory-manager and injects summary.
 *
 * Phase C upgrade: when the Working layer (L1) is provided AND hierarchical
 * memory is enabled, the Working layer contributes up to 50% of the injected
 * context budget *before* the flat memory-manager lookup. This preserves
 * backward compatibility (callers without workingStore get the v3.1 behaviour
 * unchanged) while allowing the new store to leak useful in-flight signals
 * into prompt construction.
 *
 * @module lib/runtime/middleware/memory
 */

import { getRelevantContext } from '../../learning/memory-manager.js';

const WORKING_BUDGET_RATIO = 0.5;
const WORKING_DEFAULT_TOKEN_BUDGET = 200_000;
const MAX_WORKING_LINES = 3;
const WORKING_LINE_TOKEN_CAP = 40; // chars ≈ 4 per token → ~160 chars per line
const WORKING_LINE_CHAR_CAP = WORKING_LINE_TOKEN_CAP * 4;

// system1 is the fast-path. Memory injection is now allowed there (it was
// gated to system2 only), but capped to top-K lines so the prompt-construction
// cost stays negligible. system2 keeps the full budget. The getRelevantContext
// lookup already ran for both systems before this gate, so enabling system1
// injection adds only a string-slice + concat — no extra I/O.
const SYSTEM1_MAX_LINES = 1;

function summariseWorkingEntry(entry) {
  if (!entry) return '';
  const body = typeof entry.body === 'string'
    ? entry.body
    : JSON.stringify(entry.body ?? '');
  return `[L1:${entry.kind || 'generic'}] ${body.slice(0, WORKING_LINE_CHAR_CAP)}`;
}

function collectWorkingLines(workingStore, budgetTokens) {
  if (!workingStore || typeof workingStore.snapshot !== 'function') return [];
  const snap = workingStore.snapshot?.() ?? { entries: [] };
  const entries = Array.isArray(snap.entries) ? snap.entries : [];
  if (entries.length === 0) return [];

  // Anti-pattern guard: never pour Working wholesale into the prompt.
  const maxTokens = Math.max(0, Math.floor(budgetTokens * WORKING_BUDGET_RATIO));
  const lines = [];
  let used = 0;
  // Newest-first — most recent tool/correction is usually most relevant.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (lines.length >= MAX_WORKING_LINES) break;
    const entry = entries[i];
    if (!entry) continue;
    const approxTokens = entry.tokens || WORKING_LINE_TOKEN_CAP;
    if (used + Math.min(approxTokens, WORKING_LINE_TOKEN_CAP) > maxTokens) break;
    lines.push(summariseWorkingEntry(entry));
    used += Math.min(approxTokens, WORKING_LINE_TOKEN_CAP);
  }
  return lines;
}

function toSummaryLines(relevant) {
  const lines = [];

  const prefs = relevant.preferences || [];
  if (prefs.length > 0) {
    const first = prefs[0];
    lines.push(`Preference hint: ${JSON.stringify(first).slice(0, 140)}`);
  }

  const projectContext = relevant.projectContext || [];
  if (projectContext.length > 0) {
    const first = projectContext[0];
    lines.push(`Project context: ${JSON.stringify(first).slice(0, 140)}`);
  }

  const errors = relevant.errorPatterns || [];
  if (errors.length > 0) {
    const first = errors[0];
    lines.push(`Past error pattern: ${JSON.stringify(first).slice(0, 140)}`);
  }

  return lines.slice(0, 3);
}

function buildQueryContext(state) {
  const hookData = state.input?.hookData || {};
  return {
    cwd: hookData.cwd || hookData.working_directory || hookData.path || '',
    command: state.context.intent?.commands?.[0] || '',
    project: hookData.project || '',
    keywords: state.context.intent?.intents || [],
  };
}

function countRelevantHits(relevant) {
  return (
    (relevant.preferences?.length || 0) +
    (relevant.projectContext?.length || 0) +
    (relevant.recentCommands?.length || 0) +
    (relevant.errorPatterns?.length || 0)
  );
}

function attachMemoryContextToPrompt(state, relevant, hitCount, workingLines) {
  const system = state.context.routing?.system;
  // system1 = fast-path: inject a capped top-K slice to keep latency flat.
  // system2 = deliberative: full budget. Any other/unknown routing is treated
  // conservatively as system1 (capped) rather than skipped, so injection
  // surfaces broadly without ever dumping the full set onto a hot path.
  const isSystem2 = system === 'system2';
  if (hitCount <= 0 && (!workingLines || workingLines.length === 0)) return;

  let lines = [...(workingLines || []), ...toSummaryLines(relevant)];
  if (!isSystem2) lines = lines.slice(0, SYSTEM1_MAX_LINES);
  if (lines.length > 0) {
    state.userPrompt += `\n\nRelevant memory context:\n- ${lines.join('\n- ')}`;
  }
}

function setMemorySuccessState(state, relevant, hitCount, workingLines) {
  const workingHits = workingLines?.length || 0;
  state.context.memory = {
    enabled: true,
    hitCount,
    workingHits,
    relevant,
  };
  attachMemoryContextToPrompt(state, relevant, hitCount, workingLines);
  // Preserve v3.1 wire format when L1 is inactive (zero hits AND no working
  // lines) — existing tests assert exact `memory=N` strings.
  const msg = workingHits > 0
    ? `memory=${hitCount}+L1:${workingHits}`
    : `memory=${hitCount}`;
  state.messageParts.push(msg);
}

function setMemoryErrorState(state, error) {
  state.context.memory = {
    enabled: true,
    hitCount: 0,
    error: error?.message || String(error),
  };
  state.messageParts.push('memory=0');
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @param {object} [options.workingStore] - Optional L1 store (see
 *   `lib/learning/memory/working.js`). When provided AND
 *   `options.hierarchical` is true, Working lines are prepended to the
 *   injected context at up to 50% of `workingTokenBudget`.
 * @param {boolean} [options.hierarchical=false] - Gate for L1 consumption.
 *   Mirrors `learning.hierarchicalMemory.enabled` from artibot.config.json.
 * @param {number} [options.workingTokenBudget=200000]
 * @returns {(state: object) => Promise<object>}
 */
export function createMemoryMiddleware(options = {}) {
  const {
    enabled = true,
    workingStore = null,
    hierarchical = false,
    workingTokenBudget = WORKING_DEFAULT_TOKEN_BUDGET,
  } = options;

  const workingActive = Boolean(hierarchical && workingStore);

  return async function memoryMiddleware(state) {
    if (!enabled) {
      state.context.memory = { enabled: false, hitCount: 0 };
      return state;
    }

    const queryContext = buildQueryContext(state);

    try {
      const relevant = await getRelevantContext(queryContext);
      const hitCount = countRelevantHits(relevant);
      const workingLines = workingActive
        ? collectWorkingLines(workingStore, workingTokenBudget)
        : [];
      setMemorySuccessState(state, relevant, hitCount, workingLines);
    } catch (error) {
      setMemoryErrorState(state, error);
    }

    return state;
  };
}
