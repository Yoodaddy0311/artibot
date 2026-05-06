---
context: fork
user-invocable: false
name: principles
description: |
  Core principles enforcing quality-first design, DEV protocol, Auto Mode safety, and Zero-Skip policy.
  Auto-activates when: making decisions, reviewing work, designing workflows, using Auto Mode.
  Triggers: design, principle, auto mode, autonomous, 자동, 원칙, quality, DEV protocol
platforms: [claude-cowork, claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "design"
  - "principle"
  - "auto mode"
  - "autonomous"
  - "quality"
  - "DEV protocol"
  - "자동"
  - "원칙"
agents:
  - "orchestrator"
  - "planner"
tokens: "~4K"
category: "quality"
---

# Development Principles

## When This Skill Applies
- 마케팅/콘텐츠 결정을 내리거나 전략을 검토할 때
- Auto Mode 사용 전 안전 체크리스트 확인
- 에이전트 팀 조율 시 품질 게이트 설정
- DEV Protocol 준수 여부 검증
- 워크플로우 설계 및 루틴 정의

## Core Guidance

### 마케팅 워크 원칙

- **Evidence > Assumptions**: 데이터와 리서치로 검증, 직관에만 의존 금지
- **KISS**: 가장 단순한 전략이 최선. 복잡성은 실행 리스크
- **YAGNI**: 지금 필요한 것만. 미래의 가상 캠페인을 위해 설계하지 않기
- **DRY**: 반복 작업은 루틴으로 자동화. 같은 브리프를 두 번 쓰지 않기
- **Measure First**: 최적화 전에 베이스라인 측정

### 의사결정 프레임워크

1. **Evidence > Assumptions**: 주장마다 데이터 소스 또는 리서치 근거 첨부
2. **Reversibility**: 불확실할 때는 되돌릴 수 있는 결정 우선 (소규모 테스트 → 확대)
3. **Trade-off 분석**: 단기 전환율 vs. 장기 브랜드 가치, 비용 vs. 품질
4. **User > Platform**: 플랫폼 알고리즘이 아니라 실제 사용자를 위해 설계

### Auto Mode 안전 가이드

Auto Mode는 Claude가 중간 확인 없이 여러 작업을 자율 실행하는 모드입니다.

#### 허용: Auto Mode에서 자율 실행 가능한 작업

| 작업 유형 | 예시 | 이유 |
|----------|------|------|
| 리서치 & 분석 | 경쟁사 분석, 시장 조사 | 외부 데이터 읽기 전용 |
| 초안 생성 | 콘텐츠 초안, 이메일 초안 | 검토 전 발행 없음 |
| 데이터 집계 | 지표 수집, 리포트 생성 | 계산/요약만 수행 |
| 스킬 체인 | 순차 스킬 실행 | 가이드/참조 호출만 |
| 문서 업데이트 초안 | 변경 사항 반영 초안 | 사용자 검토 후 적용 |

#### 차단: Auto Mode에서 사람 확인 필요한 작업

| 작업 유형 | 예시 | 이유 |
|----------|------|------|
| **외부 발행** | SNS 포스팅, 이메일 발송 | 되돌릴 수 없음, 브랜드 노출 |
| **예산 집행** | 광고 입찰 변경, 예산 조정 | 금전적 영향 |
| **계정 설정 변경** | 광고 계정, CRM 설정 | 범위가 큰 영향 |
| **법적 문서** | 계약서, 개인정보 관련 | 법적 책임 |
| **브랜드 변경** | 로고, 슬로건 확정 | 되돌리기 어려움 |
| **외부 API 쓰기** | 데이터베이스 수정, 파일 삭제 | 데이터 손실 위험 |

#### Auto Mode 안전 체크리스트

사용 전:
```
- [ ] 이 작업이 "차단" 목록에 해당하지 않는가?
- [ ] 실수 시 되돌릴 수 있는가?
- [ ] 외부에 발행/전송되는 내용이 없는가?
- [ ] 금전적 영향이 없는가?
```

사용 중:
```
- [ ] 중간 결과물을 사용자가 볼 수 있는가?
- [ ] 예상치 못한 방향으로 가면 즉시 중단할 수 있는가?
```

완료 후:
```
- [ ] 실제 실행된 작업 목록 검토
- [ ] 외부 시스템에 변경 사항이 없음 확인
- [ ] 생성된 콘텐츠 인간 검토 완료
```

#### xhigh Effort — 마케팅 맥락

다음 작업은 **xhigh effort** (가장 높은 집중도와 리소스)로 실행합니다:

| 작업 | Effort | 이유 |
|------|--------|------|
| `/ultraplan deep` | xhigh | WebSearch + 다중 스킬 체인 + 팀 오케스트레이션 |
| `/team campaign` | xhigh | 전체 에이전트 팀 병렬 실행 |
| 분기 마케팅 전략 | xhigh | 시장 분석 + 전략 + 실행 계획 전체 |
| 경쟁사 전체 감사 | xhigh | 멀티 소스 리서치 + 종합 분석 |
| `/ultraplan visual` | high | 시각화 포함, 다중 스킬 |
| `/monitor` 설정 | high | 패턴 정의 + 대시보드 명세 |
| 개별 콘텐츠 생성 | medium | 단일 스킬, 단일 에이전트 |
| 루틴 상태 확인 | low | 정보 조회만 |

### Quality Gate Integration

모든 마케팅 산출물은 3단계 검증을 거칩니다:

1. **전략 정렬**: 비즈니스 목표 및 브랜드 가이드라인과 일치하는가?
2. **증거 기반**: 모든 주장에 데이터/리서치 근거가 있는가?
3. **실행 가능성**: 예산, 인력, 일정 내에서 실현 가능한가?

### Execution Discipline (MANDATORY for ALL agents)

**Decompose-Execute-Verify (DEV) Protocol**:
1. **Decompose**: Break every request into numbered atomic items BEFORE starting
2. **Execute**: Read target files FIRST, make changes, re-read to confirm
3. **Verify**: Report completion with evidence (file:line) for each item

**Zero-Skip Policy**:
- NEVER silently skip or defer any part of a request
- NEVER claim "done" without re-reading modified files
- NEVER modify a file without reading it first
- If blocked, explain WHY with specific error/reason

**Evidence-Based Completion**:
- ✅ requires: file path + line number + what changed
- "Updated the file" = NOT acceptable evidence
- "Updated src/auth.ts:45-52, added validateToken() null check" = acceptable

## Quick Reference

| Principle | Check | Violation Signal |
|-----------|-------|------------------|
| Evidence | 주장마다 근거가 있는가? | 출처 없는 통계, 가정에 기반한 전략 |
| KISS | 더 단순한 방법이 있는가? | 불필요한 채널/단계 추가 |
| YAGNI | 지금 필요한가? | 가상 미래 캠페인 설계 |
| DRY | 반복되는 작업인가? | 동일 브리프 반복, 루틴화 미처리 |
| DEV | 분해-실행-검증이 완료되었는가? | 무언의 스킵, 증거 없는 완료 주장 |
| Auto Mode | "차단" 목록에 해당하지 않는가? | 외부 발행, 예산 집행, 계정 변경 |
| Zero-Skip | 요청의 모든 항목이 처리되었는가? | 누락 항목, 불완전한 완료 |

## Workflow Checklist

```
Progress:
- [ ] Step 1: DECOMPOSE — 요청을 번호 매긴 원자적 항목으로 분해
- [ ] Step 2: 관련 스킬/데이터 소스 확인
- [ ] Step 3: EXECUTE — Evidence 기반으로 실행
- [ ] Step 4: Auto Mode 사용 시 안전 체크리스트 통과 확인
- [ ] Step 5: VERIFY — 각 항목별 완료 증거 제출
- [ ] Step 6: Zero-Skip 확인 — 누락 항목 없음
```

## Human Checkpoints

### Checkpoint 1: 분해 결과 승인 (After Step 1)
**Context**: 요청이 번호가 매겨진 원자적 항목들로 분해된 시점. 분해가 완전하지 않으면 이후 단계에서 누락 항목이 생기고 Zero-Skip Policy 위반으로 이어진다.
**Ask**: "요청이 다음과 같이 분해되었습니다. **모든 항목이 포함되어 있고 분해 단위가 적절한가요?**"
**Options**:
1. Approve items — 분해 확인, Step 2 파일 읽기로 진행
2. Add missing items — 누락된 항목 추가 후 재확인
**Default**: 1 (명확한 요청에서 생성된 분해는 대부분 완전)
**Skippable**: No — 불완전한 분해는 Zero-Skip Policy 위반의 직접적 원인
**Freedom**: MEDIUM

### Checkpoint 2: 설계 트레이드오프 선택 (After Step 3)
**Context**: SOLID/DRY/KISS/YAGNI 원칙을 적용하며 구현 방식이 결정된 시점. 동일한 원칙을 다른 방향으로 해석할 수 있어 사용자의 선호와 맥락이 중요하다.
**Ask**: "구현 방식이 결정되었습니다. **제안된 설계 접근법이 현재 프로젝트 맥락에 맞나요?**"
**Options**:
1. KISS approach — 가장 단순한 구현 유지
2. More abstraction — 재사용성을 위해 추상화 레이어 추가
3. Different pattern — 다른 설계 패턴 제안 (구체적으로 명시)
**Default**: 1 (KISS 원칙 — 복잡성은 비용)
**Skippable**: Yes (기본값 사용) — KISS 접근법으로 진행
**Freedom**: HIGH

### Checkpoint 3: 완료 증거 검증 (After Step 5)
**Context**: 각 분해 항목에 대한 완료 증거(파일:라인)가 제출된 시점. "완료했다"는 주장이 아닌 실제 증거로 검증해야 Zero-Skip Policy가 보장된다.
**Ask**: "각 항목의 완료 증거가 제출되었습니다. **모든 항목에 대해 충분한 증거(파일:라인)가 있나요?**"
**Options**:
1. Accept — 증거 충분, 작업 완료
2. Request more evidence — 특정 항목에 대해 더 구체적인 증거 요청
**Default**: 1 (file:line 형식의 증거가 있으면 수락)
**Skippable**: No — 증거 없는 완료 주장은 허용되지 않음
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Decompose request | MEDIUM | Must capture all items, granularity is judgment call |
| Read target files | LOW | Mandatory before any modification |
| Apply principles | HIGH | SOLID/DRY/KISS/YAGNI provide direction, specific implementation varies |
| Re-read files | LOW | Mandatory after every modification |
| Report evidence | LOW | file:line format required, no vague claims |
| Zero-skip check | LOW | Every item must be addressed or explicitly blocked |
