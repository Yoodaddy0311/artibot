---
context: fork
user-invocable: false
name: zero-downtime-migration
description: "Production 무중단 마이그레이션 6섹션 체크리스트 (Pre-migration / Rollout / Validation / Rollback / Communication / Worst-Case) — production 매출·고객 데이터가 걸린 작업. 자연어 트리거: 마이그레이션, 이전, 교체, 롤아웃, 무중단 배포, 점진 전환, DB 이전, 결제 시스템 교체, Postgres→Mongo, MySQL→PostgreSQL, Auth0→Cognito, Node 16→20, Python 2→3, Stripe→Toss, migrate from X to Y, switch from X to Y, replace X with Y, cutover, dual write, canary rollout, feature flag rollout, rolling deployment, blue-green deployment."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "마이그레이션"
  - "이전"
  - "교체"
  - "롤아웃"
  - "롤백"
  - "무중단 배포"
  - "무중단 전환"
  - "점진 전환"
  - "점진적 전환"
  - "DB 이전"
  - "DB 교체"
  - "스키마 변경"
  - "결제 시스템 교체"
  - "인증 시스템 교체"
  - "버전 업그레이드"
  - "Node 16→20"
  - "Node 18→22"
  - "Python 2→3"
  - "Postgres→Mongo"
  - "MySQL→PostgreSQL"
  - "MongoDB→Postgres"
  - "Auth0→Cognito"
  - "Stripe→Toss"
  - "migrate from"
  - "migrate to"
  - "switch from"
  - "replace X with Y"
  - "cutover"
  - "dual write"
  - "canary"
  - "blue-green"
  - "feature flag rollout"
  - "phased rollout"
  - "rolling deployment"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash, Write]
agents:
  - "devops-engineer"
  - "architect"
tokens: 3800
level1_tokens: 250
level2_tokens: 3800
category: "infrastructure"
risk: high
version: "1.0.0"
lastVerified: "2026-05-16"
whenNotToUse: "단순 코드 리팩토링, 빌드 도구 교체 (Webpack→Vite처럼 사용자 데이터 무관), 로컬 dev 환경 변경 — production 트래픽과 사용자 데이터가 걸리지 않은 작업에는 과한 절차."
---

# Zero-Downtime Migration

> ⚠️ **이 skill이 필요한 작업은 production 매출/고객 데이터가 걸린 작업입니다.** 한 줄 실수가 결제 중단, 데이터 손실, 고객 이탈로 직결됩니다. 절차를 생략하고 싶다는 유혹이 들면, "이 작업이 실패하면 누구한테 사과 전화를 해야 하는가"를 떠올리세요.

## When This Skill Applies

- DB 엔진 교체 (MySQL→PostgreSQL, Postgres→Mongo 등)
- 스키마 변경 (컬럼 타입 변경, 테이블 분할, NF 정규화 변경)
- 외부 서비스 교체 (Stripe→Toss, Auth0→Cognito, Twilio→Vonage)
- 런타임 / 언어 버전 업그레이드 (Node 16→20, Python 2→3, Java 8→17)
- 인프라 이전 (AWS→GCP, on-prem→cloud, k8s 버전 업)
- 인증/세션/결제처럼 사용자 흐름 한가운데를 끊을 수 없는 시스템 전환

## Do NOT Use When

- 사용자 데이터 무관한 빌드 도구 교체 (Webpack→Vite)
- 로컬 개발 환경 변경
- 사내 도구만 영향받는 작업 (외부 사용자 트래픽 0)
- 단순 라이브러리 minor 업데이트 (no breaking change)

## Core Principle (Level 1)

**모든 무중단 마이그레이션은 6섹션을 거친다. 한 섹션도 건너뛸 수 없다.**

| # | 섹션 | 한 줄 요약 |
|---|---|---|
| 1 | **Pre-migration** | 백업 + 정합성 + dry-run |
| 2 | **Rollout Strategy** | feature flag + canary + dual write/read + 점진 전환 |
| 3 | **Validation** | 메트릭 / 로그 / 알람 |
| 4 | **Rollback Plan** | ABORT 조건 + Phase별 롤백 + RPO/RTO |
| 5 | **Communication** | 사전 공지 + war-room + escalation chain |
| 6 | **Worst-Case** | 데이터 손실 / 정합성 / 전파 / 롤백 실패 |

**필수 산출물**: 운영팀이 그대로 실행할 수 있는 체크리스트 (각 항목이 측정 가능하고 검증 가능해야 함)

## Detailed Guide (Level 2)

### Section 1 — Pre-migration (사전 준비)

#### 1.1 백업
- Full backup 완료 + 무결성 해시 기록
- Staging에 백업 복원 리허설 1회 이상
- 백업 2곳 이상 (기본 + cold storage)
- 보존 정책: 마이그레이션 종료 후 **최소 30일**

#### 1.2 데이터 정합성 검증
- Source 스키마 / row count 스냅샷
- Staging seed 후 row count 일치
- 샘플 100건 randomized diff
- DBMS 교체 시 인코딩 / 타임존 / NULL / collation 차이 점검

