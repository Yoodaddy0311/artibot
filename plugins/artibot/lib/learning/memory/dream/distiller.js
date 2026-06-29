/**
 * Dream Distiller (L3) — Phase-1 code-Distill (PRD-DREAMING §4.2 / ADR-3).
 *
 * DETERMINISTIC, LLM-FREE candidate extraction. Reuses the pure TF-IDF helpers
 * from session-memory.js (`tokenize` / `cosineSimilarity`) to mechanically
 * narrow the memory set into three candidate kinds:
 *
 *   - `dedup-merge` : cosine ≥ mergeThreshold AND same `type` → merge candidate.
 *   - `contradict`  : high lexical overlap but a polarity/scope conflict marker
 *                     → flagged as a contradiction pair (NEVER auto-resolved;
 *                     §6 trap ④ keeps both as hypotheses).
 *   - `archive`     : low-utility (no inbound `[[links]]`, stale by age) singletons.
 *
 * Output is `candidates.json`-shaped data written ONLY to the staging dir.
 * Phase-2 LLM-Distill (proposal bodies) happens later in a session — this
 * module never generates proposal prose and never calls a model. The nightly
 * hook stops here (ADR-3).
 *
 * @module lib/learning/memory/dream/distiller
 */

import path from 'node:path';
import { cosineSimilarity, tokenize } from '../../session-memory.js';
import { atomicWriteJson } from '../../../core/file.js';

