/**
 * System 2: Deliberate reasoning engine.
 * Implements the Plan -> Execute -> Reflect loop for complex problem solving.
 * Supports self-correction with up to 3 retry attempts per task.
 *
 * Based on dual-process theory:
 *   - System 1 (fast/intuitive) handles simple tasks
 *   - System 2 (slow/deliberate) handles complex reasoning
 *
 * Integration points:
 *   - Sandbox: Safe command execution with blocked-pattern validation
 *   - Agent Teams: TeamCreate recommendation for multi-agent tasks
 *   - Self-Evaluator: Result quality assessment
 *
 * @module lib/cognitive/system2
 */

import {
  createSandbox,
  execute as sandboxExecute,
  recordResult,
  validate,
  cleanup,
  getStats,
} from './sandbox.js';

/** Maximum retry attempts for the solve loop */
const MAX_RETRIES = 3;

/** Default planning configuration */
const DEFAULT_PLAN_OPTIONS = {
  /** Maximum number of steps in a plan */
  maxSteps: 10,
  /** Whether to analyze dependencies between steps */
  analyzeDependencies: true,
  /** Whether to assess risks for each step */
  assessRisks: true,
};

/** Complexity thresholds for team recommendation */
const TEAM_THRESHOLDS = {
  /** Score above which Agent Teams are recommended */
  teamRecommendation: 0.6,
  /** Score above which a full platoon is recommended */
  platoonRecommendation: 0.85,
};

/**
 * Decompose a task into a structured execution plan.
 * Analyzes the task to produce ordered steps with dependencies and risk assessment.
 *
 * @param {object} task - Task to plan
 * @param {string} task.id - Task identifier
 * @param {string} task.description - What needs to be done
 * @param {string} [task.type] - Task type (e.g. 'build', 'fix', 'refactor')
 * @param {string} [task.domain] - Domain (e.g. 'frontend', 'backend', 'security')
 * @param {object} [task.context] - Additional context (files, constraints, etc.)
 * @param {object} [options] - Planning options
 * @param {number} [options.maxSteps=10] - Maximum number of steps
 * @param {boolean} [options.analyzeDependencies=true] - Enable dependency analysis
 * @param {boolean} [options.assessRisks=true] - Enable risk assessment
 * @returns {{
 *   taskId: string,
 *   createdAt: string,
 *   steps: Array<{
 *     id: string,
 *     order: number,
 *     action: string,
 *     description: string,
 *     dependencies: string[],
 *     estimatedComplexity: 'low' | 'medium' | 'high',
 *     status: 'pending'
 *   }>,
 *   dependencies: Array<{ from: string, to: string }>,
 *   risks: Array<{ stepId: string, risk: string, mitigation: string, severity: 'low' | 'medium' | 'high' }>,
 *   complexity: number,
 *   teamRecommendation: object | null
 * }}
 */
export function plan(task, options = {}) {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };

  if (!task || !task.id || !task.description) {
    throw new Error('Task must have id and description');
  }

  const steps = decomposeTask(task, opts.maxSteps);
  const dependencies = opts.analyzeDependencies ? analyzeDependencies(steps) : [];
  const risks = opts.assessRisks ? assessRisks(steps, task) : [];
  const complexity = estimateComplexity(steps, dependencies, risks);
  const teamRecommendation = recommendTeam(complexity, task);

  return {
    taskId: task.id,
    createdAt: new Date().toISOString(),
    steps,
    dependencies,
    risks,
    complexity: Math.round(complexity * 100) / 100,
    teamRecommendation,
  };
}

