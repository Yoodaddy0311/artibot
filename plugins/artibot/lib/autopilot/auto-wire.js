/**
 * Engine auto-wiring orchestration helpers (v4.11.0 Track J).
 *
 * Composes v4.10.0 Track E/F/G/H feature modules into phase-boundary helpers
 * so the engine (or `/autopilot` slash command) can call ONE function per
 * boundary instead of stitching predict-cost + smart-skip + rollback + drift
 * inline. Keeps `engine.js` under the 800-line quality cap.
 *
 * All helpers are pure orchestrators:
 *   - take `state` via parameter (no global)
 *   - take dependencies via opts (DI for git runner, loaders, etc.)
 *   - return `{ ...data, instruction }` where `instruction` is markdown
 *     ready for user-facing display (한국어/English mix matches existing
 *     engine notification style)
 *   - never auto-execute side effects (no `git reset`, no fetch, no save) —
 *     they surface recommendations; the engine decides whether to act
 *
 * Composed modules (consumer only — never mutated):
 *   - cost-predictor       predictCost, classifyComplexity
 *   - smart-skip           classifyTaskComplexity, recommendSkippablePhases
 *   - rollback             listRollbackTargets, rollbackToLastGreen (referenced, not executed)
 *   - cross-machine        detectMachineDrift, prepareRebase
 *   - migrate-v3           needsV3Migration
 *   - flamegraph           renderFlamegraph
 *   - goal-drift-detector  computeDrift
 *
 * DATA POLICY: local-only. No HTTP, no remote git ops fired from this module.
 *
 * Public surface:
 *   - wirePreIntake(state, prompt, opts)
 *   - wireResume(state, opts)
 *   - wireVerifyFailure(state, failedPhase, opts)
 *   - wirePhaseEnd(state, phase, output, opts)
 *   - wireReport(state, opts)
 *
 * @module lib/autopilot/auto-wire
 */

import { classifyComplexity, predictCost } from './cost-predictor.js';
import { classifyTaskComplexity, recommendSkippablePhases } from './smart-skip.js';
import { listRollbackTargets } from './rollback.js';
import { detectMachineDrift, prepareRebase } from './cross-machine.js';
import { needsV3Migration } from './migrate-v3.js';
import { renderFlamegraph } from './flamegraph.js';
import { computeDrift } from './goal-drift-detector.js';

const DEFAULT_DRIFT_WARN_PCT = 25;
const DURATION_LABEL_MS = 60_000;

/**
 * Format ms duration as "Nm" (rounded up to whole minutes, min 1).
 * @param {number} ms
 * @returns {string}
 */
function fmtMinutes(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0m';
  return `${Math.max(1, Math.round(n / DURATION_LABEL_MS))}m`;
}

/**
 * Pick a sensible default template name from complexity. Trivial/simple →
 * `bugfix`, medium → `feature`, complex → `refactor`. Mirrors the names
 * shipped in lib/autopilot/contract-templates/.
 *
 * @param {string} level
 * @returns {string}
 */
function suggestTemplateFor(level) {
  if (level === 'complex') return 'refactor';
  if (level === 'medium') return 'feature';
  return 'bugfix';
}

/**
 * Build the markdown instruction string for the pre-intake auto-wire result.
 *
 * @param {{
 *   costEstimate: object,
 *   complexity: object,
 *   suggestedTemplate: string,
 *   skippablePhases: object,
 * }} parts
 * @returns {string}
 */
function preIntakeInstruction(parts) {
  const { costEstimate, complexity, suggestedTemplate, skippablePhases } = parts;
  const tokens = costEstimate.estimatedTokens.toLocaleString();
  const dur = fmtMinutes(costEstimate.estimatedDurationMs);
  const conf = Math.round(costEstimate.confidence * 100);
  const skipped = skippablePhases.skip.length > 0
    ? skippablePhases.skip.join(', ')
    : '(none)';
  return [
    '**Pre-intake auto-wire**',
    '',
    `- Estimated cost: ${tokens} tokens, ~${dur} (confidence ${conf}%, based on ${costEstimate.basedOnNSessions} sessions)`,
    `- Complexity: ${complexity.level} (score ${complexity.score})`,
    `- Suggested template: \`${suggestedTemplate}\``,
    `- Skippable phases: ${skipped} — ${skippablePhases.rationale}`,
  ].join('\n');
}

/**
 * Pre-intake auto-wire. Combines cost prediction + complexity classification
 * + template suggestion + skippable-phase recommendation into one return
 * value the engine can surface to the user before INTAKE phase runs.
 *
 * @param {object} state - live session state (used for telemetry DI hooks)
 * @param {string} prompt - raw user goal text
 * @param {{
 *   listSessions?: Function,
 *   readEvents?: Function,
 * }} [opts]
 * @returns {{
 *   costEstimate: object,
 *   complexity: object,
 *   suggestedTemplate: string,
 *   skippablePhases: object,
 *   instruction: string,
 * }}
 */
