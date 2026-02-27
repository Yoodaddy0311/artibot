---
description: (Artibot) Parallel team execution with cross-check — persistent team mode, leader delegates only, all teammates work independently on opus 4.6
argument-hint: '[task] e.g. "이 기능 구현하고 테스트도 작성해줘"'
allowed-tools: [Read, Glob, Grep, Bash, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
---

# /team

Parallel team execution with mandatory cross-check and **persistent team mode**. The leader (YOU) delegates work and receives results ONLY — never does the work yourself. All teammates run on opus 4.6 in parallel, then cross-check each other's output. By default, the team **persists** after task completion and awaits the next assignment. Use `--one-shot` to revert to single-task-then-shutdown behavior.

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

### Teammate Rules
- **ALL teammates use opus model** (model: "opus" or subagent_type with opus)
- **ALL work in parallel** (no blockedBy unless truly sequential dependency)
- **Each teammate works independently** on their assigned scope
- After main work: cross-check another teammate's output

### Token Conservation Rule (CRITICAL)
- **작업 완료 후 팀원을 임의로 셧다운하지 마라** — 재소환 시 토큰이 발생한다
- 다음 작업에서 해당 팀원의 전문성이 **확실히 불필요**할 때만 교체
- 애매하면 유지 — idle 상태 팀원은 토큰을 소비하지 않는다
- 셧다운 판단 기준: 다음 작업의 도메인이 완전히 달라져서 해당 전문성이 0% 필요할 때만

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

### Phase 4: CROSS-CHECK (Teammates)
After ALL main tasks complete, create cross-check tasks:

```
TaskCreate(
  subject="Cross-check: {teammate-A's work}",
  description="Review {teammate-A}'s output for correctness, completeness, and quality.
    Files modified: {list}
    Requirements: {original requirements for that unit}
    Verify: code works, tests pass, no regressions, follows project patterns"
)
```

**Cross-check assignment rule**: Teammate A checks Teammate B's work, B checks C's, C checks A's (circular).

Each cross-checker:
1. READ the files modified by the other teammate
2. Verify requirements are met
3. Run relevant tests if applicable
4. Report: APPROVE or REQUEST_CHANGES with specifics

### Phase 5: REPORT (Leader only)
Collect all results and cross-check findings, then report:

**작업 결과**

| 작업 | 담당 | 상태 | 크로스체크 |
|------|------|------|------------|
| {unit} | {teammate} | DONE/FAIL | APPROVED by {checker} |

**크로스체크 결과**

| 검토자 | 대상 | 결과 | 피드백 |
|--------|------|------|--------|
| {checker} | {teammate}'s work | APPROVE/CHANGES | {details} |

**수정된 파일**

| 파일 | 작업 | 담당 |
|------|------|------|
| {file path} | {created/modified} | {teammate} |

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
- Using sonnet/haiku for teammates (always opus)
- Single teammate for multi-domain work
- Cross-checker reviewing their own work
- **작업 완료 후 팀원을 임의로 셧다운** — 재소환 토큰 낭비 (idle 유지가 더 저렴)
- **"혹시 모르니까" 셧다운** — 애매하면 유지가 정답
