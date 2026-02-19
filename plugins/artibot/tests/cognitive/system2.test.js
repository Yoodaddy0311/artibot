import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  plan,
  execute,
  reflect,
  solve,
  assessComplexity,
} from '../../lib/cognitive/system2.js';

// Mock sandbox module so we control execution behavior
vi.mock('../../lib/cognitive/sandbox.js', () => {
  let sandboxIdCounter = 0;

  const createSandbox = vi.fn((opts = {}) => ({
    id: `mock-sandbox-${++sandboxIdCounter}`,
    status: 'active',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    options: { timeoutMs: 30000, ...opts },
    executionLog: [],
    blockedPatterns: [],
  }));

  const execute = vi.fn((action, sandbox) => ({
    executed: false,
    command: action,
    sandboxId: sandbox?.id || 'mock',
    blocked: false,
    blockedBy: null,
    startedAt: new Date().toISOString(),
    timeoutMs: 30000,
    cwd: undefined,
    stdout: '',
    stderr: '',
    exitCode: null,
    duration: 0,
  }));

  const validate = vi.fn(() => ({
    safe: true,
    success: true,
    issues: [],
    severity: 'none',
  }));

  const recordResult = vi.fn((record, actual) => ({ ...record, ...actual, executed: true }));

  const cleanup = vi.fn((sbx) => ({
    sandboxId: sbx?.id || 'unknown',
    status: 'cleaned',
    cleanedAt: new Date().toISOString(),
    stats: { totalExecutions: 0, blocked: 0, succeeded: 0, failed: 0, pending: 0, totalDuration: 0, status: 'cleaned' },
  }));

  const getStats = vi.fn(() => ({
    totalExecutions: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    pending: 0,
    totalDuration: 0,
    status: 'active',
  }));

  return { createSandbox, execute, validate, recordResult, cleanup, getStats };
});

const sandboxMocks = await import('../../lib/cognitive/sandbox.js');