/**
 * Execute a plan within a sandbox, running each step in order.
 * Steps are executed sequentially respecting dependency order.
 * Each step's command is validated for safety before execution.
 *
 * @param {object} plan - Plan from plan()
 * @param {object} [sandbox] - Sandbox context; creates one if not provided
 * @param {object} [options] - Execution options
 * @param {Function} [options.onStepStart] - Callback before each step: (step) => void
 * @param {Function} [options.onStepComplete] - Callback after each step: (step, result) => void
 * @param {boolean} [options.stopOnFailure=true] - Stop execution on first failure
 * @returns {{
 *   planId: string,
 *   sandboxId: string,
 *   startedAt: string,
 *   completedAt: string,
 *   results: Array<{
 *     stepId: string,
 *     order: number,
 *     action: string,
 *     execution: object,
 *     validation: object,
 *     status: 'success' | 'failed' | 'blocked' | 'skipped'
 *   }>,
 *   success: boolean,
 *   stepsCompleted: number,
 *   stepsTotal: number,
 *   sandboxStats: object
 * }}
 */
export function execute(plan, sandbox, options = {}) {
  const { onStepStart, onStepComplete, stopOnFailure = true } = options;
  const startedAt = new Date().toISOString();

  const ownSandbox = !sandbox;
  const sbx = sandbox || createSandbox();

  const results = [];
  let stopped = false;

  // Execute steps in dependency order
  const executionOrder = resolveExecutionOrder(plan.steps, plan.dependencies);

  for (const step of executionOrder) {
    if (stopped) {
      results.push({
        stepId: step.id,
        order: step.order,
        action: step.action,
        execution: null,
        validation: null,
        status: 'skipped',
      });
      continue;
    }

    // Check if dependencies have been satisfied
    const depsMet = checkDependencies(step, results, plan.dependencies);
    if (!depsMet.satisfied) {
      results.push({
        stepId: step.id,
        order: step.order,
        action: step.action,
        execution: null,
        validation: null,
        status: 'skipped',
      });
      continue;
    }

    if (onStepStart) {
      onStepStart(step);
    }

    // Execute via sandbox
    const execution = sandboxExecute(step.action, sbx);
    const validation = validate(execution);

    const status = execution.blocked
      ? 'blocked'
      : validation.success
        ? 'success'
        : 'failed';

    step.status = status === 'success' ? 'completed' : 'failed';

    const stepResult = {
      stepId: step.id,
      order: step.order,
      action: step.action,
      execution,
      validation,
      status,
    };

    results.push(stepResult);

    if (onStepComplete) {
      onStepComplete(step, stepResult);
    }

    if (status !== 'success' && stopOnFailure) {
      stopped = true;
    }
  }

  const success = results.every((r) => r.status === 'success');
  const stepsCompleted = results.filter((r) => r.status === 'success').length;

  // Cleanup if we created the sandbox
  const sandboxStats = getStats(sbx);
  if (ownSandbox) {
    cleanup(sbx);
  }

  return {
    planId: plan.taskId,
    sandboxId: sbx.id,
    startedAt,
    completedAt: new Date().toISOString(),
    results,
    success,
    stepsCompleted,
    stepsTotal: plan.steps.length,
    sandboxStats,
  };
}

/**
 * Reflect on execution results to identify issues and corrections.
 * Analyzes failures, determines root causes, and suggests retry strategies.
 *
 * @param {object} executionResult - Result from execute()
 * @param {object} [originalTask] - Original task for context
 * @returns {{
 *   reflectedAt: string,
 *   analysis: {
 *     overallSuccess: boolean,
 *     completionRate: number,
 *     failedSteps: Array<{ stepId: string, action: string, reason: string }>,
 *     blockedSteps: Array<{ stepId: string, action: string, reason: string }>,
 *     patterns: string[]
 *   },
 *   corrections: Array<{
 *     stepId: string,
 *     originalAction: string,
 *     suggestedAction: string,
 *     reason: string
 *   }>,
 *   retry: {
 *     shouldRetry: boolean,
 *     reason: string,
 *     adjustedPlan: object | null
 *   }
 * }}
 */
