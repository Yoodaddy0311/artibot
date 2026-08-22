---
status: active
created: 2026-08-22
number: 5
---

# ADR-005: autopilot crash 감지 — durable attempt 신설이 아니라 NDJSON 재조준 2단(B안)

## 추천 결론 (TL;DR)

> **crash 감지기를 죽은 `state.timeline` 에서 실제 이벤트 저장소(NDJSON)로 재조준하고 유령 필드를 철거하는 1단을 먼저 착지한 뒤, 그 위에 attempt/ACK(2단)를 얹는 B안 을(를) 채택한다.** 원안(durable `activePhaseAttempt` 신설)은 페이즈 상태 저장소를 3개에서 4개로 늘린다 — 2년 뒤 비용은 "attempt 레코드가 없어서"가 아니라 "같은 질문에 답이 3곳"이라서 발생한다.

## Status

Accepted — **1단 구현됨** (2026-08-23, wave2-a2). 2단(attempt/ACK)은 후속.

## 1. Context (실측, 2026-08-22 검증 세션 + plan-critic 독립 수렴)

- 페이즈 진행 상태 저장소가 3중이었다: `state.phases[]`(라이브) / `state.timeline[]`(**프로덕션 writer 0 인 유령** — 신규 세션에선 `undefined`) / `events.ndjson`(라이브, `tick()` 이 기록).
- 감지기 `_engine-helpers.js#detectInterruptedPhase` 는 유령을 읽어 **항상 `{interrupted:false}`** — fail-open. `buildRecoveryNote` 는 항상 null.
- `engine-recovery.test.js` 는 손수 합성한 timeline 픽스처로 전건 green — 프로덕션이 결코 만들지 않는 입력을 검증하는 거짓 확신(검증규율 §9 사례).

## 2. Options

1. **원안(제안서 A2)**: `activePhaseAttempt` durable 레코드 + ACK 신설 — **형태 기각.** 진실원 3→4, 유령 존치.
2. **B안 2단**: ① 감지기 NDJSON 재조준 + timeline 철거 → ② attempt/ACK — **채택.** 진실원 3→2, 각 단 독립 롤백.

## 3. Decision (1단 구현 내역)

- pending 페어링의 단일 소유자를 `replay.js#findUnterminatedPhases`(신설)로 두고 감지기가 위임. `_engine-helpers` 의 `walkTimelinePending`/`popMatchingPhase` 삭제.
- **ADR 초안 교정(구현 중 실측)**: "replay.js 에 동일 페어링 알고리즘 중복 구현" 서술은 부정확했다 — `replay.js#groupByPhase` 는 리포트 표용 윈도우 분할로 "닫히지 않은 창" 개념이 없다. 이관된 것은 pending 페어링뿐이며, 두 함수의 의미론 차이는 각 JSDoc 에 명시했다.
- `state.timeline` 철거: `session-store.js#migrateState` 의 빈 배열 보장, `cross-session-learner.js` 의 도달 불가 폴백 분기, 합성 픽스처 테스트 11건(철거 시 RED 로 거짓 green 목록이 실증됨) 재작성. 방어적 파싱 테스트는 입력면만 재조준해 보존.
- 실크래시 smoke(`engine-crash-recovery-smoke.test.js`): 실 `startAutopilot` → 실 phase 진입(NDJSON 실기록) → `SIGKILL` → 감지기 `interrupted:true`. **수정 전 RED 를 먼저 확인**(존재 증명). spawn 실패는 조기 return 이 아니라 단언 실패(fail-closed) — 초안의 조용한 skip(한글경로 퍼센트 인코딩로 spawn 불발 → 5ms green)을 잡은 사유가 파일 주석에 있다.

## 4. Consequences

- resume 경로가 처음으로 실제 중단을 감지한다. 2단(attempt/ACK — `runPhase2Execute` 재구성, 미ACK 재실행 허용목록, EXECUTE 기본 PAUSE)은 이 위에 별도 착지.
- 레거시 세션 파일의 `timeline` 배열은 마이그레이션하지 않고 무시(디스크 잔존, 데이터 손실 없음).
- 알려진 한계: SIGKILL 시점은 자식 종료 후(phase 본문 도중 사망은 미재현) · Windows 는 TerminateProcess 매핑이라 status/signal 양쪽 수용 · CI(Linux) 거동은 착지 CI 가 검증.
