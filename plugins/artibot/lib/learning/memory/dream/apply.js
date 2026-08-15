/**
 * Dream Apply (L3) — review-gated, archive-never-delete application.
 *
 * The ONLY module that may write into the live memory dir, and only behind a
 * review gate (PRD-DREAMING §4.5). Default mode is dry-run: it produces a
 * human-readable `report.md` diff summary in staging and touches NO live MD.
 *
 * Application semantics (only when `apply: true`):
 *   - REPLACED / MERGED-AWAY originals are MOVED to `<memoryDir>/.dream-archive/<date>/`
 *     (hard-delete count is always 0; PRD acceptance #6).
 *   - New / merged MD is written into the live memory dir.
 *   - `MEMORY.md` is regenerated from the resulting active set (adapter rule).
 *   - A line is appended to the transition log (append-only audit trail).
 *   - rules/CLAUDE.md proposals are NEVER applied — only reported (acceptance #7).
 *
 * autoAccept (PRD §4.5, default OFF): insert-only, confidence ≥ 0.95, external
 * signal required. Enforced in {@link canAutoAccept}; callers gate on config.
 *
 * @module lib/learning/memory/dream/apply
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir } from '../../../core/file.js';

const AUTO_ACCEPT_CONFIDENCE = 0.95;
/** Targets that must never be auto-applied — surfaced as suggestions only. */
const MANUAL_ONLY_TARGETS = Object.freeze(['CLAUDE.md', 'rules/']);

/**
 * Decide whether a proposal is eligible for autoAccept. Conservative:
 * insert-only, high confidence, and at least one external-signal evidence.
 *
 * @param {object} proposal
 * @param {object} cfg - resolved dream config
 * @returns {boolean}
 */
export function canAutoAccept(proposal, cfg) {
  if (!cfg?.autoAccept?.enabled) return false;
  if (proposal?.op !== 'insert') return false;
  const conf = Number.isFinite(proposal.confidence) ? proposal.confidence : 0;
  if (conf < AUTO_ACCEPT_CONFIDENCE) return false;
  const ev = Array.isArray(proposal.evidence) ? proposal.evidence : [];
  return ev.some((e) => e?.externalSignal === true);
}

/** True if a proposal touches a manual-only target (CLAUDE.md / rules). */
export function isManualOnly(proposal) {
  const targets = [proposal?.name, ...(proposal?.targets || []).map((t) => t.file || t.name)];
  return targets.some((t) => t && MANUAL_ONLY_TARGETS.some((m) => String(t).includes(m)));
}

/**
 * Render a human-readable report of proposals for the review gate.
 * @param {object[]} proposals
 * @param {object} cfg
 * @returns {string}
 */
