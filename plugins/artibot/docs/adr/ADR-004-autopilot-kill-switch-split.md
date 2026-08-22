---
status: active
created: 2026-08-22
number: 4
---

# ADR-004: autopilot kill-switch — 플래그 분할 + 레거시 양방향 보수 매핑

## 추천 결론 (TL;DR)

> **`autopilot.enabled` 불리언 하나가 겸하던 두 정책을 `autopilot.suggest.enabled`(NL 자동제안) / `autopilot.execution.enabled`(엔진 mutation) 로 분할하고, 레거시 `enabled:false` 는 양쪽 모두 false 로 보수 매핑 + stderr WARN 을(를) 채택한다.** 게이트는 신규 `lib/autopilot/consent-gate.js` 의 단일 리졸버 `resolveAutopilotConsent` 가 소유하며, `engine.js` 접점은 `startAutopilot`/`resumeAutopilot` 진입부의 호출 수 줄로 제한한다(부작용 0 지점 — `makeInitialState` 이전). `status`/`list`/`abort` 류 read/control 은 항상 허용(꺼진 오토파일럿도 멈추고 조회할 수 있어야 한다).

## Status

Accepted — 구현됨 (2026-08-23, wave2-a1). 검증: consent-gate 테스트 41건(정책 매트릭스·파일시스템 side-effect 0 단언·override 음성 대조·양성 대조 선행).

## 1. Context

- 실측(2026-08-22 검증 세션): `engine.js#startAutopilot` 은 `autopilot.enabled` 를 읽지 않고 lock·state·PRD·keep-awake 부작용을 시작했다. 유일한 코드 소비자는 NLU 제안 훅(`scripts/hooks/autopilot-nlu-trigger.js#isEnabled`) 뿐.
- 그러나 그 플래그의 출하된 의미는 CHANGELOG v4.4.1 상 **"자동제안 침묵" 전용**이며, 이 리포는 의도적으로 `enabled:false` 를 유지한 채 명시적 `/autopilot <task>` 를 사용해 왔다.
- 반면 `commands/autopilot.md` 의 Config 절은 `enabled:false` 를 전면 비활성화처럼 서술 — 두 진실원이 어긋난 상태였다.

## 2. Options

1. **원안(제안서 A1)**: `enabled:false` 가 엔진 mutation 전부 차단 — **기각.** 출하 config 에서 `/autopilot <task>` 가 첫날부터 불능(자기 DoS).
2. **분할 + 레거시를 suggest 에만 매핑** — **기각.** 문서가 약속한 "전면 비활성화" 의도로 false 를 넣은 사용자가 실행 권한을 조용히 되찾는다(동의 상실).
3. **분할 + 레거시 양방향 보수 매핑 + WARN** — **채택.** 두 해석의 사용자 의도를 모두 보존한다.

## 3. Decision

- 우선순위 계약(ADR 이 비워둔 상호작용 — 구현이 확정하고 테스트로 고정): ① `autopilot.<gate>.enabled` 명시 boolean 최우선 → ② 부재 시 레거시 `enabled:false` 를 양쪽 false 로 매핑 + stderr WARN(레거시 매핑이 실제 발동한 경우에만) → ③ 둘 다 부재 시 기본 활성.
- override 는 **호출 인자 전용** — config/env 로는 무력화 불가("어떤 config 파일로도 중화되는 kill-switch 는 kill-switch 가 아니다"). one-shot override 는 `state.consentReceipt` 에 additive 필드로 기록(스키마 버전 불변 — 롤백 일방통행 금지).
- 차단은 조용한 no-op 이 아니라 `{blocked:true, reason, instruction:{type:'pause', remedy}}` — 꺼진 오토파일럿이 멈춘 오토파일럿처럼 보이지 않게 한다.
- 손상 config(JSON 파싱 실패)는 게이트 기본 활성으로 폴백 — NLU 훅의 fail-closed 와 반대 방향이며 의도적(제안 침묵은 무해, 명시 커맨드 거부는 DoS).

## 4. Consequences

- 활성화 어휘가 이미 다수(enabled·autoApply·autoSelect·fast)인 config 에서, 이 게이트 계열의 유일 소유자는 `consent-gate.js#resolveAutopilotConsent` 다. 새 게이트 어휘는 반드시 이 리졸버를 경유한다.
- 알려진 미배선 1건: `queue` 는 정책표(`OPERATION_GATES`)에 선언됐으나 `lib/autopilot/goal-queue.js#enqueueGoal` 이 리졸버를 호출하지 않는다 — 후속 배선 대상(정책표 옆 주석에 명시).
- 근거 검증 이력: 자기 DoS 반증과 매핑 방향 결정은 2026-08-22 /ultraplan 적대 검증(plan-critic C3)과 위험 렌즈 실측에서 나왔다.
