---
context: fork
user-invocable: false
name: multi-agent-patterns
description: |
  멀티에이전트 실증 패턴 - supervisor/swarm/hierarchical 아키텍처, 토큰 multiplier, 컨텍스트 격리, 합의 메커니즘.
  Auto-activates when: multi-agent system design, agent coordination, context isolation needs.
  Triggers: multi-agent, supervisor, swarm, agent coordination, 멀티에이전트, 에이전트 협업
lang: [en, ko]
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 200
  level2_tokens: 3800
triggers:
  - "multi-agent"
  - "supervisor"
  - "swarm"
  - "orchestrator"
  - "agent coordination"
  - "멀티에이전트"
  - "에이전트 협업"
  - "에이전트 아키텍처"
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "orchestrator"
  - "planner"
tokens: "~4K"
category: "orchestration"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
source_hash: 15f3c060
whenNotToUse: "Do not use multi-agent architecture for tasks that fit within a single agent's context window with no parallelism benefit. A single agent with good tools outperforms a poorly coordinated multi-agent system — only scale out when context isolation or parallel execution provides a measurable benefit."
---

# Multi-Agent Architecture Patterns

## When This Skill Applies
- 단일 에이전트 컨텍스트 한계로 태스크 복잡도 제약
- 태스크가 자연스럽게 병렬 서브태스크로 분해 가능
- 서브태스크마다 다른 도구/시스템 프롬프트 필요
- 다중 도메인 동시 처리 시스템 설계
- 프로덕션 멀티에이전트 시스템 구축

## Core Guidance (Level 1)

### Why Multi-Agent
단일 에이전트는 컨텍스트 윈도우 채움 → lost-in-middle, attention 부족, poisoning으로 성능 저하. 멀티에이전트는 컨텍스트를 분할하여 각 에이전트가 자기 서브태스크에 집중.

### Token Economics

| Architecture | Token Multiplier |
|-------------|-----------------|
| Single agent chat | 1x |
| Single agent + tools | ~4x |
| Multi-agent system | ~15x |

### Three Core Patterns
1. **Supervisor/Orchestrator**: 중앙 에이전트가 위임/종합. 명확한 분해 가능 태스크에 적합.
2. **Peer-to-Peer/Swarm**: 에이전트 간 직접 핸드오프. 유연한 탐색에 적합.
3. **Hierarchical**: 전략/계획/실행 레이어 분리. 대규모 프로젝트에 적합.

### Design Principle
멀티에이전트의 핵심 목적은 **컨텍스트 격리**. 역할 분담이 아니라 각 에이전트가 깨끗한 컨텍스트에서 서브태스크에 집중하도록 하는 것.

## Detailed Guide (Level 2)

### Supervisor Pattern
```
User Query → Supervisor → [Specialist A, B, C] → Aggregation → Final Output
```
**장점**: 워크플로우 통제, human-in-the-loop 용이
**단점**: Supervisor 컨텍스트가 병목, "전화 게임" 문제 (supervisor가 sub-agent 응답을 왜곡 전달)

**Telephone Game 해결**: `forward_message` 도구로 sub-agent 응답을 직접 사용자에게 전달
```python
def forward_message(message: str, to_user: bool = True):
    """Sub-agent 응답을 supervisor 종합 없이 직접 전달"""
    if to_user:
        return {"type": "direct_response", "content": message}
    return {"type": "supervisor_input", "content": message}
```

### Swarm Pattern
에이전트 간 명시적 핸드오프 프로토콜로 제어 이전. 중앙 제어점 없음.
```python
def transfer_to_agent_b():
    return agent_b  # 함수 반환으로 핸드오프

agent_a = Agent(name="Agent A", functions=[transfer_to_agent_b])
```
**장점**: 단일 실패점 없음, breadth-first 탐색에 효과적
**단점**: 에이전트 수 증가 시 coordination 복잡도 증가, 발산 위험