export function reflect(executionResult, originalTask) {
  const failedSteps = [];
  const blockedSteps = [];
  const patterns = [];

  for (const r of executionResult.results) {
    if (r.status === 'failed') {
      const reason = extractFailureReason(r);
      failedSteps.push({ stepId: r.stepId, action: r.action, reason });
    }
    if (r.status === 'blocked') {
      const reason = r.execution?.blockedBy || 'Unknown blocked reason';
      blockedSteps.push({ stepId: r.stepId, action: r.action, reason });
    }
  }

  // Pattern detection
  if (failedSteps.length > 0 && failedSteps.length === executionResult.stepsTotal) {
    patterns.push('all_steps_failed');
  }
  if (blockedSteps.length > 0) {
    patterns.push('safety_blocked');
  }
  if (failedSteps.some((f) => f.reason.includes('timeout'))) {
    patterns.push('timeout_failures');
  }
  if (failedSteps.some((f) => f.reason.includes('permission'))) {
    patterns.push('permission_issues');
  }
  if (executionResult.stepsCompleted > 0 && !executionResult.success) {
    patterns.push('partial_success');
  }

  const completionRate = executionResult.stepsTotal > 0
    ? executionResult.stepsCompleted / executionResult.stepsTotal
    : 0;

  // Generate corrections for failed steps
  const corrections = failedSteps.map((failed) => ({
    stepId: failed.stepId,
    originalAction: failed.action,
    suggestedAction: suggestCorrection(failed),
    reason: failed.reason,
  }));

  // Determine retry strategy
  const shouldRetry = failedSteps.length > 0
    && blockedSteps.length === 0
    && completionRate < 1.0
    && !patterns.includes('all_steps_failed');

  const retryReason = shouldRetry
    ? `${failedSteps.length} step(s) failed with correctable issues`
    : blockedSteps.length > 0
      ? 'Blocked by safety rules - manual intervention required'
      : patterns.includes('all_steps_failed')
        ? 'All steps failed - task may need fundamental re-planning'
        : executionResult.success
          ? 'All steps succeeded - no retry needed'
          : 'Cannot determine retry strategy';

  return {
    reflectedAt: new Date().toISOString(),
    analysis: {
      overallSuccess: executionResult.success,
      completionRate: Math.round(completionRate * 100) / 100,
      failedSteps,
      blockedSteps,
      patterns,
    },
    corrections,
    retry: {
      shouldRetry,
      reason: retryReason,
      adjustedPlan: shouldRetry ? buildAdjustedPlan(executionResult, corrections) : null,
    },
  };
}

/**
 * Full solve loop: Plan -> Execute -> Reflect, with automatic retry.
 * This is the main entry point for System 2 reasoning.
 *
 * @param {object} task - Task to solve
 * @param {string} task.id - Task identifier
 * @param {string} task.description - Task description
 * @param {string} [task.type] - Task type
 * @param {string} [task.domain] - Task domain
 * @param {object} [task.context] - Additional context
 * @param {object} [options] - Solve options
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {object} [options.sandboxOptions] - Options for sandbox creation
 * @param {object} [options.planOptions] - Options for plan creation
 * @param {Function} [options.onAttempt] - Callback per attempt: (attempt, phase, data) => void
 * @returns {{
 *   taskId: string,
 *   success: boolean,
 *   attempts: number,
 *   history: Array<{
 *     attempt: number,
 *     plan: object,
 *     execution: object,
 *     reflection: object
 *   }>,
 *   finalResult: object | null,
 *   teamRecommendation: object | null,
 *   duration: number
 * }}
 */