#### 1.3 사전 점검
- Staging dry-run 1회 완료
- 모니터링 대시보드 준비 (에러율 / 지연 / 처리량)
- 알람 임계값 설정 (5분 내 평소 +20% 에러 → PagerDuty)
- 의존 팀 owner T-72h 사전 공지

### Section 2 — Rollout Strategy (점진적 전환)

#### 2.1 Feature Flag
- `migration.<name>.enabled` 기본 false
- 토글 즉시 반영 (재배포 불필요)
- 사용자 ID / 트래픽 비율 기반 분기

#### 2.2 Canary 단계
```
0% → 1% (30분) → 10% (1시간) → 50% (6시간) → 100%
```
각 단계 ABORT 조건 명시 (§4 참조)

#### 2.3 Dual Write / Dual Read
| Phase | 쓰기 | 읽기 | 사용자 응답 | 되돌리기 |
|---|---|---|---|---|
| A | source + target | source | source | 쉬움 (flag off) |
| B | source + target | source + target compare | source | 쉬움 |
| C | source + target | target | **target** | **어려워짐 (PoNR 직전)** |
| D | target only | target | target | 거의 불가 (source 폐기 X) |

#### 2.4 점진적 전환 원칙
- **Backward-compatible 우선** — 새 컬럼/필드 nullable, 기존 코드 영향 0
- **Expand → Migrate → Contract** — 새 구조 추가 → 데이터 이동 → 옛 구조 제거 (각각 별도 배포)
- **세션 무중단** — 활성 세션 drain timeout, in-flight transaction 처리 방식 명시

### Section 3 — Validation (검증)

#### 3.1 메트릭 임계
| 지표 | 임계 |
|---|---|
| 에러율 (4xx/5xx) | 기존 +0.5%p 이내 |
| p95 지연 | 기존 +20% 이내 |
| p99 지연 | 기존 +50% 이내 |
| TPS | 평소 -10% 이내 |
| 정합성 checksum | hourly, 불일치 즉시 알람 |

#### 3.2 로그
- `migration_id=<id>` 태그
- dual-read 불일치 별도 채널 (sampling 1% 권장)
- 사용자 영향 이벤트 추적 (로그인/결제 실패 등)

#### 3.3 알람
- 에러율 임계 초과 → on-call PagerDuty + Slack `#war-room-migration`
- 정합성 실패 → 즉시 ABORT 자동 트리거
- `/health/migration` endpoint에 현재 phase 노출

### Section 4 — Rollback Plan (롤백 계획)

#### 4.1 ABORT 조건
- 에러율 +1%p 5분 지속 → **자동 ABORT**
- p95 지연 +50% 10분 지속 → **자동 ABORT**
- dual-write 불일치율 0.1% 초과 → 수동 판단 + ABORT 후보
- 결제 / 인증 등 critical path 장애 → **즉시 ABORT**

#### 4.2 Phase별 롤백 매트릭스
| Phase | 방법 | 소요 | 데이터 손실 |
|---|---|---|---|
| A | flag off | <1분 | 없음 |
| B | flag off | <1분 | 없음 |
| C | flag off + target→source delta replay | 5~30분 | **있음 (delta 실패 시)** |
| D | source 복원 + target 백포팅 | 30분~수시간 | **있음 (시간차)** |

각 Phase별 롤백 dry-run 1회 이상. Phase C 진입 전 **Point-of-No-Return 회의** 책임자 승인 필수.

#### 4.3 RPO / RTO
- **RPO** (얼마나 이전 시점까지 복구 가능): 1.1 백업 시점 기준 명시
- **RTO** (복구에 걸리는 시간): 측정값 명시 (추정 금지)
- 부분 복구 (특정 테이블만) 가능 여부 확인

### Section 5 — Communication Plan

#### 5.1 사전 공지 타임라인
| 시점 | 대상 | 채널 |
|---|---|---|
| T-7d | 전사 | 이메일 + Slack 공지 채널 |
| T-72h | 의존 팀 owner | 개별 컨택 + 회신 확인 |
| T-24h | 고객 (영향 시) | 점검 윈도우 + 대체 채널 + 보상안 |
| T-1h | 운영/on-call | 최종 점검 회의 |

#### 5.2 실시간
- War-room 채널 `#war-room-migration-YYYYMMDD`
- Status page Phase 전환 시점마다 업데이트
- 30분 단위 정기 상태 공유

#### 5.3 Escalation Chain
| 단계 | 트리거 | 대상 | 응답 시한 |
|---|---|---|---|
| L1 | 메트릭 경고 | on-call 엔지니어 | 5분 |
| L2 | ABORT 후보 | 책임자 | 10분 |
| L3 | 데이터 손실 의심 | CTO + 데이터팀장 | 즉시 |
| L4 | 외부 고객 영향 | CEO + PR + 법무 | 즉시 |

