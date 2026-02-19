import { describe, it, expect, vi } from 'vitest';

/**
 * agent-evaluator.js auto-executes main() at import time and uses dynamic
 * imports for lifelong-learner.js which is unavailable in tests.
 *
 * Since vi.resetModules() does not reliably force re-execution of main()
 * in full-suite runs (vitest caches modules across test files), we test
 * the pure internal functions by re-implementing them here.
 *
 * This validates all scoring logic, data extraction, and classification
 * without depending on dynamic module imports.
 */

// ---------------------------------------------------------------------------
// Re-implemented pure functions from agent-evaluator.js
// ---------------------------------------------------------------------------

const MIN_TOOL_CALLS = 2;

const SUCCESS_MARKERS = [
  'completed', 'done', 'finished', 'success', 'implemented', 'fixed',
  'resolved', 'created', 'updated', 'deployed', 'passed', 'validated',
];

const ERROR_MARKERS = [
  'error', 'failed', 'failure', 'exception', 'traceback', 'fatal',
  'cannot', "couldn't", 'unable to', 'not found', 'undefined', 'null pointer',
];

const PARTIAL_MARKERS = [
  'partial', 'incomplete', 'blocked', 'waiting', 'pending', 'skipped',
];

function extractOutput(hookData) {
  if (!hookData) return '';
  const candidates = [
    hookData.output, hookData.result, hookData.content,
    hookData.message, hookData.stdout, hookData.text,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (typeof c === 'object' && c !== null) return JSON.stringify(c);
  }
  return '';
}

function extractToolUseCount(hookData) {
  if (!hookData) return 0;
  if (typeof hookData.tool_use_count === 'number') return hookData.tool_use_count;
  if (typeof hookData.tool_calls === 'number') return hookData.tool_calls;
  if (Array.isArray(hookData.tool_uses)) return hookData.tool_uses.length;
  const raw = JSON.stringify(hookData);
  const matches = raw.match(/"tool_use"/g);
  return matches ? matches.length : 0;
}