export function solve(task, options = {}) {
  const { maxRetries = MAX_RETRIES, sandboxOptions, planOptions, onAttempt } = options;
  const startTime = Date.now();

  const history = [];
  let currentTask = { ...task };
  let finalResult = null;
  let teamRecommendation = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Phase 1: Plan
    if (onAttempt) onAttempt(attempt, 'plan', currentTask);
    const currentPlan = plan(currentTask, planOptions);

    // Capture team recommendation from first attempt
    if (attempt === 1 && currentPlan.teamRecommendation) {
      teamRecommendation = currentPlan.teamRecommendation;
    }

    // Phase 2: Execute
    if (onAttempt) onAttempt(attempt, 'execute', currentPlan);
    const sandbox = createSandbox(sandboxOptions);
    const execution = execute(currentPlan, sandbox);

    // Phase 3: Reflect
    if (onAttempt) onAttempt(attempt, 'reflect', execution);
    const reflection = reflect(execution, currentTask);

    history.push({
      attempt,
      plan: currentPlan,
      execution,
      reflection,
    });

    // Success - we're done
    if (execution.success) {
      finalResult = execution;
      cleanup(sandbox);
      break;
    }

    // Clean up sandbox for this attempt
    cleanup(sandbox);

    // Check if retry is recommended
    if (!reflection.retry.shouldRetry || attempt >= maxRetries) {
      finalResult = execution;
      break;
    }

    // Apply corrections for next attempt
    if (reflection.retry.adjustedPlan) {
      currentTask = {
        ...currentTask,
        context: {
          ...currentTask.context,
          previousAttempt: attempt,
          corrections: reflection.corrections,
          adjustedSteps: reflection.retry.adjustedPlan.steps,
        },
      };
    }
  }

  return {
    taskId: task.id,
    success: finalResult?.success || false,
    attempts: history.length,
    history,
    finalResult,
    teamRecommendation,
    duration: Date.now() - startTime,
  };
}

/**
 * Estimate the complexity of a task for routing decisions.
 * Used by the cognitive router to decide between System 1 and System 2.
 *
 * @param {object} task - Task to assess
 * @param {string} task.description - Task description
 * @param {string} [task.type] - Task type
 * @param {string} [task.domain] - Task domain
 * @param {object} [task.context] - Additional context
 * @returns {{
 *   score: number,
 *   factors: Record<string, number>,
 *   recommendation: 'system1' | 'system2' | 'team'
 * }}
 */
export function assessComplexity(task) {
  if (!task || !task.description) {
    return { score: 0, factors: {}, recommendation: 'system1' };
  }

  const factors = {};
  const desc = task.description.toLowerCase();

  // Length factor: longer descriptions usually mean more complex tasks
  factors.descriptionLength = Math.min(1.0, desc.length / 500);

  // Multi-step indicators
  const stepIndicators = ['then', 'after', 'next', 'finally', 'first', 'second', 'step'];
  const stepCount = stepIndicators.reduce(
    (count, word) => count + (desc.includes(word) ? 1 : 0),
    0,
  );
  factors.multiStep = Math.min(1.0, stepCount / 3);

  // Domain complexity keywords
  const complexKeywords = [
    'architecture', 'refactor', 'migrate', 'security', 'performance',
    'optimize', 'redesign', 'scale', 'comprehensive', 'system-wide',
    'cross-module', 'integration', 'concurrent', 'distributed',
  ];
  const complexCount = complexKeywords.reduce(
    (count, word) => count + (desc.includes(word) ? 1 : 0),
    0,
  );
  factors.domainComplexity = Math.min(1.0, complexCount / 3);

  // Context richness (more context = more complex)
  if (task.context) {
    const contextKeys = Object.keys(task.context).length;
    factors.contextRichness = Math.min(1.0, contextKeys / 5);
  } else {
    factors.contextRichness = 0;
  }

  // Type-based complexity
  const complexTypes = ['refactor', 'migrate', 'security-audit', 'architecture', 'performance'];
  const simpleTypes = ['fix', 'typo', 'format', 'lint', 'rename'];
  if (task.type) {
    if (complexTypes.includes(task.type)) factors.typeComplexity = 0.8;
    else if (simpleTypes.includes(task.type)) factors.typeComplexity = 0.1;
    else factors.typeComplexity = 0.4;
  } else {
    factors.typeComplexity = 0.3;
  }

  // Weighted score
  const weights = {
    descriptionLength: 0.15,
    multiStep: 0.25,
    domainComplexity: 0.30,
    contextRichness: 0.10,
    typeComplexity: 0.20,
  };

  const score = Object.entries(factors).reduce(
    (sum, [key, value]) => sum + value * (weights[key] || 0),
    0,
  );

  const roundedScore = Math.round(score * 100) / 100;

  let recommendation;
  if (roundedScore >= TEAM_THRESHOLDS.teamRecommendation) {
    recommendation = 'team';
  } else if (roundedScore >= 0.3) {
    recommendation = 'system2';
  } else {
    recommendation = 'system1';
  }

  return {
    score: roundedScore,
    factors,
    recommendation,
  };
}