const DEFAULTS = Object.freeze({
  mergeThreshold: 0.82,
  contradictThreshold: 0.6,
  staleDays: 180,
  minDescTokens: 1,
  // Archive-protection knob: a stale memory whose vector cosine-similarity to the
  // aggregated recent-conversation signals is >= this is kept "fresh" (never
  // archived). Range [0,1]. 0 = protect ALL stale memories when signals are present
  // (maximum protection, NOT disabled). 1 = protect only near-identical matches.
  // To fully disable freshness protection, supply no signals (opts.signals absent
  // or []). (F-08 D2)
  freshnessThreshold: 0.3,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lexical markers that, when present near overlapping memories, hint at a
 *  contradiction worth surfacing as a hypothesis rather than a merge. */
const CONTRADICTION_MARKERS = Object.freeze([
  'no longer', 'deprecated', 'instead of', 'replaced', 'not ',
  '대신', '아님', '폐기', '더 이상', '교체', '변경',
]);

/**
 * Resolve distiller config from the artibot config block, applying safe
 * conservative defaults.
 * @param {object} [config]
 * @returns {{mergeThreshold:number, contradictThreshold:number, staleDays:number, freshnessThreshold:number}}
 */
export function resolveDistillConfig(config) {
  const block = config?.learning?.dream?.distill;
  const safe = block && typeof block === 'object' ? block : {};
  return {
    mergeThreshold: clamp01(safe.mergeThreshold, DEFAULTS.mergeThreshold),
    contradictThreshold: clamp01(safe.contradictThreshold, DEFAULTS.contradictThreshold),
    staleDays: Number.isFinite(safe.staleDays) && safe.staleDays > 0
      ? safe.staleDays : DEFAULTS.staleDays,
    freshnessThreshold: clamp01(safe.freshnessThreshold, DEFAULTS.freshnessThreshold),
  };
}

/** @param {*} v @param {number} fallback */
function clamp01(v, fallback) {
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

/** Build a TF-IDF vector for a memory record from title+description+body. */
function vectorOf(record) {
  const heading = String(record.body ?? '').match(/^#{1,6}\s+(.+)$/m)?.[1] ?? '';
  const source = [record.name, record.description, heading, record.body]
    .filter(Boolean).join(' ');
  return tokenize(source);
}

/**
 * Aggregate recent-conversation signal texts into one "fresh terms" TF vector,
 * reusing the SAME tokenizer (`vectorOf`) applied to memories so the cosine
 * comparison is apples-to-apples. Signals are wrapped as `{ body: text }` —
 * the only field `vectorOf` needs. Empty/undefined input → empty vector.
 *
 * @param {Array<{text?:string}>|undefined} signals
 * @returns {Record<string, number>}
 */
function freshTermsVector(signals) {
  const agg = {};
  for (const sig of Array.isArray(signals) ? signals : []) {
    const text = sig?.text;
    if (!text || typeof text !== 'string') continue;
    const vec = vectorOf({ body: text });
    for (const [term, count] of Object.entries(vec)) {
      agg[term] = (agg[term] || 0) + count;
    }
  }
  return agg;
}

/** Detect a contradiction marker in either body of an overlapping pair. */
function hasContradictionMarker(a, b) {
  const blob = `${a.body ?? ''}\n${b.body ?? ''}`.toLowerCase();
  return CONTRADICTION_MARKERS.some((m) => blob.includes(m));
}

/**
 * Determine if a memory is low-utility: no inbound links from any sibling and
 * older than the stale window. Defensive — missing timestamps never archive.
 *
 * @param {object} rec
 * @param {Set<string>} linkedNames - slugs referenced by other memories
 * @param {number} now
 * @param {number} staleMs
 * @returns {boolean}
 */
function isLowUtility(rec, linkedNames, now, staleMs) {
  if (linkedNames.has(rec.name)) return false;
  const created = parseRecordDate(rec);
  if (created === null) return false; // unknown age → never archive
  return (now - created) > staleMs;
}

/** Best-effort created-at extraction from frontmatter/body date hints. */
function parseRecordDate(rec) {
  const explicit = rec.front?.createdAt || rec.metadata?.createdAt;
  if (explicit) {
    const t = Date.parse(explicit);
    if (Number.isFinite(t)) return t;
  }
  const m = String(rec.body ?? '').match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (m) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Run Phase-1 code-Distill over collected memories. Pure compute — returns the
 * candidate set; persistence is a separate call so tests can assert in memory.
 *
 * @param {object[]} memories - parsed memory records (from collector/adapter)
 * @param {object} [opts]
 * @param {object} [opts.config]
 * @param {() => number} [opts.now]
 * @param {Array<{kind?:string, source?:string, text?:string}>} [opts.signals]
 *   Recent-conversation signals (ledger/handoff/session-notes). A stale memory
 *   whose terms overlap these signals is protected from archiving (freshness).
 *   Absent/empty → archive output is byte-identical to the pre-F-08 behavior.
 * @returns {{generatedAt:string, mergeCandidates:object[], contradictCandidates:object[], archiveCandidates:object[]}}
 */
export function distillCandidates(memories, opts = {}) {
  const cfg = resolveDistillConfig(opts.config);
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const staleMs = cfg.staleDays * DAY_MS;
  const freshVec = freshTermsVector(opts.signals);
  const hasFresh = Object.keys(freshVec).length > 0;

  const enriched = memories.map((rec) => ({ rec, vec: vectorOf(rec) }));
  const linkedNames = new Set();
  for (const { rec } of enriched) {
    for (const link of rec.links || []) linkedNames.add(link);
  }

  const mergeCandidates = [];
  const contradictCandidates = [];

  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i];
      const b = enriched[j];
      const sim = cosineSimilarity(a.vec, b.vec);
      if (sim < cfg.contradictThreshold) continue;
      const pair = pairRef(a.rec, b.rec, sim);
      if (sim >= cfg.mergeThreshold && a.rec.type === b.rec.type
        && !hasContradictionMarker(a.rec, b.rec)) {
        mergeCandidates.push({ ...pair, kind: 'dedup-merge', type: a.rec.type });
      } else if (hasContradictionMarker(a.rec, b.rec)) {
        contradictCandidates.push({ ...pair, kind: 'contradict' });
      }
    }
  }

  const archiveCandidates = enriched
    .filter(({ rec }) => isLowUtility(rec, linkedNames, now, staleMs))
    // Freshness protection: drop stale memories still echoed by recent signals.
    // No-op when no signals were supplied (hasFresh === false).
    .filter(({ vec }) =>
      !(hasFresh && cosineSimilarity(vec, freshVec) >= cfg.freshnessThreshold))
    .map(({ rec }) => ({
      kind: 'archive', target: ref(rec),
      reason: 'stale+unreferenced+low-utility',
    }));

  return Object.freeze({
    generatedAt: new Date(now).toISOString(),
    mergeCandidates: Object.freeze(mergeCandidates),
    contradictCandidates: Object.freeze(contradictCandidates),
    archiveCandidates: Object.freeze(archiveCandidates),
  });
}

/** Compact provenance reference for a single record. */
function ref(rec) {
  return { name: rec.name, file: rec.file, type: rec.type, hash: rec.hash };
}

/** Pair provenance reference with similarity score. */
function pairRef(a, b, sim) {
  return {
    similarity: Math.round(sim * 1000) / 1000,
    targets: [ref(a), ref(b)],
  };
}

/**
 * Persist a candidate set to `<stagingDir>/candidates.json` atomically. The
 * staging dir is the ONLY write target — source memory files are untouched.
 *
 * @param {string} stagingDir
 * @param {object} candidates
 * @returns {Promise<string>} the written path
 */
export async function writeCandidates(stagingDir, candidates) {
  const target = path.join(stagingDir, 'candidates.json');
  await atomicWriteJson(target, candidates);
  return target;
}

export const _internals = Object.freeze({ DEFAULTS, CONTRADICTION_MARKERS, vectorOf, freshTermsVector });
