/**
 * Hybrid Goal Evaluator (Track L — Claude /goal Native Integration, v4.11.0).
 *
 * Combines Claude Haiku judgment with exit-code validation for the
 * /goal workflow. Strategy:
 *
 *   1. Run Haiku judge first (fast, ~200ms).
 *   2. If Haiku confidence >= HAIKU_TRUST_THRESHOLD (default 0.85),
 *      trust it and return immediately.
 *   3. Else run the validation command (exit-code based).
 *   4. If both agree → 'consensus'.
 *      If they disagree → trust validation (deterministic > LLM).
 *
 * All external work is dependency-injected:
 *   - `runValidation(cmd)`   : returns `{exitCode, stdout, stderr}`
 *   - `runHaikuJudge(c,ctx)` : returns `{met, confidence}`
 *
 * Per DATA POLICY: this module makes ZERO real LLM/exec calls itself.
 * Caller supplies real or mock implementations.
 *
 * @module lib/cognitive/hybrid-goal-evaluator
 */

/**
 * Haiku confidence at or above this is "trust-and-return" territory.
 */
export const HAIKU_TRUST_THRESHOLD = 0.85;

/**
 * Build a failure result with the supplied reasoning string.
 *
 * @param {string} reasoning
 * @returns {{met:false,confidence:0,evaluator:'haiku',reasoning:string}}
 */
function inputError(reasoning) {
  return {
    met: false,
    confidence: 0,
    evaluator: 'haiku',
    reasoning,
  };
}

/**
 * Coerce Haiku output to a canonical shape. Defends against malformed
 * judge responses (e.g. confidence > 1, missing fields).
 *
 * @param {any} raw
 * @returns {{met: boolean, confidence: number}}
 */
function normalizeHaiku(raw) {
  if (!raw || typeof raw !== 'object') {
    return { met: false, confidence: 0 };
  }
  const met = raw.met === true;
  let conf = typeof raw.confidence === 'number' ? raw.confidence : 0;
  if (!Number.isFinite(conf) || conf < 0) conf = 0;
  if (conf > 1) conf = 1;
  return { met, confidence: conf };
}

/**
 * Coerce validation output to a canonical shape.
 *
 * @param {any} raw
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
function normalizeValidation(raw) {
  if (!raw || typeof raw !== 'object') {
    return { exitCode: 1, stdout: '', stderr: 'validation returned non-object' };
  }
  return {
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : 1,
    stdout: String(raw.stdout ?? ''),
    stderr: String(raw.stderr ?? ''),
  };
}

/**
 * Build a result from Haiku-only evaluation.
 *
 * @param {{met:boolean, confidence:number}} h
 * @returns {object}
 */
function haikuResult(h) {
  return {
    met: h.met,
    confidence: h.confidence,
    evaluator: 'haiku',
    reasoning: `Haiku high-confidence (${h.confidence.toFixed(2)}): ` +
      `${h.met ? 'condition met' : 'condition not met'}`,
  };
}

/**
 * Build a result from validation-only evaluation (no Haiku available).
 *
 * @param {{exitCode:number,stdout:string,stderr:string}} v
 * @returns {object}
 */
function validationResult(v) {
  return {
    met: v.exitCode === 0,
    confidence: 1.0,
    evaluator: 'validation',
    reasoning: `validation exit ${v.exitCode}`,
  };
}

/**
 * Build a consensus result when Haiku and validation agree.
 *
 * @param {{met:boolean,confidence:number}} h
 * @param {{exitCode:number}} v
 * @returns {object}
 */
function consensusResult(h, v) {
  return {
    met: v.exitCode === 0,
    confidence: 1.0,
    evaluator: 'consensus',
    reasoning: `consensus: Haiku (${h.confidence.toFixed(2)}, met=${h.met}) ` +
      `and validation (exit ${v.exitCode}) agree`,
  };
}

/**
 * Build a conflict-resolution result: trust validation over Haiku.
 *
 * @param {{met:boolean,confidence:number}} h
 * @param {{exitCode:number}} v
 * @returns {object}
 */
function conflictResult(h, v) {
  return {
    met: v.exitCode === 0,
    confidence: 0.9,
    evaluator: 'validation',
    reasoning: `conflict: Haiku said met=${h.met} (${h.confidence.toFixed(2)}) ` +
      `but validation exit ${v.exitCode} — trusting validation`,
  };
}

/**
 * Evaluate a stopping condition using the hybrid strategy.
 *
 * @param {string} condition stopping-condition phrase
 * @param {object} contextSnapshot opaque context passed to Haiku judge
 * @param {{
 *   runValidation?: (cmd:string)=>{exitCode:number,stdout:string,stderr:string},
 *   runHaikuJudge?: (cond:string,ctx:object)=>{met:boolean,confidence:number},
 *   validationCommand?: string|null,
 *   haikuTrustThreshold?: number
 * }} [opts]
 * @returns {{
 *   met: boolean,
 *   confidence: number,
 *   evaluator: 'haiku'|'validation'|'consensus',
 *   reasoning: string
 * }}
 */
export function evaluateHybrid(condition, contextSnapshot, opts = {}) {
  if (!condition || typeof condition !== 'string' || !condition.trim()) {
    return inputError('empty condition');
  }
  const threshold = typeof opts.haikuTrustThreshold === 'number'
    ? opts.haikuTrustThreshold
    : HAIKU_TRUST_THRESHOLD;
  const ctx = contextSnapshot && typeof contextSnapshot === 'object'
    ? contextSnapshot
    : {};

  // Step 1: run Haiku if available.
  let haiku = null;
  if (typeof opts.runHaikuJudge === 'function') {
    try {
      haiku = normalizeHaiku(opts.runHaikuJudge(condition, ctx));
    } catch (err) {
      haiku = null;
      const reason = err?.message || 'haiku threw';
      // Fall through to validation-only path; record reason below.
      ctx.__haikuError = reason;
    }
  }

  // Step 2: Haiku trusted on its own.
  if (haiku && haiku.confidence >= threshold) {
    return haikuResult(haiku);
  }

  // Step 3: run validation if a command + runner are present.
  const cmd = typeof opts.validationCommand === 'string'
    ? opts.validationCommand.trim()
    : '';
  const hasValidation = cmd && typeof opts.runValidation === 'function';
  if (!hasValidation) {
    if (haiku) {
      return {
        met: haiku.met,
        confidence: haiku.confidence,
        evaluator: 'haiku',
        reasoning: `Haiku low-confidence (${haiku.confidence.toFixed(2)}) ` +
          'and no validation fallback — returning Haiku result',
      };
    }
    return inputError('no Haiku judge and no validation command available');
  }

  let validation;
  try {
    validation = normalizeValidation(opts.runValidation(cmd));
  } catch (err) {
    return {
      met: false,
      confidence: 0,
      evaluator: 'validation',
      reasoning: `validation threw: ${err?.message || 'unknown'}`,
    };
  }

  // Step 4: combine.
  if (!haiku) return validationResult(validation);
  const validationMet = validation.exitCode === 0;
  if (haiku.met === validationMet) return consensusResult(haiku, validation);
  return conflictResult(haiku, validation);
}
