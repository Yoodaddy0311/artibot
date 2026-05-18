---
description: (Artibot) Zero-downtime 마이그레이션 체크리스트 — 백업/Rollout/검증/Rollback/Communication/Worst-Case 6섹션 생성
argument-hint: 'e.g. "MySQL→PostgreSQL", "Node 18→22", "결제 시스템을 Stripe로 이전"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
toolset: devops
lifecycle: ship
---

# /migrate

운영팀이 그대로 사용할 수 있는 **Zero-Downtime Migration 체크리스트**를 생성합니다.

> ⚠️ **production 매출/고객 데이터가 걸린 작업입니다.** 한 줄 실수가 결제 중단, 데이터 손실, 고객 이탈로 직결됩니다. 이 커맨드는 그 위험을 단계별 체크리스트로 분해해, 운영팀이 빠뜨리는 항목이 없도록 합니다.

## 언제 자동 트리거되는가

다음과 같은 자연어 요청이 감지되면 `zero-downtime-migration` skill과 함께 자동 실행됩니다.

| 한국어 트리거 | 영어 트리거 |
|---|---|
| "마이그레이션 계획 짜줘" | "plan a migration from X to Y" |
| "DB 이전", "DB 교체" | "migrate from MySQL to Postgres" |
| "Postgres에서 MongoDB로 옮기고 싶어" | "switch from Stripe to Toss" |
| "Node 16에서 20으로 올리려고" | "Node 16→20 upgrade" |
| "결제 시스템 바꾸려고 하는데" | "replace the auth system" |
| "롤아웃 전략", "점진 전환" | "rollout strategy", "phased cutover" |
| "무중단 배포" | "zero-downtime cutover" |

## Usage

```
/migrate [기존 시스템] → [새 시스템]
/migrate MySQL→PostgreSQL
/migrate "Stripe에서 Toss Payments로 결제 모듈 교체"
/migrate --depth deep --window "2026-06-15 02:00 KST"
```

## Arguments

`$ARGUMENTS` 파싱:

- **source → target**: 무엇에서 무엇으로 (자연어 OK — "MySQL을 Postgres로", "Auth0에서 Cognito로")
- `--depth [level]`: `shallow` (단일 페이지 체크리스트) | `deep` (섹션별 상세 절차 + 명령어 예시) — 기본 `deep`
- `--scope [level]`: `data` (DB/스키마) | `service` (API/외부 의존성) | `infra` (런타임/인프라) | `language` (Node/Python 버전)
- `--window "<일시>"`: 점검 윈도우 (예: "2026-06-15 02:00~04:00 KST"). 미지정 시 "TBD" 자리표시자
- `--owner "<이름/팀>"`: 책임자 (escalation chain 첫 단계). 미지정 시 "TBD"

## Execution Flow

1. **Parse**: source/target 추출, scope 자동 감지 (DB 키워드 → `data`, npm/runtime → `language` 등)
2. **Skill 로드**: `zero-downtime-migration` skill을 무조건 로드 — 6섹션 템플릿이 여기에 정의됨
3. **Context 스캔** (해당 시):
   - 현재 코드베이스의 관련 의존성 (package.json, requirements.txt, schema.prisma 등)
   - 기존 백업 스크립트 / 헬스체크 엔드포인트
   - 환경 분리 상태 (staging 존재 여부)
4. **Delegate**: `Task(devops-engineer)` 또는 `Task(architect)`로 라우팅
   - 데이터 마이그레이션 (스키마 변경) → `architect` 우선
   - 서비스 / 인프라 / 런타임 교체 → `devops-engineer` 우선
5. **Generate**: 아래 **체크리스트 템플릿** 형식으로 출력
6. **Persist**: `.artibot/REPORTS/YYYY-MM-DD-migration-<slug>.md` 로 저장 (운영팀 공유용)
7. **Track**: `TaskCreate`로 각 섹션의 미완료 항목을 작업화

## 출력 — 6섹션 체크리스트 템플릿

