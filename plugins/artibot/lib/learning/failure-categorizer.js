/**
 * Failure Categorizer — GRPO Stage B sub-categorization for "fix" actions.
 *
 * Consumes the curated dictionary at `.artibot/failure-patterns.json` (schema
 * v1) and tags a failure context with the most relevant category so future
 * GRPO weight updates can be applied per-pattern instead of to a single
 * coarse "fix" bucket.
 *
 * Pure functions — no module state besides an mtime-keyed in-memory cache.
 * Filesystem is injectable via `opts.fs` for tests; cwd via `opts.cwd`.
 *
 * @module lib/learning/failure-categorizer
 */
import fsDefault from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATTERNS_REL_PATH = '.artibot/failure-patterns.json';

/** Confidence floor for `categorizeAll` results. */
const MIN_CONFIDENCE = 0.1;

/** Weight applied to a matched file-glob signal. Regex signals use signal.weight or 1.0. */
const FILE_SIGNAL_WEIGHT = 0.8;

/** Severity ranking — higher rank wins ties after category weight. */
const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

/** Signal scopes that map to which `failureContext` field is inspected. */
const SCOPE_FIELDS = Object.freeze({
  stderr: ['stderr'],
  stdout: ['stdout'],
  diff: ['diff'],
  any: ['stderr', 'stdout', 'diff'],
});

// ---------------------------------------------------------------------------
// Cache (mtime-keyed; module-scoped)
// ---------------------------------------------------------------------------

/** @type {{ path: string, mtimeMs: number, value: object } | null} */
let cacheEntry = null;

