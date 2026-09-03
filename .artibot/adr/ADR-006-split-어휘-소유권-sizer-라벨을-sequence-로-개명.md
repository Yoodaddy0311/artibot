---
status: active
created: 2026-08-26
number: 6
renumbered-from: ADR-001
moved-from: docs/adr/ADR-001-split-어휘-소유권-sizer-라벨을-sequence-로-개명.md
renumbered-by: B2 (오너 결정 2026-09-03)
---

# ADR-006: split 어휘 소유권 — sizer 라벨을 sequence 로 개명

## 추천 결론 (TL;DR)
> **sizer 라벨 split→sequence 개명(커맨드명 유지)을(를) 채택한다.** session-sizer.js:306 recommendation:"split" 은 순차 세션 분할, 신규 /split 은 동시 창 분할 — 같은 도메인의 2번째 referent 는 ORCHESTRATION-GLOSSARY "workflow 6중 의미" 재현. 개명 파급은 4파일 22곳·.plan-state.json 무영향(critic 실측). 사용자 표면 0.

## Status
Accepted — 확정 2026-08-26 (PRD `split-cross-session-multi-worktree-20260826` Phase 6).

**번호 이력**: r2 초안 `ADR-006` → r1 확정 `ADR-001`(2026-08-26) → **결정 B2(오너, 2026-09-03)로 `ADR-006` 재부여**. B2 는 ADR 을 `.artibot/adr/` 한 계열로 단일화했고, 거기로 함께 옮겨간 `plugins/artibot/docs/adr/` 계열이 이미 쓰던 001~005(effort/autopilot 계열, 내용 무관)와의 번호 충돌을 피하려 split 계열 5건을 006~010 으로 재번호했다. 숫자가 r2 초안과 같아진 것은 **재번호의 결과이지 r2 초안 번호의 부활이 아니다**. 이 문서의 정본 번호는 이제 `ADR-006` 이다.

작성일: 2026-08-26
작성자: Artibot core (ULTRAPLAN /split, 2026-08-26)
확정일: 2026-08-26

---

## 1. Context (컨텍스트와 제약사항)
조사 필요

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: sizer 라벨 split→sequence 개명(커맨드명 유지)
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: /split 을 다른 이름으로
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 두 의미 병존 + 글로서리 각주
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
> ## ✓ **추천: sizer 라벨 split→sequence 개명(커맨드명 유지)**

**선택 근거**: session-sizer.js:306 recommendation:"split" 은 순차 세션 분할, 신규 /split 은 동시 창 분할 — 같은 도메인의 2번째 referent 는 ORCHESTRATION-GLOSSARY "workflow 6중 의미" 재현. 개명 파급은 4파일 22곳·.plan-state.json 무영향(critic 실측). 사용자 표면 0.

---

## 6. Consequences (의사결정의 결과)
조사 필요

---

## 7. 2년 뒤 기술 부채 예상 포인트
조사 필요