export function wirePreIntake(state, prompt, opts = {}) {
  const task = typeof prompt === 'string' ? prompt : '';
  const costEstimate = predictCost({ task }, {
    listSessions: opts.listSessions,
    readEvents: opts.readEvents,
  });
  const complexity = classifyTaskComplexity(task);
  // Re-use the predictor's coarse classifier as a secondary cross-check.
  // Surfaced on costEstimate.complexity already; not re-emitted here.
  void classifyComplexity(task);
  const suggestedTemplate = suggestTemplateFor(complexity.level);
  const skippablePhases = recommendSkippablePhases(complexity);
  const instruction = preIntakeInstruction({
    costEstimate,
    complexity,
    suggestedTemplate,
    skippablePhases,
  });
  return {
    costEstimate,
    complexity,
    suggestedTemplate,
    skippablePhases,
    instruction,
    sessionId: state && typeof state === 'object' ? state.sessionId : null,
  };
}

/**
 * Build the markdown instruction string for the resume auto-wire result.
 *
 * @param {{
 *   drift: object,
 *   migrationNeeded: boolean,
 *   rebasePlan: Array<object>|null,
 * }} parts
 * @returns {string}
 */
function resumeInstruction(parts) {
  const { drift, migrationNeeded, rebasePlan } = parts;
  const lines = ['**Resume auto-wire**', ''];
  if (drift.needsRebase) {
    lines.push(
      `- Machine drift: session last saved on \`${drift.driftedFrom}\`, now resuming on \`${drift.currentMachine}\``,
    );
    if (Array.isArray(rebasePlan) && rebasePlan.length > 0) {
      const rendered = rebasePlan.map((r) => `  - \`${r.cmd} ${r.args.join(' ')}\``).join('\n');
      lines.push('- Rebase plan (run before continuing):');
      lines.push(rendered);
    }
  } else if (drift.hasPriorMachine) {
    lines.push(`- Machine: \`${drift.currentMachine}\` (no drift)`);
  } else {
    lines.push(`- Machine: \`${drift.currentMachine}\` (first save)`);
  }
  if (migrationNeeded) {
    lines.push('- Schema migration: v2 → v3 required before resume');
  } else {
    lines.push('- Schema migration: up-to-date');
  }
  return lines.join('\n');
}

/**
 * Resume auto-wire. Combines cross-machine drift detection + v3 migration
 * check + rebase command preparation. Surfaces the plan but does NOT
 * execute any git command.
 *
 * @param {object} state
 * @param {{
 *   machineId?: string,
 *   baseBranch?: string,
 *   remote?: string,
 * }} [opts]
 * @returns {{
 *   driftDetected: boolean,
 *   migrationNeeded: boolean,
 *   rebasePlan: Array<{cmd:string, args:string[]}>|null,
 *   drift: object,
 *   instruction: string,
 * }}
 */
export function wireResume(state, opts = {}) {
  const drift = detectMachineDrift(state, { machineId: opts.machineId });
  const migrationNeeded = needsV3Migration(state);
  let rebasePlan = null;
  if (drift.needsRebase) {
    try {
      rebasePlan = prepareRebase({
        baseBranch: opts.baseBranch,
        remote: opts.remote,
      });
    } catch {
      rebasePlan = null;
    }
  }
  const instruction = resumeInstruction({ drift, migrationNeeded, rebasePlan });
  return {
    driftDetected: drift.needsRebase,
    migrationNeeded,
    rebasePlan,
    drift,
    instruction,
  };
}

/**
 * Build the markdown instruction string for the verify-failure auto-wire.
 *
 * @param {{
 *   failedPhase: string,
 *   targets: Array<object>,
 *   recommended: object|null,
 * }} parts
 * @returns {string}
 */
function verifyFailureInstruction(parts) {
  const { failedPhase, targets, recommended } = parts;
  const lines = ['**Verify failure auto-wire**', '', `- Failed phase: \`${failedPhase}\``];
  if (!recommended) {
    lines.push('- No green checkpoint available — manual recovery required');
    return lines.join('\n');
  }
  lines.push(
    `- Recommended rollback: \`${recommended.sha}\` from phase \`${recommended.phase}\``,
  );
  if (targets.length > 1) {
    lines.push(`- ${targets.length} total green checkpoint(s) available`);
  }
  lines.push('- To execute: call `rollbackToLastGreen(sessionId)` — this helper only surfaces the option');
  return lines.join('\n');
}

/**
 * Verify-failure auto-wire. Lists rollback targets and recommends the latest
 * green checkpoint. Does NOT execute the rollback — surfaces options only.
 *
 * @param {object} state
 * @param {string} failedPhase
 * @param {{ sessionId?: string }} [opts]
 * @returns {{
 *   targets: Array<object>,
 *   recommended: object|null,
 *   instruction: string,
 * }}
 */
export function wireVerifyFailure(state, failedPhase, opts = {}) {
  const phaseLabel = typeof failedPhase === 'string' && failedPhase ? failedPhase : 'unknown';
  const sessionId = typeof opts.sessionId === 'string' && opts.sessionId
    ? opts.sessionId
    : (state && typeof state === 'object' ? state.sessionId : null);
  let targets = [];
  if (sessionId) {
    targets = listRollbackTargets(sessionId, { state });
  }
  const recommended = targets.length > 0 ? targets[0] : null;
  const instruction = verifyFailureInstruction({
    failedPhase: phaseLabel,
    targets,
    recommended,
  });
  return { targets, recommended, instruction };
}

