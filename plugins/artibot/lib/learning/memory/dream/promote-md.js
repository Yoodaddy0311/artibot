/**
 * Dream Promote-MD (L3) — gated promotion of LLM proposals to staging.
 *
 * Sibling of promoter.js (PRD-DREAMING ADR-1 / §4.4): borrows the SAME gating
 * pattern (occurrences / distinctSessions / confidence floor / rejection
 * ledger) but targets memory-MD proposals instead of JSON episodes. promoter.js
 * is left untouched — this is a parallel engine.
 *
 * A "proposal" is the Phase-2 (session/LLM) output shaped as:
 *   {op: 'merge'|'replace'|'insert', targets[], evidence[], scope, confidence, body, name, type}
 *
 * Gating rules:
 *   - evidence[] MUST be non-empty (PRD acceptance #3) else discarded.
 *   - occurrences (distinct evidence sources) ≥ minOccurrences
 *   - distinctSessions (distinct originSessionId in evidence) ≥ distinctSessions
 *   - confidence ≥ confidenceFloor
 *   - signatureHash not present in the dream rejection ledger within window.
 *
 * Passing proposals are serialized to `<stagingDir>/<slug>.proposed.md` with
 * scope/confidence/evidence frontmatter. THIS STEP NEVER WRITES REAL MEMORY MD.
 *
 * @module lib/learning/memory/dream/promote-md
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWriteJson, ensureDir, readJsonFile } from '../../../core/file.js';
import { serializeMemoryDoc } from './memory-md-adapter.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  minOccurrences: 2,
  confidenceFloor: 0.85,
  distinctSessions: 2,
  rejectionWindowDays: 30,
});

/**
 * Resolve gating config from the dream block, mirroring promoter.js defaults
 * (dream uses minOccurrences 2 — MD insights are scarcer than episodes).
 * @param {object} [config]
 */
export function resolvePromoteConfig(config) {
  const block = config?.learning?.dream?.promotion;
  const safe = block && typeof block === 'object' ? block : {};
  return {
    minOccurrences: posInt(safe.minOccurrences, DEFAULTS.minOccurrences),
    confidenceFloor: Number.isFinite(safe.confidenceFloor)
      ? safe.confidenceFloor : DEFAULTS.confidenceFloor,
    distinctSessions: posInt(safe.distinctSessions, DEFAULTS.distinctSessions),
    rejectionWindowDays: Number.isFinite(safe.rejectionWindowDays) && safe.rejectionWindowDays >= 0
      ? safe.rejectionWindowDays : DEFAULTS.rejectionWindowDays,
  };
}

function posInt(v, fallback) {
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/** Stable signature for a proposal (op + sorted target names). */
function signatureOf(proposal) {
  const names = (proposal.targets || []).map((t) => t.name || t.file || '').sort();
  return `${proposal.op}||${proposal.name || ''}||${names.join(',')}`;
}

function hashSignature(sig) {
  return createHash('sha256').update(String(sig)).digest('hex').slice(0, 16);
}

/** Count distinct evidence sources + distinct sessions from evidence[]. */
function evidenceStats(evidence) {
  const sources = new Set();
  const sessions = new Set();
  for (const e of evidence || []) {
    if (e?.source || e?.file) sources.add(e.source || e.file);
    if (e?.originSessionId) sessions.add(e.originSessionId);
  }
  return { occurrences: sources.size, distinctSessions: sessions.size };
}

function isRecentlyRejected(rejections, signatureHash, now, windowDays) {
  if (!rejections?.length) return false;
  const windowMs = windowDays * DAY_MS;
  return rejections.some((r) => {
    if (!r || r.signatureHash !== signatureHash) return false;
    const ts = Number(r.rejectedAt) || Date.parse(r.rejectedAt || '');
    return Number.isFinite(ts) && (now - ts) <= windowMs;
  });
}

/**
 * Evaluate a single proposal against the gates. Pure.
 * @param {object} proposal
 * @param {object} cfg
 * @returns {{passes:boolean, reason:string|null, occurrences:number, distinctSessions:number}}
 */
export function evaluateProposal(proposal, cfg) {
  if (!proposal || typeof proposal !== 'object') {
    return { passes: false, reason: 'invalid', occurrences: 0, distinctSessions: 0 };
  }
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) {
    return { passes: false, reason: 'no-evidence', occurrences: 0, distinctSessions: 0 };
  }
  const conf = Number.isFinite(proposal.confidence) ? proposal.confidence : 0;
  const { occurrences, distinctSessions } = evidenceStats(proposal.evidence);
  if (conf < cfg.confidenceFloor) {
    return { passes: false, reason: 'below-confidence', occurrences, distinctSessions };
  }
  if (occurrences < cfg.minOccurrences) {
    return { passes: false, reason: 'below-occurrences', occurrences, distinctSessions };
  }
  if (distinctSessions < cfg.distinctSessions) {
    return { passes: false, reason: 'below-sessions', occurrences, distinctSessions };
  }
  return { passes: true, reason: null, occurrences, distinctSessions };
}

