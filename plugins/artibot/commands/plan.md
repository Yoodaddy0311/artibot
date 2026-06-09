---
description: (Artibot) Implementation plan creation with risk identification and phase decomposition
argument-hint: '[task] e.g. "결제 시스템 구현 계획"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
toolset: team
lifecycle: plan
---

# /plan

Create structured implementation plans using the planner agent. Decomposes complex work into phases with dependency tracking and risk assessment.

> **/plan vs /ultraplan vs deep-research — 헷갈리지 않기**
> - **/plan** (여기) — 빠른 구현 설계. 단일 planner가 단계·의존성·리스크를 분해. 범위가 명확할 때.
> - **/ultraplan** — 상위 등급. 근거수집(deep-research) + 다관점 의회 + 적대적 검증 + 실행 핸드오프. 위험·비용·장기부채 큰 결정, 마이그레이션, 아키텍처 변경에.
> - **deep-research 스킬** — "무엇이 진실인가"(사실 조사) 자체가 목적일 때. 구현 계획이 아니라 조사. (`/ultraplan`이 1단계로 내부 호출)
> 정리: **계획=/plan, 철저한 계획=/ultraplan, 조사=deep-research.**

## Arguments

Parse $ARGUMENTS:
- `feature-or-task`: Description of what needs to be implemented or changed
- `--depth [level]`: `shallow` (high-level phases) | `deep` (detailed task breakdown)
- `--scope [level]`: `file` | `module` | `project` | `system`
- `--risks`: Emphasize risk identification and mitigation strategies

## Execution Flow

1. **Parse**: Extract requirements from description. Identify scope and complexity
2. **Context**: Scan codebase for:
   - Existing patterns and conventions
   - Related files and modules that will be affected
   - Current test coverage in target areas
   - Dependency graph of affected components
3. **Delegate**: Route to Task(planner) with gathered context for:
   - Phase decomposition (3-7 phases typical)
   - Task breakdown within each phase
   - Dependency ordering between tasks
   - Risk identification per phase
4. **Validate**: Check plan for:
   - Circular dependencies between phases
   - Missing test phases
   - Unreferenced files in the codebase
5. **Report**: Output structured plan with TaskCreate integration

## Plan Structure

Each phase contains:
- **Objective**: What this phase achieves
- **Tasks**: Atomic work items (create/modify/delete files)
- **Dependencies**: Which phases must complete first
- **Risks**: What could go wrong + mitigation
- **Verification**: How to confirm phase completion

## Output Format

```
IMPLEMENTATION PLAN
===================
Feature:    [description]
Complexity: [simple|moderate|complex]
Phases:     [count]
Est. Files: [create: n, modify: n]

PHASE 1: [name]
  Objective: [what]
  Tasks:
    [ ] [task description] -> [file path]
    [ ] [task description] -> [file path]
  Depends on: [none|phase N]
  Risk: [description] | Mitigation: [strategy]
  Verify: [how to confirm completion]

PHASE 2: [name]
  ...

RISKS
-----
[severity] [description] -> [mitigation]
```

## Plan Tracker Integration

플랜 생성 후 `PlanTracker` (`lib/core/plan-tracker.js`)를 활용하여 진행 상태를 추적한다.

**1. 플랜 파싱 — 태스크 목록 추출**
```js
import { PlanTracker } from './lib/core/plan-tracker.js';

const tracker = new PlanTracker();
const tasks = tracker.parsePlan(planMarkdown);
// [{ text: 'Set up project structure', completed: false }, ...]
```

**2. 진행률 확인**
```js
const { total, completed, percentage } = tracker.getProgress();
// { total: 12, completed: 5, percentage: 42 }
```

**3. 태스크 완료 마킹 (불변 — 새 마크다운 반환)**
```js
const updatedMarkdown = tracker.markCompleted(taskIndex);
// 원본 planMarkdown은 변경되지 않음
```

**4. 세션 간 상태 지속 (`.plan-state.json`)**
```js
// 세션 시작 시
tracker.addSession('session-abc');

// 작업 완료 후 상태 저장
const state = tracker.toState('/path/to/plan.md');
await writeJsonFile('/path/to/.plan-state.json', state);

// 다음 세션에서 복원
const saved = await readJsonFile('/path/to/.plan-state.json');
tracker.fromState(saved);
```

**상태 파일 형식** (`.plan-state.json`):
```json
{
  "planFile": "/path/to/plan.md",
  "tasks": [{ "text": "...", "completed": true }, ...],
  "sessions": [{ "id": "session-abc", "completedIndices": [0, 2], "startedAt": "..." }],
  "lastUpdated": "2026-03-29T..."
}
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 계획 실행 | `/implement` | 계획된 기능 구현 시작 |
| 2 | 공수 산정 | `/estimate` | 계획 기반 공수 산정 |
| 3 | 작업 등록 | `/task` | 계획 항목 작업 목록 등록 |
