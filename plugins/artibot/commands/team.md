---
description: (Artibot) Parallel team execution with cross-check — persistent team mode, leader delegates only, implementation on opus 4.7 (xhigh effort 권장), review phases on sonnet 4.6
argument-hint: '[task] e.g. "이 기능 구현하고 테스트도 작성해줘"'
allowed-tools: [Read, Glob, Grep, Bash, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
toolset: team
---

# /team

Parallel team execution with mandatory cross-check and **persistent team mode**. The leader (YOU) delegates work and receives results ONLY — never does the work yourself. Implementation teammates (Phase 3) run on **opus 4.7** for maximum code quality. Review teammates (Phase 4 cross-check, Phase 4.5 inspection) run on **sonnet 4.6** for faster turnaround. By default, the team **persists** after task completion and awaits the next assignment. Use `--one-shot` to revert to single-task-then-shutdown behavior.

## Arguments

Parse $ARGUMENTS:
- `task-description`: What the team should accomplish
- `--agents [list]`: Override agent selection (comma-separated)
- `--skip-crosscheck`: Skip the cross-check phase (NOT recommended)
- `--dry-run`: Show team plan without executing
- `--persistent` / `--keep`: Keep team alive after task completion (DEFAULT — always on unless `--one-shot`)
- `--one-shot`: Disband team after single task completion (legacy behavior)
- `--shutdown`: Explicitly disband a persistent team

## Core Rules

### Leader Role (YOU)
- **ONLY delegate tasks and receive results**
- **NEVER do implementation work yourself**
- Decompose the request into independent work units
- Assign each unit to the best specialist
- Collect results and present to user
- You are the CTO — teammates are your engineers

### Teammate Rules & Model Policy
- **Implementation teammates (Phase 3)**: `model="opus"` — 코드 작성/구현은 최고 품질 필수
- **Review teammates (Phase 4, 4.5)**: `model="sonnet"` — 읽기+검증은 sonnet으로 충분, 속도 우선
- **ALL work in parallel** (no blockedBy unless truly sequential dependency)
- **Each teammate works independently** on their assigned scope
- After main work: cross-check another teammate's output (on sonnet)

### Token Conservation Rule (CRITICAL)
- **작업 완료 후 팀원을 임의로 셧다운하지 마라** — 재소환 시 토큰이 발생한다
- 다음 작업에서 해당 팀원의 전문성이 **확실히 불필요**할 때만 교체
- 애매하면 유지 — idle 상태 팀원은 토큰을 소비하지 않는다
- 셧다운 판단 기준: 다음 작업의 도메인이 완전히 달라져서 해당 전문성이 0% 필요할 때만

### Task Budget (Beta, Opus 4.7+) ⚗️ research preview — API 변경 가능
에이전트 루프 토큰 폭주 방지용 옵트인. 팀 전체 작업 예산을 모델에 권고한다.

```json
{
  "headers": { "anthropic-beta": "task-budgets-2026-03-13" },
  "output_config": { "task_budget": { "type": "tokens", "total": 128000 } }
}
```

| 상황 | 권장 task_budget |
|---|---|
| `/team` 구현 phase | 128,000 |
| `/team` 리뷰 phase | 40,000 |
| 짧은 배치 | 20,000 (최소) |
| 개방형 탐색 | 설정하지 말 것 |

주의: 하드 캡 아님. `max_tokens`(요청별 상한)와 역할이 다름.

## Execution Flow

### Phase 1: DECOMPOSE (Leader only)
Break the user's request into independent work units:
```
요청 분해:
1. [work unit A] → assigned to [agent-type]
2. [work unit B] → assigned to [agent-type]
3. [work unit C] → assigned to [agent-type]
```
- Identify natural boundaries (by file, by domain, by concern)
- Each unit should be independently completable
- Choose the best specialist agent for each unit

### Auto-Effort Pre-injection (4.7 Agentic)

Before spawning teammates, `scripts/hooks/runtime-prompt.js` has already written:
- `runtime/current-effort.json` — 현재 커맨드의 effort level (xhigh/high/medium/low)
- `runtime/current-task-budget.json` — 해당 effort에 매핑된 max_tokens budget

The orchestrator MUST:
1. Phase 1 시작 직후 두 파일을 Read (없으면 effort=xhigh, budget=128000 기본값 적용)
2. 각 팀원의 초기 프롬프트 맨 앞에 아래 디렉티브를 포함:
   ```
   [artibot:effort level={effort} command=team][artibot:task-budget max_tokens={budget}]

   {원래 teammate prompt}
   ```
3. **Lower-only override allowed mid-team** — 예: Phase 4 review 팀원은 `high` 또는 `medium`로 하향 가능
4. **Up-escalate requires user approval** — 팀원이 기본값보다 더 높은 effort/budget를 요청하면 유저 확인 필요
5. `lib/runtime/middleware/tasks.js`는 위 파일을 자동 Read해 `task.meta.effort`, `task.meta.taskBudget`을 채워주므로, TaskCreate 시 meta를 그대로 넘기면 된다

### Phase 2: TEAM SETUP (Leader only)
```
TeamCreate(
  team_name="team-{task-slug}",
  description="Parallel: {task description}"
)
```

Spawn ALL teammates in a single message (parallel):
```
Task(subagent_type="artibot:{agent-type}", team_name="team-*", name="{role}", model="opus",
     prompt="[DEV Protocol 준수]\n\n작업:\n{specific work unit}\n\n완료 후 결과를 리더에게 보고해주세요.")
```

### Phase 3: PARALLEL EXECUTION (Teammates)
- Create tasks with NO blockedBy (all parallel):
```
TaskCreate(subject="{work unit}", description="{scope, files, success criteria}")
```
- Assign each task to appropriate teammate:
```
TaskUpdate(taskId="{id}", owner="{teammate-name}", status="in_progress")
```
- Teammates work independently
- Leader monitors via TaskList but does NOT intervene unless blocked

### Phase 4: CROSS-CHECK (Sonnet 4.6)
After ALL main tasks complete, spawn cross-check agents on **sonnet** for fast review:

```
Task(subagent_type="code-reviewer", team_name="team-*", name="checker-{n}", model="sonnet",
     prompt="[Cross-check Mode]\n\n{teammate-A}의 작업물을 검증해주세요.
     변경 파일: {list}\n요구사항: {original requirements}\n
     코드 동작, 테스트 통과, 리그레션 없음, 프로젝트 패턴 준수 여부 확인 후 APPROVE 또는 REQUEST_CHANGES 보고.")
```

**Cross-check assignment rule**: Teammate A checks Teammate B's work, B checks C's, C checks A's (circular).

Each cross-checker:
1. READ the files modified by the other teammate
2. Verify requirements are met
3. Run relevant tests if applicable
4. Report: APPROVE or REQUEST_CHANGES with specifics

### Phase 4.5: INSPECTION (Sonnet 4.6)
Cross-check 완료 후, **code-reviewer 에이전트(sonnet)가 전체 작업물을 최종 검수**한다.

팀에 code-reviewer가 없으면 이 단계에서 소환:
```
Task(subagent_type="artibot:code-reviewer", team_name="team-*", name="inspector", model="sonnet",
     prompt="[Inspection Mode 활성화]\n\n원본 요청: {original user request}\n\n
각 팀원의 작업물을 검수해주세요:
1. {teammate-1}: {작업 내용} — 변경 파일: {files}
2. {teammate-2}: {작업 내용} — 변경 파일: {files}

검수 체크리스트 5개 항목 전부 확인 후 INSPECTION REPORT 제출.")
```

**검수 체크리스트 (5개 항목 — 하나도 건너뛰지 마라):**

| # | 항목 | 검증 내용 |
|---|------|----------|
| 1 | 요청 일치 | 원본 요청 vs 실제 변경 1:1 대조 |
| 2 | 범위 준수 | 요청 범위 밖 파일 변경 없는지 |
| 3 | 무결성 | 기존 기능 파손 없는지 (테스트 통과) |
| 4 | 품질 | 프로젝트 패턴/컨벤션 준수 |
| 5 | 부작용 | 불필요한 추가/변경 없는지 |

**판정:**
- **APPROVE** → Phase 5 진행
- **REQUEST_CHANGES** → 해당 팀원에게 수정 지시 후 재검수
- **REJECT** → 리더가 유저에게 보고, 재작업 또는 방향 전환

### Phase 5: REPORT (Leader only)
Collect all results, cross-check findings, and **inspection report**, then report:

**작업 결과**

| 작업 | 담당 | 상태 | 크로스체크 |
|------|------|------|------------|
| {unit} | {teammate} | DONE/FAIL | APPROVED by {checker} |

**크로스체크 결과**

| 검토자 | 대상 | 결과 | 피드백 |
|--------|------|------|--------|
| {checker} | {teammate}'s work | APPROVE/CHANGES | {details} |

**검수 결과 (Inspection)**

| 대상 | 요청일치 | 범위준수 | 무결성 | 품질 | 부작용 | 판정 |
|------|:-------:|:-------:|:-----:|:----:|:-----:|------|
| {teammate-1} | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | APPROVE/CHANGES |

**수정된 파일**

| 파일 | 작업 | 담당 |
|------|------|------|
| {file path} | {created/modified} | {teammate} |

### Phase 5.5: FOLLOW-UP (Leader only)
Phase 5 리포트를 유저에게 보여준 직후, `AskUserQuestion` 도구를 사용해 인터랙티브 후속 액션을 제안한다.

> `--one-shot` 모드에서는 Phase 5.5를 **스킵**하고 바로 Phase 6 SHUTDOWN으로 진행한다.

**AskUserQuestion 호출:**
```
AskUserQuestion(
  question="작업이 완료되었습니다. 다음 단계를 선택해주세요.",
  options=[
    "관련 작업 이어서 (Recommended) — 방금 작업과 관련된 추가 구현/테스트/개선을 이어서 진행",
    "커밋 & 푸시 — 변경사항을 커밋하고 원격에 푸시 (버전 업데이트 포함)",
    "메모리 & 문서화 — 작업 내용을 메모리에 저장하고 문서를 업데이트",
    "새로운 작업 — 현재 작업과 무관한 새 작업을 팀에 배정"
  ]
)
```

**터미널에 표시되는 형태:**
```
? 작업이 완료되었습니다. 다음 단계를 선택해주세요.
  1. 관련 작업 이어서 (Recommended) — 방금 작업과 관련된 추가 구현/테스트/개선을 이어서 진행
  2. 커밋 & 푸시 — 변경사항을 커밋하고 원격에 푸시 (버전 업데이트 포함)
  3. 메모리 & 문서화 — 작업 내용을 메모리에 저장하고 문서를 업데이트
  4. 새로운 작업 — 현재 작업과 무관한 새 작업을 팀에 배정
  Chat about this
```

**유저 선택에 따른 동작:**

| # | 선택 | 동작 |
|---|------|------|
| 1 | **관련 작업 이어서** | 리더가 방금 완료한 작업 컨텍스트를 기반으로 관련 후속 작업을 추천 → 유저 확인 후 Phase 1 DECOMPOSE로 돌아감 (팀원 재활용) |
| 2 | **커밋 & 푸시** | 리더가 git 워크플로우 수행: stage → commit → push (버전 업데이트 포함) → 완료 후 persistent mode 대기 |
| 3 | **메모리 & 문서화** | 작업 내용을 MEMORY.md에 저장하고 관련 문서(README 등) 업데이트 → 완료 후 persistent mode 대기 |
| 4 | **새로운 작업** | Phase 1 DECOMPOSE로 돌아감 (팀원 재활용, 새 컨텍스트) |

**Persistent mode (default):** After reporting, do NOT shutdown. Display:
```
---
✅ 작업 완료 — 팀 대기 중

현재 팀원:
- {teammate-1} ({agent-type}) — 대기
- {teammate-2} ({agent-type}) — 대기
- {teammate-3} ({agent-type}) — 대기

다음 작업을 지시하세요.
팀 해체: "해체", "종료", "shutdown", 또는 --shutdown
---
```
Then wait for the user's next instruction. When a new task arrives, go back to **Phase 1: DECOMPOSE** with the existing team (see [Persistent Team Mode](#persistent-team-mode) below).

**One-shot mode** (`--one-shot`): Proceed directly to Phase 6 SHUTDOWN after reporting.

### Phase 6: SHUTDOWN (On Request Only)
```
SendMessage(type="shutdown_request", recipient="{teammate}")
```
- Shutdown all teammates after explicit user request
- TeamDelete to clean up
- Triggered by: user says "해체", "종료", "shutdown", or passes `--shutdown` flag
- In `--one-shot` mode: triggered automatically after Phase 5

## Agent Selection Guide

| Domain | Agent Type | Use When |
|--------|-----------|----------|
| Planning | artibot:planner | Feature breakdown, architecture planning |
| Frontend | artibot:frontend-developer | UI components, styling, accessibility |
| Backend | artibot:backend-developer | API, server logic, database |
| Testing | artibot:tdd-guide | Unit tests, integration tests |
| E2E | artibot:e2e-runner | End-to-end test scenarios |
| Review | artibot:code-reviewer | Code quality, patterns |
| Security | artibot:security-reviewer | Security audit, vulnerabilities |
| Database | artibot:database-reviewer | Schema, queries, migrations |
| TypeScript | artibot:typescript-pro | Type system, generics |
| Refactor | artibot:refactor-cleaner | Dead code, cleanup |
| Build | artibot:build-error-resolver | Build/compile errors |
| Docs | artibot:doc-updater | Documentation updates |
| Performance | artibot:performance-engineer | Profiling, optimization |
| DevOps | artibot:devops-engineer | CI/CD, Docker, infra |

## Persistent Team Mode

By default, `/team` operates in **persistent mode** — the team stays alive after completing a task and waits for the next assignment. This avoids the overhead of spinning up new teammates for every task.

### Keeping the Team Alive
- Persistent mode is the **default** behavior. No flag needed.
- Explicitly: `--persistent` or `--keep` (same effect, for clarity)
- After Phase 5 REPORT, the leader displays the waiting prompt and the team remains active.

### Assigning a New Task
When the user gives a new task to a persistent team:

1. **Leader re-enters Phase 1: DECOMPOSE** with the new task
2. **기존 팀원 우선 재활용** — 전문성이 조금이라도 겹치면 유지하고 새 작업 배정
3. **신규 팀원은 기존 팀에 없는 전문성이 필요할 때만** 추가:
   ```
   Task(subagent_type="artibot:{new-agent-type}", team_name="team-*", name="{role}", model="opus",
        prompt="[DEV Protocol 준수]\n\n작업:\n{new work unit}\n\n완료 후 결과를 리더에게 보고해주세요.")
   ```
4. **팀원 교체는 다음 작업 배정 시에만** — 현재 작업 완료 후 임의 셧다운 금지 (Token Conservation Rule)
5. Proceed through Phase 3 → 4 → 5 as normal

### Releasing Specific Teammates
**다음 작업의 도메인이 완전히 달라져서 해당 전문성이 0% 필요할 때만** 해제:
```
SendMessage(type="shutdown_request", recipient="{teammate-to-release}")
```
- **업무 완료만으로는 셧다운 사유가 안 됨** — 재소환 비용(토큰) > idle 유지 비용
- 애매하면 유지 — 다음 작업에서 다시 활용 가능
- 해제 시 팀에 공지:
  ```
  ℹ️ {teammate} ({agent-type}) 해제됨 — 다음 작업에 해당 전문성 불필요
  ```

### Disbanding the Team
The team is disbanded ONLY when the user explicitly requests it:
- Korean: "해체", "종료"
- English: "shutdown"
- Flag: `--shutdown`

Upon disbanding, execute full Phase 6 SHUTDOWN — send shutdown to all remaining teammates and call TeamDelete.

### Reverting to Single-Task Mode
Use `--one-shot` to disable persistent mode for a single invocation:
```
/team --one-shot "이 버그 수정해줘"
```
This runs the original flow: Phase 1 through 6, with automatic shutdown after reporting.

## Anti-Patterns

- Leader doing implementation work directly
- Sequential execution when parallel is possible
- Skipping cross-check phase
- Using sonnet/haiku for **implementation** teammates (Phase 3 must be opus)
- Using opus for review-only phases (Phase 4/4.5 — sonnet is faster and sufficient)
- Single teammate for multi-domain work
- Cross-checker reviewing their own work
- **작업 완료 후 팀원을 임의로 셧다운** — 재소환 토큰 낭비 (idle 유지가 더 저렴)
- **"혹시 모르니까" 셧다운** — 애매하면 유지가 정답

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 팀 작업 커밋 | `/git` | 팀 작업 결과 커밋 및 푸시 |
| 2 | 작업 리포트 | `/daily` | 팀 작업 일일 회고 리포트 |
| 3 | 결과 검증 | `/verify` | 팀 작업 결과 전체 검증 |
