---
status: active
created: 2026-08-26
number: 7
renumbered-from: ADR-002
moved-from: docs/adr/ADR-002-worktree-제공자-split-은-내장-worktree-worktree-manager-는-autopilot-전용-공존.md
renumbered-by: B2 (오너 결정 2026-09-03)
---

# ADR-007: worktree 제공자 — /split 은 내장 worktree, worktree-manager 는 autopilot 전용 공존

## 추천 결론 (TL;DR)
> **내장 worktree 사용 + worktree-manager 무수정 공존(provider 어댑터는 2번째 소비자/C단계 때)을(를) 채택한다.** worktree-manager.js:51 autopilot/ 접두 allowlist + deleteBranch 기본 true 는 393-브랜치 누수 사고 대응물. 내장은 junction/stale lock/.worktreeinclude/PR checkout 을 Anthropic 이 출하. 우리 worktree 는 plugin runtime 안(중첩) — 통증 ⑤ 원천. split/ 접두면 allowlist 가 구조적으로 분리.

## Status
Accepted — 확정 2026-08-26 (PRD `split-cross-session-multi-worktree-20260826` Phase 6).

**번호 이력**: r2 초안 `ADR-007` → r1 확정 `ADR-002`(2026-08-26) → **결정 B2(오너, 2026-09-03)로 `ADR-007` 재부여**. B2 는 ADR 을 `.artibot/adr/` 한 계열로 단일화했고, 거기로 함께 옮겨간 `plugins/artibot/docs/adr/` 계열이 이미 쓰던 001~005(effort/autopilot 계열, 내용 무관)와의 번호 충돌을 피하려 split 계열 5건을 006~010 으로 재번호했다. 숫자가 r2 초안과 같아진 것은 **재번호의 결과이지 r2 초안 번호의 부활이 아니다**. 이 문서의 정본 번호는 이제 `ADR-007` 이다.

작성일: 2026-08-26
작성자: Artibot core (ULTRAPLAN /split, 2026-08-26)
확정일: 2026-08-26

---

## 1. Context (컨텍스트와 제약사항)
조사 필요

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: 내장 worktree 사용 + worktree-manager 무수정 공존(provider 어댑터는 2번째 소비자/C단계 때)
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 즉시 단일 수렴(worktree-manager 재작성)
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 영구 병존
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
> ## ✓ **추천: 내장 worktree 사용 + worktree-manager 무수정 공존(provider 어댑터는 2번째 소비자/C단계 때)**

**선택 근거**: worktree-manager.js:51 autopilot/ 접두 allowlist + deleteBranch 기본 true 는 393-브랜치 누수 사고 대응물. 내장은 junction/stale lock/.worktreeinclude/PR checkout 을 Anthropic 이 출하. 우리 worktree 는 plugin runtime 안(중첩) — 통증 ⑤ 원천. split/ 접두면 allowlist 가 구조적으로 분리.

### 보충(2026-08-26 실측)

**전제 교정**: 위 "split/ 접두" 전제는 실측과 다르다. 내장 `claude --worktree <name>` 은 브랜치를 `worktree-<name>` 으로 자동 생성한다(2026-08-26 21:30 리더 실측 `worktree-probe1`, PRD "Phase 2 프로브 실측" P2). `split/` 접두 브랜치는 내장 provider 가 만들어 주지 않으며, 직접 `git worktree add -b split/…` 로 만드는 것은 본 ADR 의 결정("내장 provider 만") 위반이라 기각.

**채택 규약(2026-08-26 리더 결정)**: worktree 이름 `split-<repo-short>-<limb>` → 브랜치 `worktree-split-<repo-short>-<limb>`. 정본은 `lib/git/repo-identity.js#splitLimbBranch` / `SPLIT_BRANCH_PREFIXES`(bare `split/` 거부) — 21:55 기준 :220 / :64.

**결론(분리) 유지 근거**: `lib/autopilot/worktree-manager.js` 의 가드는 `AUTOPILOT_BRANCH_PREFIX = 'autopilot/'`(:27) 접두 검사이고, `worktree-split-` 은 `autopilot/` 과 상호 비접두(어느 쪽도 다른 쪽의 접두가 아님)이므로 worktree-manager 의 삭제 가드(`deleteBranch` 기본 true, :170)는 `/split` 줄기 브랜치에 닿지 않는다. 즉 접두 문자열은 바뀌었지만 "allowlist 가 구조적으로 분리한다"는 결론은 그대로 성립한다.

---

## 6. Consequences (의사결정의 결과)
조사 필요

---

## 7. 2년 뒤 기술 부채 예상 포인트
조사 필요
