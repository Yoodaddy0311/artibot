# 11. Benchmark Notes — 공식 문서에서 가져올 것

> 2026-09-01 기준 확인. 벤치마크는 복제 대상이 아니라 설계 원리 참고용이다.

## 1. Claude Code — Hooks

Official:
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide

참고 요소:
- PreCompact / PostCompact
- SessionEnd reason (`clear`, `resume` 등)
- SubagentStart / SubagentStop
- TeammateIdle / TaskCompleted
- WorktreeCreate / WorktreeRemove
- command/http/mcp_tool/prompt/agent hook type

Artibot 적용:
- 기존 PreCompact를 PostCompact rehydrate와 닫힌 loop로 연결
- session/worktree mapping을 이름 휴리스틱 대신 hook event ledger로 보강
- `TeammateIdle`을 lane scheduler trigger로 활용 가능

## 2. Claude Code — Agents / Worktrees / Agent View

Official:
- https://code.claude.com/docs/en/agents
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/worktrees
- https://code.claude.com/docs/en/sub-agents

참고 요소:
- background sessions
- `claude agents`, attach/logs/stop
- isolated worktrees
- subagent `background`, `effort`, `maxTurns`, `memory`, `isolation: worktree`

Artibot 적용:
- P6 `WorkerProviderPort`의 Claude 구현
- terminal N개 수동 open을 opt-in background worker로 단계적 대체
- effort/maxTurns를 budget router input으로 활용

## 3. GitHub Copilot SDK — Custom Agents / Subagent Orchestration

Official:
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents

참고 요소:
- agent마다 별도 context
- parent가 lifecycle event 수신
- parallel subagent delegation
- tool scope 분리

Artibot 적용:
- Supervisor와 Worker context의 강한 분리
- runtime event tree UI
- agent 역할을 prompt가 아니라 typed capability로도 관리

## 4. OpenAI Codex — Multi-agent Command Center

Official:
- https://openai.com/index/introducing-the-codex-app/
- https://openai.com/codex/

참고 요소:
- multiple agents in parallel
- built-in worktrees
- background/long-running tasks
- command-center UX

Artibot 적용:
- “터미널 4개” UI가 아니라 run/lane 중심 Control Center
- WorkerProviderPort를 만들어 향후 Claude 외 Codex worker도 붙일 수 있게 설계

## 5. Temporal + LangGraph — Durable Execution

Official:
- https://docs.temporal.io/
- https://docs.langchain.com/oss/python/langgraph/persistence

참고 요소:
- workflow crash 이후 정확히 resume
- checkpoint
- human interrupt/approval
- successful parallel node 결과 보존
- failed node만 retry

Artibot 적용:
- v5는 lightweight local event sourcing으로 구현
- multi-machine / daemon 요구가 커지면 RunStorePort를 Temporal/DB 구현으로 교체
- 같은 wave에서 성공 lane 재실행 금지

## 벤치마크를 그대로 가져오지 않을 것

- 외부 SaaS가 필수인 구조
- permission bypass를 전제로 한 headless 실행
- 중앙 DB 없이도 되는 단계에서 무거운 infra 선도입
- LLM이 durable state의 정본이 되는 구조