// --- Internal helpers ---

/**
 * Decompose a task into ordered steps.
 * @param {object} task
 * @param {number} maxSteps
 * @returns {Array<object>}
 */
function decomposeTask(task, maxSteps) {
  const steps = [];
  const desc = task.description.toLowerCase();

  // Extract explicit steps from description (numbered lists, bullet points)
  const stepPatterns = [
    /(?:^|\n)\s*(?:\d+[\.\)]\s*|[-*]\s+)(.+)/gm,
    /(?:first|then|next|after that|finally)[,:]?\s*(.+?)(?:\.|$)/gim,
  ];

  for (const pattern of stepPatterns) {
    let match;
    while ((match = pattern.exec(task.description)) !== null && steps.length < maxSteps) {
      const action = match[1].trim();
      if (action.length > 5) {
        steps.push(createStep(steps.length + 1, action));
      }
    }
  }

  // If no explicit steps found, create a single step from the description
  if (steps.length === 0) {
    steps.push(createStep(1, task.description));
  }

  return steps;
}

/**
 * Create a plan step.
 * @param {number} order
 * @param {string} action
 * @returns {object}
 */
function createStep(order, action) {
  const complexity = estimateStepComplexity(action);
  return {
    id: `step-${order}`,
    order,
    action,
    description: action,
    dependencies: order > 1 ? [`step-${order - 1}`] : [],
    estimatedComplexity: complexity,
    status: 'pending',
  };
}

/**
 * Estimate a single step's complexity.
 * @param {string} action
 * @returns {'low' | 'medium' | 'high'}
 */
function estimateStepComplexity(action) {
  const lower = action.toLowerCase();
  const highWords = ['refactor', 'migrate', 'redesign', 'optimize', 'security', 'architecture'];
  const lowWords = ['read', 'list', 'check', 'print', 'log', 'echo', 'format', 'lint'];

  if (highWords.some((w) => lower.includes(w))) return 'high';
  if (lowWords.some((w) => lower.includes(w))) return 'low';
  return 'medium';
}

/**
 * Analyze dependencies between steps.
 * @param {Array<object>} steps
 * @returns {Array<{ from: string, to: string }>}
 */
function analyzeDependencies(steps) {
  const deps = [];
  for (const step of steps) {
    for (const depId of step.dependencies) {
      deps.push({ from: depId, to: step.id });
    }
  }
  return deps;
}

/**
 * Assess risks for plan steps.
 * @param {Array<object>} steps
 * @param {object} task
 * @returns {Array<object>}
 */
