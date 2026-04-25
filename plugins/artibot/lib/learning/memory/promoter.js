/**
 * Episodic -> Semantic promotion worker.
 *
 * Scans the episodic layer, groups episodes by a stable signature (reusing
 * pattern-analyzer.extractPattern when possible), and promotes groups that
 * pass the gated criteria defined in design 3.2 / Section 6.3:
 *
 *   - occurrences        >= config.promotion.minOccurrences        (default 3)
 *   - confidence         >= config.promotion.confidenceFloor       (default 0.85)
 *   - distinctSessions   >= config.promotion.distinctSessions      (default 2)
 *   - no rejection of the same signature inside `rejectionWindowDays`
 *
 * Respects a user-approved rejection ledger at
 * `plugins/artibot/runtime/promotion-rejections.json` so declines persist
 * across sweeps. Every accepted promotion is appended to the ledger at
 * `plugins/artibot/runtime/memory-transitions.log` (JSONL).
 *
 * Zero external deps. All writes are atomic. No network IO.
 *
 * @module lib/learning/memory/promoter
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  atomicWriteJson,
  ensureDir,
  readJsonFile,
} from '../../core/file.js';
import { getPluginRoot } from '../../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  minOccurrences: 3,
  confidenceFloor: 0.85,
  distinctSessions: 2,
  rejectionWindowDays: 30,
});

function resolvePromotionConfig(config) {
  const block = config?.learning?.hierarchicalMemory?.promotion;
  const safe = block && typeof block === 'object' ? block : {};
  return {
    minOccurrences: Number.isFinite(safe.minOccurrences) && safe.minOccurrences >= 1
      ? safe.minOccurrences : DEFAULTS.minOccurrences,
    confidenceFloor: Number.isFinite(safe.confidenceFloor)
      ? safe.confidenceFloor : DEFAULTS.confidenceFloor,
    distinctSessions: Number.isFinite(safe.distinctSessions) && safe.distinctSessions >= 1
      ? safe.distinctSessions : DEFAULTS.distinctSessions,
    rejectionWindowDays: Number.isFinite(safe.rejectionWindowDays) && safe.rejectionWindowDays >= 0
      ? safe.rejectionWindowDays : DEFAULTS.rejectionWindowDays,
  };
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function simpleSignature(episode) {
  const title = String(episode.title || '').toLowerCase().trim();
  const summaryHead = String(episode.summary || '').toLowerCase().split('\n')[0]?.slice(0, 120) || '';
  return `${title}||${summaryHead}`.slice(0, 240);
}

function hashSignature(signature) {
  return createHash('sha256').update(String(signature)).digest('hex').slice(0, 16);
}

/**
 * Try to reuse pattern-analyzer if present in the project; fall back to a
 * title+summary hash when not available (keeps the module usable in isolated
 * tests without the full learning tree loaded).
 * @param {object} episode
 * @returns {Promise<string>} Stable signature string
 */
async function deriveSignature(episode) {
  try {
    const mod = await import('../pattern-analyzer.js');
    if (mod && typeof mod.extractPattern === 'function') {
      const ranked = {
        bestEntry: {
          composite: typeof episode.importanceScore === 'number' ? episode.importanceScore : 0,
          experience: { data: { title: episode.title } },
          scores: { success: 0 },
        },
        groupMean: 0,
        entries: [{ composite: 0, experience: {} }],
      };
      const pattern = mod.extractPattern(simpleSignature(episode), ranked);
      if (pattern && pattern.key) return String(pattern.key);
    }
  } catch {
    /* fall through to simple signature */
  }
  return simpleSignature(episode);
}