```markdown
# Migration: <source> → <target>

| 항목 | 값 |
|---|---|
| Source | <기존 시스템> |
| Target | <새 시스템> |
| Scope | <data / service / infra / language> |
| 점검 윈도우 | <일시 또는 TBD> |
| 책임자 | <이름/팀 또는 TBD> |
| 예상 영향 사용자 수 | <건수 또는 TBD> |
| 예상 다운타임 | <0분 목표 / 허용 한도> |

---

## 1. Pre-migration (사전 준비)

### 1.1 백업
- [ ] Full backup 완료 (원본 데이터 무결성 해시 기록)
- [ ] 백업 복원 리허설 (staging에서 실제 복원 1회 이상)
- [ ] 백업 보관 위치 2곳 이상 (기본 + cold storage)
- [ ] 백업 만료 정책 명시 (이번 마이그레이션 종료 후 최소 30일 보관)

### 1.2 데이터 정합성 검증
- [ ] Source 스키마 / row count 스냅샷 기록
- [ ] Target 환경에 동일 데이터 시드 후 row count 일치 확인
- [ ] 샘플 100건 randomized diff (source vs target)
- [ ] 인코딩 / 타임존 / NULL 처리 차이 점검 (특히 DBMS 교체 시)

### 1.3 사전 점검
- [ ] Staging 환경에 동일 마이그레이션 dry-run 1회 완료
- [ ] 모니터링 대시보드 준비 (에러율, 지연시간, 처리량)
- [ ] 알람 임계값 설정 (5분 내 평소 대비 +20% 에러 → PagerDuty)
- [ ] 관련 의존 서비스 owner에게 작업 사전 공지 (T-72h)

---

## 2. Rollout Strategy (점진적 전환)

### 2.1 Feature Flag
- [ ] `migration.<name>.enabled` 플래그 추가 (기본 false)
- [ ] 플래그 토글 즉시 반영 가능한지 검증 (재배포 불필요)
- [ ] 사용자 ID / 트래픽 비율 기반 분기 가능 여부 확인

### 2.2 Canary (0% → 1% → 10% → 50% → 100%)
- [ ] 1% 트래픽으로 30분 운영 → 메트릭 정상 확인
- [ ] 10% → 1시간 → 50% → 6시간 → 100%
- [ ] 각 단계 ABORT 조건 명시 (아래 §4 Rollback 참조)

### 2.3 Dual Write / Dual Read (데이터 마이그레이션 시)
- [ ] **Phase A**: source 쓰기 + target 쓰기 (target은 shadow)
- [ ] **Phase B**: source 읽기 + target 읽기 비교 (불일치 로깅, 사용자 응답은 source)
- [ ] **Phase C**: target 읽기 + source 백업 쓰기 (전환점 — 되돌리기 어려워짐)
- [ ] **Phase D**: target 단독 (source는 read-only 보관)

### 2.4 점진적 전환 원칙
- [ ] **Backward-compatible 우선**: 새 컬럼/필드 추가는 nullable, 기존 코드 영향 0
- [ ] **Expand → Migrate → Contract**: 새 구조 추가 → 데이터 이동 → 옛 구조 제거 (각 배포 분리)
- [ ] **세션 무중단**: 활성 세션 / 진행중 트랜잭션 처리 방식 명시 (drain timeout 등)

---

## 3. Validation (검증)

### 3.1 메트릭
- [ ] **에러율**: target 응답 4xx/5xx ≤ 기존 대비 +0.5%p
- [ ] **지연시간**: p95 ≤ 기존 +20%, p99 ≤ 기존 +50%
- [ ] **처리량**: TPS 평소 대비 -10% 이내
- [ ] **데이터 정합성**: hourly checksum source vs target (불일치 즉시 알람)

### 3.2 로그
- [ ] 마이그레이션 전용 로그 태그 (`migration_id=<id>`)
- [ ] dual-read 불일치 별도 로그 채널 (sampling 1% 권장 — 폭주 방지)
- [ ] 사용자 영향 이벤트 추적 (로그인 실패, 결제 실패, 데이터 불일치 노출 등)

### 3.3 알람
- [ ] 에러율 임계 초과 → on-call PagerDuty + Slack `#war-room-migration`
- [ ] 정합성 체크 실패 → 즉시 ABORT 자동 트리거
- [ ] 백엔드 health endpoint `/health/migration` 추가 (현재 phase 노출)

---

## 4. Rollback Plan (롤백 계획)

### 4.1 ABORT 조건 (자동/수동)
- [ ] 에러율 +1%p 5분 지속 → 자동 ABORT
- [ ] p95 지연 +50% 10분 지속 → 자동 ABORT
- [ ] dual-write 불일치율 0.1% 초과 → 수동 판단 + ABORT 후보
- [ ] 결제 / 인증 등 critical path 장애 → 즉시 ABORT

### 4.2 롤백 절차 (Phase별)
| Phase | 롤백 방법 | 예상 소요 | 데이터 손실 가능성 |
|---|---|---|---|
| Phase A (shadow write) | flag off | <1분 | 없음 |
| Phase B (compare read) | flag off | <1분 | 없음 |
| Phase C (target read) | flag off + replay target→source delta | 5~30분 | **있음** (delta replay 실패 시) |
| Phase D (cutover 완료) | source 복원 + target 데이터 백포팅 | 30분~수시간 | **있음** (시간차 데이터) |

- [ ] 각 Phase별 롤백 dry-run 1회 이상 완료
- [ ] Phase C 진입 전 **Point-of-No-Return 회의** (책임자 승인 필수)

### 4.3 데이터 복구
- [ ] 1.1 백업으로 복원 가능 시점 명시 (RPO — Recovery Point Objective)
- [ ] 복원 소요 시간 측정 (RTO — Recovery Time Objective)
- [ ] 부분 복구 (특정 테이블만) 가능 여부 확인

---

## 5. Communication Plan (커뮤니케이션)