function assessRisks(steps, task) {
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
 * @param {Array<object>} steps
 * @param {Array<object>} dependencies
 * @param {Array<object>} risks
 * @returns {number}
 */
function estimateComplexity(steps, dependencies, risks) {
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
 * Recommend team composition based on complexity.
 * @param {number} complexity - 0-1 complexity score
 * @param {object} task
 * @returns {object|null}
 */
function recommendTeam(complexity, task) {
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
 * @param {string} domain
 * @param {'squad' | 'platoon'} level
 * @returns {string[]}
 */
function selectTeammates(domain, level) {
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
 * Resolve execution order considering dependencies.
 * Returns steps in topological order.
 * @param {Array<object>} steps
 * @param {Array<object>} dependencies
 * @returns {Array<object>}
 */
function resolveExecutionOrder(steps, dependencies) {
  // Simple case: already ordered sequentially
  if (dependencies.length === 0) {
    return [...steps].sort((a, b) => a.order - b.order);
  }

  // Topological sort via Kahn's algorithm
  const inDegree = {};
  const adjacency = {};
  const stepMap = {};

  for (const step of steps) {
    inDegree[step.id] = 0;
    adjacency[step.id] = [];
    stepMap[step.id] = step;
  }

  for (const dep of dependencies) {
    if (adjacency[dep.from] && inDegree[dep.to] !== undefined) {
      adjacency[dep.from].push(dep.to);
      inDegree[dep.to] += 1;
    }
  }

  const queue = Object.keys(inDegree).filter((id) => inDegree[id] === 0);
  const ordered = [];

  while (queue.length > 0) {
    const current = queue.shift();
    ordered.push(stepMap[current]);

    for (const neighbor of adjacency[current]) {
      inDegree[neighbor] -= 1;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Add any remaining steps (in case of circular deps, fallback to order)
  for (const step of steps) {
    if (!ordered.find((s) => s.id === step.id)) {
      ordered.push(step);
    }
  }

  return ordered;
}

/**
 * Check if step dependencies are satisfied.
 * @param {object} step
 * @param {Array<object>} completedResults
 * @param {Array<object>} dependencies
 * @returns {{ satisfied: boolean, unmet: string[] }}
 */
function checkDependencies(step, completedResults, dependencies) {
  const requiredSteps = dependencies
    .filter((d) => d.to === step.id)
    .map((d) => d.from);

  const unmet = requiredSteps.filter((reqId) => {
    const result = completedResults.find((r) => r.stepId === reqId);
    return !result || result.status !== 'success';
  });

  return { satisfied: unmet.length === 0, unmet };
}

/**
 * Extract a human-readable failure reason from a step result.
 * @param {object} stepResult
 * @returns {string}
 */
function extractFailureReason(stepResult) {
  if (!stepResult.execution) return 'No execution data';
  if (stepResult.execution.blocked) return `Blocked: ${stepResult.execution.blockedBy}`;
  if (stepResult.validation?.issues?.length > 0) {
    return stepResult.validation.issues.join('; ');
  }
  if (stepResult.execution.stderr) {
    const firstLine = stepResult.execution.stderr.split('\n')[0];
    return firstLine.slice(0, 200);
  }
  return `Exit code: ${stepResult.execution.exitCode}`;
}

/**
 * Suggest a correction for a failed step.
 * @param {object} failedStep - { stepId, action, reason }
 * @returns {string}
 */
function suggestCorrection(failedStep) {
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

/**
 * Build an adjusted plan from reflection corrections.
 * @param {object} executionResult
 * @param {Array<object>} corrections
 * @returns {object}
 */
function buildAdjustedPlan(executionResult, corrections) {
  const adjustedSteps = executionResult.results.map((r) => {
    const correction = corrections.find((c) => c.stepId === r.stepId);

    if (r.status === 'success') {
      // Already succeeded - keep but mark as completed
      return {
        id: r.stepId,
        order: r.order,
        action: r.action,
        status: 'completed',
        skipOnRetry: true,
      };
    }

    return {
      id: r.stepId,
      order: r.order,
      action: correction ? correction.suggestedAction : r.action,
      status: 'pending',
      corrected: !!correction,
    };
  });

  return {
    steps: adjustedSteps,
    adjustedAt: new Date().toISOString(),
    pendingCount: adjustedSteps.filter((s) => s.status === 'pending').length,
  };
}
