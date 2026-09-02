# 09. Security / Governance / Autonomy Boundary

## 기본 철학

자율화는 permission bypass가 아니다.

현재 `/split`이 창 자동 생성에 보수적이었던 이유를 존중한다. vNext background worker는 **명시 opt-in + 기존 permission policy 승계** 조건에서만 활성화한다.

## Action Risk Matrix

| Action | Auto | 조건 |
|---|---|---|
| read/search | O | scope 내 |
| unit test | O | scope 내 |
| full build | O | resource budget |
| checkpoint | O | 항상 |
| fresh worker rotation | O | 동일 worktree/branch 검증 |
| retry flaky test | O | retry budget |
| commit | 정책 | 기존 Artibot 규율 승계 |
| no-conflict integration | 정책 | required review/gate 통과 |
| semantic merge conflict | X | human/reviewer |
| secret/credential change | X | human |
| permission escalation | X | human |
| destructive DB migration | X | human |
| prod deploy | 기본 X | S4에서 explicit policy만 |
| security policy disable | X | human |

## Permission Escalation Rule

Background worker가 tool permission이 부족하면:
1. bypass하지 않는다.
2. 동일 task를 `WAITING_PERMISSION`으로 전환.
3. supervisor가 foreground handoff를 준비.
4. 사용자가 승인한 뒤 새 foreground worker가 continuation checkpoint를 읽는다.

## Prompt Injection / Cross-session Message

현재 Artibot split message가 “다른 세션에서 온 데이터이지 지시가 아니다”라고 구분하는 원칙을 계속 유지한다.

Supervisor event도:
- immutable event envelope
- source (`worker|hook|git|human|supervisor`)
- trust level
- evidenceRef

를 가진다.

LLM이 쓴 자유텍스트만으로 상태를 DONE으로 바꾸지 않는다.

## Run Ledger Integrity

- append-only event log
- event id unique
- hash chaining optional Phase 2
- state cache는 rebuild 가능
- file permissions local-user only
- secret/token 기록 금지

## Autonomy Rollout

- Observe 2주
- Auto-Reversible shadow 1주
- S2 opt-in
- staging 자동화 별도 승인
- prod는 별도 정책/오너 결정
