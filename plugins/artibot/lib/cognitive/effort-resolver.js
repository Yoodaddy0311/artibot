/**
 * Score-Aware Effort Resolution (cognitive layer, pure).
 * @module lib/cognitive/effort-resolver
 */
import { getEffortForCommand } from './router.js';

export const EFFORT_BANDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const HYSTERESIS = 0.05;

function clampIndex(i) { return Math.max(0, Math.min(EFFORT_BANDS.length - 1, i)); }

/** @param {{score?:number, remainingContextRatio?:number}} s @returns {{shift:number, reasons:string[]}} */
function computeShift(s) {
  const reasons = []; let shift = 0;
  if (typeof s.score === 'number' && !Number.isNaN(s.score)) {
    if (s.score >= 0.7) { shift += 1; reasons.push('score>=0.7 (+1)'); }
    else if (s.score <= 0.25) { shift -= 1; reasons.push('score<=0.25 (-1)'); }
  }
  if (typeof s.remainingContextRatio === 'number' && s.remainingContextRatio < 0.15) {
    shift -= 1; reasons.push('ctx<0.15 (-1)');
  }
  return { shift, reasons };
}

/**
 * @param {string} command - slash command (leading '/' optional)
 * @param {object} [signals] - {score?, remainingContextRatio?, prevEffort?}
 * @returns {{effort:string, baseline:string, shift:number, reason:string}}
 */
export function resolveEffort(command, signals = {}) {
  const baseline = getEffortForCommand(command);
  const baseIdx = EFFORT_BANDS.indexOf(baseline);
  const hasSignal = (typeof signals.score === 'number' && !Number.isNaN(signals.score))
    || (typeof signals.remainingContextRatio === 'number' && !Number.isNaN(signals.remainingContextRatio));
  if (baseIdx < 0 || !hasSignal) return { effort: baseline, baseline, shift: 0, reason: 'baseline' };

  const { shift: rawShift, reasons } = computeShift(signals);
  const shift = Math.max(-1, Math.min(1, rawShift));

  // Hysteresis: suppress flap when score is within ±0.05 of a boundary it crossed AND prevEffort==baseline
  if (shift !== 0 && typeof signals.score === 'number' && signals.prevEffort === baseline) {
    const nearHigh = Math.abs(signals.score - 0.7) <= HYSTERESIS;
    const nearLow = Math.abs(signals.score - 0.25) <= HYSTERESIS;
    if (nearHigh || nearLow) return { effort: baseline, baseline, shift: 0, reason: 'hysteresis-hold' };
  }

  const targetIdx = baseIdx + shift;
  const clampedIdx = clampIndex(targetIdx);
  const effort = EFFORT_BANDS[clampedIdx];
  const wasClamped = targetIdx !== clampedIdx;
  const reason = wasClamped ? `${reasons.join(',')} [clamped]` : (reasons.join(',') || 'baseline');
  return { effort, baseline, shift, reason };
}
