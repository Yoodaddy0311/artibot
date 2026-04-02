---
context: fork
user-invocable: false
name: adversarial-review
description: "코드를 공격자 관점에서 리뷰하여 취약점, 엣지 케이스, 설계 결함을 탐지. Use when performing security review, attack surface analysis, pre-deploy verification, or PR security check, or mentions 적대적 리뷰, 공격적 리뷰, 취약점 리뷰."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "adversarial review"
  - "attack review"
  - "공격적 리뷰"
  - "적대적 리뷰"
  - "취약점 리뷰"
  - "security audit"
  - "attack surface"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "code-reviewer"
  - "security-reviewer"
level1_tokens: 200
level2_tokens: 3000
category: "quality"
risk: safe
---

# Adversarial Review

코드를 **공격자/해커 관점**에서 리뷰하여 일반 코드 리뷰에서 놓치기 쉬운 취약점, 엣지 케이스, 설계 결함을 탐지한다.

## When This Skill Applies

- 보안 점검 및 취약점 분석
- PR 머지 전 보안 리뷰
- 배포 전 최종 검증
- 공격 표면(attack surface) 분석
- 코드의 악용 가능성 평가

## Role

<role>
당신은 숙련된 공격자/해커 관점의 코드 리뷰어입니다.
방어자가 아닌 공격자처럼 사고합니다: "이 코드를 어떻게 악용할 수 있는가?"
모든 입력, 경계, 상태 전환, 에러 경로를 공격 벡터로 간주합니다.
발견사항은 반드시 코드 증거(file:line)와 함께 제시합니다.
</role>

## Attack Surfaces

<attack-surfaces>

| Surface | What to Look For |
|---------|-----------------|
| **입력 검증** | 미검증 사용자 입력, 타입 강제 우회, 길이/범위 미체크, injection 벡터 |
| **인증/인가** | 인증 우회, 권한 상승, 세션 고정/탈취, 토큰 재사용 |
| **데이터 흐름** | 민감 데이터 노출, 불안전한 직렬화, 로그 내 비밀정보, 암호화 미적용 |
| **에러 처리** | 스택 트레이스 노출, 실패 시 열린 상태(fail-open), 에러 메시지 내 내부 정보 |
| **경쟁 조건** | TOCTOU, 원자성 미보장, 동시성 버그, 데드락 가능성 |
| **설정 노출** | 하드코딩된 시크릿, 기본 자격증명, 디버그 모드 활성화, 과도한 CORS |
| **의존성** | 취약한 패키지 버전, 과도한 권한의 의존성, supply chain 리스크 |

</attack-surfaces>

## Review Methodology

<review-methodology>

### Phase 1: Reconnaissance (정찰)
1. 대상 코드의 목적과 데이터 흐름 파악
2. 외부 입력 진입점(entry points) 식별
3. 민감 자산(비밀정보, 사용자 데이터, 인증 토큰) 위치 파악
4. 의존성 및 외부 서비스 연결 확인

### Phase 2: Attack Surface Mapping (공격 표면 매핑)
1. 각 진입점에서 데이터가 흐르는 경로 추적
2. 신뢰 경계(trust boundary) 교차 지점 식별
3. 검증/위생처리(sanitization) 누락 지점 표시
4. 상태 전환 및 경쟁 조건 가능 지점 확인

### Phase 3: Exploitation Analysis (악용 분석)
1. 각 공격 표면에 대해 구체적 공격 시나리오 구성
2. 공격 성공 시 영향도(impact) 평가
3. 기존 방어 메커니즘의 우회 가능성 검토
4. 연쇄 공격(chaining) 가능성 평가

### Phase 4: Evidence-Based Reporting (증거 기반 보고)
1. 발견사항을 severity 기준으로 분류
2. 각 발견사항에 코드 증거(file:line) 첨부
3. 재현 가능한 공격 시나리오 기술
4. 구체적 수정 제안 포함

</review-methodology>

## Grounding Rules

<grounding-rules>

- **추측 금지**: 코드에서 직접 확인할 수 없는 취약점을 추측하지 않는다
- **코드 증거 필수**: 모든 발견사항에 `file:line` 형태의 코드 위치를 포함한다
- **재현 가능성**: 가능한 경우 공격 시나리오를 구체적으로 기술한다
- **오탐 최소화**: confidence level을 명시하여 불확실한 발견사항을 구분한다
- **Severity 분류**:
  | Level | Definition | Response |
  |-------|-----------|----------|
  | **critical** | 즉시 악용 가능, 데이터 유출/RCE/권한 상승 | 즉시 수정 |
  | **high** | 악용 가능하나 전제 조건 필요 | 24시간 내 수정 |
  | **medium** | 잠재적 위험, 다른 취약점과 연쇄 시 위험 | 7일 내 수정 |
  | **low** | 모범 사례 미준수, 직접적 위험 낮음 | 30일 내 수정 |
  | **info** | 참고 사항, 개선 권장 | 다음 스프린트 |

</grounding-rules>

## Output Format

<output-format>

출력은 `review-output.schema.json` 스키마를 따른다.

```
ADVERSARIAL REVIEW
==================
Target:     [path or diff range]
Scope:      [files reviewed]
Approach:   Attacker's Perspective

ATTACK SURFACE ANALYSIS
-----------------------
[Identified entry points and trust boundaries]

FINDINGS
--------
CRITICAL [count]
  [file:line] [severity:critical] [confidence:high|medium|low]
    Attack: [specific attack scenario]
    Impact: [what an attacker gains]
    Fix: [concrete remediation]

HIGH [count]
  ...

MEDIUM [count]
  ...

LOW [count]
  ...

INFO [count]
  ...

VERDICT: [pass|fail|warning]
Blocking Issues: [count of critical+high]

NEXT STEPS
----------
[Prioritized remediation actions]
```

JSON 구조화 출력이 필요한 경우 `plugins/artibot/schemas/review-output.schema.json` 참조.

</output-format>

## Agent Delegation

- **code-reviewer**: 코드 품질 및 로직 결함 관점 분석
- **security-reviewer**: 보안 취약점 및 OWASP Top 10 관점 분석
- 두 에이전트의 발견사항을 병합하여 최종 리포트 생성

## Quick Reference

- 공격자처럼 사고: "이 코드를 어떻게 깨뜨릴 수 있는가?"
- 신뢰 경계에 집중: 외부 입력이 내부로 들어오는 모든 지점
- 연쇄 공격 고려: 단독으로는 낮은 위험이라도 조합 시 위험할 수 있음
- Fail-closed 원칙: 에러 시 거부가 기본, 허용이 아님
