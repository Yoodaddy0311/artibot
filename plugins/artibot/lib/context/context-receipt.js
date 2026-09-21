/**
 * Context Receipt assembler (vNext PR-CX02, design ARTIBOT-5.0-DESIGN.md
 * §8.2/§41 — the Context Receipt is the `data` object of the ledger event
 * `context.compiled`, not a standalone artifact).
 *
 * This module exists to make an ABSENCE explicit. `schemas/context-receipt.schema.json`
 * requires ten top-level keys, `additionalProperties:false` at every level.
 * A caller that can only measure some of them has exactly two honest options:
 * report the gap, or not emit at all. Inventing a value is the one thing it
 * may not do — and the schema makes the temptation concrete: `transforms.*`
 * values are SIGNED token deltas where `0` means "the transform ran and
 * changed nothing". Zero-filling a transform that never ran therefore writes
 * a false measurement into an append-only ledger.
 *
 * Measured 2026-09-12 for the PostCompact caller
 * (`scripts/hooks/post-compact-rehydrate.js`): it can supply
 * `schema_version`, `strategy_version`, `context_receipt_id`,
 * `protected_sections` (`[]` is a statement per the schema), `input_tokens`
 * (only when the host reports `context_window.current_tokens` — the live
 * 2026-09-11 snapshot carried no such key, so live it is five of ten) and
 * `output_tokens` — six of the ten keys, 11 schema leaves short. It
 * supplies `mission_id` and `based_on.{intent_revision, plan_revision}` only
 * CONDITIONALLY (SH-16, limb `e99f450f`): the project-state store must name
 * exactly one active mission whose id ends in `-S<sid8>` for this session, and
 * the nested revisions must be integers >= 1. Outside that case those leaves
 * stay missing, so read the NAMES in `missing` rather than its count. It still
 * cannot supply `transforms.*` (0 of 5 instrumented) or `cache.*` (single writer:
 * `lib/economics/usage-receipt.js`, design §3.6 — this module references
 * those numbers, it never re-measures them).
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 * Pure and total: no imports, no I/O, no clock, no randomness; every input,
 * including hostile ones, returns a result instead of throwing. A field is
 * filled ONLY from an explicit, individually valid input; everything else is
 * a dotted path in `missing`, ordered by the schema rather than by discovery
 * so two callers produce comparable gap reports.
 *
 * @module lib/context/context-receipt
 */

/** Receipt schema revision this module assembles (schema `const 1`). */
export const CONTEXT_RECEIPT_SCHEMA_VERSION = 1;

/** Version of the compilation strategy recorded when the caller names none. */
export const CONTEXT_STRATEGY_VERSION = 1;

/** The five §41 transforms, in schema order. All five or none. */
export const TRANSFORM_KEYS = Object.freeze([
  'dedup',
  'tool_compression',
  'history_trim',
  'memory_add',
  'project_knowledge_add',
]);

/** Prompt-cache accounting keys, in schema order. All three or none. */
export const CACHE_KEYS = Object.freeze(['provider', 'hit_tokens', 'created_tokens']);

const MAX_NAMED_GAPS = 3;

/**
 * Read a property without trusting the object: a caller may hand us a proxy
 * or a throwing getter, and this module promises never to throw.
 *
 * @param {unknown} obj
 * @param {string} key
 * @returns {unknown}
 */
