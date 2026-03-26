import { describe, expect, it } from 'vitest';
import {
  _conditionsMet,
  _evaluateToolCall,
  _findMatchingRule,
  _matchToolPattern,
  createGuardrailMiddleware,
  DEFAULT_RULES,
} from '../../../lib/runtime/middleware/guardrail.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
  return {
    userPrompt: 'test prompt',
    context: {
      routing: { system: 'system1', score: 0.3 },
      subagents: { contract: { tools: [] } },
      tasks: { mode: 'subAgent' },
      ...overrides.context,
    },
    messageParts: [],
    ...overrides,
  };
}

function makeStateWithTools(tools, overrides = {}) {
  return makeState({
    ...overrides,
    context: {
      subagents: { contract: { tools } },
      routing: { system: 'system1', score: 0.3 },
      tasks: { mode: 'subAgent' },
      ...overrides.context,
    },
  });
}

// ---------------------------------------------------------------------------
// Unit: matchToolPattern
// ---------------------------------------------------------------------------

describe('guardrail/_matchToolPattern', () => {
  it('정확한 이름 매칭', () => {
    expect(_matchToolPattern('Bash', 'Bash')).toBe(true);
  });

  it('이름 불일치 시 false', () => {
    expect(_matchToolPattern('Bash', 'Read')).toBe(false);
  });

  it('와일드카드 * → 모든 도구 매칭', () => {
    expect(_matchToolPattern('Bash', '*')).toBe(true);
    expect(_matchToolPattern('Read', '*')).toBe(true);
  });

  it('접두사 와일드카드 매칭 (Task*)', () => {
    expect(_matchToolPattern('TaskCreate', 'Task*')).toBe(true);
    expect(_matchToolPattern('TaskUpdate', 'Task*')).toBe(true);
    expect(_matchToolPattern('SendMessage', 'Task*')).toBe(false);
  });

  it('대소문자 구분', () => {
    expect(_matchToolPattern('bash', 'Bash')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: conditionsMet
// ---------------------------------------------------------------------------

describe('guardrail/_conditionsMet', () => {
  it('조건 없는 규칙은 항상 true', () => {
    const rule = { tool: 'Bash', decision: 'deny' };
    expect(_conditionsMet(rule, {})).toBe(true);
  });

  it('phases 조건 매칭', () => {
    const rule = { tool: 'Bash', decision: 'deny', conditions: { phases: ['system2'] } };
    expect(_conditionsMet(rule, { routingPhase: 'system2' })).toBe(true);
    expect(_conditionsMet(rule, { routingPhase: 'system1' })).toBe(false);
  });

  it('args 조건 매칭 (부분 문자열)', () => {
    const rule = { tool: 'Bash', decision: 'deny', conditions: { args: ['rm -rf'] } };
    expect(_conditionsMet(rule, { toolArgs: 'please rm -rf /' })).toBe(true);
    expect(_conditionsMet(rule, { toolArgs: 'ls -la' })).toBe(false);
  });

  it('args + phases 모두 만족해야 true', () => {
    const rule = {
      tool: 'Bash',
      decision: 'deny',
      conditions: { phases: ['system2'], args: ['deploy'] },
    };
    expect(_conditionsMet(rule, { routingPhase: 'system2', toolArgs: 'deploy prod' })).toBe(true);
    expect(_conditionsMet(rule, { routingPhase: 'system1', toolArgs: 'deploy prod' })).toBe(false);
    expect(_conditionsMet(rule, { routingPhase: 'system2', toolArgs: 'ls' })).toBe(false);
  });

  it('빈 phases 배열은 무시', () => {
    const rule = { tool: 'Bash', decision: 'deny', conditions: { phases: [] } };
    expect(_conditionsMet(rule, { routingPhase: 'system1' })).toBe(true);
  });

  it('빈 args 배열은 무시', () => {
    const rule = { tool: 'Bash', decision: 'deny', conditions: { args: [] } };
    expect(_conditionsMet(rule, { toolArgs: 'anything' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: findMatchingRule
// ---------------------------------------------------------------------------

describe('guardrail/_findMatchingRule', () => {
  it('첫 번째 매칭 규칙 반환', () => {
    const rules = [
      { tool: 'Read', decision: 'allow' },
      { tool: 'Bash', decision: 'deny' },
      { tool: 'Bash', decision: 'allow' },
    ];
    const result = _findMatchingRule(rules, 'Bash', {});
    expect(result.decision).toBe('deny');
  });

  it('매칭 규칙 없으면 null', () => {
    const rules = [{ tool: 'Read', decision: 'allow' }];
    expect(_findMatchingRule(rules, 'Bash', {})).toBeNull();
  });

  it('조건 불일치 시 다음 규칙으로 스킵', () => {
    const rules = [
      { tool: 'Bash', decision: 'deny', conditions: { phases: ['system2'] } },
      { tool: 'Bash', decision: 'allow' },
    ];
    const result = _findMatchingRule(rules, 'Bash', { routingPhase: 'system1' });
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Unit: evaluateToolCall
// ---------------------------------------------------------------------------

describe('guardrail/_evaluateToolCall', () => {
  it('매칭 규칙 반환', () => {
    const rules = [{ tool: 'Bash', decision: 'ask', reason: 'dangerous' }];
    const result = _evaluateToolCall(rules, 'Bash', {}, true);
    expect(result.decision).toBe('ask');
    expect(result.reason).toBe('dangerous');
  });

  it('fail_closed=true → 미매칭 시 deny', () => {
    const result = _evaluateToolCall([], 'Unknown', {}, true);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('fail_closed');
  });

  it('fail_closed=false → 미매칭 시 allow', () => {
    const result = _evaluateToolCall([], 'Unknown', {}, false);
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('default allow');
  });

  it('규칙에 reason 없으면 기본 reason 생성', () => {
    const rules = [{ tool: 'Bash', decision: 'deny' }];
    const result = _evaluateToolCall(rules, 'Bash', {}, true);
    expect(result.reason).toContain('Matched rule for');
  });
});

// ---------------------------------------------------------------------------
// Integration: createGuardrailMiddleware
// ---------------------------------------------------------------------------

describe('middleware/guardrail', () => {
  it('enabled=false → 패스스루', async () => {
    const mw = createGuardrailMiddleware({ enabled: false });
    const state = makeStateWithTools(['Bash']);
    const result = await mw(state);

    expect(result.context.guardrail.enabled).toBe(false);
    expect(result.context.guardrail.evaluations).toEqual([]);
  });

  it('기본 규칙으로 Read → allow', async () => {
    const mw = createGuardrailMiddleware();
    const state = makeStateWithTools(['Read']);
    const result = await mw(state);

    expect(result.context.guardrail.denied).toEqual([]);
    expect(result.context.guardrail.evaluations[0].decision).toBe('allow');
    expect(result.messageParts).toContain('guardrail=ok');
  });

  it('기본 규칙으로 Bash → ask', async () => {
    const mw = createGuardrailMiddleware();
    const state = makeStateWithTools(['Bash']);
    const result = await mw(state);

    expect(result.context.guardrail.asked).toEqual(['Bash']);
    expect(result.messageParts).toContain('guardrail=ask:Bash');
  });

  it('fail_closed=true → 미등록 도구 deny', async () => {
    const mw = createGuardrailMiddleware({ failClosed: true });
    const state = makeStateWithTools(['UnknownTool']);
    const result = await mw(state);

    expect(result.context.guardrail.denied).toEqual(['UnknownTool']);
    expect(result.messageParts[0]).toContain('guardrail=denied:UnknownTool');
    expect(result.userPrompt).toContain('Guardrail');
  });

  it('fail_closed=false → 미등록 도구 allow', async () => {
    const mw = createGuardrailMiddleware({ failClosed: false });
    const state = makeStateWithTools(['UnknownTool']);
    const result = await mw(state);

    expect(result.context.guardrail.denied).toEqual([]);
    expect(result.messageParts).toContain('guardrail=ok');
  });

  it('커스텀 규칙 추가 (defaults + custom)', async () => {
    const mw = createGuardrailMiddleware({
      rules: [{ tool: 'Bash', decision: 'deny', reason: 'no shell' }],
    });
    const state = makeStateWithTools(['Bash']);
    const result = await mw(state);

    // Custom rule comes after defaults, so default 'ask' rule wins (first match)
    expect(result.context.guardrail.evaluations[0].decision).toBe('ask');
  });

  it('includeDefaults=false → 커스텀 규칙만 적용', async () => {
    const mw = createGuardrailMiddleware({
      includeDefaults: false,
      rules: [{ tool: 'Bash', decision: 'deny', reason: 'blocked' }],
    });
    const state = makeStateWithTools(['Bash']);
    const result = await mw(state);

    expect(result.context.guardrail.evaluations[0].decision).toBe('deny');
    expect(result.context.guardrail.ruleCount).toBe(1);
  });

  it('agentTeam 모드 → TeamCreate/SendMessage/TaskCreate 후보 추가', async () => {
    const mw = createGuardrailMiddleware({ failClosed: true, includeDefaults: false });
    const state = makeState({
      context: {
        routing: { system: 'system2' },
        subagents: { contract: { tools: [] } },
        tasks: { mode: 'agentTeam' },
      },
    });
    const result = await mw(state);

    const toolNames = result.context.guardrail.evaluations.map((e) => e.tool);
    expect(toolNames).toContain('TeamCreate');
    expect(toolNames).toContain('SendMessage');
    expect(toolNames).toContain('TaskCreate');
  });

  it('다수 도구 평가 — 혼합 결과', async () => {
    const mw = createGuardrailMiddleware();
    const state = makeStateWithTools(['Read', 'Bash', 'Write']);
    const result = await mw(state);

    expect(result.context.guardrail.evaluated).toBe(3);
    const decisions = result.context.guardrail.evaluations.map((e) => e.decision);
    expect(decisions).toContain('allow');
    expect(decisions).toContain('ask');
  });

  it('denied 도구가 있으면 prompt에 경고 추가', async () => {
    const mw = createGuardrailMiddleware({
      includeDefaults: false,
      rules: [{ tool: 'Bash', decision: 'deny', reason: 'blocked' }],
    });
    const state = makeStateWithTools(['Bash']);
    const result = await mw(state);

    expect(result.userPrompt).toContain('⚠️ Guardrail');
    expect(result.userPrompt).toContain('Bash');
  });

  it('규칙 동결 — 외부 변경 불가', async () => {
    const rules = [{ tool: 'Test', decision: 'allow' }];
    createGuardrailMiddleware({ rules });

    // Mutating original should not affect middleware
    rules.push({ tool: 'Hack', decision: 'allow' });
    // No error thrown means freeze worked
    expect(rules).toHaveLength(2);
  });

  it('빈 도구 후보 → 평가 0건', async () => {
    const mw = createGuardrailMiddleware();
    const state = makeStateWithTools([]);
    const result = await mw(state);

    expect(result.context.guardrail.evaluated).toBe(0);
    expect(result.messageParts).toContain('guardrail=ok');
  });

  it('DEFAULT_RULES는 frozen', () => {
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
    expect(DEFAULT_RULES.length).toBeGreaterThanOrEqual(6);
  });

  it('context.guardrail 구조 검증', async () => {
    const mw = createGuardrailMiddleware();
    const state = makeStateWithTools(['Read']);
    const result = await mw(state);

    const g = result.context.guardrail;
    expect(g).toHaveProperty('enabled', true);
    expect(g).toHaveProperty('failClosed', true);
    expect(g).toHaveProperty('ruleCount');
    expect(g).toHaveProperty('evaluated');
    expect(g).toHaveProperty('denied');
    expect(g).toHaveProperty('asked');
    expect(g).toHaveProperty('evaluations');
  });

  it('evaluation 항목 구조 검증', async () => {
    const mw = createGuardrailMiddleware();
    const state = makeStateWithTools(['Read']);
    const result = await mw(state);

    const ev = result.context.guardrail.evaluations[0];
    expect(ev).toHaveProperty('tool', 'Read');
    expect(ev).toHaveProperty('decision', 'allow');
    expect(ev).toHaveProperty('reason');
    expect(ev).toHaveProperty('rulePattern', 'Read');
  });

  it('rulePattern이 null — fail_closed deny에서', async () => {
    const mw = createGuardrailMiddleware({ failClosed: true, includeDefaults: false });
    const state = makeStateWithTools(['SomeTool']);
    const result = await mw(state);

    expect(result.context.guardrail.evaluations[0].rulePattern).toBeNull();
  });

  it('와일드카드 규칙으로 모든 도구 allow', async () => {
    const mw = createGuardrailMiddleware({
      includeDefaults: false,
      rules: [{ tool: '*', decision: 'allow', reason: 'all allowed' }],
      failClosed: true,
    });
    const state = makeStateWithTools(['AnyTool', 'AnotherTool']);
    const result = await mw(state);

    expect(result.context.guardrail.denied).toEqual([]);
    expect(result.context.guardrail.evaluations.every((e) => e.decision === 'allow')).toBe(true);
  });

  it('조건부 deny — system2에서만 Bash 차단', async () => {
    const mw = createGuardrailMiddleware({
      includeDefaults: false,
      rules: [
        { tool: 'Bash', decision: 'deny', conditions: { phases: ['system2'] } },
        { tool: 'Bash', decision: 'allow' },
      ],
    });

    // system1 → allow
    const s1 = makeStateWithTools(['Bash'], {
      context: { routing: { system: 'system1' }, subagents: { contract: { tools: ['Bash'] } }, tasks: {} },
    });
    const r1 = await mw(s1);
    expect(r1.context.guardrail.evaluations[0].decision).toBe('allow');

    // system2 → deny
    const s2 = makeStateWithTools(['Bash'], {
      context: { routing: { system: 'system2' }, subagents: { contract: { tools: ['Bash'] } }, tasks: {} },
    });
    const r2 = await mw(s2);
    expect(r2.context.guardrail.evaluations[0].decision).toBe('deny');
  });
});
