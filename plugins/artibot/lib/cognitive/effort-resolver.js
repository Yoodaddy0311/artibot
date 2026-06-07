/**
 * Score-Aware Effort Resolution (cognitive layer, pure).
 * @module lib/cognitive/effort-resolver
 */
import { getEffortForCommand } from './effort-policy.js';
import { getCachedEffortPolicyOverlay } from './effort-policy-config.js';

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
 * Resolve the learned band shift for a command from the (synchronously cached)
 * effort-policy overlay. Returns 0 when the overlay is disabled/identity or has
 * no entry for `command`. The value is itself clamped to ±1 by the config
 * reader; we re-clamp defensively. Never throws.
 *
 * @param {string} command - slash command key (no leading '/')
 * @returns {number} learned shift in {-1, 0, +1}
 */
function learnedShiftFor(command) {
  try {
    const overlay = getCachedEffortPolicyOverlay();
    if (!overlay || overlay.enabled !== true) return 0;
    const raw = overlay.bandShifts?.[command];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    return Math.max(-1, Math.min(1, Math.round(raw)));
  } catch {
    return 0;
  }
}

/**
 * @param {string} command - slash command (leading '/' optional)
 * @param {object} [signals] - {score?, remainingContextRatio?, prevEffort?}
 * @returns {{effort:string, baseline:string, shift:number, reason:string}}
 */
export function resolveEffort(command, signals = {}) {
  const baseline = getEffortForCommand(command);
  const baseIdx = EFFORT_BANDS.indexOf(baseline);
  const key = String(command || '').replace(/^\//, '').trim();
  const learned = baseIdx < 0 ? 0 : learnedShiftFor(key);

  const hasSignal = (typeof signals.score === 'number' && !Number.isNaN(signals.score))
    || (typeof signals.remainingContextRatio === 'number' && !Number.isNaN(signals.remainingContextRatio));

  // No heuristic signal: identity unless the learned overlay biases this command.
  if (baseIdx < 0 || !hasSignal) {
    if (learned === 0) return { effort: baseline, baseline, shift: 0, reason: 'baseline' };
    const idx = clampIndex(baseIdx + learned);
    const reason = `learnedShift (${learned > 0 ? '+' : ''}${learned})`;
    return { effort: EFFORT_BANDS[idx], baseline, shift: learned, reason };
  }

  const { shift: heuristicRaw, reasons } = computeShift(signals);
  const heuristicShift = Math.max(-1, Math.min(1, heuristicRaw));

  // Hysteresis: suppress flap when score is within ±0.05 of a boundary it crossed AND prevEffort==baseline
  if (heuristicShift !== 0 && typeof signals.score === 'number' && signals.prevEffort === baseline) {
    const nearHigh = Math.abs(signals.score - 0.7) <= HYSTERESIS;
    const nearLow = Math.abs(signals.score - 0.25) <= HYSTERESIS;
    if (nearHigh || nearLow) {
      // Hysteresis holds the heuristic shift at 0; the learned overlay may still bias.
      if (learned === 0) return { effort: baseline, baseline, shift: 0, reason: 'hysteresis-hold' };
      const idx = clampIndex(baseIdx + learned);
      const reason = `hysteresis-hold,learnedShift (${learned > 0 ? '+' : ''}${learned})`;
      return { effort: EFFORT_BANDS[idx], baseline, shift: learned, reason };
    }
  }

  // Sum heuristic + learned, then a SINGLE ladder clamp [0,4] (no per-term
  // overshoot). reason carries the combined breakdown.
  const totalShift = heuristicShift + learned;
  const targetIdx = baseIdx + totalShift;
  const clampedIdx = clampIndex(targetIdx);
  const effort = EFFORT_BANDS[clampedIdx];
  const wasClamped = targetIdx !== clampedIdx;
  const parts = [...reasons];
  if (learned !== 0) parts.push(`learnedShift (${learned > 0 ? '+' : ''}${learned})`);
  const base = parts.length > 0 ? parts.join(',') : 'baseline';
  const reason = wasClamped ? `${base} [clamped]` : base;
  return { effort, baseline, shift: totalShift, reason };
}
