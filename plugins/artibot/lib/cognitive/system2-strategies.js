/**
 * System 2 Strategy patterns: risk assessment, complexity estimation,
 * team recommendation, and step-level correction heuristics.
 *
 * Extracted from system2.js to reduce module size and improve cohesion.
 * Strategy functions are pure analysis/heuristic functions with no
 * dependency on sandbox or execution state.
 *
 * @module lib/cognitive/system2-strategies
 */

/** Complexity thresholds for team recommendation */
export const TEAM_THRESHOLDS = {
  /** Score above which Agent Teams are recommended */
  teamRecommendation: 0.6,
  /** Score above which a full platoon is recommended */
  platoonRecommendation: 0.85,
};

/**
 * Estimate a single step's complexity level.
 * @param {string} action - Action description
 * @returns {'low' | 'medium' | 'high'}
 */
export function estimateStepComplexity(action) {
  const lower = action.toLowerCase();
  const highWords = ['refactor', 'migrate', 'redesign', 'optimize', 'security', 'architecture'];
  const lowWords = ['read', 'list', 'check', 'print', 'log', 'echo', 'format', 'lint'];

  if (highWords.some((w) => lower.includes(w))) return 'high';
  if (lowWords.some((w) => lower.includes(w))) return 'low';
  return 'medium';
}

/**
 * Analyze and extract dependencies between steps.
 * @param {Array<object>} steps - Steps to analyze
 * @returns {Array<{ from: string, to: string }>}
 */
export function analyzeDependencies(steps) {
  const deps = [];
  for (const step of steps) {
    for (const depId of step.dependencies) {
      deps.push({ from: depId, to: step.id });
    }
  }
  return deps;
}

/**
 * Assess risks for each plan step.
 * @param {Array<object>} steps - Steps to assess
 * @param {object} _task - Original task context
 * @returns {Array<object>}
 */
export function assessRisks(steps, _task) {
  const risks = [];

  for (const step of steps) {
    const action = step.action.toLowerCase();

    if (action.includes('delete') || action.includes('remove') || action.includes('drop')) {
      risks.push({
        stepId: step.id,
        risk: 'Destructive operation may cause data loss',
        mitigation: 'Create backup before execution; verify target carefully',
        severity: 'high',
      });
    }

    if (action.includes('deploy') || action.includes('publish') || action.includes('push')) {
      risks.push({
        stepId: step.id,
        risk: 'Deployment may affect production environment',
        mitigation: 'Validate in staging first; have rollback plan ready',
        severity: 'high',
      });
    }

    if (action.includes('install') || action.includes('update') || action.includes('upgrade')) {
      risks.push({
        stepId: step.id,
        risk: 'Dependency changes may introduce breaking changes',
        mitigation: 'Review changelogs; run tests after changes',
        severity: 'medium',
      });
    }

    if (step.estimatedComplexity === 'high') {
      risks.push({
        stepId: step.id,
        risk: 'High complexity step may take longer than expected',
        mitigation: 'Break into smaller sub-steps if possible',
        severity: 'low',
      });
    }
  }

  return risks;
}

/**
 * Estimate overall plan complexity as a 0-1 score.
 * @param {Array<object>} steps - Plan steps
 * @param {Array<object>} dependencies - Step dependencies
 * @param {Array<object>} risks - Identified risks
 * @returns {number}
 */
export function estimateComplexity(steps, dependencies, risks) {
  const stepCount = Math.min(1.0, steps.length / 10);
  const depRatio = steps.length > 1
    ? Math.min(1.0, dependencies.length / (steps.length - 1))
    : 0;
  const highRiskCount = risks.filter((r) => r.severity === 'high').length;
  const riskFactor = Math.min(1.0, highRiskCount / 3);
  const complexSteps = steps.filter((s) => s.estimatedComplexity === 'high').length;
  const complexRatio = steps.length > 0
    ? complexSteps / steps.length
    : 0;

  return (stepCount * 0.3) + (depRatio * 0.2) + (riskFactor * 0.25) + (complexRatio * 0.25);
}

/**
 * Recommend team composition based on complexity score.
 * @param {number} complexity - 0-1 complexity score
 * @param {object} task - Task to recommend team for
 * @returns {object|null}
 */
export function recommendTeam(complexity, task) {
  if (complexity < TEAM_THRESHOLDS.teamRecommendation) {
    return null;
  }

  const domain = task.domain || 'general';
  const level = complexity >= TEAM_THRESHOLDS.platoonRecommendation ? 'platoon' : 'squad';

  const teammates = selectTeammates(domain, level);

  return {
    recommended: true,
    level,
    complexity,
    pattern: 'leader',
    domain,
    teammates,
    reason: `Task complexity (${complexity}) exceeds team threshold (${TEAM_THRESHOLDS.teamRecommendation})`,
  };
}

/**
 * Select appropriate teammates based on domain and team level.
 * @param {string} domain - Domain classification
 * @param {'squad' | 'platoon'} level - Team level
 * @returns {string[]}
 */
export function selectTeammates(domain, level) {
  const domainTeams = {
    frontend: ['frontend-dev', 'ui-designer', 'qa-tester'],
    backend: ['backend-dev', 'db-specialist', 'api-designer'],
    security: ['security-analyst', 'penetration-tester', 'compliance-reviewer'],
    performance: ['performance-engineer', 'profiler', 'load-tester'],
    general: ['developer', 'reviewer', 'tester'],
  };

  const baseTeam = domainTeams[domain] || domainTeams.general;

  if (level === 'platoon') {
    return [...baseTeam, 'architect', 'tech-lead'];
  }

  return baseTeam;
}

/**
 * Suggest a correction for a failed step.
 * @param {object} failedStep - Failed step with { stepId, action, reason }
 * @returns {string}
 */
export function suggestCorrection(failedStep) {
  const reason = failedStep.reason.toLowerCase();

  if (reason.includes('timeout')) {
    return `${failedStep.action} (with extended timeout)`;
  }
  if (reason.includes('permission')) {
    return `${failedStep.action} (check permissions first)`;
  }
  if (reason.includes('not found')) {
    return `${failedStep.action} (verify paths and dependencies exist)`;
  }
  if (reason.includes('syntax')) {
    return `${failedStep.action} (fix syntax before re-running)`;
  }

  return `${failedStep.action} (retry with adjusted approach)`;
}
