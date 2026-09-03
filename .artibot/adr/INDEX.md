# ADR Index

`.artibot/adr/` 가 **ADR 정본 단일 계열**이다(오너 결정 **B2**, 2026-09-03 최종).
설계 정본 `ARTIBOT-5.0-DESIGN.md` §3.3 이행 매핑표(:151)·§5 결정표(:282)·`/adr` 운명(:159)이
모두 이 위치를 지정하고, 루트 `.gitignore:116` 도 이 경로를 추적 정본으로 열거한다.

**통합 전 상태**: ADR 계열이 둘이었고 **양쪽 모두 001~005 를 써서 같은 번호가 서로 다른
결정을 가리켰다** — `plugins/artibot/docs/adr/`(추적 5건, effort/native-rules/autopilot)와
루트 `docs/adr/`(미추적 5+INDEX, `/split`). B2 가 이렇게 정리했다:

| 원래 위치 | 원래 번호 | 처리 | 현재 |
|---|---|---|---|
| `plugins/artibot/docs/adr/` | ADR-001~005 | `git mv`(번호 유지) | `.artibot/adr/ADR-001~005` |
| 루트 `docs/adr/` | ADR-001~005 | **006~010 재번호** 후 이동, 원본 디렉터리 삭제 | `.artibot/adr/ADR-006~010` |

> **왜 병합이 아니라 재번호였나**: 두 계열의 001~005 는 같은 결정의 사본이 아니라 **내용이
> 전혀 다른 별개 결정**이었다(전자 = effort/autopilot, 후자 = `/split`). 사본이면 병합이
> 맞지만 별개 결정이므로 번호를 새로 주는 것이 맞다. 옮겨온 5건은 frontmatter 에
> `renumbered-from`·`moved-from`·`renumbered-by` 를 갖고, 본문 Status 에 번호 이력이 있다.

`/adr` 커맨드의 기본 저장 경로도 이 디렉터리로 바뀌었다(`plugins/artibot/commands/adr.md`).

| # | 제목 | status | created | 재번호 이력 | 파일 |
|---|------|--------|---------|------------|------|
| 001 | Effort 결정 방식 — 정적 매핑 vs Score-Aware vs GRPO-학습 | active | 2026-05-29 | — | [`ADR-001-effort-workflow-fusion.md`](./ADR-001-effort-workflow-fusion.md) |
| 002 | 네이티브 마켓플레이스 설치에서 8개 auto-activating rules 전달 | active | 2026-07-07 | — | [`ADR-002-native-rules-delivery.md`](./ADR-002-native-rules-delivery.md) |
| 003 | autopilot EXECUTE pluggable runner (Option-B) | active | 2026-07-15 | — | [`ADR-003-autopilot-execute-pluggable-runner-option-b.md`](./ADR-003-autopilot-execute-pluggable-runner-option-b.md) |
| 004 | autopilot kill-switch — 플래그 분할 + 레거시 양방향 보수 매핑 | active | 2026-08-22 | — | [`ADR-004-autopilot-kill-switch-split.md`](./ADR-004-autopilot-kill-switch-split.md) |
| 005 | autopilot crash 감지 — durable attempt 신설이 아니라 NDJSON 재조준 2단(B안) | active | 2026-08-22 | — | [`ADR-005-autopilot-crash-detection-ndjson-retarget.md`](./ADR-005-autopilot-crash-detection-ndjson-retarget.md) |
| 006 | split 어휘 소유권 — sizer 라벨을 sequence 로 개명 | active | 2026-08-26 | ← `ADR-001`(루트 `docs/adr/`) | [`ADR-006-split-어휘-소유권-sizer-라벨을-sequence-로-개명.md`](./ADR-006-split-어휘-소유권-sizer-라벨을-sequence-로-개명.md) |
| 007 | worktree 제공자 — /split 은 내장 worktree, worktree-manager 는 autopilot 전용 공존 | active | 2026-08-26 | ← `ADR-002`(루트 `docs/adr/`) | [`ADR-007-worktree-제공자-split-은-내장-worktree-worktree-manager-는-autopilot-전용-공존.md`](./ADR-007-worktree-제공자-split-은-내장-worktree-worktree-manager-는-autopilot-전용-공존.md) |
| 008 | lib/orchestration/ 휴면 828줄 처분 | active | 2026-08-26 | ← `ADR-003`(루트 `docs/adr/`) | [`ADR-008-lib-orchestration-휴면-828줄-처분.md`](./ADR-008-lib-orchestration-휴면-828줄-처분.md) |
| 009 | team.worktreeIsolation orphan 설정 삭제 | active | 2026-08-26 | ← `ADR-004`(루트 `docs/adr/`) | [`ADR-009-team-worktreeisolation-orphan-설정-삭제.md`](./ADR-009-team-worktreeisolation-orphan-설정-삭제.md) |
| 010 | merge-tree 사전 충돌 탐지 소유권 — lib/git/merge-preflight.js 로 승격해 /git worktree check 와 /split integrate 양쪽이 소비 | active | 2026-08-26 | ← `ADR-005`(루트 `docs/adr/`) | [`ADR-010-merge-tree-사전-충돌-탐지-소유권-lib-git-merge-preflight-js-로-승격해-git-worktree-check-와-split-integrate-양쪽이-소비.md`](./ADR-010-merge-tree-사전-충돌-탐지-소유권-lib-git-merge-preflight-js-로-승격해-git-worktree-check-와-split-integrate-양쪽이-소비.md) |

총 10 건. `ageDays` 열은 두지 않는다 — 정적 파일에 적힌 경과일은 쓰는 순간 낡는다.
