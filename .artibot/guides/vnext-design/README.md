# Artibot vNext — Autonomous Engineering Runtime Design Package

> 설계 기준: `Yoodaddy0311/artibot` master (2026-09-01 조사) + Ontology에서 실제 운용한 `/split` run 데이터
> 목적: `/split`을 “사람이 여러 터미널을 지휘하는 병렬 실행기”에서 “예외만 사람이 승인하는 자율 엔지니어링 런타임”으로 진화

## 한 줄 결론

현재 Artibot은 **병렬 실행 primitives는 이미 강하다.** 새로 필요한 것은 더 많은 agent가 아니라, 이들을 지속적으로 감시·복구·예산통제·컨텍스트관리하는 **Supervisor Control Plane**이다.

## 이 패키지의 핵심 원칙

1. **재작성 금지** — 기존 `/split`, worktree, git trailer, telemetry, agents, hooks를 그대로 활용한다.
2. **Human-on-exception** — 정상 진행은 자동, irreversible/owner/security 판단만 사람에게 올린다.
3. **Conversation ≠ State** — 대화 context가 아니라 durable run ledger가 업무 상태의 정본이다.
4. **Event first** — 현재 append-only NDJSON telemetry를 상태 복구의 기반으로 승격한다.
5. **Fail closed** — 권한, 배포, destructive action, 판단 불가능 상태는 자동 진행하지 않는다.
6. **Economics by design** — 모델/effort/token/time을 lane별 예산으로 관리한다.
7. **Backward compatible** — 최초 출하는 observe-only. 기존 `/split` 동작을 깨지 않는다.

## 파일 구성

- `00_EXECUTIVE_SUMMARY.md` — 의사결정용 요약
- `01_CURRENT_STATE_AUDIT.md` — 현재 Artibot 구현을 기준으로 한 갭 분석
- `02_TARGET_ARCHITECTURE.md` — 목표 아키텍처
- `03_SUPERVISOR_CONTROL_PLANE.md` — Supervisor 상세 설계
- `04_CONTEXT_LIFECYCLE.md` — compact/clear/session rotation 자동화
- `05_DURABLE_WORKFLOW.md` — 상태머신·checkpoint·resume·self-healing
- `06_ADAPTIVE_SCHEDULER.md` — 동적 병렬도·DAG·work stealing
- `07_COST_MODEL_ROUTER.md` — 모델/effort/토큰/시간 예산
- `08_OBSERVABILITY_KPI.md` — Split Efficiency Score 포함
- `09_SECURITY_GOVERNANCE.md` — 자동화 경계 및 승인 정책
- `10_ROADMAP.md` — 단계별 도입 순서
- `11_BENCHMARKS.md` — Claude Code / GitHub Copilot / Codex / Temporal / LangGraph 벤치마크
- `12_FILE_BY_FILE_PATCH_MAP.md` — 현재 repo 경로에 맞춘 구현 위치
- `implementation/PR_PLAN.md` — 실제 PR 단위 구현계획
- `implementation/ACCEPTANCE_CRITERIA.md` — 수락기준
- `implementation/VIBE_CODING_MASTER_PROMPT.md` — 바로 구현시킬 수 있는 마스터 프롬프트
- `contracts/*.json` — run/lane/event/checkpoint/budget 계약 초안
- `configs/artibot.config.vnext.example.json` — 제안 config
- `agents/*.md` — Supervisor / Recovery / Scheduler 역할 초안
- `diagrams/*.mmd` — Mermaid 아키텍처/상태머신/시퀀스
- `examples/*` — run state / event 예시

## 권장 도입 순서

**P1 Supervisor Observe → P2 Context Lifecycle → P3 Durable Resume → P4 Adaptive Scheduler → P5 Cost Router → P6 Background Workers/Control Center → P7 Staging/Live**

가장 먼저 체감되는 것은 P1+P2다. 사용자가 각 터미널을 순찰하고 `/compact`, `/clear`, “계속”, “다시 검수”를 반복하는 시간을 직접 줄인다.
