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
- `--prd`: 플랜을 PRD 문서로도 저장 (opt-in — /plan 기본은 PRD 미생성, 가벼움 유지)
- `--adr`: 플랜에 either/or 결정이 있으면 ADR로 기록 (opt-in — 절대 기본 자동 아님)
- `--status`: 현재 플랜의 TODO 진행률 표 출력 (PlanTracker `.plan-state.json` 조회)
- `--done <n>`: 태스크 인덱스 `<n>`을 완료로 마킹 (PlanTracker markCompleted → state 갱신)

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
5. **Persist (기본 — TODO 추적)**: 플랜 생성 직후 공유 산출물 레이어를 호출해 `.plan-state.json`에 진행상태를 기록한다 (아래 "Artifacts Integration" 참조). 이것이 `/plan`의 유일한 기본 산출물이다 (PRD/ADR은 옵트인).
6. **Optional artifacts (옵트인)**:
   - `--prd` 지정 시: `writePRD()`로 플랜을 PRD 문서(`docs/PRD/<slug>-<date>.md`)로 저장.
   - `--adr` 지정 시 **그리고** 플랜에 either/or 결정(2개 이상 실선택지 비교)이 있을 때만: `ensureADR()`로 결정 기록. 결정이 없으면 ADR을 만들지 않는다 (스팸 방지).
7. **Status / Done (조회·마킹 흐름)**:
   - `--status` 지정 시: PlanTracker를 `.plan-state.json`에서 복원 → `getProgress()` 결과를 진행률 표로 출력 (플랜 생성·신규 산출물 없음).
   - `--done <n>` 지정 시: PlanTracker 복원 → `markCompleted(n)` → `syncTodo()`로 state 재기록.
8. **Report**: Output structured plan with TaskCreate integration

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

## Artifacts Integration

문서 산출물(TODO 추적 / PRD / ADR)은 **공유 산출물 레이어** `lib/planning/artifacts.js`를 호출해 생성한다. `/plan`은 이 레이어를 직접 재구현하지 않고 **호출만** 한다. 세 함수의 정확한 시그니처:

```
writePRD({ projectRoot, slug, title, sections, linkedAdrs, now }) → { ok, prdPath }
  // docs/PRD/<slug>-<date>.md 생성
ensureADR({ projectRoot, title, options, decision, rationale, now }) → { ok, adrPath, number }
  // docs/adr/ADR-NNN-slug.md 생성 (멱등 — 동일 결정 재호출 시 기존 ADR 재사용)
syncTodo({ projectRoot, planMarkdown, planFile, sessionId, now }) → { ok, stateFile, progress }
  // .plan-state.json 기록 (내부적으로 PlanTracker 사용). progress = { total, completed, percentage }
```

### 호출 방법 (동적 import — 절대경로)

`artibot.config.json`/엔진과 동일하게 `CLAUDE_PLUGIN_ROOT` 기준 절대경로로 해석한다 (cwd 상대경로 금지 — `commands/autopilot.md` Step 1의 `toFileUrl`/`pluginRoot` 해석 패턴 참고). 요지:

```js
import path from 'node:path';
import fs from 'node:fs';
const toFileUrl = (p) => {
  const f = p.replace(/\\/g, '/');
  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
};
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const candidates = [process.env.CLAUDE_PLUGIN_ROOT].filter(Boolean);
const mpDir = path.join(home, '.claude', 'plugins', 'marketplaces');
if (fs.existsSync(mpDir)) {
  for (const mp of fs.readdirSync(mpDir)) candidates.push(path.join(mpDir, mp, 'plugins', 'artibot'));
}
const pluginRoot = candidates.find((c) => fs.existsSync(path.join(c, 'lib/planning/artifacts.js')));
if (!pluginRoot) throw new Error('Artibot planning layer not found. Set CLAUDE_PLUGIN_ROOT or install via marketplace.');
const { writePRD, ensureADR, syncTodo } = await import(toFileUrl(path.join(pluginRoot, 'lib/planning/artifacts.js')));
```

### 1. 기본 — TODO 추적 (`syncTodo`)

플랜 생성 직후 항상 호출. `.plan-state.json`에 태스크 목록·진행률·세션을 기록해 세션 간 추적을 가능케 한다.

```js
const { ok, stateFile, progress } = syncTodo({
  projectRoot: process.cwd(),
  planMarkdown,            // 방금 생성한 IMPLEMENTATION PLAN 마크다운
  planFile: 'docs/plan.md',// 플랜 원본 경로 (있으면)
  sessionId: '<current-session>',
  now: new Date(),
});
// progress = { total, completed, percentage }
```

### 2. `--status` — 진행률 조회

신규 산출물 없이 `syncTodo()` 가 반환한 `progress`(또는 기존 `.plan-state.json`)를 진행률 표로 렌더한다:

```
TODO STATUS
-----------
Tasks: 5/12 (42%)   state: .plan-state.json
```

### 3. `--done <n>` — 완료 마킹

`syncTodo()` 는 PlanTracker `markCompleted` 결과를 반영해 state를 재기록한다 (불변 — 새 state 파일 내용 생성, 원본 planMarkdown 미변경). 마킹 후 갱신된 `progress` 를 출력한다.

### 4. `--prd` — PRD 생성 (옵트인)

```js
const { ok, prdPath } = writePRD({
  projectRoot: process.cwd(),
  slug: '<feature-slug>',
  title: '<feature title>',
  sections: { 배경, 목표, 비목표, 설계, 산출물, 실행계획, 위험, 수락기준 },
  linkedAdrs: [],          // --adr 로 ADR 생성 시 ADR 번호/경로 연결
  now: new Date(),
});
```

### 5. `--adr` — 결정 기록 (옵트인 + 결정 존재 시에만)

`--adr` 플래그가 있고 플랜에 either/or 결정(2개 이상 실선택지 비교)이 실제로 있을 때만 호출한다. 결정이 없으면 ADR을 만들지 않는다.

```js
const { ok, adrPath, number } = ensureADR({
  projectRoot: process.cwd(),
  title: '<decision title>',
  options: ['선택지 A', '선택지 B'],   // 비교한 실선택지 (2개 이상)
  decision: '선택지 A',
  rationale: '왜 A인가 — 근거',
  now: new Date(),
});
// number = ADR 번호. writePRD의 linkedAdrs로 cross-link 가능.
```

**상태 파일 형식** (`.plan-state.json`, `syncTodo` 산출):
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
