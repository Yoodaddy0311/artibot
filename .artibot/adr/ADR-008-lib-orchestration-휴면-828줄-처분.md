---
status: active
created: 2026-08-26
number: 8
renumbered-from: ADR-003
moved-from: docs/adr/ADR-003-lib-orchestration-휴면-828줄-처분.md
renumbered-by: B2 (오너 결정 2026-09-03)
---

# ADR-008: lib/orchestration/ 휴면 828줄 처분

## 추천 결론 (TL;DR)
> **/split 은 lib/orchestration/ 에 의존하지 않는다 — 처분은 독립 결정으로 분리, 본 계획은 어느 쪽도 전제하지 않음을(를) 채택한다.** 7파일 828줄, 프로덕션 import 0(lifecycle.js:33 canceler=null). 살아있는 코드를 휴면 디렉터리에 섞으면 2년 뒤 "반은 죽은" 경계. git-관측 부품은 lib/git/ 에 둔다.

## Status
Accepted — 확정 2026-08-26 (PRD `split-cross-session-multi-worktree-20260826` Phase 6).

**번호 이력**: r2 초안 `ADR-008` → r1 확정 `ADR-003`(2026-08-26) → **결정 B2(오너, 2026-09-03)로 `ADR-008` 재부여**. B2 는 ADR 을 `.artibot/adr/` 한 계열로 단일화했고, 거기로 함께 옮겨간 `plugins/artibot/docs/adr/` 계열이 이미 쓰던 001~005(effort/autopilot 계열, 내용 무관)와의 번호 충돌을 피하려 split 계열 5건을 006~010 으로 재번호했다. 숫자가 r2 초안과 같아진 것은 **재번호의 결과이지 r2 초안 번호의 부활이 아니다**. 이 문서의 정본 번호는 이제 `ADR-008` 이다.

작성일: 2026-08-26
작성자: Artibot core (ULTRAPLAN /split, 2026-08-26)
확정일: 2026-08-26

---

## 1. Context (컨텍스트와 제약사항)
조사 필요

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: /split 이 실소비자로 배선
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 삭제
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 현상 유지
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
> ## ✓ **추천: /split 은 lib/orchestration/ 에 의존하지 않는다 — 처분은 독립 결정으로 분리, 본 계획은 어느 쪽도 전제하지 않음**

**선택 근거**: 7파일 828줄, 프로덕션 import 0(lifecycle.js:33 canceler=null). 살아있는 코드를 휴면 디렉터리에 섞으면 2년 뒤 "반은 죽은" 경계. git-관측 부품은 lib/git/ 에 둔다.

---

## 6. Consequences (의사결정의 결과)
조사 필요

---

## 7. 2년 뒤 기술 부채 예상 포인트
조사 필요