/** Build the staged proposed-MD record with scope/confidence/evidence. */
function buildProposedRecord(proposal, stats) {
  const slug = proposal.name || `proposal-${hashSignature(signatureOf(proposal)).slice(0, 8)}`;
  const evidenceLines = (proposal.evidence || [])
    .map((e) => `> ${e.source || e.file || '?'}: ${String(e.quote || '').slice(0, 200)}`)
    .join('\n');
  const body = [
    `\n${proposal.body || ''}`.trimEnd(),
    '',
    '## Dream evidence',
    evidenceLines || '> (none)',
    '',
  ].join('\n');
  const record = {
    front: {
      name: slug,
      description: proposal.description || `dream:${proposal.op}`,
    },
    metadata: {
      node_type: 'memory',
      type: proposal.type || 'project',
      dream_op: proposal.op,
      scope: proposal.scope || 'unspecified',
      confidence: String(proposal.confidence ?? ''),
      occurrences: String(stats.occurrences),
      distinct_sessions: String(stats.distinctSessions),
      ...(proposal.contradicts ? { contradicts: `[[${proposal.contradicts}]]` } : {}),
    },
    body,
  };
  return { slug, record };
}

/**
 * Create a promote-md engine bound to a staging dir + ledger paths.
 *
 * @param {object} options
 * @param {string} options.stagingDir - Where `<slug>.proposed.md` is written.
 * @param {string} options.rejectionsPath - Dream rejection ledger JSON.
 * @param {string} [options.ledgerPath] - Append-only transition log.
 * @param {object} [options.config]
 * @param {() => number} [options.now]
 * @returns {object} frozen engine
 */
export function createPromoteMd(options = {}) {
  if (!options.stagingDir) throw new Error('createPromoteMd requires options.stagingDir');
  if (!options.rejectionsPath) throw new Error('createPromoteMd requires options.rejectionsPath');
  const stagingDir = options.stagingDir;
  const rejectionsPath = options.rejectionsPath;
  const ledgerPath = options.ledgerPath || null;
  const cfg = resolvePromoteConfig(options.config);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  async function loadRejections() {
    const data = await readJsonFile(rejectionsPath);
    return Array.isArray(data?.rejections) ? data.rejections : [];
  }

  async function appendLedger(line) {
    if (!ledgerPath) return;
    await ensureDir(path.dirname(ledgerPath));
    await fs.appendFile(ledgerPath, `${JSON.stringify(line)}\n`, 'utf-8');
  }

  /**
   * Gate a batch of proposals; write passing ones to staging as proposed MD.
   * @param {object[]} proposals
   * @returns {Promise<{staged:object[], skipped:object[]}>}
   */
  async function promote(proposals) {
    const list = Array.isArray(proposals) ? proposals : [];
    const rejections = await loadRejections();
    const ts = now();
    const staged = [];
    const skipped = [];

    for (const proposal of list) {
      const sig = signatureOf(proposal);
      const signatureHash = hashSignature(sig);
      if (isRecentlyRejected(rejections, signatureHash, ts, cfg.rejectionWindowDays)) {
        skipped.push({ signatureHash, reason: 'recent-rejection' });
        continue;
      }
      const evalResult = evaluateProposal(proposal, cfg);
      if (!evalResult.passes) {
        skipped.push({ signatureHash, reason: evalResult.reason, ...evalResult });
        continue;
      }
      const { slug, record } = buildProposedRecord(proposal, evalResult);
      const target = path.join(stagingDir, `${slug}.proposed.md`);
      await ensureDir(stagingDir);
      await writeText(target, serializeMemoryDoc(record));
      await appendLedger({
        ts: new Date(ts).toISOString(), kind: 'stage', op: proposal.op,
        signatureHash, confidence: proposal.confidence, target,
      });
      staged.push({ slug, signatureHash, target, op: proposal.op, ...evalResult });
    }
    return { staged, skipped };
  }

  /**
   * Persist a rejection so a declined proposal is not re-staged next sweep.
   * @param {object} proposal
   * @param {string} reason
   */
  async function registerRejection(proposal, reason) {
    const sig = signatureOf(proposal);
    const signatureHash = hashSignature(sig);
    const rejections = await loadRejections();
    const ts = now();
    await atomicWriteJson(rejectionsPath, {
      rejections: [...rejections, {
        signatureHash, signature: sig, op: proposal.op,
        reason: reason || 'user-declined', rejectedAt: ts,
      }],
    });
    await appendLedger({
      ts: new Date(ts).toISOString(), kind: 'reject', op: proposal.op,
      signatureHash, reason: reason || 'user-declined',
    });
    return { rejected: true, signatureHash };
  }

  return Object.freeze({
    promote,
    registerRejection,
    get config() { return { ...cfg }; },
  });
}

/** Atomic-ish text write (tmp+rename) so staged MD is never half-written. */
async function writeText(targetPath, text) {
  await ensureDir(path.dirname(targetPath));
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf-8');
  await fs.rename(tmp, targetPath);
}

export const _internals = Object.freeze({ DEFAULTS, signatureOf, evidenceStats });