/** Reset cache — intended for tests only. */
export function _resetCache() {
  cacheEntry = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate the failure-patterns dictionary.
 * Cached by absolute path + mtime; second call with unchanged file returns
 * the cached object reference.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Repo root (default: process.cwd()).
 * @param {object} [opts.fs] - fs/promises-like injectable (stat, readFile).
 * @returns {Promise<{ schemaVersion: number, categories: object[] }>}
 * @throws {Error} when the file is missing, unreadable, or malformed.
 */
export async function loadFailurePatterns(opts = {}) {
  const fs = opts.fs || fsDefault;
  const cwd = opts.cwd || process.cwd();
  const filePath = path.join(cwd, PATTERNS_REL_PATH);

  const stat = await statOrThrow(fs, filePath);
  if (cacheEntry && cacheEntry.path === filePath && cacheEntry.mtimeMs === stat.mtimeMs) {
    return cacheEntry.value;
  }

  const raw = await readOrThrow(fs, filePath);
  const parsed = parseOrThrow(raw, filePath);
  validateSchema(parsed, filePath);

  const value = Object.freeze({
    schemaVersion: parsed.schemaVersion,
    categories: Object.freeze(parsed.categories.map((c) => Object.freeze({ ...c }))),
  });

  cacheEntry = { path: filePath, mtimeMs: stat.mtimeMs, value };
  return value;
}

/**
 * Categorize a single failure context against the loaded dictionary.
 * Returns the highest-confidence category, or `null` if no signals match.
 *
 * Tie-break order: confidence DESC → category weight DESC → severity DESC.
 *
 * @param {{ stderr?: string, stdout?: string, diff?: string, files?: string[] }} failureContext
 * @param {object} [opts] - Same shape as `loadFailurePatterns`.
 * @returns {Promise<{ categoryId: string, confidence: number, matchedSignals: object[] } | null>}
 */
export async function categorizeFailure(failureContext, opts = {}) {
  const all = await categorizeAll(failureContext, opts);
  return all.length > 0 ? all[0] : null;
}

/**
 * Categorize and return ALL categories with confidence > MIN_CONFIDENCE,
 * sorted by tie-break order.
 *
 * @param {{ stderr?: string, stdout?: string, diff?: string, files?: string[] }} failureContext
 * @param {object} [opts]
 * @returns {Promise<Array<{ categoryId: string, confidence: number, matchedSignals: object[], weight: number, severity: string }>>}
 */
export async function categorizeAll(failureContext, opts = {}) {
  const dict = await loadFailurePatterns(opts);
  const ctx = normalizeContext(failureContext);

  const results = [];
  for (const category of dict.categories) {
    const scored = scoreCategory(category, ctx);
    if (scored.confidence > MIN_CONFIDENCE) {
      results.push(scored);
    }
  }
  return results.sort(compareCategoryResults);
}

// ---------------------------------------------------------------------------
// Internal — scoring
// ---------------------------------------------------------------------------

/**
 * Score a single category against the normalized context.
 * Confidence = (sum of matched signal weights) / (sum of all signal weights).
 *
 * @param {object} category
 * @param {{ stderr: string, stdout: string, diff: string, files: string[] }} ctx
 * @returns {{ categoryId: string, confidence: number, matchedSignals: object[], weight: number, severity: string }}
 */
function scoreCategory(category, ctx) {
  const signals = Array.isArray(category.signals) ? category.signals : [];
  let matchedWeight = 0;
  let totalWeight = 0;
  const matchedSignals = [];

  for (const signal of signals) {
    const w = signalMaxWeight(signal);
    totalWeight += w;
    const matched = signalMatches(signal, ctx);
    if (matched) {
      matchedWeight += signalMatchWeight(signal);
      matchedSignals.push({ ...signal });
    }
  }

  const confidence = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  return {
    categoryId: category.id,
    confidence: roundConfidence(confidence),
    matchedSignals,
    weight: typeof category.weight === 'number' ? category.weight : 1.0,
    severity: typeof category.severity === 'string' ? category.severity : 'medium',
  };
}

function signalMaxWeight(signal) {
  if (signal?.type === 'file') return FILE_SIGNAL_WEIGHT;
  if (typeof signal?.weight === 'number') return signal.weight;
  return 1.0;
}

function signalMatchWeight(signal) {
  // Symmetric with signalMaxWeight — both numerator/denominator use the same scale.
  return signalMaxWeight(signal);
}

function signalMatches(signal, ctx) {
  if (!signal || typeof signal !== 'object') return false;
  if (signal.type === 'regex') return regexSignalMatches(signal, ctx);
  if (signal.type === 'file') return fileSignalMatches(signal, ctx);
  return false;
}

function regexSignalMatches(signal, ctx) {
  if (typeof signal.pattern !== 'string') return false;
  const scopes = SCOPE_FIELDS[signal.scope] || SCOPE_FIELDS.any;
  let re;
  try {
    re = new RegExp(signal.pattern, signal.flags || '');
  } catch {
    return false;
  }
  for (const field of scopes) {
    const text = ctx[field];
    if (typeof text === 'string' && text.length > 0 && re.test(text)) {
      return true;
    }
  }
  return false;
}

function fileSignalMatches(signal, ctx) {
  if (typeof signal.pattern !== 'string') return false;
  if (!Array.isArray(ctx.files) || ctx.files.length === 0) return false;
  const re = globToRegExp(signal.pattern);
  return ctx.files.some((f) => typeof f === 'string' && re.test(toPosix(f)));
}

/**
 * Tie-break: confidence DESC → weight DESC → severity DESC → id ASC (stable).
 */
function compareCategoryResults(a, b) {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (b.weight !== a.weight) return b.weight - a.weight;
  const sevDiff = (SEVERITY_RANK[b.severity] ?? 1) - (SEVERITY_RANK[a.severity] ?? 1);
  if (sevDiff !== 0) return sevDiff;
  return a.categoryId.localeCompare(b.categoryId);
}

// ---------------------------------------------------------------------------
// Internal — helpers
// ---------------------------------------------------------------------------

function normalizeContext(failureContext) {
  const c = failureContext || {};
  return {
    stderr: typeof c.stderr === 'string' ? c.stderr : '',
    stdout: typeof c.stdout === 'string' ? c.stdout : '',
    diff: typeof c.diff === 'string' ? c.diff : '',
    files: Array.isArray(c.files) ? c.files : [],
  };
}

function roundConfidence(value) {
  return Math.round(value * 1000) / 1000;
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Minimal glob → RegExp. Supports `**`, `*`, `?`, and literal segments.
 * Sufficient for the curated dictionary shapes (no brace expansion needed).
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('(^|/)' + re + '$');
}

// ---------------------------------------------------------------------------
// Internal — load + validate
// ---------------------------------------------------------------------------

async function statOrThrow(fs, filePath) {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    throw new Error(
      `failure-categorizer: cannot stat ${filePath} — ${err.code || err.message}`,
      { cause: err },
    );
  }
}

async function readOrThrow(fs, filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `failure-categorizer: cannot read ${filePath} — ${err.code || err.message}`,
      { cause: err },
    );
  }
}

function parseOrThrow(raw, filePath) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failure-categorizer: malformed JSON in ${filePath} — ${err.message}`,
      { cause: err },
    );
  }
}

function validateSchema(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`failure-categorizer: schema invalid in ${filePath} — not an object`);
  }
  if (typeof parsed.schemaVersion !== 'number') {
    throw new Error(`failure-categorizer: schema invalid in ${filePath} — missing schemaVersion`);
  }
  if (!Array.isArray(parsed.categories)) {
    throw new Error(`failure-categorizer: schema invalid in ${filePath} — categories not array`);
  }
  for (const c of parsed.categories) {
    if (!c || typeof c.id !== 'string' || !Array.isArray(c.signals)) {
      throw new Error(`failure-categorizer: schema invalid in ${filePath} — category missing id/signals`);
    }
  }
}