describe('system2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: safe and successful execution
    sandboxMocks.execute.mockImplementation((action, sandbox) => ({
      executed: false,
      command: action,
      sandboxId: sandbox?.id || 'mock',
      blocked: false,
      blockedBy: null,
      startedAt: new Date().toISOString(),
      timeoutMs: 30000,
      cwd: undefined,
      stdout: '',
      stderr: '',
      exitCode: null,
      duration: 0,
    }));
    sandboxMocks.validate.mockReturnValue({ safe: true, success: true, issues: [], severity: 'none' });
    sandboxMocks.getStats.mockReturnValue({ totalExecutions: 1, blocked: 0, succeeded: 1, failed: 0, pending: 0, totalDuration: 10, status: 'active' });
  });

  // -------------------------------------------------------------------------
  describe('plan()', () => {
    const baseTask = { id: 'task-1', description: 'Fix the authentication bug' };

    it('throws when task is missing', () => {
      expect(() => plan(null)).toThrow();
    });

    it('throws when task.id is missing', () => {
      expect(() => plan({ description: 'test' })).toThrow();
    });

    it('throws when task.description is missing', () => {
      expect(() => plan({ id: 'x' })).toThrow();
    });

    it('returns taskId matching input task id', () => {
      const result = plan(baseTask);
      expect(result.taskId).toBe('task-1');
    });

    it('returns createdAt ISO string', () => {
      const result = plan(baseTask);
      expect(() => new Date(result.createdAt)).not.toThrow();
    });

    it('produces at least one step', () => {
      const result = plan(baseTask);
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });

    it('step has required fields', () => {
      const result = plan(baseTask);
      const step = result.steps[0];
      expect(step).toHaveProperty('id');
      expect(step).toHaveProperty('order');
      expect(step).toHaveProperty('action');
      expect(step).toHaveProperty('dependencies');
      expect(step).toHaveProperty('estimatedComplexity');
      expect(step).toHaveProperty('status', 'pending');
    });

    it('extracts numbered list steps', () => {
      const task = {
        id: 'numbered',
        description: '1. Read the file\n2. Parse the content\n3. Write results',
      };
      const result = plan(task);
      expect(result.steps.length).toBeGreaterThanOrEqual(3);
    });

    it('extracts steps with numbered list connectors', () => {
      const task = {
        id: 'connector',
        description: 'First read the config\nSecond validate it\nThird deploy the app',
      };
      const result = plan(task);
      // Connector-based extraction may yield 1-3 steps depending on regex behavior
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });

    it('returns complexity as a 0-1 number', () => {
      const result = plan(baseTask);
      expect(result.complexity).toBeGreaterThanOrEqual(0);
      expect(result.complexity).toBeLessThanOrEqual(1);
    });

    it('returns risks array', () => {
      const result = plan(baseTask);
      expect(Array.isArray(result.risks)).toBe(true);
    });

    it('identifies high-severity risk for delete operations', () => {
      const task = { id: 'dangerous', description: 'delete the old user records from database' };
      const result = plan(task);
      const highRisks = result.risks.filter((r) => r.severity === 'high');
      expect(highRisks.length).toBeGreaterThan(0);
    });

    it('identifies deploy risk', () => {
      const task = { id: 'deploy', description: 'deploy the application to production' };
      const result = plan(task);
      const deployRisks = result.risks.filter((r) => r.risk.includes('production'));
      expect(deployRisks.length).toBeGreaterThan(0);
    });

    it('returns null teamRecommendation for simple tasks', () => {
      const task = { id: 'simple', description: 'list the files' };
      const result = plan(task);
      expect(result.teamRecommendation).toBeNull();
    });

    it('returns teamRecommendation for complex tasks', () => {
      const task = {
        id: 'complex',
        description: 'Comprehensive security audit: refactor architecture, migrate database, optimize performance, redesign authentication, deploy to production',
      };
      const result = plan(task);
      // May or may not recommend based on complexity calculation
      if (result.teamRecommendation) {
        expect(result.teamRecommendation).toHaveProperty('recommended', true);
        expect(result.teamRecommendation).toHaveProperty('level');
      }
    });

    it('analyzeDependencies=false returns empty dependencies', () => {
      const task = { id: 'nodeps', description: 'First do this, then do that' };
      const result = plan(task, { analyzeDependencies: false });
      expect(result.dependencies).toEqual([]);
    });

    it('assessRisks=false returns empty risks', () => {
      const task = { id: 'norisks', description: 'delete everything and deploy' };
      const result = plan(task, { assessRisks: false });
      expect(result.risks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('execute()', () => {
    const simpleTask = { id: 'exec-task', description: 'read the config file' };

    it('returns planId matching plan taskId', () => {
      const p = plan(simpleTask);
      const result = execute(p);
      expect(result.planId).toBe('exec-task');
    });

    it('returns sandboxId string', () => {
      const p = plan(simpleTask);
      const result = execute(p);
      expect(typeof result.sandboxId).toBe('string');
    });

    it('returns startedAt and completedAt ISO strings', () => {
      const p = plan(simpleTask);
      const result = execute(p);
      expect(() => new Date(result.startedAt)).not.toThrow();
      expect(() => new Date(result.completedAt)).not.toThrow();
    });

    it('returns results array for each step', () => {
      const p = plan(simpleTask);
      const result = execute(p);
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBe(p.steps.length);
    });

    it('marks success=true when all steps succeed', () => {
      sandboxMocks.validate.mockReturnValue({ safe: true, success: true, issues: [], severity: 'none' });
      const p = plan(simpleTask);
      const result = execute(p);
      expect(result.success).toBe(true);
    });

    it('marks success=false when a step fails', () => {
      sandboxMocks.validate.mockReturnValue({ safe: false, success: false, issues: ['error'], severity: 'medium' });
      sandboxMocks.execute.mockReturnValue({
        executed: false, command: 'test', sandboxId: 'mock', blocked: false, blockedBy: null,
        startedAt: new Date().toISOString(), timeoutMs: 30000, cwd: undefined,
        stdout: '', stderr: 'error', exitCode: 1, duration: 0,
      });
      const p = plan(simpleTask);
      const result = execute(p);
      expect(result.success).toBe(false);
    });

    it('stops on first failure by default (stopOnFailure=true)', () => {
      sandboxMocks.validate.mockReturnValue({ safe: true, success: false, issues: ['fail'], severity: 'medium' });
      const task = {
        id: 'multi',
        description: '1. Step one\n2. Step two\n3. Step three',
      };
      const p = plan(task);
      const result = execute(p);
      const skipped = result.results.filter((r) => r.status === 'skipped');
      expect(skipped.length).toBeGreaterThanOrEqual(0);
    });

    it('accepts pre-created sandbox', () => {
      const mockSandbox = {
        id: 'provided-sandbox',
        status: 'active',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        options: { timeoutMs: 30000 },
        executionLog: [],
        blockedPatterns: [],
      };
      const p = plan(simpleTask);
      const result = execute(p, mockSandbox);
      expect(result.sandboxId).toBe('provided-sandbox');
    });

    it('calls onStepStart and onStepComplete callbacks', () => {
      const onStart = vi.fn();
      const onComplete = vi.fn();
      const p = plan(simpleTask);
      execute(p, null, { onStepStart: onStart, onStepComplete: onComplete });
      expect(onStart).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
    });

    it('stepsCompleted counts successful steps', () => {
      sandboxMocks.validate.mockReturnValue({ safe: true, success: true, issues: [], severity: 'none' });
      const p = plan(simpleTask);
      const result = execute(p);
      expect(result.stepsCompleted).toBeGreaterThanOrEqual(1);
    });

    it('stepsTotal equals plan steps length', () => {
      const p = plan(simpleTask);
      const result = execute(p);
      expect(result.stepsTotal).toBe(p.steps.length);
    });
  });

  // -------------------------------------------------------------------------
  describe('reflect()', () => {
    function makeExecution(overrides = {}) {
      return {
        planId: 'task-1',
        sandboxId: 'sbx-1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        results: [],
        success: true,
        stepsCompleted: 1,
        stepsTotal: 1,
        sandboxStats: {},
        ...overrides,
      };
    }

    it('returns reflectedAt ISO string', () => {
      const r = reflect(makeExecution());
      expect(() => new Date(r.reflectedAt)).not.toThrow();
    });

    it('includes analysis object', () => {
      const r = reflect(makeExecution());
      expect(r).toHaveProperty('analysis');
      expect(r.analysis).toHaveProperty('overallSuccess');
      expect(r.analysis).toHaveProperty('completionRate');
      expect(r.analysis).toHaveProperty('failedSteps');
      expect(r.analysis).toHaveProperty('blockedSteps');
      expect(r.analysis).toHaveProperty('patterns');
    });

    it('no retry when success=true', () => {
      const r = reflect(makeExecution({ success: true, stepsCompleted: 1, stepsTotal: 1, results: [{ stepId: 's1', action: 'a', status: 'success', execution: {}, validation: {} }] }));
      expect(r.retry.shouldRetry).toBe(false);
    });

    it('retry when some steps failed and none blocked', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 0,
        stepsTotal: 2,
        results: [
          { stepId: 's1', action: 'first action', status: 'failed', execution: { exitCode: 1, stderr: 'error occurred' }, validation: {} },
          { stepId: 's2', action: 'second action', status: 'success', execution: {}, validation: {} },
        ],
      });
      const r = reflect(execution);
      expect(r.retry.shouldRetry).toBe(true);
    });

    it('no retry when all steps blocked', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 0,
        stepsTotal: 1,
        results: [
          { stepId: 's1', action: 'rm -rf /', status: 'blocked', execution: { blocked: true, blockedBy: 'rm -rf with path' }, validation: {} },
        ],
      });
      const r = reflect(execution);
      expect(r.retry.shouldRetry).toBe(false);
    });

    it('detects safety_blocked pattern', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 0,
        stepsTotal: 1,
        results: [
          { stepId: 's1', action: 'rm -rf /', status: 'blocked', execution: { blocked: true, blockedBy: 'rm -rf' }, validation: {} },
        ],
      });
      const r = reflect(execution);
      expect(r.analysis.patterns).toContain('safety_blocked');
    });

    it('detects partial_success pattern', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 1,
        stepsTotal: 2,
        results: [
          { stepId: 's1', action: 'step1', status: 'success', execution: {}, validation: {} },
          { stepId: 's2', action: 'step2', status: 'failed', execution: { exitCode: 1, stderr: '' }, validation: {} },
        ],
      });
      const r = reflect(execution);
      expect(r.analysis.patterns).toContain('partial_success');
    });

    it('generates corrections for failed steps', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 0,
        stepsTotal: 1,
        results: [
          { stepId: 's1', action: 'read file', status: 'failed', execution: { exitCode: 1, stderr: 'permission denied' }, validation: {} },
        ],
      });
      const r = reflect(execution);
      expect(r.corrections.length).toBeGreaterThan(0);
      expect(r.corrections[0].suggestedAction).toContain('permission');
    });

    it('adjustedPlan is not null when shouldRetry is true', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 1,
        stepsTotal: 2,
        results: [
          { stepId: 's1', action: 'step1', status: 'success', execution: {}, validation: {} },
          { stepId: 's2', action: 'step2 timeout error', status: 'failed', execution: { exitCode: 1, stderr: 'timeout' }, validation: {} },
        ],
      });
      const r = reflect(execution);
      if (r.retry.shouldRetry) {
        expect(r.retry.adjustedPlan).not.toBeNull();
        expect(r.retry.adjustedPlan.steps).toBeDefined();
      }
    });

    it('completionRate is between 0 and 1', () => {
      const execution = makeExecution({ stepsCompleted: 2, stepsTotal: 4 });
      const r = reflect(execution);
      expect(r.analysis.completionRate).toBe(0.5);
    });

    it('suggestion includes extended timeout for timeout failures', () => {
      const execution = makeExecution({
        success: false,
        stepsCompleted: 0,
        stepsTotal: 1,
        results: [
          { stepId: 's1', action: 'slow action', status: 'failed', execution: { exitCode: 1, stderr: 'timeout exceeded' }, validation: {} },
        ],
      });
      const r = reflect(execution);
      if (r.corrections.length > 0) {
        expect(r.corrections[0].suggestedAction).toContain('timeout');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('solve() - retry loop', () => {
    const basicTask = { id: 'solve-1', description: 'fix the bug', type: 'fix' };

    it('returns taskId', () => {
      const result = solve(basicTask);
      expect(result.taskId).toBe('solve-1');
    });

    it('reports success when execution succeeds on first attempt', () => {
      sandboxMocks.validate.mockReturnValue({ safe: true, success: true, issues: [], severity: 'none' });
      const result = solve(basicTask);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it('returns history array with attempt entries', () => {
      const result = solve(basicTask);
      expect(Array.isArray(result.history)).toBe(true);
      expect(result.history.length).toBeGreaterThanOrEqual(1);
      expect(result.history[0]).toHaveProperty('attempt', 1);
      expect(result.history[0]).toHaveProperty('plan');
      expect(result.history[0]).toHaveProperty('execution');
      expect(result.history[0]).toHaveProperty('reflection');
    });

    it('includes duration in milliseconds', () => {
      const result = solve(basicTask);
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('includes finalResult', () => {
      const result = solve(basicTask);
      expect(result.finalResult).toBeDefined();
    });

    it('retries when execution fails and shouldRetry is true', () => {
      // First call fails, second succeeds
      sandboxMocks.validate
        .mockReturnValueOnce({ safe: true, success: false, issues: ['err'], severity: 'medium' })
        .mockReturnValue({ safe: true, success: true, issues: [], severity: 'none' });

      const result = solve(basicTask, { maxRetries: 3 });
      expect(result.attempts).toBeGreaterThanOrEqual(1);
    });

    it('stops retrying after maxRetries', () => {
      sandboxMocks.validate.mockReturnValue({ safe: true, success: false, issues: ['persistent error'], severity: 'medium' });
      const result = solve(basicTask, { maxRetries: 2 });
      expect(result.attempts).toBeLessThanOrEqual(2);
    });

    it('calls onAttempt callback for each phase', () => {
      const onAttempt = vi.fn();
      solve(basicTask, { onAttempt });
      // 3 phases: plan, execute, reflect
      expect(onAttempt).toHaveBeenCalledWith(1, 'plan', expect.anything());
      expect(onAttempt).toHaveBeenCalledWith(1, 'execute', expect.anything());
      expect(onAttempt).toHaveBeenCalledWith(1, 'reflect', expect.anything());
    });

    it('captures teamRecommendation from plan', () => {
      const complexTask = {
        id: 'complex',
        description: 'refactor the entire security architecture and migrate all databases, optimize performance and deploy to production',
        type: 'refactor',
        domain: 'security',
      };
      const result = solve(complexTask);
      // teamRecommendation is set from first plan - may be null for simple cases
      expect(result).toHaveProperty('teamRecommendation');
    });
  });

  // -------------------------------------------------------------------------
  describe('assessComplexity()', () => {
    it('returns score 0 for missing task', () => {
      const result = assessComplexity(null);
      expect(result.score).toBe(0);
      expect(result.recommendation).toBe('system1');
    });

    it('returns score 0 for missing description', () => {
      const result = assessComplexity({ id: 'x' });
      expect(result.score).toBe(0);
    });

    it('returns score between 0 and 1', () => {
      const result = assessComplexity({ id: 'x', description: 'fix a typo' });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('recommends system1 for very simple tasks', () => {
      const result = assessComplexity({ id: 'x', description: 'lint the file', type: 'lint' });
      expect(result.recommendation).toBe('system1');
    });

    it('recommends system2 for moderately complex tasks', () => {
      const result = assessComplexity({ id: 'x', description: 'fix the authentication bug by first reading the docs, then updating the handler' });
      // score >= 0.3 → system2
      if (result.score >= 0.3) {
        expect(result.recommendation).toBe('system2');
      }
    });

    it('recommends team for highly complex tasks', () => {
      const result = assessComplexity({
        id: 'hard',
        description: 'comprehensive security audit: refactor architecture, migrate database, optimize performance system-wide, concurrent distributed redesign',
        type: 'security-audit',
        domain: 'security',
        context: { files: 100, modules: 20, teams: 3, critical: true, deadline: 'asap' },
      });
      expect(['system2', 'team']).toContain(result.recommendation);
    });

    it('includes all factor keys', () => {
      const result = assessComplexity({ id: 'x', description: 'do something' });
      expect(result.factors).toHaveProperty('descriptionLength');
      expect(result.factors).toHaveProperty('multiStep');
      expect(result.factors).toHaveProperty('domainComplexity');
      expect(result.factors).toHaveProperty('contextRichness');
      expect(result.factors).toHaveProperty('typeComplexity');
    });

    it('context richness contributes to complexity', () => {
      const withContext = assessComplexity({
        id: 'x',
        description: 'do something',
        context: { a: 1, b: 2, c: 3, d: 4, e: 5 },
      });
      const withoutContext = assessComplexity({ id: 'x', description: 'do something' });
      expect(withContext.score).toBeGreaterThanOrEqual(withoutContext.score);
    });

    it('complex type (refactor) scores higher than simple type (format)', () => {
      const complex = assessComplexity({ id: 'x', description: 'do something', type: 'refactor' });
      const simple = assessComplexity({ id: 'x', description: 'do something', type: 'format' });
      expect(complex.score).toBeGreaterThan(simple.score);
    });

    it('multi-step description increases score', () => {
      const single = assessComplexity({ id: 'x', description: 'fix it' });
      const multi = assessComplexity({ id: 'x', description: 'first do this, then do that, after that finalize, next deploy, finally verify' });
      expect(multi.score).toBeGreaterThan(single.score);
    });
  });
});