#### 5.4 사후 보고
- 완료 직후 1줄 요약 + 메트릭 스냅샷 Slack
- T+24h: RCA 템플릿 회고 문서
- T+7d: postmortem 회의 (성공/실패 무관)

### Section 6 — Worst-Case Scenarios

#### 6.1 데이터 손실
- **사전 대비**: source는 cutover 후 최소 30일 read-only 보관, 시간 단위 PITR, 백업 2곳
- **발생 시**: L3 escalation → 영향 범위 산정 → 백업 부분 복구 + diff merge

#### 6.2 Silent Corruption (정합성 깨짐)
- **사전 대비**: dual-write 트랜잭션화 (불가 시 outbox), hourly checksum, reconciliation job
- **발생 시**: 신규 dual-write 중단 (read는 source 고정) → 불일치 데이터 전수 조사 → 우선순위 머지

#### 6.3 Cascading Failure (장애 전파)
- **사전 대비**: circuit breaker (실패율 임계 시 source fallback), target rate limiting, connection pool 격리
- **발생 시**: 즉시 ABORT + flag off → 의존 서비스 health 전수 점검 → war-room 5분 단위 상태 공유

#### 6.4 롤백 실패
- **사전 대비**: 백업 복원 리허설 (1.1), 2-fault tolerance (백업+cold storage 동시 손상까지 대비), vendor support 핫라인 사전 확보
- **발생 시**: L3+L4 동시 escalation → vendor support 컨택 → 외부 데이터 복구 업체 (사전 보관 연락처)

## Workflow Checklist (skill 호출 시 출력 권장)

```
Progress:
- [ ] Section 1: Pre-migration (백업 + 정합성 + dry-run)
- [ ] Section 2: Rollout Strategy (flag + canary + dual write/read)
- [ ] Section 3: Validation (메트릭 + 로그 + 알람)
- [ ] Section 4: Rollback Plan (ABORT 조건 + Phase별 롤백)
- [ ] Section 5: Communication (사전 공지 + war-room + escalation)
- [ ] Section 6: Worst-Case (손실 / 정합성 / 전파 / 롤백 실패)
- [ ] Final Sign-off (책임자 + 데이터팀 + 보안팀 + on-call)
```

## Quick Reference

| 패턴 | 언제 | 키워드 |
|---|---|---|
| Feature Flag | 모든 마이그레이션 진입점 | `migration.<name>.enabled` |
| Canary | 사용자 영향 점진 노출 | 1% → 10% → 50% → 100% |
| Dual Write | 데이터 시스템 교체 | A→B→C→D phase |
| Expand-Migrate-Contract | 스키마 변경 | 3단계 분리 배포 |
| Circuit Breaker | 장애 전파 방지 | target 실패율 임계 |
| PITR | 시점 복구 | RPO 측정 기준 |
| PoNR | Phase C 진입 게이트 | 책임자 승인 필수 |

## Output Style (운영팀 친화)

- 모든 항목은 **체크박스 `[ ]`**로 표현 (운영팀이 그대로 사용)
- 측정 가능한 임계값 (예: "+0.5%p", "5분 지속") — 모호한 표현 금지
- 시간 표기는 절대값 + KST 명시 (예: "2026-06-15 02:00 KST")
- 책임자 / 대상은 이름 또는 팀명으로 명시 ("팀장님"이 아닌 "데이터팀 김OO")
- 한국어 위주, 영문 고유명사만 영어 (DBMS / SaaS 제품명)

## Rationalizations

The following table captures common excuses agents (or developers) make to skip rigor here, paired with rebuttals.

| Excuse | Rebuttal |
|---|---|
| "트래픽 적은 시간대니까 그냥 끄고 바꾸자" | "트래픽 적은 시간"에 사고가 나면 대응 인원도 적다 — 무중단 절차는 사람 수와 무관하게 안전망이다 |
| "staging이랑 prod는 거의 같으니까 dry-run 생략하자" | "거의 같다"는 곳에서 실패한다. 데이터 볼륨/RPS/시크릿 형식 등이 다르다 |
| "백업은 어제 받은 거 있어요" | 어제 백업으로 오늘 데이터를 복구할 수 없다. RPO = 24시간이면 24시간 데이터를 잃는다 |
| "dual write는 복잡하니까 그냥 한번에 옮기자" | "한번에 옮기는 작업"의 롤백 비용은 dual write 구현 비용의 100배다 |
| "rollback은 안 쓸 거니까 대충 적자" | rollback dry-run을 안 한 롤백은 "있다"고 부르지 않는다 |
| "war-room은 슬랙 채널이면 충분하지" | escalation 시한 / 책임자 / 응답 SLA 없는 채널은 사고 시 침묵한다 |
| "vendor support는 사고 나면 부르면 되지" | DB 벤더 SLA 응답 평균 24시간. 사전 핫라인 계약이 없으면 사고 한복판에서 영업팀과 통화한다 |
| "이번엔 작은 변경이니까 6섹션은 과해" | 6섹션을 생략한 작은 변경이 가장 많이 사고를 낸다. "작아 보였다"가 모든 RCA의 첫 문장이다 |
