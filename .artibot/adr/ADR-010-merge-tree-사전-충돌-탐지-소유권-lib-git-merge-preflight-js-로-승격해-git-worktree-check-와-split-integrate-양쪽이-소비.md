---
status: active
created: 2026-08-26
number: 10
renumbered-from: ADR-005
moved-from: docs/adr/ADR-005-merge-tree-사전-충돌-탐지-소유권-lib-git-merge-preflight-js-로-승격해-git-worktree-check-와-split-integrate-양쪽이-소비.md
renumbered-by: B2 (오너 결정 2026-09-03)
---

# ADR-010: merge-tree 사전 충돌 탐지 소유권 — lib/git/merge-preflight.js 로 승격해 /git worktree check 와 /split integrate 양쪽이 소비

## 추천 결론 (TL;DR)
> **lib/git/merge-preflight.js 승격 + 양쪽 소비을(를) 채택한다.** commands/git.md:170,186-188 이 merge-tree 충돌 매트릭스·머지 순서를 이미 제공(critic 발견 #1). 승격은 실소비자 2인 규칙 충족, --write-tree 버전 프로브 fail-closed 를 한 곳에서 소유. 존재≠작동 — Phase 4 착수 시 /git worktree check 1회 실행 선행.

## Status
Accepted — 확정 2026-08-26 (PRD `split-cross-session-multi-worktree-20260826` Phase 6).

**번호 이력**: r2 초안 `ADR-010` → r1 확정 `ADR-005`(2026-08-26) → **결정 B2(오너, 2026-09-03)로 `ADR-010` 재부여**. B2 는 ADR 을 `.artibot/adr/` 한 계열로 단일화했고, 거기로 함께 옮겨간 `plugins/artibot/docs/adr/` 계열이 이미 쓰던 001~005(effort/autopilot 계열, 내용 무관)와의 번호 충돌을 피하려 split 계열 5건을 006~010 으로 재번호했다. 숫자가 r2 초안과 같아진 것은 **재번호의 결과이지 r2 초안 번호의 부활이 아니다**. 이 문서의 정본 번호는 이제 `ADR-010` 이다.

작성일: 2026-08-26
작성자: Artibot core (ULTRAPLAN /split, 2026-08-26)
확정일: 2026-08-26

---

## 1. Context (컨텍스트와 제약사항)
조사 필요

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: /split integrate 가 /git worktree check 를 호출
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: lib/git/merge-preflight.js 승격 + 양쪽 소비
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 중복 인정 + 사유 명문화
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
> ## ✓ **추천: lib/git/merge-preflight.js 승격 + 양쪽 소비**

**선택 근거**: commands/git.md:170,186-188 이 merge-tree 충돌 매트릭스·머지 순서를 이미 제공(critic 발견 #1). 승격은 실소비자 2인 규칙 충족, --write-tree 버전 프로브 fail-closed 를 한 곳에서 소유. 존재≠작동 — Phase 4 착수 시 /git worktree check 1회 실행 선행.

---

## 6. Consequences (의사결정의 결과)
조사 필요

---

## 7. 2년 뒤 기술 부채 예상 포인트
조사 필요
