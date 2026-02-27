---
description: Parallel team execution with cross-check — leader delegates only, all teammates work independently on opus 4.6
argument-hint: '[task] e.g. "이 기능 구현하고 테스트도 작성해줘"'
allowed-tools: [Read, Glob, Grep, Bash, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
---

# /team

Parallel team execution with mandatory cross-check. The leader (YOU) delegates work and receives results ONLY — never does the work yourself. All teammates run on opus 4.6 in parallel, then cross-check each other's output.

## Arguments

Parse $ARGUMENTS:
- `task-description`: What the team should accomplish
- `--agents [list]`: Override agent selection (comma-separated)
- `--skip-crosscheck`: Skip the cross-check phase (NOT recommended)
- `--dry-run`: Show team plan without executing

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

### Phase 6: SHUTDOWN (Leader only)
```
SendMessage(type="shutdown_request", recipient="{teammate}")
```
- Shutdown all teammates after reporting
- TeamDelete to clean up

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

## Anti-Patterns

- Leader doing implementation work directly
- Sequential execution when parallel is possible
- Skipping cross-check phase
- Using sonnet/haiku for teammates (always opus)
- Single teammate for multi-domain work
- Cross-checker reviewing their own work
