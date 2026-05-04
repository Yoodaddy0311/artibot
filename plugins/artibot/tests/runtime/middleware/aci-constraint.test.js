import { afterEach, describe, expect, it } from 'vitest';
import {
  _buildConstraintInfo,
  _resolveConstraints,
  createAciConstraintMiddleware,
  ROLE_CONSTRAINTS,
} from '../../../lib/runtime/middleware/aci-constraint.js';
import { reset as resetEventBus, getLastEvent } from '../../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
  return {
    userPrompt: 'test prompt',
    context: {
      routing: { system: 'system1', score: 0.3 },
      ...overrides.context,
    },
    messageParts: [],
    agent: overrides.agent || undefined,
    ...overrides,
  };
}

afterEach(() => {
  resetEventBus();
});

// ---------------------------------------------------------------------------
// Unit: ROLE_CONSTRAINTS
// ---------------------------------------------------------------------------

describe('aci-constraint/ROLE_CONSTRAINTS', () => {
  it('핵심 역할이 모두 정의됨', () => {
    const expected = [
      'tdd-guide', 'security-reviewer', 'code-reviewer', 'spec-reviewer',
      'quality-reviewer', 'doc-updater', 'data-analyst', 'planner', 'architect',
    ];
    for (const role of expected) {
      expect(ROLE_CONSTRAINTS).toHaveProperty(role);
    }
  });

  it('읽기 전용 역할은 readOnly=true', () => {
    const readOnlyRoles = ['security-reviewer', 'code-reviewer', 'spec-reviewer', 'quality-reviewer'];
    for (const role of readOnlyRoles) {
      expect(ROLE_CONSTRAINTS[role].readOnly).toBe(true);
    }
  });

  it('tdd-guide는 bashPattern을 가짐', () => {
    expect(ROLE_CONSTRAINTS['tdd-guide'].bashPattern).toBeInstanceOf(RegExp);
  });

  it('모든 역할의 tools는 배열', () => {
    for (const [, constraint] of Object.entries(ROLE_CONSTRAINTS)) {
      expect(Array.isArray(constraint.tools)).toBe(true);
      expect(constraint.tools.length).toBeGreaterThan(0);
    }
  });

  it('ROLE_CONSTRAINTS는 frozen 객체', () => {
    expect(Object.isFrozen(ROLE_CONSTRAINTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveConstraints
// ---------------------------------------------------------------------------

describe('aci-constraint/_resolveConstraints', () => {
  it('알려진 역할의 제약을 반환', () => {
    const result = _resolveConstraints('security-reviewer');
    expect(result).toEqual(ROLE_CONSTRAINTS['security-reviewer']);
  });

  it('미정의 역할은 null 반환', () => {
    expect(_resolveConstraints('unknown-role')).toBeNull();
  });

  it('override가 기본 제약보다 우선', () => {
    const override = { 'security-reviewer': { tools: ['Read'], readOnly: true } };
    const result = _resolveConstraints('security-reviewer', override);
    expect(result.tools).toEqual(['Read']);
  });

  it('override에 없는 역할은 기본 제약 사용', () => {
    const override = { 'custom-role': { tools: ['Bash'] } };
    const result = _resolveConstraints('security-reviewer', override);
    expect(result).toEqual(ROLE_CONSTRAINTS['security-reviewer']);
  });
});

// ---------------------------------------------------------------------------
// Unit: buildConstraintInfo
// ---------------------------------------------------------------------------

describe('aci-constraint/_buildConstraintInfo', () => {
  it('제약이 있으면 applied=true', () => {
    const info = _buildConstraintInfo('code-reviewer', ROLE_CONSTRAINTS['code-reviewer']);
    expect(info.applied).toBe(true);
    expect(info.role).toBe('code-reviewer');
    expect(info.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(info.readOnly).toBe(true);
  });

  it('제약이 null이면 applied=false', () => {
    const info = _buildConstraintInfo('unknown', null);
    expect(info.applied).toBe(false);
    expect(info.role).toBe('unknown');
    expect(info.reason).toContain('no constraints');
  });

  it('bashPattern이 있으면 hasBashPattern=true', () => {
    const info = _buildConstraintInfo('tdd-guide', ROLE_CONSTRAINTS['tdd-guide']);
    expect(info.hasBashPattern).toBe(true);
  });

  it('readOnly가 없으면 false', () => {
    const info = _buildConstraintInfo('doc-updater', ROLE_CONSTRAINTS['doc-updater']);
    expect(info.readOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: createAciConstraintMiddleware
// ---------------------------------------------------------------------------

describe('aci-constraint/middleware', () => {
  it('enabled=false일 때 제약 미적용', async () => {
    const mw = createAciConstraintMiddleware({ enabled: false });
    const state = makeState();
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(false);
    expect(state.context.aciConstraints.reason).toContain('disabled');
  });

  it('agent.type으로 역할 감지', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'code-reviewer' } });
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(true);
    expect(state.context.aciConstraints.role).toBe('code-reviewer');
    expect(state.context.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('context.agent.type에서도 역할 감지', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ context: { agent: { type: 'planner' } } });
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(true);
    expect(state.context.aciConstraints.role).toBe('planner');
  });

  it('subagents.contract.agentType에서도 역할 감지', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({
      context: { subagents: { contract: { agentType: 'architect' } } },
    });
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(true);
    expect(state.context.aciConstraints.role).toBe('architect');
  });

  it('역할이 없으면 skip', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState();
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(false);
    expect(state.messageParts).toContain('aci=skip');
  });

  it('미정의 역할은 default (제약 없음)', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'frontend-developer' } });
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(false);
    expect(state.messageParts).toContain('aci=default');
  });

  it('readOnly 역할은 context.readOnly=true 설정', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'security-reviewer' } });
    await mw(state);
    expect(state.context.readOnly).toBe(true);
  });

  it('bashPattern이 있으면 context.bashPattern 설정', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'tdd-guide' } });
    await mw(state);
    expect(state.context.bashPattern).toBeInstanceOf(RegExp);
  });

  it('messageParts에 aci 요약 추가', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'doc-updater' } });
    await mw(state);
    expect(state.messageParts[0]).toMatch(/^aci=doc-updater:\d+tools$/);
  });

  it('event-bus에 feature:aci-applied 이벤트 발행', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'architect' } });
    await mw(state);
    const event = getLastEvent('feature:aci-applied');
    expect(event).toBeDefined();
    expect(event.role).toBe('architect');
    expect(event.constraints.applied).toBe(true);
  });

  it('roleOverrides로 커스텀 제약 적용', async () => {
    const mw = createAciConstraintMiddleware({
      roleOverrides: {
        'custom-agent': { tools: ['Read', 'Bash'], readOnly: false },
      },
    });
    const state = makeState({ agent: { type: 'custom-agent' } });
    await mw(state);
    expect(state.context.aciConstraints.applied).toBe(true);
    expect(state.context.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('next 콜백이 있으면 호출', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'planner' } });
    let nextCalled = false;
    await mw(state, (s) => { nextCalled = true; return s; });
    expect(nextCalled).toBe(true);
  });

  it('next 콜백이 없어도 정상 작동', async () => {
    const mw = createAciConstraintMiddleware();
    const state = makeState({ agent: { type: 'planner' } });
    const result = await mw(state);
    expect(result).toBe(state);
  });

  it('각 역할별 도구 수가 올바름', async () => {
    const mw = createAciConstraintMiddleware();

    for (const [role, constraint] of Object.entries(ROLE_CONSTRAINTS)) {
      const state = makeState({ agent: { type: role } });
      await mw(state);
      expect(state.context.allowedTools).toEqual([...constraint.tools]);
      resetEventBus();
    }
  });
});
