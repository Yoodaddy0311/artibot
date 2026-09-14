---
status: active
created: 2026-09-14
number: 12
---

# ADR-012: Wave 10 편성 — 8창 롤링 + 감사 결함을 로드맵 선행 불변식으로 흡수

## 추천 결론 (TL;DR)
> **8창 롤링(오너 처리량 지시 maxWindows 8 준수): 창 1 autopilot-phase-transition(F01→F02) · 창 2 routing-single-decision(F04+F05, 기록→전환 2단계) · 창 3 split-ops-remediation(F06~F09 + addendum) · 창 4 economics-coverage(fold→pricing 순차) · 창 5 scorecard-absent-contract · 창 6 verify-numerator-rate A · 창 7 nl-activation-report · 창 8 guard-l2-followups. F03+F10·plan-md-emitter·routebench-live 는 롤링. 세션 한도는 창 수가 아니라 시작 시각(리셋 직후)·wip 규약·부분 배치 착지로 완화. 감사 F01/F02(CA-03 선행)·F04/F05(SH-04 선행)는 로드맵으로 세되 V5-BACKLOG 비고에 F 번호 명기(E1 오너 결정 대기, 대안은 엄격 25%).을(를) 채택한다.** 세 렌즈가 독립 실측으로 같은 직렬 제약(engine.js 986줄 공유 → F01/F02/F10 한 창, tasks.js 한 함수 → F04/F05 한 창, materializeLimb 공유 → F06+addendum 병합, safety.js 3중 경합 → F03 은 guard-l2 뒤)에 수렴했다. 갈린 것은 창 수뿐이다. 창 수를 줄여도 계정 단위 한도는 총 사용량에 걸리므로(원인 추론, 호스트 계측 0) 6창이 사망을 막는다는 근거가 없고, 오너 2026-09-11 지시가 처리량 우선·maxWindows 8 이다. plan-md-emitter 는 tasks.js plan.revision 뮤테이터가 필요해(brief-draft :27·:52) 창 2 와 겹치므로 Wave 10 본편에서 제외했다. Wave 10 의 진짜 크리티컬 패스는 코드가 아니라 4.62.0 선릴리스(Wave 9 미릴리스 52 files)와 라이브 분모 누적이다.

## Status
Accepted

작성일: 2026-09-14

---

## 1. Context (컨텍스트와 제약사항)
조사 필요

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: (risk 렌즈) 6창 + 롤링 후속: F01→F02 만 창 1, F04+F05 창 2, split 4결함 창 3, Observe 판독기 3창. 세션 한도 동시 사망 2회 실증을 근거로 창 수 축소, 부채 1/6
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: (mvp 렌즈) 8창: Observe 판독기 5축 전부 + pricing + routebench + autopilot(F01+F02+F10) + split. routing-C 는 Wave 11 로. 부채 2/8
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: (arch 렌즈) 8창: F01+F02 · F04+F05 · pricing+fold 한 창 · plan-md-emitter · verify-A · scorecard · split(F06~F08) · F09 단독. F03+F10 은 Wave 11. 부채 2/8
- **장점**: 조사 필요
- **단점**: 조사 필요

---

## 3. 확장성 관점 평가
조사 필요

---

## 4. 숨겨진 비용
조사 필요

---

## 5. Decision (추천안)
> ## ✓ **추천: 8창 롤링(오너 처리량 지시 maxWindows 8 준수): 창 1 autopilot-phase-transition(F01→F02) · 창 2 routing-single-decision(F04+F05, 기록→전환 2단계) · 창 3 split-ops-remediation(F06~F09 + addendum) · 창 4 economics-coverage(fold→pricing 순차) · 창 5 scorecard-absent-contract · 창 6 verify-numerator-rate A · 창 7 nl-activation-report · 창 8 guard-l2-followups. F03+F10·plan-md-emitter·routebench-live 는 롤링. 세션 한도는 창 수가 아니라 시작 시각(리셋 직후)·wip 규약·부분 배치 착지로 완화. 감사 F01/F02(CA-03 선행)·F04/F05(SH-04 선행)는 로드맵으로 세되 V5-BACKLOG 비고에 F 번호 명기(E1 오너 결정 대기, 대안은 엄격 25%).**

**선택 근거**: 세 렌즈가 독립 실측으로 같은 직렬 제약(engine.js 986줄 공유 → F01/F02/F10 한 창, tasks.js 한 함수 → F04/F05 한 창, materializeLimb 공유 → F06+addendum 병합, safety.js 3중 경합 → F03 은 guard-l2 뒤)에 수렴했다. 갈린 것은 창 수뿐이다. 창 수를 줄여도 계정 단위 한도는 총 사용량에 걸리므로(원인 추론, 호스트 계측 0) 6창이 사망을 막는다는 근거가 없고, 오너 2026-09-11 지시가 처리량 우선·maxWindows 8 이다. plan-md-emitter 는 tasks.js plan.revision 뮤테이터가 필요해(brief-draft :27·:52) 창 2 와 겹치므로 Wave 10 본편에서 제외했다. Wave 10 의 진짜 크리티컬 패스는 코드가 아니라 4.62.0 선릴리스(Wave 9 미릴리스 52 files)와 라이브 분모 누적이다.

---

## 6. Consequences (의사결정의 결과)
조사 필요

---

## 7. 2년 뒤 기술 부채 예상 포인트
조사 필요

## 오너 결정 확정 (2026-09-14 11:5x KST, AskUserQuestion 실답 — 4건 전부 권장안)

| ID | 결정 | 적용 |
|---|---|---|
| E1 | 감사 결함은 로드맵 ID 의 선행 불변식이면 로드맵으로 산입하되 V5-BACKLOG 해당 ID 비고에 F 번호 명기 | F01/F02→CA-03·SH-06 비고, F04/F05→SH-04 비고, F03/F10→CA-03·CA-12 비고, F06~F09→§3 split 행. Wave 10 부채 2/8 확정 |
| E2 | Observe ⑤ Existence Audit 은 Shadow 로 이월. Observe 종료는 ①②③④ 4축으로 판정 | V5-BACKLOG §4 표 갱신(L5), SH-29 carrier writer 는 Wave 12 Shadow 계측 |
| E3 | RouteBench 시나리오 = B(스크럽 코퍼스 + 소비 게이트, 개인정보 역추적 0 이 완료 조건) | `routebench-scenarios-live` 롤링 줄기 착수 가능 |
| G1 | v5.0 GA 조건 = GA-02 기전 GA(allowlist + config 1키 되돌림 실증)만. GA-01·GA-03(WP02) 은 v5.1 트랙 | 설계 §4 GA 행 문구 변경 + V5-BACKLOG GA-01/03 비고 "v5.1" (L5) |

권장안 기록(질문 없이 확정): A′ · pricing 선행조건 해제 · resume CLI source=supervisor · plan.revised mode=plan · E4 Canary 판정 Wave 12 뒤 리더 · E5 carrier 3키 · E6 decisions 스토어 · E7 N=30 · E8 실측 해소 · E9 unknown usage 경고만 · OB-10 controller 정본 유지.
