# Acceptance Criteria

## Global invariants

1. 기존 `/split` manual mode 결과가 동일해야 한다.
2. existing trailer completion contract 변경 0.
3. permission bypass 신규 경로 0.
4. state cache 삭제 후 events replay로 동일 state 복구.
5. completed lane은 resume에서 재실행하지 않는다.
6. supervisor가 구현 파일을 직접 수정하지 않는다.
7. unknown/ambiguous state는 fail-closed.

## P1 Supervisor

- [ ] run 3개 replay fixture
- [ ] crash mid-phase fixture
- [ ] stale heartbeat detection
- [ ] observe mode side effect 0
- [ ] status가 git evidence와 일치

## P2 Context

- [ ] PreCompact snapshot regression 0
- [ ] PostCompact receives compact summary and stores it
- [ ] rehydrate payload <= configured max bytes
- [ ] same checkpoint restore idempotent
- [ ] wrong branch/worktree restore refused
- [ ] manual explanation 없이 test fixture continuation 성공

## P3 Recovery

- [ ] killed worker → fresh worker resume
- [ ] finished siblings no rerun
- [ ] retry budget enforcement
- [ ] permission-required action auto-denied/escalated

## P4 Scheduler

- [ ] dependency violation 0
- [ ] shared path concurrent assignment 0
- [ ] max heavy slots enforced
- [ ] work stealing only ready lanes
- [ ] hard cap cannot be exceeded

## P5 Budget

- [ ] soft limit warns/degrades
- [ ] hard limit pauses
- [ ] security hard-pin cannot be overridden
- [ ] retry cost included

## Performance target after 10+ real runs

- HumanWaitPct median < 8%
- Context manual intervention -80% vs baseline
- Auto-recovery > 90% of classified recoverable failures
- Conflict rate not worse than baseline
- First-pass approval not worse than baseline by >5%p
- Cost per accepted lane -20% target
