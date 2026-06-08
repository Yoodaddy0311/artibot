#!/usr/bin/env node
/**
 * Render a prominent ASCII progress box for /team and PRD/autopilot work.
 *
 * The orchestrator prints this box directly in chat (NOT via a hook or the
 * statusline) so the user always sees a live, eye-catching "X%" readout of how
 * far the work has progressed — and a 🎉 100% box when it is finished.
 *
 * Usage:
 *   node render-progress.js <done> <total> [phaseLabel] [inflight] [pending]
 * Example:
 *   node render-progress.js 7 10 "Review" 3 0
 *
 * Pure + zero-dep; all formatting helpers are exported for testing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BAR_WIDTH = 20;
const RULE = '━'.repeat(40);

/** Coerce to a non-negative integer, or `fallback` when not a finite count. */
export function clampInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** done/total → integer percentage in [0, 100]. total<=0 → 0. */
export function computePct(done, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** Build a `█`/`░` bar of `width` cells for a given percentage. */
export function renderBar(pct, width = BAR_WIDTH) {
  const safe = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.max(0, Math.min(width, Math.round((safe / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Render the full progress box. When done >= total (and total > 0) the
 * completion variant is returned so the run visibly ends at 100%.
 *
 * @param {{done:number,total:number,phaseLabel?:string,inflight?:number,pending?:number}} opts
 * @returns {string} multi-line box (no trailing newline)
 */
export function renderProgressBox({ done, total, phaseLabel = '', inflight, pending } = {}) {
  const d = clampInt(done);
  const t = Math.max(d, clampInt(total)); // total can never be below done
  const pct = computePct(d, t);
  const bar = renderBar(pct);

  if (t > 0 && d >= t) {
    return [
      RULE,
      `  🎉 작업 완료   ${bar}  100%`,
      `  ✅ 완료 ${t} / 전체 ${t}   (전 작업 완료)`,
      RULE,
    ].join('\n');
  }

  const inf = inflight === undefined ? '' : `   🔄 진행 ${clampInt(inflight)}`;
  const pen = pending === undefined ? '' : `   ⏳ 대기 ${clampInt(pending)}`;
  const phase = phaseLabel ? `\n  └ 현재 단계: ${phaseLabel}` : '';
  return [
    RULE,
    `  📊 작업 진행률   ${bar}  ${pct}%`,
    `  ✅ 완료 ${d} / 전체 ${t}${inf}${pen}${phase}`,
    RULE,
  ].join('\n');
}

function main() {
  const [done, total, phaseLabel, inflight, pending] = process.argv.slice(2);
  process.stdout.write(renderProgressBox({ done, total, phaseLabel, inflight, pending }) + '\n');
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) main();