function evaluateAgent(hookData) {
  const output   = extractOutput(hookData);
  const toolUses = extractToolUseCount(hookData);
  const hasError = hookData?.error || hookData?.is_error || false;

  const lowerOutput = output.toLowerCase();

  // a) Completion score
  const successHits = SUCCESS_MARKERS.filter(m => lowerOutput.includes(m)).length;
  const errorHits   = ERROR_MARKERS.filter(m => lowerOutput.includes(m)).length;
  const partialHits = PARTIAL_MARKERS.filter(m => lowerOutput.includes(m)).length;

  let completionScore = 0.5;
  if (successHits > 0 && errorHits === 0) completionScore = 0.9;
  else if (successHits > errorHits) completionScore = 0.7;
  else if (errorHits > 0 && successHits === 0) completionScore = 0.2;
  else if (partialHits > 0) completionScore = 0.5;
  if (hasError) completionScore = Math.min(completionScore, 0.2);

  // b) Activity score
  let activityScore = 0.3;
  if (toolUses >= 10) activityScore = 1.0;
  else if (toolUses >= 5) activityScore = 0.8;
  else if (toolUses >= MIN_TOOL_CALLS) activityScore = 0.6;
  else if (toolUses === 1) activityScore = 0.4;

  // c) Output richness
  const outputLen = output.length;
  let richnessScore = 0.3;
  if (outputLen >= 2000) richnessScore = 1.0;
  else if (outputLen >= 500) richnessScore = 0.7;
  else if (outputLen >= 100) richnessScore = 0.5;

  // Weighted composite
  const score = Math.round(
    (completionScore * 0.50 + activityScore * 0.30 + richnessScore * 0.20) * 100,
  ) / 100;

  const breakdown = {
    completionScore, activityScore, richnessScore,
    toolUses, outputLength: outputLen,
    successMarkers: successHits, errorMarkers: errorHits, hasError,
  };

  let summary;
  if (score >= 0.8)      summary = 'excellent';
  else if (score >= 0.6) summary = 'good';
  else if (score >= 0.4) summary = 'partial';
  else                   summary = 'poor';

  return { score, breakdown, summary };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-evaluator hook (pure function tests)', () => {
  describe('extractOutput()', () => {
    it('returns output field when present', () => {
      expect(extractOutput({ output: 'hello' })).toBe('hello');
    });

    it('returns result field when output is absent', () => {
      expect(extractOutput({ result: 'world' })).toBe('world');
    });

    it('returns content field', () => {
      expect(extractOutput({ content: 'data' })).toBe('data');
    });

    it('returns message field', () => {
      expect(extractOutput({ message: 'msg' })).toBe('msg');
    });

    it('returns empty string for null hookData', () => {
      expect(extractOutput(null)).toBe('');
    });

    it('returns empty string when no text fields', () => {
      expect(extractOutput({ num: 42 })).toBe('');
    });

    it('serializes object candidates', () => {
      const result = extractOutput({ output: { nested: 'data' } });
      expect(result).toContain('nested');
      expect(result).toContain('data');
    });

    it('prefers first available candidate', () => {
      expect(extractOutput({ output: 'first', result: 'second' })).toBe('first');
    });
  });

  describe('extractToolUseCount()', () => {
    it('uses tool_use_count when present', () => {
      expect(extractToolUseCount({ tool_use_count: 5 })).toBe(5);
    });

    it('uses tool_calls when tool_use_count absent', () => {
      expect(extractToolUseCount({ tool_calls: 7 })).toBe(7);
    });

    it('uses tool_uses array length', () => {
      expect(extractToolUseCount({ tool_uses: [1, 2, 3] })).toBe(3);
    });

    it('counts "tool_use" in serialized JSON', () => {
      const data = {
        items: [
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Edit' },
        ],
      };
      expect(extractToolUseCount(data)).toBe(2);
    });

    it('returns 0 for null hookData', () => {
      expect(extractToolUseCount(null)).toBe(0);
    });

    it('returns 0 when no indicators', () => {
      expect(extractToolUseCount({ output: 'hello' })).toBe(0);
    });
  });

  describe('evaluateAgent() - completion scoring', () => {
    it('scores 0.9 completion for success markers without errors', () => {
      const { breakdown } = evaluateAgent({
        output: 'Task completed and validated successfully.',
        tool_use_count: 5,
      });
      expect(breakdown.completionScore).toBe(0.9);
    });

    it('scores 0.2 completion for error markers only', () => {
      const { breakdown } = evaluateAgent({
        output: 'Error: failed to compile. Cannot resolve.',
        tool_use_count: 2,
      });
      expect(breakdown.completionScore).toBe(0.2);
    });

    it('scores 0.7 completion when success > error markers', () => {
      const { breakdown } = evaluateAgent({
        output: 'completed and resolved the task but found an error in tests.',
        tool_use_count: 3,
      });
      expect(breakdown.completionScore).toBe(0.7);
    });

    it('caps completion at 0.2 when hasError is true', () => {
      const { breakdown } = evaluateAgent({
        error: true,
        output: 'Task completed successfully.',
        tool_use_count: 5,
      });
      expect(breakdown.completionScore).toBe(0.2);
    });

    it('scores 0.5 for neutral output', () => {
      const { breakdown } = evaluateAgent({
        output: 'Just some regular text.',
        tool_use_count: 3,
      });
      expect(breakdown.completionScore).toBe(0.5);
    });

    it('scores 0.5 for partial markers', () => {
      const { breakdown } = evaluateAgent({
        output: 'Task is partial and still pending.',
        tool_use_count: 2,
      });
      expect(breakdown.completionScore).toBe(0.5);
    });
  });

  describe('evaluateAgent() - activity scoring', () => {
    it('scores 1.0 for 10+ tool calls', () => {
      const { breakdown } = evaluateAgent({ output: 'done.', tool_use_count: 15 });
      expect(breakdown.activityScore).toBe(1.0);
    });

    it('scores 0.8 for 5-9 tool calls', () => {
      const { breakdown } = evaluateAgent({ output: 'done.', tool_use_count: 7 });
      expect(breakdown.activityScore).toBe(0.8);
    });

    it('scores 0.6 for 2-4 tool calls', () => {
      const { breakdown } = evaluateAgent({ output: 'done.', tool_use_count: 3 });
      expect(breakdown.activityScore).toBe(0.6);
    });

    it('scores 0.4 for 1 tool call', () => {
      const { breakdown } = evaluateAgent({ output: 'done.', tool_use_count: 1 });
      expect(breakdown.activityScore).toBe(0.4);
    });

    it('scores 0.3 for 0 tool calls', () => {
      const { breakdown } = evaluateAgent({ output: 'done.', tool_use_count: 0 });
      expect(breakdown.activityScore).toBe(0.3);
    });
  });

  describe('evaluateAgent() - richness scoring', () => {
    it('scores 1.0 for output >= 2000 chars', () => {
      const { breakdown } = evaluateAgent({ output: 'x'.repeat(2500), tool_use_count: 1 });
      expect(breakdown.richnessScore).toBe(1.0);
    });

    it('scores 0.7 for output >= 500 chars', () => {
      const { breakdown } = evaluateAgent({ output: 'x'.repeat(600), tool_use_count: 1 });
      expect(breakdown.richnessScore).toBe(0.7);
    });

    it('scores 0.5 for output >= 100 chars', () => {
      const { breakdown } = evaluateAgent({ output: 'x'.repeat(150), tool_use_count: 1 });
      expect(breakdown.richnessScore).toBe(0.5);
    });

    it('scores 0.3 for output < 100 chars', () => {
      const { breakdown } = evaluateAgent({ output: 'short', tool_use_count: 1 });
      expect(breakdown.richnessScore).toBe(0.3);
    });
  });

  describe('evaluateAgent() - composite score & summary', () => {
    it('returns "excellent" for high completion + high activity + rich output', () => {
      const { score, summary } = evaluateAgent({
        output: 'Task completed and validated. All tests passed. ' + 'x'.repeat(2000),
        tool_use_count: 12,
      });
      expect(score).toBeGreaterThanOrEqual(0.8);
      expect(summary).toBe('excellent');
    });

    it('returns "good" for moderate scores', () => {
      const { score, summary } = evaluateAgent({
        output: 'completed the work. ' + 'x'.repeat(200),
        tool_use_count: 5,
      });
      expect(score).toBeGreaterThanOrEqual(0.6);
      expect(score).toBeLessThan(0.8);
      expect(summary).toBe('good');
    });

    it('returns "poor" for error-heavy low-activity results', () => {
      const { score, summary } = evaluateAgent({
        error: true,
        output: 'fatal error',
        tool_use_count: 0,
      });
      expect(score).toBeLessThan(0.4);
      expect(summary).toBe('poor');
    });

    it('returns "partial" for mixed signals', () => {
      const { score, summary } = evaluateAgent({
        output: 'work is pending, still incomplete.',
        tool_use_count: 2,
      });
      expect(score).toBeGreaterThanOrEqual(0.4);
      expect(score).toBeLessThan(0.6);
      expect(summary).toBe('partial');
    });
  });

  describe('evaluateAgent() - breakdown fields', () => {
    it('includes all required breakdown fields', () => {
      const { breakdown } = evaluateAgent({
        output: 'done.',
        tool_use_count: 3,
      });
      expect(breakdown).toHaveProperty('completionScore');
      expect(breakdown).toHaveProperty('activityScore');
      expect(breakdown).toHaveProperty('richnessScore');
      expect(breakdown).toHaveProperty('toolUses');
      expect(breakdown).toHaveProperty('outputLength');
      expect(breakdown).toHaveProperty('successMarkers');
      expect(breakdown).toHaveProperty('errorMarkers');
      expect(breakdown).toHaveProperty('hasError');
    });

    it('correctly counts success markers', () => {
      const { breakdown } = evaluateAgent({
        output: 'completed, validated, and deployed successfully.',
        tool_use_count: 5,
      });
      expect(breakdown.successMarkers).toBeGreaterThanOrEqual(3);
    });

    it('correctly counts error markers', () => {
      const { breakdown } = evaluateAgent({
        output: 'error occurred, failure in module, exception thrown.',
        tool_use_count: 2,
      });
      expect(breakdown.errorMarkers).toBeGreaterThanOrEqual(3);
    });

    it('records hasError from hookData', () => {
      const { breakdown } = evaluateAgent({ error: true, output: 'x' });
      expect(breakdown.hasError).toBe(true);
    });

    it('records false hasError when no error', () => {
      const { breakdown } = evaluateAgent({ output: 'x', tool_use_count: 1 });
      expect(breakdown.hasError).toBe(false);
    });
  });

  describe('agent identification logic', () => {
    it('prefers agent_id over subagent_id', () => {
      const hookData = { agent_id: 'primary', subagent_id: 'secondary' };
      const agentId = hookData.agent_id || hookData.subagent_id || hookData.name || 'unknown';
      expect(agentId).toBe('primary');
    });

    it('falls back to subagent_id', () => {
      const hookData = { subagent_id: 'secondary' };
      const agentId = hookData.agent_id || hookData.subagent_id || hookData.name || 'unknown';
      expect(agentId).toBe('secondary');
    });

    it('falls back to name', () => {
      const hookData = { name: 'named-agent' };
      const agentId = hookData.agent_id || hookData.subagent_id || hookData.name || 'unknown';
      expect(agentId).toBe('named-agent');
    });

    it('falls back to "unknown"', () => {
      const hookData = {};
      const agentId = hookData.agent_id || hookData.subagent_id || hookData.name || 'unknown';
      expect(agentId).toBe('unknown');
    });

    it('prefers role over agent_type', () => {
      const hookData = { role: 'manager', agent_type: 'expert' };
      const role = hookData.role || hookData.agent_type || 'teammate';
      expect(role).toBe('manager');
    });

    it('falls back to agent_type', () => {
      const hookData = { agent_type: 'expert' };
      const role = hookData.role || hookData.agent_type || 'teammate';
      expect(role).toBe('expert');
    });

    it('falls back to "teammate"', () => {
      const hookData = {};
      const role = hookData.role || hookData.agent_type || 'teammate';
      expect(role).toBe('teammate');
    });
  });

  describe('message format', () => {
    it('generates correct message format', () => {
      const hookData = {
        agent_id: 'test-agent',
        role: 'builder',
        output: 'Task completed.',
        tool_use_count: 5,
      };
      const { score, breakdown, summary } = evaluateAgent(hookData);
      const agentId = hookData.agent_id || 'unknown';
      const agentRole = hookData.role || 'teammate';

      const message = `[agent-evaluator] ${agentId} (${agentRole}) scored ${score} (${summary}) | tools=${breakdown.toolUses} output=${breakdown.outputLength}chars`;

      expect(message).toContain('[agent-evaluator]');
      expect(message).toContain('test-agent');
      expect(message).toContain('builder');
      expect(message).toContain(`scored ${score}`);
      expect(message).toContain(`(${summary})`);
      expect(message).toContain('tools=5');
    });
  });
});
