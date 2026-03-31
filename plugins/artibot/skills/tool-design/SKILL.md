---
context: fork
user-invocable: false
name: tool-design
description: |
  에이전트 도구 설계 아키텍처 패턴 - 통합 vs 분리 트레이드오프, description engineering, architectural reduction.
  Auto-activates when: creating agent tools, debugging tool failures, optimizing tool sets.
  Triggers: tool design, tool API, MCP tool, agent tool, 도구 설계
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 180
  level2_tokens: 3500
triggers:
  - "tool design"
  - "tool API"
  - "MCP tool"
  - "agent tool"
  - "도구 설계"
  - "도구 최적화"
  - "tool consolidation"
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "architect"
  - "mcp-developer"
tokens: "~3.5K"
category: "architecture"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
---

# Tool Design for Agents

## When This Skill Applies
- Creating new tools for agent systems
- Debugging tool-related failures or misuse
- Optimizing existing tool sets for better agent performance
- Designing tool APIs or MCP servers
- Evaluating tool conventions across a codebase

## Core Guidance (Level 1)

### Consolidation Principle
인간 엔지니어가 어떤 도구를 써야 할지 확답 못하면, 에이전트도 마찬가지다. 유사 기능 도구는 하나의 포괄적 도구로 통합하라.

### Tool Description = Prompt Engineering
도구 설명은 에이전트의 행동을 형성하는 프롬프트다. 4가지 질문에 답해야 한다:
1. **What**: 무엇을 하는가 (명확하고 구체적으로)
2. **When**: 언제 사용하는가 (트리거와 컨텍스트)
3. **Input**: 어떤 입력을 받는가 (타입, 제약, 기본값)
4. **Output**: 무엇을 반환하는가 (포맷, 예시)

### Key Rules
- 10-20개 도구가 대부분 애플리케이션에 적합
- 네임스페이싱으로 논리적 그룹화
- 에러 메시지는 복구 가능하게 설계
- Response format 옵션 (concise/detailed)으로 토큰 효율성 확보

## Detailed Guide (Level 2)

### Architectural Reduction
통합 원칙의 극단적 적용: 대부분의 특수 도구를 제거하고 범용 primitive 도구만 제공.

**File System Agent Pattern**: 커스텀 도구 대신 파일시스템 직접 접근 (grep, cat, find, ls)으로 탐색. 모델이 primitive를 유연하게 체이닝.

**Reduction이 효과적인 경우**:
- 데이터 레이어가 잘 문서화되고 일관적
- 모델의 추론 능력이 복잡성 탐색에 충분
- 특수 도구가 모델을 제약하는 상황

**Reduction이 실패하는 경우**:
- 데이터가 지저분하고 비일관적
- 안전 제약이 에이전트 행동 제한 필요
- 진정으로 복잡한 워크플로우

### Description Engineering

**잘못된 설계**:
```python
def search(query):
    """Search the database."""  # 모호, 파라미터 부족, 반환값 없음
```

**올바른 설계**:
```python
def get_customer(customer_id: str, format: str = "concise"):
    """
    Retrieve customer information by ID.
    Use when: User asks about customer details, need customer context.
    Args:
        customer_id: Format "CUST-######" (e.g., "CUST-000001")
        format: "concise" for key fields, "detailed" for complete record
    Returns: Customer object with requested fields
    Errors:
        NOT_FOUND: Customer ID not found
        INVALID_FORMAT: ID must match CUST-###### pattern
    """
```

### MCP Tool Naming
MCP 도구는 항상 정규화된 이름 사용: `ServerName:tool_name`
```python
# Correct
"Use the GitHub:create_issue tool"
# Incorrect - 다중 서버 환경에서 실패 가능
"Use the create_issue tool"
```

### Anti-Patterns
- 모호한 설명 ("Search the database")
- 난해한 파라미터명 (x, val, param1)
- 에러 핸들링 없음 (generic error만 반환)
- 비일관적 네이밍 (id vs identifier vs customer_id)

### Tool Optimization Loop
1. 에이전트가 도구 사용 시 실패 모드 수집
2. 실패 분석으로 description 개선안 도출
3. 개선된 description으로 동일 태스크 재테스트
4. 40% task completion time 단축 달성 가능

## Guidelines
1. Description은 what, when, returns를 명확히
2. 통합으로 모호성 제거
3. Response format 옵션으로 토큰 효율성 확보
4. 에러 메시지를 에이전트 복구용으로 설계
5. 일관된 네이밍 컨벤션 유지
6. 실제 에이전트 상호작용으로 도구 테스트
7. 모델 개선 시 함께 진화하는 최소 아키텍처 지향