export function renderReport(proposals, cfg) {
  const lines = ['# Dream Consolidation Report', ''];
  if (!proposals.length) {
    lines.push('_No proposals this run._', '');
    return lines.join('\n');
  }
  for (const p of proposals) {
    const manual = isManualOnly(p);
    lines.push(`## ${p.op.toUpperCase()} — ${p.name || '(unnamed)'}`);
    lines.push(`- confidence: ${p.confidence ?? 'n/a'} | scope: ${p.scope || 'unspecified'}`);
    if (Array.isArray(p.targets) && p.targets.length) {
      lines.push(`- targets: ${p.targets.map((t) => t.file || t.name).join(', ')}`);
    }
    lines.push(`- evidence: ${(p.evidence || []).length} source(s)`);
    if (manual) {
      lines.push('- ⚠️ MANUAL MERGE RECOMMENDED — rules/CLAUDE.md are never auto-applied.');
    } else if (canAutoAccept(p, cfg)) {
      lines.push('- eligible for autoAccept (insert-only, conf≥0.95, external signal).');
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Write the report into staging (never the live dir). */
async function writeReport(stagingDir, text) {
  await ensureDir(stagingDir);
  const target = path.join(stagingDir, 'report.md');
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf-8');
  await fs.rename(tmp, target);
  return target;
}

/** Append a JSONL transition line (append-only audit trail). */
async function appendTransition(ledgerPath, line) {
  if (!ledgerPath) return;
  await ensureDir(path.dirname(ledgerPath));
  await fs.appendFile(ledgerPath, `${JSON.stringify(line)}\n`, 'utf-8');
}

/** Move a source file into the dated archive dir (never delete). */
async function archiveFile(memoryDir, file, dateStamp) {
  const src = path.join(memoryDir, file);
  if (!(await fileExists(src))) return null;
  const archiveDir = path.join(memoryDir, '.dream-archive', dateStamp);
  await ensureDir(archiveDir);
  const dest = path.join(archiveDir, file);
  await fs.rename(src, dest);
  return dest;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Create an apply engine bound to the live memory dir + staging + ledger.
 *
 * @param {object} options
 * @param {string} options.memoryDir - LIVE memory dir (written only when apply=true).
 * @param {string} options.stagingDir
 * @param {string} [options.ledgerPath]
 * @param {object} [options.adapter] - injected memory-md-adapter (for index regen)
 * @param {object} [options.config] - resolved dream config (for autoAccept)
 * @param {() => Date} [options.now]
 * @returns {object} frozen engine
 */
export function createApplyEngine(options = {}) {
  if (!options.memoryDir) throw new Error('createApplyEngine requires options.memoryDir');
  if (!options.stagingDir) throw new Error('createApplyEngine requires options.stagingDir');
  const { memoryDir, stagingDir } = options;
  const ledgerPath = options.ledgerPath || null;
  const adapter = options.adapter || null;
  const cfg = options.config || {};
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function dateStamp() {
    const d = now();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /**
   * Dry-run: write report.md only. NO live MD writes. (default path)
   * @param {object[]} proposals
   * @returns {Promise<{mode:'dry-run', reportPath:string, applied:0, archived:0}>}
   */
  async function dryRun(proposals) {
    const reportPath = await writeReport(stagingDir, renderReport(proposals, cfg));
    return { mode: 'dry-run', reportPath, applied: 0, archived: 0 };
  }

  /**
   * Apply accepted proposals: archive replaced originals, write new MD,
   * regenerate the index. rules/CLAUDE.md proposals are skipped (reported).
   *
   * @param {object[]} accepted - proposals the gate approved
   * @returns {Promise<{mode:'apply', applied:number, archived:number, skippedManual:number, hardDeleted:0}>}
   */
  async function apply(accepted) {
    const list = Array.isArray(accepted) ? accepted : [];
    const stamp = dateStamp();
    let applied = 0;
    let archived = 0;
    let skippedManual = 0;

    for (const p of list) {
      if (isManualOnly(p)) {
        skippedManual += 1;
        await appendTransition(ledgerPath, {
          ts: now().toISOString(), kind: 'skip-manual', op: p.op, name: p.name,
        });
        continue;
      }
      // Archive originals that this proposal replaces/merges away.
      const toArchive = p.op === 'insert' ? [] : (p.targets || []).map((t) => t.file).filter(Boolean);
      for (const file of toArchive) {
        const dest = await archiveFile(memoryDir, file, stamp);
        if (dest) archived += 1;
      }
      // Write the new/merged MD from its staged proposed copy.
      if (p.stagedPath && p.targetFile) {
        const staged = await fs.readFile(p.stagedPath, 'utf-8');
        await writeLive(path.join(memoryDir, p.targetFile), staged);
        applied += 1;
      }
      await appendTransition(ledgerPath, {
        ts: now().toISOString(), kind: 'apply', op: p.op, name: p.name,
        archived: toArchive,
      });
    }

    if (applied + archived > 0 && adapter) {
      await regenerateIndex();
    }

    return { mode: 'apply', applied, archived, skippedManual, hardDeleted: 0 };
  }

  async function regenerateIndex() {
    const records = await adapter.readAll();
    const priorRows = await adapter.readIndex();
    // Raw prior text keeps the user's / installer's prose sections alive; the
    // adapter splices rows into it instead of rendering a header-only index.
    const priorText = typeof adapter.readIndexText === 'function'
      ? await adapter.readIndexText()
      : '';
    const text = adapter.regenerateIndex(records, { preserveOrderFrom: priorRows, priorText });
    await writeLive(adapter.indexPath, text);
  }

  return Object.freeze({ dryRun, apply, canAutoAccept: (p) => canAutoAccept(p, cfg) });
}

/** Write a live MD file atomically (tmp+rename). */
async function writeLive(targetPath, text) {
  await ensureDir(path.dirname(targetPath));
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf-8');
  await fs.rename(tmp, targetPath);
}

export const _internals = Object.freeze({ AUTO_ACCEPT_CONFIDENCE, MANUAL_ONLY_TARGETS });