function groupBySignature(episodesWithSignature) {
  const groups = new Map();
  for (const entry of episodesWithSignature) {
    const key = entry.signature;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function computeConfidence(occurrences, distinctSessions, floor) {
  // Monotonic ramp — saturates near 0.99 once we exceed 2x the floor count.
  const base = 0.6 + (occurrences - 1) * 0.1;
  const sessionBonus = Math.max(0, (distinctSessions - 1) * 0.05);
  const raw = Math.min(0.99, base + sessionBonus);
  return Math.max(floor - 0.01, Math.min(0.99, raw));
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function defaultRuntimePaths() {
  let root;
  try { root = getPluginRoot(); } catch { root = process.cwd(); }
  return {
    rejectionsPath: path.join(root, 'runtime', 'promotion-rejections.json'),
    ledgerPath: path.join(root, 'runtime', 'memory-transitions.log'),
  };
}

async function loadRejections(rejectionsPath) {
  const data = await readJsonFile(rejectionsPath);
  if (!data || typeof data !== 'object') return { rejections: [] };
  return {
    rejections: Array.isArray(data.rejections) ? data.rejections : [],
  };
}

async function writeRejections(rejectionsPath, state) {
  await atomicWriteJson(rejectionsPath, state);
}

async function appendLedger(ledgerPath, line) {
  await ensureDir(path.dirname(ledgerPath));
  await fs.appendFile(ledgerPath, `${JSON.stringify(line)}\n`, 'utf-8');
}

function isRecentlyRejected(rejections, signatureHash, now, windowDays) {
  if (!rejections?.length) return false;
  const windowMs = windowDays * DAY_MS;
  return rejections.some((r) => {
    if (!r || r.signatureHash !== signatureHash) return false;
    const ts = Number(r.rejectedAt) || Date.parse(r.rejectedAt || '');
    if (!Number.isFinite(ts)) return false;
    return (now - ts) <= windowMs;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a promoter that consumes an episodic store and emits facts into a
 * semantic store when thresholds pass.
 *
 * @param {object} options
 * @param {import('./episodic.js').EpisodicStore} options.episodicStore
 * @param {{put: (entry: object) => Promise<object|null>}} options.semanticStore
 * @param {object} [options.config] - artibot config snapshot
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {string} [options.rejectionsPath]
 * @param {string} [options.ledgerPath]
 * @returns {object}
 */
export function createPromoter(options) {
  if (!options || !options.episodicStore || !options.semanticStore) {
    throw new Error('createPromoter requires episodicStore and semanticStore');
  }
  const { episodicStore, semanticStore } = options;
  const config = resolvePromotionConfig(options.config || {});
  const logger = options.logger || { info() {}, warn() {} };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const paths = {
    ...defaultRuntimePaths(),
    ...(options.rejectionsPath ? { rejectionsPath: options.rejectionsPath } : {}),
    ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
  };

  async function annotateEpisodes(episodes) {
    const out = [];
    for (const ep of episodes) {
      const signature = await deriveSignature(ep);
      out.push({ episode: ep, signature, signatureHash: hashSignature(signature) });
    }
    return out;
  }

  function evaluateGroup(entries, promotionCfg) {
    const sessions = new Set(entries.map((e) => e.episode.sessionId).filter(Boolean));
    const occurrences = entries.length;
    const distinctSessions = sessions.size;
    const confidence = computeConfidence(
      occurrences,
      distinctSessions,
      promotionCfg.confidenceFloor,
    );
    const passes = occurrences >= promotionCfg.minOccurrences
      && distinctSessions >= promotionCfg.distinctSessions
      && confidence >= promotionCfg.confidenceFloor;
    return { occurrences, distinctSessions, confidence, passes };
  }

  async function runPromotionSweep() {
    const episodes = await episodicStore.listEpisodes();
    if (!episodes.length) return { promoted: [], skipped: [] };

    const annotated = await annotateEpisodes(episodes);
    const groups = groupBySignature(annotated);
    const rejections = await loadRejections(paths.rejectionsPath);
    const ts = now();

    const promoted = [];
    const skipped = [];

    for (const [signature, entries] of groups.entries()) {
      const signatureHash = entries[0].signatureHash;

      if (isRecentlyRejected(rejections.rejections, signatureHash, ts, config.rejectionWindowDays)) {
        skipped.push({ signature, signatureHash, reason: 'recent-rejection' });
        continue;
      }

      const result = evaluateGroup(entries, config);
      if (!result.passes) {
        skipped.push({ signature, signatureHash, reason: 'below-threshold', ...result });
        continue;
      }

      const semanticEntry = {
        layer: 'semantic',
        signature,
        signatureHash,
        title: entries[0].episode.title,
        summary: entries[0].episode.summary,
        keywords: entries[0].episode.keywords,
        usageCount: result.occurrences,
        distinctSessions: result.distinctSessions,
        confidence: result.confidence,
        provenance: entries.map((e) => e.episode.id),
        createdAt: new Date(ts).toISOString(),
        source: 'promoter',
      };

      const stored = await semanticStore.put(semanticEntry);
      const id = stored?.id || semanticEntry.signatureHash;

      for (const e of entries) {
        try { await episodicStore.linkToSemantic(e.episode.id, signatureHash); } catch { /* best-effort */ }
      }

      await appendLedger(paths.ledgerPath, {
        ts: new Date(ts).toISOString(),
        kind: 'promote',
        from: 'episodic',
        to: 'semantic',
        id,
        score: result.confidence,
        reason: `occurrences=${result.occurrences}|sessions=${result.distinctSessions}`,
      });

      promoted.push({ signature, signatureHash, id, ...result, stored });
    }

    logger.info?.(`[promoter] sweep done — promoted=${promoted.length} skipped=${skipped.length}`);
    return { promoted, skipped };
  }

  async function registerRejection(episodeId, reason) {
    if (!episodeId) return false;
    const episodes = await episodicStore.listEpisodes();
    const target = episodes.find((e) => e.id === episodeId);
    if (!target) return false;
    const signature = await deriveSignature(target);
    const signatureHash = hashSignature(signature);
    const state = await loadRejections(paths.rejectionsPath);
    const ts = now();
    const entry = {
      episodeId,
      signatureHash,
      signature,
      reason: reason || 'user-declined',
      rejectedAt: ts,
    };
    await writeRejections(paths.rejectionsPath, {
      rejections: [...state.rejections, entry],
    });
    await appendLedger(paths.ledgerPath, {
      ts: new Date(ts).toISOString(),
      kind: 'reject',
      from: 'episodic',
      to: 'semantic',
      id: episodeId,
      reason: entry.reason,
    });
    return true;
  }

  return Object.freeze({
    runPromotionSweep,
    registerRejection,
    get config() { return { ...config }; },
  });
}