### 5.1 사전 공지
- [ ] **T-7d**: 전사 공지 (이메일 + Slack 공지 채널) — 영향 범위, 일정, 대체 절차
- [ ] **T-72h**: 의존 팀 owner에게 개별 컨택 + 회신 확인
- [ ] **T-24h**: 고객 공지 (필요 시) — 점검 윈도우, 대체 채널, 보상안
- [ ] **T-1h**: 운영팀 / on-call 최종 점검 회의

### 5.2 실시간 커뮤니케이션
- [ ] War-room 채널 개설 (`#war-room-migration-YYYYMMDD`)
- [ ] Status page 업데이트 (각 Phase 전환 시점)
- [ ] 30분 단위 정기 상태 공유 (Phase / 메트릭 / 이슈 유무)

### 5.3 Escalation Chain
| 단계 | 트리거 | 연락 대상 | 응답 시한 |
|---|---|---|---|
| L1 | 메트릭 경고 | on-call 엔지니어 | 5분 |
| L2 | ABORT 후보 | 책임자 (`--owner`) | 10분 |
| L3 | 데이터 손실 의심 | CTO + 데이터팀장 | 즉시 |
| L4 | 외부 고객 영향 | CEO + PR + 법무 | 즉시 |

### 5.4 사후 보고
- [ ] 완료 직후 1줄 요약 + 메트릭 스냅샷 Slack 공유
- [ ] T+24h: 상세 회고 문서 (RCA 템플릿) 작성 및 회람
- [ ] T+7d: postmortem 회의 (성공/실패 무관 시행)

---

## 6. Worst-Case Scenarios (최악의 시나리오)

### 6.1 데이터 손실
- **시나리오**: cutover 후 source 폐기 → target에서 데이터 일부 누락 발견
- **사전 대비**:
  - [ ] Source는 cutover 후 **최소 30일 read-only 보관** (즉시 폐기 금지)
  - [ ] 시간 단위 백업 (point-in-time recovery 가능)
  - [ ] 1.1 백업 위치 2곳 이상
- **발생 시 대응**:
  - [ ] 즉시 §5.3 L3 escalation
  - [ ] 영향 범위 산정 (어떤 사용자 / 어떤 데이터)
  - [ ] 백업에서 부분 복구 → diff merge

### 6.2 데이터 정합성 깨짐 (silent corruption)
- **시나리오**: dual-write 도중 한쪽만 성공 → 양쪽 데이터 분기
- **사전 대비**:
  - [ ] Dual-write를 트랜잭션으로 묶기 (불가 시 outbox pattern)
  - [ ] Hourly checksum (3.1)
  - [ ] Reconciliation job (불일치 자동 수정 가능한 케이스만)
- **발생 시 대응**:
  - [ ] 즉시 신규 dual-write 중단 (read는 source 고정)
  - [ ] 불일치 데이터 전수 조사 → 우선순위 머지

### 6.3 장애 전파 (cascading failure)
- **시나리오**: target 시스템 과부하 → 의존 서비스 connection pool 고갈 → 전사 장애
- **사전 대비**:
  - [ ] Circuit breaker 적용 (target 실패율 임계 초과 시 source fallback)
  - [ ] Rate limiting (target에 초기 트래픽 제한)
  - [ ] Connection pool 격리 (source/target 별도 풀)
- **발생 시 대응**:
  - [ ] 즉시 ABORT + flag off
  - [ ] 의존 서비스 health 전수 점검
  - [ ] War-room §5.2 채널에서 5분 단위 상태 공유

### 6.4 롤백 실패
- **시나리오**: ABORT 발동했으나 롤백 절차 자체가 실패 (예: backup 복원 중 corruption)
- **사전 대비**:
  - [ ] 백업 복원 리허설 1.1에서 검증
  - [ ] **2-fault tolerance**: 백업 1곳 + cold storage 1곳 동시 손상 시나리오까지 대비
  - [ ] Vendor support 사전 채널 확보 (DBMS/클라우드 벤더 핫라인)
- **발생 시 대응**:
  - [ ] §5.3 L3+L4 동시 escalation
  - [ ] Vendor support 즉시 컨택
  - [ ] 외부 데이터 복구 전문 업체 연락처 사전 보관

---

## Final Sign-off

| 역할 | 이름 | 승인 시각 | 비고 |
|---|---|---|---|
| 책임자 | | | |
| 데이터팀 검토 | | | |
| 보안팀 검토 | | | |
| on-call 엔지니어 | | | |

> 모든 체크박스가 채워지고 4명 sign-off 완료 시점에 Phase A 진입 가능합니다.
```

## Phase Mapping

- **Default agents**: `devops-engineer` (운영/인프라/런타임), `architect` (데이터/스키마/도메인 경계)
- **Candidates**: devops-engineer, architect, database-reviewer, security-reviewer
- **Toolset**: `devops`

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 실행 계획 | `/plan` | 마이그레이션 체크리스트 기반 phase별 작업 분해 |
| 2 | 작업 등록 | `/task` | 각 체크리스트 항목을 추적 가능한 task로 등록 |
| 3 | 배포 | `/ship` | 점검 윈도우 도래 시 실제 cutover 실행 |
| 4 | 사후 회고 | `/recap` | T+24h 회고 보고서 작성 |
