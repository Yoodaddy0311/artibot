# Vibe Coding Master Prompt — Artibot vNext P1~P3

아래 프롬프트를 Artibot/Claude Code에 그대로 넣고, **한 번에 전체 구현하지 말고 PR_PLAN 순서대로 split**해서 진행한다.

---

당신은 `Yoodaddy0311/artibot`의 Artibot vNext “Autonomous Engineering Runtime”을 구현한다.

## 절대 원칙

- 기존 `/split` manual mode를 깨지 않는다.
- 현재 `plugins/artibot/commands/split.md`, `lib/git/split-dispatch.js`, `lib/observability/split-telemetry.js`, `scripts/hooks/pre-compact.js`, `hooks/dispatch-table.json`, `agents/orchestrator.md`, `artibot.config.json`을 먼저 읽는다.
- 완료의 진실원은 git/worktree/trailer/gate다. Agent 메시지를 완료의 정본으로 승격하지 않는다.
- 기존 split telemetry는 RECORD ONLY 의미를 보존한다. 판단은 신규 supervisor layer에 둔다.
- 기존 PreCompact summary logic을 재작성하지 않는다.
- permission bypass, auto prod deploy, destructive action 자동화는 금지한다.
- config는 backward-compatible additive만 허용한다.
- 새 engine을 markdown command에 길게 넣지 말고 `lib/`에 구현한다.

## 목표 아키텍처

Cross-session Supervisor → Session Orchestrator → Specialist Workers.

신규 핵심:
1. append-only run event vocabulary
2. deterministic state reducer
3. rebuildable run/lane state cache
4. observe-only Supervisor
5. PostCompact rehydrate
6. durable checkpoint
7. crash reconcile
8. auto-reversible recovery

## 구현 순서

`PR-SV01 → PR-SV02 → PR-CX01 → PR-CX02 → PR-DR01 → PR-DR02 → PR-DR03`

각 PR 전에:
- 현재 main 재측정
- 파일 ownership allowlist 정의
- 기존 테스트/방화벽 영향 조사
- acceptance criteria를 test로 먼저 고정

각 PR 후:
- targeted unit
- firewall
- type/lint
- relevant integration
- 전체 build 영향이 있으면 build
- “기록됨 ≠ 작동함” 항목 별도 보고

## Human-on-exception

자동 가능: read probe, retry, checkpoint, context recovery, test rerun.
사람 필요: owner decision, permission escalation, destructive action, production deploy, semantic merge conflict.

## 출력

각 PR은:
- 변경 파일
- 상태 전이
- 테스트
- 역주입/negative test
- 기존 동작 무회귀 증거
- 다음 PR dependency
- 미확인

을 반드시 포함한다.

한 번에 너무 넓게 구현하지 말고 `/split plan`을 이용해 ownership이 겹치지 않는 작업만 병렬화하라.