### Context Isolation Mechanisms
- **Full context delegation**: 복잡 태스크 시 전체 컨텍스트 공유 (격리 목적 약화)
- **Instruction passing**: 단순 서브태스크에 지시만 전달 (격리 유지)
- **File system memory**: 공유 상태를 파일시스템으로 중개 (컨텍스트 비대화 방지)

### Consensus & Coordination
- **Weighted voting**: 신뢰도/전문성 기반 가중 투표 (단순 다수결은 환각을 동등 취급)
- **Debate protocol**: 에이전트 간 상호 비판으로 복잡 추론 정확도 향상
- **Trigger-based intervention**: 진행 정체(stall) 또는 동조(sycophancy) 감지 시 개입

### Failure Modes & Mitigations

| Failure | Mitigation |
|---------|-----------|
| Supervisor 병목 | 출력 스키마 제약, 체크포인팅 |
| Coordination 오버헤드 | 명확한 핸드오프 프로토콜, 비동기 패턴 |
| 발산 (Divergence) | 목표 경계 정의, 수렴 체크, TTL 제한 |
| 에러 전파 | 출력 검증, 재시도 + circuit breaker |

## Guidelines
1. 컨텍스트 격리를 멀티에이전트의 핵심 이점으로 설계
2. 조직 메타포가 아닌 coordination 필요에 따라 패턴 선택
3. 명시적 핸드오프 프로토콜 + 상태 전달 구현
4. 가중 투표 또는 토론 프로토콜로 합의
5. Supervisor 병목 모니터링 + 체크포인팅
6. 에이전트 간 출력 전달 전 검증
7. 무한 루프 방지를 위한 TTL 설정

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "one big agent is simpler than a swarm" | one big agent hits a context ceiling; multi-agent horizontally scales past it |
| "supervisor patterns add latency" | supervisors add a routing turn but prevent wrong-agent work that costs entire task cycles |
| "token multiplier kills the economics" | the multiplier is bounded (~3-5x); the quality and parallelism gains exceed that on non-trivial tasks |
| "hierarchical is over-engineered" | hierarchical isolates failure domains — the alternative is one stuck agent blocking the whole system |
| "consensus mechanisms are philosophical overhead" | consensus catches divergent hallucinations before they propagate; it's a cheap sanity check |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "Supervisor pattern gives me control so I should default to it" | Supervisor becomes a bottleneck when it re-processes every sub-agent response; use `forward_message` to pass sub-agent output directly to the user when no synthesis is needed | Choose Supervisor only when synthesis is genuinely required; use Swarm for independent tasks |
| "More agents means more parallelism and therefore faster results" | Token multiplier grows with agent count; beyond 7 agents the coordination overhead dominates; spawning 15 agents to do 15 files produces worse results than 5 agents on 3 files each | Set a hard cap (max 7 concurrent) and batch work instead of spawning one agent per unit |
| "Context isolation is automatic in multi-agent systems" | Context is only isolated if you pass instruction-only messages to sub-agents; if you forward the full conversation history, isolation fails | Pass bounded task descriptions, not conversation threads; use file-system memory for shared state |
| "Hierarchical architecture is over-engineered for this task" | Hierarchical is not about formality — it is about isolating failure domains; a flat swarm where one stuck agent can block the whole system is fragile by design | Use a two-level hierarchy (orchestrator + specialists) whenever tasks span more than two domains |
| "Debate protocol wastes tokens on artificial disagreement" | Debate catches hallucinations that single-agent review misses; the cost is one additional agent turn — bounded and predictable | Apply debate only to high-stakes decisions (architecture choices, security design, critical algorithm selection) |

## Red Flags

- Multi-agent system with no TTL or circuit breaker on agent loops
- Supervisor agent with a context window over 80% full due to aggregating all sub-agent outputs
- Sub-agents receiving full conversation history instead of task-scoped instructions
- Swarm pattern used for tasks with sequential dependencies (use Pipeline instead)
- No aggregation step after parallel agent work — results not deduplicated or cross-referenced
- Agent spawned without an explicit success criterion in the task description