function read(obj, key) {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  try {
    return /** @type {Record<string, unknown>} */ (obj)[key];
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isText(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Monotonic counter (schema `minimum: 1`).
 * @param {unknown} v
 * @returns {v is number}
 */
function isCounter(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 1;
}

/**
 * Token count (schema `minimum: 0`).
 * @param {unknown} v
 * @returns {v is number}
 */
function isCount(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 0;
}

/**
 * `protected_sections`: absent is the empty statement the schema blesses,
 * present-but-malformed is a gap (we will not quietly downgrade a caller's
 * botched list to "nothing was protected").
 *
 * @param {unknown} v
 * @returns {{ value: string[]|null }}
 */
function readProtectedSections(v) {
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v)) return { value: null };
  const out = [];
  for (const item of v) {
    if (!isText(item)) return { value: null };
    out.push(item);
  }
  return { value: out };
}

/**
 * @param {unknown} input
 * @param {string[]} missing
 * @returns {Record<string, number>|null}
 */
function readTransforms(input, missing) {
  const src = read(input, 'transforms');
  /** @type {Record<string, number>} */
  const out = {};
  let complete = true;
  for (const key of TRANSFORM_KEYS) {
    const value = read(src, key);
    if (Number.isInteger(value)) out[key] = /** @type {number} */ (value);
    else {
      complete = false;
      missing.push(`transforms.${key}`);
    }
  }
  return complete ? out : null;
}

/**
 * @param {unknown} input
 * @param {string[]} missing
 * @returns {{ provider: string, hit_tokens: number, created_tokens: number }|null}
 */
function readCache(input, missing) {
  const src = read(input, 'cache');
  const provider = read(src, 'provider');
  const hit = read(src, 'hit_tokens');
  const created = read(src, 'created_tokens');
  const ok = { provider: isText(provider), hit_tokens: isCount(hit), created_tokens: isCount(created) };
  for (const key of CACHE_KEYS) {
    if (!ok[key]) missing.push(`cache.${key}`);
  }
  if (!ok.provider || !ok.hit_tokens || !ok.created_tokens) return null;
  return {
    provider: /** @type {string} */ (provider),
    hit_tokens: /** @type {number} */ (hit),
    created_tokens: /** @type {number} */ (created),
  };
}

/**
 * @param {unknown} input
 * @param {string[]} missing
 * @returns {{ intent_revision: number, plan_revision: number }|null}
 */
function readBasedOn(input, missing) {
  const src = read(input, 'basedOn');
  const intent = read(src, 'intentRevision');
  const plan = read(src, 'planRevision');
  if (!isCounter(intent)) missing.push('based_on.intent_revision');
  if (!isCounter(plan)) missing.push('based_on.plan_revision');
  if (!isCounter(intent) || !isCounter(plan)) return null;
  return { intent_revision: /** @type {number} */ (intent), plan_revision: /** @type {number} */ (plan) };
}

/**
 * Assemble a Context Receipt from what the caller actually measured.
 *
 * @param {{
 *   receiptId?: unknown, missionId?: unknown, taskId?: unknown, actionId?: unknown,
 *   basedOn?: unknown, inputTokens?: unknown, transforms?: unknown,
 *   protectedSections?: unknown, outputTokens?: unknown, cache?: unknown,
 *   strategyVersion?: unknown,
 * }} input
 * @returns {{ ok: true, receipt: object, missing: [] }
 *   | { ok: false, receipt: null, missing: string[], partial: object }}
 */
export function assembleContextReceipt(input) {
  /** @type {string[]} */
  const missing = [];
  /** @type {Record<string, unknown>} */
  const partial = { schema_version: CONTEXT_RECEIPT_SCHEMA_VERSION };

  const receiptId = read(input, 'receiptId');
  if (isText(receiptId)) partial.context_receipt_id = receiptId;
  else missing.push('context_receipt_id');

  const missionId = read(input, 'missionId');
  if (isText(missionId)) partial.mission_id = missionId;
  else missing.push('mission_id');

  const taskId = read(input, 'taskId');
  if (isText(taskId)) partial.task_id = taskId;
  const actionId = read(input, 'actionId');
  if (isText(actionId)) partial.action_id = actionId;

  const basedOn = readBasedOn(input, missing);
  if (basedOn) partial.based_on = basedOn;

  const inputTokens = read(input, 'inputTokens');
  if (isCount(inputTokens)) partial.input_tokens = inputTokens;
  else missing.push('input_tokens');

  const transforms = readTransforms(input, missing);
  if (transforms) partial.transforms = transforms;

  const sections = readProtectedSections(read(input, 'protectedSections'));
  if (sections.value) partial.protected_sections = sections.value;
  else missing.push('protected_sections');

  const outputTokens = read(input, 'outputTokens');
  if (isCount(outputTokens)) partial.output_tokens = outputTokens;
  else missing.push('output_tokens');

  const cache = readCache(input, missing);
  if (cache) partial.cache = cache;

  const strategyVersion = read(input, 'strategyVersion');
  partial.strategy_version = isCounter(strategyVersion) ? strategyVersion : CONTEXT_STRATEGY_VERSION;

  if (missing.length === 0) return { ok: true, receipt: partial, missing: [] };
  return { ok: false, receipt: null, missing, partial };
}

/**
 * One-line, log-safe rendering of an assembly result. Total: any argument.
 *
 * @param {unknown} result
 * @returns {string}
 */
export function describeReceiptGap(result) {
  const raw = read(result, 'missing');
  const missing = Array.isArray(raw) ? raw.filter(isText) : [];
  if (missing.length === 0) return 'receipt complete';
  const named = missing.slice(0, MAX_NAMED_GAPS).join(', ');
  const rest = missing.length > MAX_NAMED_GAPS ? ', ...' : '';
  return `receipt incomplete: ${missing.length} missing (${named}${rest})`;
}
