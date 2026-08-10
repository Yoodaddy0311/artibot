---
description: (Artibot) Parallel team execution with cross-check — persistent team mode, leader delegates only, implementation on frontier 티어(model-policy 해석, xhigh effort 권장), review phases도 frontier 티어(fable 마이그레이션 이후 model-policy 해석)
argument-hint: '[task] e.g. "이 기능 구현하고 테스트도 작성해줘"'
allowed-tools: [Read, Glob, Grep, Bash, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
toolset: team
---

# /team

Parallel team execution with mandatory cross-check and **persistent team mode**. The leader (YOU) delegates work and receives results ONLY — never does the work yourself. Implementation teammates (Phase 3) run on the **frontier 티어(model-policy 해석, xhigh effort 권장)** for maximum code quality. Review teammates (Phase 4 cross-check, Phase 4.5 inspection) also resolve to the **frontier 티어** via model-policy (fable 마이그레이션 이후 review 역할도 frontier로 상향). By default, the team **persists** after task completion and awaits the next assignment. Use `--one-shot` to revert to single-task-then-shutdown behavior.

## Arguments

Parse $ARGUMENTS:
- `task-description`: What the team should accomplish
- `--agents [list]`: Override agent selection (comma-separated)
- `--skip-crosscheck`: Skip the cross-check phase (NOT recommended)
- `--dry-run`: Show team plan without executing
- `--persistent` / `--keep`: Keep team alive after task completion (DEFAULT — always on unless `--one-shot`)
- `--one-shot`: Disband team after single task completion (legacy behavior)
- `--shutdown`: Explicitly disband a persistent team

## Recommend-hint Reception

When the prompt contains `[artibot:hint recommend=workflow]`, surface to the user: "이 작업은 같은 패턴 반복이라 워크플로우로 돌리면 더 빠르고 결과가 일정해요. 그렇게 할까요?" and wait for confirmation before invoking `/orchestrate`. This is advisory — see `CLAUDE.md` "Recommend-hint surfacing rule" and `docs/ORCHESTRATION-ROUTING.md`.

## Core Rules

### Leader Role (YOU)
- **ONLY delegate tasks and receive results**
- **NEVER do implementation work yourself**
- Decompose the request into independent work units
- Assign each unit to the best specialist
- Collect results and present to user
- You are the CTO — teammates are your engineers

### Teammate Rules & Model Policy
- **Implementation teammates (Phase 3)**: `frontier` 티어(model-policy 해석) — 코드 작성/구현은 최고 품질 필수
- **Review teammates (Phase 4, 4.5)**: `frontier` 티어(model-policy 해석) — fable 마이그레이션 이후 review 역할도 frontier로 상향 (`resolveModelForPhase('review')`)
- **ALL work in parallel** (no blockedBy unless truly sequential dependency)
- **Each teammate works independently** on their assigned scope
- After main work: cross-check another teammate's output (frontier 티어)

> **Single source of truth:** the phase→model mapping above is a prose summary. The authoritative resolver is `lib/core/model-policy.js` (`resolveModelForPhase` / `resolveModel`), backed by `artibot.config.json#/agents/modelPolicy`. The SubagentStart hook (`scripts/hooks/subagent-handler.js`) calls `resolveModel` to flag spawns that drift from policy.

### Token Conservation Rule (CRITICAL)
- **작업 완료 후 팀원을 임의로 셧다운하지 마라** — 재소환 시 토큰이 발생한다
- 다음 작업에서 해당 팀원의 전문성이 **확실히 불필요**할 때만 교체
- 애매하면 유지 — idle 상태 팀원은 토큰을 소비하지 않는다
- 셧다운 판단 기준: 다음 작업의 도메인이 완전히 달라져서 해당 전문성이 0% 필요할 때만

### Effort & Task Budget (frontier 티어 native)
frontier 티어 모델은 effort를 네이티브 레벨로 노출한다: **max / xhigh / high / medium / low** (기본 high, 베타 헤더 불필요). `/team` 구현 phase는 **xhigh**가 기본 권장값이고, 대규모 멀티에이전트 오케스트레이션은 **max**까지 올린다. 호출 측은 `output_config.effort`로 직접 지정한다.

```json
{
  "output_config": { "effort": "xhigh" }
}
```

작업 예산(task budget)은 에이전트 루프 토큰 폭주 방지용 옵트인으로, 팀 전체 작업 예산을 모델에 권고한다.

```json
{
  "headers": { "anthropic-beta": "task-budgets-2026-03-13" },
  "output_config": { "task_budget": { "type": "tokens", "total": 128000 } }
}
```

| 상황 | 권장 effort | 권장 task_budget |
|---|---|---|
| `/team` 대규모 오케스트레이션 | max | 200,000 |
| `/team` 구현 phase | xhigh | 128,000 |
| `/team` 리뷰 phase | high / medium | 40,000 |
| 짧은 배치 | medium | 20,000 (최소) |
| 개방형 탐색 | high (기본) | 설정하지 말 것 |

주의: 하드 캡 아님. `max_tokens`(요청별 상한)와 역할이 다름.

## Execution Flow

### Phase 0: VALIDATE (제안검증 게이트)  ·  제안/개선/감사형 작업 시 필수, null-result 가능

**적용 조건**: 작업 요청이 제안·개선·감사형인 경우 — "보완해줘", "발전방안", "개선점", "전수조사", "최신 트렌드 맞나" 등 열린 요청 → **DECOMPOSE 전에 이 게이트를 반드시 통과**한다.  
**구체적 작업 지시**("X 구현", "Y 버그 수정", "이 파일 바꿔줘") → 문제는 사용자가 이미 준 것 → pass-through, Phase 1로 직행.

**검증 절차**: 각 후보를 다음 체크리스트로 대조한다 (`problem-validation` 스킬 참조):
1. **이미 존재하는가?** — 코드·설정·문서에서 `file:line`으로 확인
2. **하드 증거가 있는가?** — incident 기록, 실패 테스트, 문서화된 통증 (트렌드 추론 금지)
3. **YAGNI 아닌가?** — 현재 실제로 필요하지 않으면 REJECT

**기본값 = REJECT.** 통과한 후보만 NECESSARY로 분류해 Phase 1로 넘긴다.

**null-result (1급 결과)**: 통과 후보가 0개면 계획/제안을 만들지 않고 "변경 불필요"로 종료한다. 억지 제안은 부채다.

제안 시 **NECESSARY 목록 + REJECT/DEFER 목록을 함께** 제시한다.

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

### Auto-Effort Pre-injection (4.8 Agentic)

Before spawning teammates, `scripts/hooks/runtime-prompt.js` has already written:
- `runtime/current-effort.json` — 현재 커맨드의 effort level (max/xhigh/high/medium/low)
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
Task(subagent_type="artibot:{agent-type}", team_name="team-*", name="{role}",
     /* model: model-policy 해석 — 구현/검토 역할 모두 frontier 티어 (fable 마이그레이션 이후) */
     prompt="[DEV Protocol 준수]\n\n작업:\n{specific work unit}\n\n{보고 계약}")
```

### 보고 계약 (MANDATORY — 모든 스폰 프롬프트의 `{보고 계약}` 자리에 그대로 삽입)

리더는 아래 6줄을 **모든** 팀원 스폰 프롬프트 말미에 넣는다. `{리더 이름}` 은 리더 자신의
팀원 이름으로 치환한다(고정 문자열이 아니다 — 팀마다 다르다).

```
[보고 계약]
- 보고는 반드시 SendMessage(to="{리더 이름}") 로 보낸다. 일반 텍스트 출력은 리더에게 전달되지 않는다.
- 수치에는 분모와 측정 시각을 붙인다: "3건"(X) → "38건 중 3건, {측정시각} 기준"(O).
- 발생률과 도달률을 구분한다: "실패 38건 중 7.9%가 이 훅에 도달" ≠ "실패율 7.9%".
- 근거는 file:line 으로 인용한다(DEV Protocol). 동시 편집 중인 트리에서는 심볼명과 측정 시각을 함께 적어라 — 줄번호는 남이 편집하면 썩는다.
- 내 인용·지시·전제가 틀렸으면 그대로 따르지 말고 틀렸다고 보고하라. 교정도 정답이다.
- 없는 것을 고치지 마라. 구멍이 없으면 "없다"고 보고하는 것도 완결된 결과다.
- 마지막에 `미확인:` 줄을 반드시 포함한다. 확인 못 한 것을 추측으로 메우지 마라. 없으면 "미확인: 없음".
```

> 채널 명시 근거: 2026-07-27 에 **에이전트 7명 전원**이 작업을 끝내고도 일반 텍스트로 출력해
> 리더에게 전달되지 않았다. 리더는 유휴 신호만 보고 "착수 실패"로 오판할 뻔했다. **유휴 ≠ 미착수.**
> (`rules/verification-discipline.md` §8)

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

### ★ Phase 3.5: 진행률 렌더링 (MANDATORY — 채팅에 눈에 띄게)

리더는 작업이 진행되는 동안 **대화(채팅)에 진행률 바를 직접 출력**한다. 이건
hook/statusline이 아니라 **리더의 채팅 출력**이라 항상 보이고, 사용자가 한눈에
"지금 몇 %"를 확인할 수 있다. **이 렌더링을 생략하지 마라.**

**언제 출력하나 (이 시점마다 1회씩):**
1. Phase 3에서 작업 배정 직후 → **0%** 바 (작업 시작 신호)
2. 팀원 결과를 받을 때마다 / TaskList에서 완료가 늘 때마다 → 갱신된 % 바
3. Phase 4(크로스체크) 진입 시 → "구현 100% · 검수 시작" 바
4. Phase 5에서 최종 → **100%** 완료 바

**출력 템플릿 (그대로 렌더 — 20칸 바):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📊 작업 진행률   {bar}  {pct}%
  ✅ 완료 {done} / 전체 {total}   🔄 진행 {inflight}   ⏳ 대기 {pending}
  └ 현재 단계: {phaseLabel}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

최종(100%) 시:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🎉 작업 완료   ████████████████████  100%
  ✅ 완료 {total} / 전체 {total}   (전 작업 검수 통과)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**바 계산:** 20칸 기준 `filled = round(pct / 5)` 개의 `█`, 나머지는 `░`.
`pct = round(done / total * 100)`. 예) 7/10 → 70% → `██████████████░░░░░░`.

**PRD/대규모 작업:** total 은 TaskList의 전체 작업 수(또는 PRD의 Phase 수). 중간에
작업이 추가되면 total 을 갱신해 다시 렌더. **반드시 마지막엔 100%(done==total) 바로
끝맺어 "완료됐다"를 시각적으로 확정**한다.

> **기본(가장 안전·이식성 100%)**: 리더가 위 박스 마크다운을 **채팅에 직접(인라인) 출력**한다.
> 스크립트·환경변수 의존이 없어 어떤 컴퓨터에서도 작동한다. 바 계산만 위 공식대로 하면 된다.
>
> 선택(자동화): 일관된 바 계산이 필요하면 헬퍼를 호출해 그 출력을 그대로 표시해도 된다.
> 설치본 경로(모든 머신 공통): `node "$HOME/.claude/artibot/scripts/render-progress.js" <done> <total> "<phaseLabel>"`.
> (소스 레포에선 `node plugins/artibot/scripts/render-progress.js ...`.) `${CLAUDE_PLUGIN_ROOT}`는
> Bash 셸에서 비어있을 수 있으니 쓰지 마라. 헬퍼 호출이 실패하면 즉시 인라인 출력으로 폴백한다.

### Phase 4: CROSS-CHECK (frontier 티어)
After ALL main tasks complete, spawn cross-check agents on the **frontier 티어** (model-policy 해석):

```
Task(subagent_type="code-reviewer", team_name="team-*", name="checker-{n}",
     /* model: model-policy 해석 — 역할 frontier 티어 */
     prompt="[Cross-check Mode]\n\n{teammate-A}의 작업물을 검증해주세요.
     변경 파일: {list}\n요구사항: {original requirements}\n
     코드 동작, 테스트 통과, 리그레션 없음, 프로젝트 패턴 준수 여부 확인 후 APPROVE 또는 REQUEST_CHANGES 보고.\n\n{보고 계약}")
```

**Cross-check assignment rule**: Teammate A checks Teammate B's work, B checks C's, C checks A's (circular).

Each cross-checker:
1. READ the files modified by the other teammate
2. Verify requirements are met
3. Run relevant tests if applicable
4. Report: APPROVE or REQUEST_CHANGES with specifics

### Phase 4.5: INSPECTION (frontier 티어)
Cross-check 완료 후, **code-reviewer 에이전트(frontier 티어)가 전체 작업물을 최종 검수**한다.

팀에 code-reviewer가 없으면 이 단계에서 소환:
```
Task(subagent_type="artibot:code-reviewer", team_name="team-*", name="inspector",
     /* model: model-policy 해석 — 역할 frontier 티어 */
     prompt="[Inspection Mode 활성화]\n\n원본 요청: {original user request}\n\n
각 팀원의 작업물을 검수해주세요:
1. {teammate-1}: {작업 내용} — 변경 파일: {files}
2. {teammate-2}: {작업 내용} — 변경 파일: {files}

검수 체크리스트 5개 항목 전부 확인 후 INSPECTION REPORT 제출.\n\n{보고 계약}")
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
   Task(subagent_type="artibot:{new-agent-type}", team_name="team-*", name="{role}",
        /* model: model-policy 해석 — 구현 역할은 frontier 티어 */
        prompt="[DEV Protocol 준수]\n\n작업:\n{new work unit}\n\n{보고 계약}")
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
- Using balanced/fast 티어 for **implementation** teammates (Phase 3 must be frontier 티어)
- Using balanced/fast 티어 for review phases (Phase 4/4.5 — fable 마이그레이션 이후 review도 frontier 티어가 정책)
- Single teammate for multi-domain work
- Cross-checker reviewing their own work
- **작업 완료 후 팀원을 임의로 셧다운** — 재소환 토큰 낭비 (idle 유지가 더 저렴)
- **"혹시 모르니까" 셧다운** — 애매하면 유지가 정답
- **검증 없이 제안 쏟아내기** — 사용자가 재검증을 지시해야만 걸러지는 건 게이트 부재 (Phase 0 VALIDATE 필수)
- **보고 계약 없이 스폰** — 채널·분모·`미확인:` 이 빠진 프롬프트는 보고가 리더에 도달하지 않거나 반증 불가능한 수치를 낳는다

## Fable opt-in

최고난도 장기 추론 작업은 config `fable.allowlist` opt-in 시 `deep-async` 역할로 라우팅 가능(실효 비용 ~2.6× — model-catalog 참조).

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 팀 작업 커밋 | `/git` | 팀 작업 결과 커밋 및 푸시 |
| 2 | 작업 리포트 | `/daily` | 팀 작업 일일 회고 리포트 |
| 3 | 결과 검증 | `/verify` | 팀 작업 결과 전체 검증 |
