---
context: fork
user-invocable: false
name: context-degradation
description: |
  LLM 컨텍스트 윈도우 실패 모드 분석 - lost-in-middle, poisoning, distraction, confusion, clash 패턴 진단 및 완화.
  Auto-activates when: long conversation degradation, context-related failures, agent output quality drops.
  Triggers: context degradation, lost in middle, context poisoning, context window, attention, 컨텍스트 열화
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 180
  level2_tokens: 3500
triggers:
  - "context degradation"
  - "lost in middle"
  - "context poisoning"
  - "context distraction"
  - "context window"
  - "attention"
  - "컨텍스트 열화"
  - "컨텍스트 품질"
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "llm-architect"
tokens: "~3.5K"
category: "quality"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
source_hash: 8e3bbe6d
whenNotToUse: "Short, fresh sessions without context loss symptoms; do not apply as a preventive measure when no degradation signal (irrelevant outputs, lost instructions, contradictions) has been observed."
---

# Context Degradation Patterns

## When This Skill Applies
- Agent performance degrades during long conversations
- Debugging incorrect or irrelevant agent outputs
- Designing systems handling large contexts reliably
- Investigating "lost in middle" phenomena
- Analyzing context-related failures in agent behavior

## Core Guidance (Level 1)

### Five Degradation Patterns
1. **Lost-in-Middle**: 컨텍스트 중간부 정보의 attention 감소 (10-40% recall 저하)
2. **Context Poisoning**: 오류/환각이 컨텍스트에 유입되어 피드백 루프로 증폭
3. **Context Distraction**: 무관한 정보가 관련 정보와 attention 경쟁
4. **Context Confusion**: 무관한 컨텍스트가 응답 품질에 영향
5. **Context Clash**: 축적된 정보 간 직접적 충돌

### Four-Bucket Mitigation
- **Write**: 컨텍스트 외부 저장 (scratchpad, file system)
- **Select**: 관련 컨텍스트만 선별 로드 (retrieval, filtering)
- **Compress**: 토큰 축소 + 정보 보존 (summarization, observation masking)
- **Isolate**: sub-agent/세션 분리로 단일 컨텍스트 과부하 방지

## Detailed Guide (Level 2)

### Lost-in-Middle Phenomenon
모델은 U자형 attention 곡선을 보인다. 시작과 끝의 정보는 안정적으로 처리되지만, 중간부 정보는 recall 정확도가 크게 저하된다.

**실무 대응**:
- 핵심 정보를 컨텍스트 시작/끝에 배치
- 긴 문서에 명시적 섹션 헤더와 전환점 사용
- 요약 구조로 주요 정보를 attention 우위 위치에 표면화

### Context Poisoning
환각/오류가 컨텍스트에 진입하면 후속 결정이 오염된 내용을 참조하여 강화한다.

**침투 경로**: 도구 출력 오류, 검색 문서 부정확, 모델 생성 요약의 환각

**탐지 증상**: 이전 성공 태스크의 품질 저하, 도구 오사용, 교정 후에도 지속되는 환각

**복구**: 오염 시점 이전으로 컨텍스트 절단, 검증된 정보만 보존하여 재시작

### Context Distraction & Confusion
모델은 컨텍스트 내 모든 정보에 attend해야 하므로 무관한 정보도 관련 정보와 경쟁한다. 단일 무관 문서도 성능을 크게 저하시킨다.

**완화**: 컨텍스트 진입 전 관련성 필터링, 네임스페이싱으로 구조적 분리, 도구 호출로 대체 가능한 정보는 컨텍스트에서 제외

### Context Clash
다수 정확한 정보가 서로 모순될 때 발생. 다중 소스 검색, 버전 충돌, 관점 충돌이 원인.

**해결**: 명시적 충돌 마킹, 우선순위 규칙 수립, 버전 필터링으로 구버전 제외

### Degradation Thresholds (참고)

| Model | 열화 시작 | 심각한 열화 |
|-------|----------|------------|
| Claude Opus 4.5 | ~100K tokens | ~180K tokens |
| Claude Sonnet 4.5 | ~80K tokens | ~150K tokens |
| GPT-5.2 | ~64K tokens | ~200K tokens |

### Architectural Patterns
- **Just-in-time context loading**: 필요 시점에만 정보 검색
- **Observation masking**: 장황한 도구 출력을 간결한 참조로 대체
- **Sub-agent isolation**: 태스크별 컨텍스트 격리
- **Compaction triggers**: 열화 임계점 도달 전 요약 실행

## Guidelines
1. 컨텍스트 길이와 성능 상관관계 모니터링
2. 핵심 정보는 시작/끝에 배치
3. 열화 심각화 전 compaction 트리거 구현
4. 검색 문서는 컨텍스트 추가 전 정확성 검증
5. 태스크 세그먼테이션으로 컨텍스트 혼동 방지
6. 점진적 열화(graceful degradation) 설계

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "long context means Claude remembers everything" | lost-in-middle is real and measurable — middle positions have 30-40% worse recall than start/end |
| "more context is always better" | distraction and confusion scale super-linearly; at some point added context reduces answer quality |
| "poisoning is rare" | one bad example in 50 can flip the model's pattern; tool failure traces and wrong hypotheses poison faster than you think |
| "I'll detect degradation from the output" | degraded outputs look fluent — the tell is inconsistency with earlier turns, which you've already lost context of |
| "clash resolves itself" | contradictory facts in context cause the model to pick one non-deterministically; resolve clashes explicitly or expect random answers |
