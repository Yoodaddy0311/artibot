---
context: fork
user-invocable: false
name: ddd-strategic-design
description: |
  DDD 전략적 설계 - 바운디드 컨텍스트, 유비쿼터스 언어, 서브도메인 분류, 팀 소유권 정렬.
  Auto-activates when: domain boundary definition, bounded context design, ubiquitous language creation.
  Triggers: DDD strategic, bounded context, ubiquitous language, subdomain, 바운디드 컨텍스트, DDD 전략
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 150
  level2_tokens: 2500
triggers:
  - "DDD strategic"
  - "bounded context"
  - "ubiquitous language"
  - "subdomain"
  - "바운디드 컨텍스트"
  - "DDD 전략"
  - "도메인 경계"
allowed-tools: [Read, Grep, Glob]
agents:
  - "architect"
  - "planner"
tokens: "~2.5K"
category: "architecture"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
---

# DDD Strategic Design

## When This Skill Applies
- Core/Supporting/Generic 서브도메인 정의
- 모놀리스 또는 서비스 분할 시 도메인 경계 설정
- 팀과 소유권을 바운디드 컨텍스트에 정렬
- 도메인 전문가와 유비쿼터스 언어 구축
- 아키텍처 결정 기록(ADR) 작성

## Do NOT Use When
- 도메인 모델이 안정적이고 경계가 명확한 경우
- 전술적 코드 패턴만 필요한 경우
- 순수 인프라 또는 UI 작업

## Core Guidance (Level 1)

### 서브도메인 분류
- **Core**: 비즈니스 차별화 요소, 직접 구현 필수
- **Supporting**: 핵심은 아니나 비즈니스 운영에 필요, 내부 구현 또는 커스텀 솔루션
- **Generic**: 범용 문제, 기성 솔루션/SaaS 사용 가능

### 바운디드 컨텍스트
동일 용어가 다른 의미를 갖는 경계. 일관성과 소유권을 기준으로 컨텍스트를 분리하고, 각 컨텍스트는 독립적 유비쿼터스 언어를 가진다.

### 필수 산출물
1. 서브도메인 분류표
2. 바운디드 컨텍스트 카탈로그
3. 표준 용어 글로서리 + 금지 용어
4. 경계 결정 근거 (ADR)

## Detailed Guide (Level 2)

### Step 1: 도메인 역량 추출
```
1. 비즈니스 프로세스를 이벤트 단위로 분해
2. 이벤트를 역량(Capability) 그룹으로 클러스터링
3. 각 역량의 비즈니스 가치와 복잡도 평가
4. Core/Supporting/Generic 분류
```

### Step 2: 바운디드 컨텍스트 정의
```
컨텍스트 경계 기준:
- 일관성 범위: 트랜잭션 경계가 같은 개념 묶기
- 팀 소유권: 한 팀이 독립 배포/운영 가능한 단위
- 언어 경계: 동일 용어가 다른 의미를 갖는 지점에서 분리
- 변경 빈도: 함께 변경되는 것을 함께 묶기
```

### Step 3: 컨텍스트 매핑
컨텍스트 간 관계 패턴:
- **Shared Kernel**: 두 컨텍스트가 공유 모델 유지 (강한 결합)
- **Customer-Supplier**: 업스트림이 다운스트림 요구에 맞춰 제공
- **Conformist**: 다운스트림이 업스트림 모델에 순응
- **Anti-Corruption Layer**: 외부 모델을 내부 모델로 변환
- **Open Host Service**: 공개 프로토콜로 서비스 제공
- **Published Language**: 표준화된 교환 포맷 사용

### Step 4: 유비쿼터스 언어 글로서리

| Term | Definition | Context | Anti-terms |
|------|-----------|---------|-----------|
| Order | 고객의 구매 요청 | Commerce | Request, Purchase |
| Shipment | 물리적 배송 단위 | Logistics | Delivery, Package |

**규칙**:
- 동일 컨텍스트 내 동의어 금지
- 코드 변수명, DB 컬럼명, API 필드명에 일관 적용
- 새 팀원 온보딩 시 글로서리 필수 학습

## Limitations
- 실행 가능한 코드를 생성하지 않음
- 이해관계자 입력 없이 비즈니스 진실 추론 불가
- 전술적 설계로 후속 진행 필요

## Guidelines
1. 비즈니스 역량부터 추출, 기술적 관점은 이후
2. 컨텍스트 경계는 팀 소유권과 정렬
3. 유비쿼터스 언어를 코드에 직접 반영
4. 경계 결정을 ADR로 기록
5. 구현 전 전략적 설계를 먼저 완료

## References

See `${CLAUDE_SKILL_DIR}/references/event-sourcing.md` for Event Sourcing, CQRS, Saga, and Snapshot 패턴.