/**
 * Build the markdown instruction string for a per-phase drift snapshot.
 *
 * @param {{
 *   phase: string,
 *   driftPct: number,
 *   warning: boolean,
 *   missing: string[],
 *   extra: string[],
 * }} parts
 * @returns {string}
 */
function phaseEndInstruction(parts) {
  const { phase, driftPct, warning, missing, extra } = parts;
  const flag = warning ? '⚠️ DRIFT' : 'OK';
  const lines = [`**Phase \`${phase}\` end — drift ${driftPct}% ${flag}**`];
  if (missing.length > 0) {
    lines.push(`- Missing deliverables: ${missing.slice(0, 5).join(', ')}`);
  }
  if (extra.length > 0) {
    lines.push(`- Scope creep (extras): ${extra.slice(0, 5).join(', ')}`);
  }
  if (!warning && missing.length === 0 && extra.length === 0) {
    lines.push('- All deliverables on track');
  }
  return lines.join('\n');
}

/**
 * Phase-end auto-wire. Computes goal-vs-actual drift for the just-completed
 * phase. Warning threshold defaults to 25% and is overridable per call.
 *
 * @param {object} state - must expose `state.goalContract`
 * @param {string} phase
 * @param {object|Array<object>} output - phase output(s) with deliverables
 * @param {{ warnPct?: number }} [opts]
 * @returns {{
 *   driftPct: number,
 *   warning: boolean,
 *   missing: string[],
 *   extra: string[],
 *   instruction: string,
 * }}
 */
export function wirePhaseEnd(state, phase, output, opts = {}) {
  const warnPct = Number.isFinite(opts.warnPct) && opts.warnPct >= 0
    ? opts.warnPct
    : DEFAULT_DRIFT_WARN_PCT;
  const phaseLabel = typeof phase === 'string' && phase ? phase : 'unknown';
  const contract = state && typeof state === 'object' ? state.goalContract : null;
  const drift = computeDrift(contract, output);
  const warning = drift.driftPct >= warnPct;
  const instruction = phaseEndInstruction({
    phase: phaseLabel,
    driftPct: drift.driftPct,
    warning,
    missing: drift.missing,
    extra: drift.extra,
  });
  return {
    driftPct: drift.driftPct,
    warning,
    missing: drift.missing,
    extra: drift.extra,
    instruction,
  };
}

/**
 * Extract per-phase flamegraph rows from session state. Walks
 * `state.phases[]` and picks duration/tokens/cost; tolerant of missing fields.
 *
 * @param {object} state
 * @returns {Array<{phase:string, durationMs:number, tokens:number, cost:number}>}
 */
function flamegraphRowsFromState(state) {
  if (!state || typeof state !== 'object') return [];
  const phases = Array.isArray(state.phases) ? state.phases : [];
  const out = [];
  for (const p of phases) {
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.phase === 'string' && p.phase ? p.phase : null;
    if (!name) continue;
    out.push({
      phase: name,
      durationMs: Number(p.durationMs) || 0,
      tokens: Number(p.tokens) || 0,
      cost: Number(p.cost) || 0,
    });
  }
  return out;
}

/**
 * Aggregate all phase outputs into a single deliverable set for the
 * end-of-run drift summary.
 *
 * @param {object} state
 * @returns {Array<object>}
 */
function phaseOutputsFromState(state) {
  if (!state || typeof state !== 'object') return [];
  const phases = Array.isArray(state.phases) ? state.phases : [];
  return phases
    .map((p) => (p && typeof p === 'object' ? p.output || p : null))
    .filter(Boolean);
}

/**
 * Report auto-wire. Renders the flamegraph block + final drift summary as
 * one markdown block ready to inject into REPORT.md.
 *
 * @param {object} state
 * @param {{ maxWidth?: number, sort?: 'phase'|'duration' }} [opts]
 * @returns {string} markdown block
 */
export function wireReport(state, opts = {}) {
  const rows = flamegraphRowsFromState(state);
  const flamegraph = renderFlamegraph(rows, {
    maxWidth: opts.maxWidth,
    sort: opts.sort,
  });
  const contract = state && typeof state === 'object' ? state.goalContract : null;
  const drift = computeDrift(contract, phaseOutputsFromState(state));
  const driftLines = [
    '**Goal-vs-Actual Drift**',
    '',
    `- Drift: ${drift.driftPct}% (${drift.missing.length} missing, ${drift.extra.length} extra, ${drift.inScope.length} in-scope)`,
  ];
  if (drift.missing.length > 0) {
    driftLines.push(`- Missing: ${drift.missing.slice(0, 10).join(', ')}`);
  }
  if (drift.extra.length > 0) {
    driftLines.push(`- Extras: ${drift.extra.slice(0, 10).join(', ')}`);
  }
  return [
    '### Phase Flamegraph',
    '',
    flamegraph,
    '',
    '### Drift Summary',
    '',
    driftLines.join('\n'),
  ].join('\n');
}
