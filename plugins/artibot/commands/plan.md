---
description: (Artibot) Implementation plan creation with risk identification and phase decomposition
argument-hint: '[task] e.g. "결제 시스템 구현 계획" [--depth shallow|deep] [--scope file|module|project|system] [--size quick|session|epic] [--risks] [--prd] [--adr] · 조회/정리: [--status] [--done N] [--list active|done|stale|all] [--archive [--apply]] [--supersede old new]'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate]
toolset: team
lifecycle: plan
---

# /plan

Create structured implementation plans using the planner agent. Decomposes complex work into phases with dependency tracking and risk assessment.

> **/plan vs /ultraplan vs deep-research — 헷갈리지 않기**
> - **/plan** (여기) — 빠른 구현 설계. 단일 planner가 단계·의존성·리스크를 분해. 범위가 명확할 때.
> - **/ultraplan** — 상위 등급. 근거수집(WebSearch+Grep) + 다관점 의회 + 적대적 검증 + 실행 핸드오프. 위험·비용·장기부채 큰 결정, 마이그레이션, 아키텍처 변경에.
> - **deep-research 스킬** — "무엇이 진실인가"(사실 조사) 자체가 목적일 때. 구현 계획이 아니라 조사. **Artibot 자체 제공 아님** — 설치돼 있으면 `/ultraplan` Phase 1이 보강으로 호출하고, 없으면 주경로(WebSearch+Grep)만으로 진행한다.
> 정리: **계획=/plan, 철저한 계획=/ultraplan, 조사=deep-research.**
> ⚠️ **감사형 입력 주의**: "바꿀 게 있나 / 개선점 찾아 / 트렌드 맞나" 같은 **열린 요청**엔 `/plan`(·`/ultraplan`)을 쓰기 **전에 문제-검증 먼저** — 이들은 "할 일이 정해졌다"를 전제하는 **해법(solution) 도구**다. 실제 코드로 검증된 문제가 0이면 "무변경"이 정답. (`/ultraplan` Phase 0 게이트 / 메모리 `audit-problem-first`)

## Arguments

Parse $ARGUMENTS:
- `feature-or-task`: Description of what needs to be implemented or changed
- `--depth [level]`: `shallow` (high-level phases) | `deep` (detailed task breakdown)
- `--scope [level]`: `file` | `module` | `project` | `system`
- `--size [quick|session|epic]`: 계획을 **autopilot 자율실행 풋프린트 밴드**에 맞춰 사이징. **기본 `session`** = 2~4h autopilot 밴드(토큰 쓰며 도는 시간 기준, 사람 공수 아님). `quick` = 가벼움(<2h, 단발 작업), `epic` = 대형(>4h, 분할 권장). /plan은 가벼운 용도이므로 `--size quick`로 경량 유지 가능
- `--risks`: Emphasize risk identification and mitigation strategies
- `--prd`: 플랜을 PRD 문서로도 저장 (opt-in — /plan 기본은 PRD 미생성, 가벼움 유지)
- `--adr`: 플랜에 either/or 결정이 있으면 ADR로 기록 (opt-in — 절대 기본 자동 아님)
- `--status`: 현재 플랜의 TODO 진행률 표 출력 (PlanTracker `.plan-state.json` 조회)
- `--done <n>`: 태스크 인덱스 `<n>`을 완료로 마킹 (PlanTracker markCompleted → state 갱신)
- `--list [active|done|stale|all]`: PRD/플랜 문서 인덱스 조회 (기본 `all`). 조회 전용 — 플랜 생성 안 함
- `--archive [--older-than <Nd>]`: stale/done/legacy 문서를 `_archive/`로 회전. **기본 dry-run**(이동 예정 목록만 미리보기), `--apply` 추가 시에만 실제 이동. 삭제 아님(이동), 비파괴
- `--supersede <oldSlug> <newPath>`: 옛 문서를 새 문서로 승계(superseded) 표식

## Execution Flow

1. **Parse**: Extract requirements from description. Identify scope and complexity
2. **Context**: Scan codebase for:
   - Existing patterns and conventions
   - Related files and modules that will be affected
   - Current test coverage in target areas
   - Dependency graph of affected components
3. **Delegate**: Route to Agent(planner) with gathered context for:
   - Phase decomposition (3-7 phases typical)
   - Task breakdown within each phase
   - Dependency ordering between tasks
   - Risk identification per phase
4. **Validate**: Check plan for:
   - Circular dependencies between phases
   - Missing test phases
   - Unreferenced files in the codebase
5. **Size (autopilot 풋프린트 사이징)**: 분해된 태스크를 `{type,complexity}` 배열로 매핑해 공유 사이저 `sizePlan()`을 호출하고 (아래 "Artifacts Integration §0" 참조), 결과에 따라 계획을 밴드에 맞춘다:
   - 한 줄 요약: **"예상 autopilot 풋프린트: ~X.XM tokens / ~Y.Yh (tier, confidence)"**.
   - `recommendation==='expand'`(밴드 미달): **품질축으로 확장** — 엣지케이스·테스트·하드닝·관측·문서 단계를 추가한다. **기능 스코프를 억지로 확대하지 않는다** (없던 기능 끼워넣기 금지).
   - `recommendation==='sequence'`(밴드 초과): `sequenceInto` 개 autopilot 세션으로 **순차 분할**하고 각 세션의 goal을 제시한다.
   - `recommendation==='ok'`: 그대로 진행.
   - `--size quick`이면 quick 밴드로(<2h) 경량 사이징, `--size epic`이면 epic(>4h, 분할 전제)으로 호출한다 (기본 `session`).
6. **Persist (기본 — TODO 추적)**: 플랜 생성 직후 공유 산출물 레이어를 호출해 `.plan-state.json`에 진행상태를 기록한다 (아래 "Artifacts Integration" 참조). 이것이 `/plan`의 유일한 기본 산출물이다 (PRD/ADR은 옵트인).
7. **Optional artifacts (옵트인)**:
   - `--prd` 지정 시: `writePRD()`로 플랜을 PRD 문서(`docs/PRD/<slug>-<date>.md`)로 저장.
   - `--adr` 지정 시 **그리고** 플랜에 either/or 결정(2개 이상 실선택지 비교)이 있을 때만: `ensureADR()`로 결정 기록. 결정이 없으면 ADR을 만들지 않는다 (스팸 방지).
8. **Status / Done (조회·마킹 흐름)**:
   - `--status` 지정 시: PlanTracker를 `.plan-state.json`에서 복원 → `getProgress()` 결과를 진행률 표로 출력 (플랜 생성·신규 산출물 없음).
   - `--done <n>` 지정 시: PlanTracker 복원 → `markCompleted(n)` → `syncTodo()`로 state 재기록.
9. **Lifecycle 관리 (문서 라이프사이클 — 조회·아카이브·승계)**: 아래 플래그는 플랜을 새로 만들지 않고 기존 PRD/플랜 문서를 관리한다 (상세 호출은 "Artifacts Integration §6~8" 참조):
   - `--list [filter]` 지정 시: `listArtifacts({filter})` 결과를 표로 출력 (조회 전용 — 플랜 생성·이동 없음).
   - `--archive` 지정 시: 기본 `archiveStale({dryRun:true})`로 **이동 예정 목록만** 미리보기 → 사용자가 `--apply`를 추가하면 `dryRun:false`로 실제 `_archive/` 이동 + `indexArtifacts()`로 INDEX.md 갱신. **삭제 아님(이동), git 추적이라 복구 가능**.
   - `--supersede <oldSlug> <newPath>` 지정 시: `supersede()`로 옛 문서에 superseded 표식.
10. **Report**: Output structured plan with TaskCreate integration. 마지막에 autopilot 핸드오프 라인을 사이징 결과(`autopilot.maxHint`/`autopilot.budgetHint`)에 맞춰 출력한다 (아래 Output Format 참조).

## Plan Structure

Each phase contains:
- **Objective**: What this phase achieves
- **Tasks**: Atomic work items (create/modify/delete files)
- **Dependencies**: Which phases must complete first
- **Risks**: What could go wrong + mitigation
- **Verification**: How to confirm phase completion

## 복구 사다리 (D05)

실행이 실패했을 때 **어느 층이 틀렸는지 먼저 판정하고**, 그 층에서만 고친다. 진단 없이 위층으로 올라가지 마라 — 한 칸 올라갈 때마다 비용과 되돌릴 것이 늘어난다.

| 실패한 층 | 증상 | 대응 | 산출물 |
|---|---|---|---|
| **구현** | 계획대로 했는데 코드·테스트가 틀렸다. 단계와 순서는 여전히 맞다 | **현 플랜을 수리**한다 — 플랜은 그대로 두고 해당 태스크만 다시 한다 | 수정된 코드 + 통과 증거 |
| **플랜** | 단계 분해·의존 순서·검증 방법이 틀렸다. 문제 정의는 맞다 | **플랜을 개정**한다 — 이 커맨드를 다시 돌려 영향받는 phase 를 다시 분해한다 | 개정된 플랜 + 무엇이 왜 바뀌었는지 |
| **프레이밍·아키텍처** | 문제 자체를 잘못 잡았다. 계획을 아무리 고쳐도 같은 벽에 부딪힌다 | **`/ultraplan`** 으로 근거수집·다관점·적대검증부터 다시 한다 | 재프레이밍된 문제 정의 + 새 플랜 |

**세 번째 칸은 희귀하다.** 실패의 대부분은 구현 오류이고, 그다음이 플랜 오류다. "안 되니까 처음부터 다시" 는 진단이 아니다 — 어느 층이 틀렸는지 `file:line` 이나 실패 출력으로 말할 수 없으면 아직 사다리에 오를 자격이 없다. 같은 층에서 두 번 실패한 뒤에야 한 칸 올라간다.

**층 판정법**: 실패 증거를 놓고 "플랜이 시킨 대로 했는가?" 를 먼저 묻는다. 아니오면 구현 층. 예인데 결과가 틀렸으면 플랜 층. 플랜을 두세 번 고쳤는데도 같은 종류의 벽이면 프레이밍 층이다.

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

SIZING (autopilot 풋프린트)
---------------------------
예상 autopilot 풋프린트: ~X.XM tokens / ~Y.Yh (tier, confidence)
밴드: [quick|session|epic]  추천: [ok|expand|split(→N 세션)]

HANDOFF
-------
> 자율실행: /autopilot "<task>" --goal "<검증가능 종료조건>" --max {autopilot.maxHint} --budget {autopilot.budgetHint}
```

> **정직성**: 토큰→시간 환산은 밴드+confidence 기반 **휴리스틱 추정**이며 보장값이 아니다. 실제 하드스톱은 autopilot의 `--max`/`--budget`이다 (사이징은 그 값을 추천할 뿐 강제하지 않는다).

## Artifacts Integration

### 0. autopilot 풋프린트 사이징 (`sizePlan`)

계획 분해(Execution Flow Step 5) 직후, 공유 사이저 `lib/planning/session-sizer.js`를 호출해 autopilot 자율실행 풋프린트를 추정한다. 이 레이어를 재구현하지 않고 **호출만** 한다. 정확한 시그니처:

```
sizePlan(tasks, opts) → { footprint:{tokens,hours,tier,confidence}, sizing:{band,recommendation,sequenceInto,target}, autopilot:{maxHint,budgetHint} }
estimateFootprint(tasks, opts) → { tokens, hours, tier, confidence, perTask }
classifySize(hours, opts) → { band, target, recommendation, sequenceInto }
// tasks = [{ type:'impl'|'test'|'review'|'docs'|'other', complexity?:'low'|'medium'|'high' }]
```

`sizePlan`은 `lib/planning/artifacts.js`와 **동일한 동적 import 패턴**(아래 "호출 방법" — `CLAUDE_PLUGIN_ROOT` 기준 절대경로)으로 `lib/planning/session-sizer.js`에서 import한다.

```js
const { sizePlan } = await import(toFileUrl(path.join(pluginRoot, 'lib/planning/session-sizer.js')));
const tasks = phases.flatMap((p) => p.tasks.map((t) => ({ type: t.kind, complexity: t.complexity })));
const { footprint, sizing, autopilot } = sizePlan(tasks, { size: sizeFlag /* quick|session|epic, 기본 session */ });
// footprint = { tokens, hours, tier, confidence }
// sizing = { band, recommendation: 'ok'|'expand'|'sequence', sequenceInto, target }
// autopilot = { maxHint, budgetHint }   ← /autopilot --max / --budget 에 그대로 매칭
```

- `recommendation==='expand'`(밴드 미달): 품질축(엣지케이스·테스트·하드닝·관측·문서)으로 확장. **기능 스코프 억지 확대 금지**.
- `recommendation==='sequence'`(밴드 초과): `sequenceInto` 개 autopilot 세션으로 순차 분할 + 각 세션 goal 제시.
- `recommendation==='ok'`: 그대로 진행.
- 출력은 Output Format의 `SIZING` 블록과 `HANDOFF` 라인에 반영한다. **토큰→시간은 휴리스틱 추정**이며 autopilot의 `--max`/`--budget`이 실제 하드스톱이다.

### 산출물 함수

문서 산출물(TODO 추적 / PRD / ADR)은 **공유 산출물 레이어** `lib/planning/artifacts.js`를 호출해 생성한다. `/plan`은 이 레이어를 직접 재구현하지 않고 **호출만** 한다. 세 함수의 정확한 시그니처 (**전부 async — `await` 필수**):

```
await writePRD({ projectRoot, slug, title, sections, linkedAdrs, now }) → { ok, prdPath }
  // docs/PRD/<slug>-<date>.md 생성
await ensureADR({ projectRoot, title, options, decision, rationale, now }) → { ok, adrPath, number }
  // 프로젝트의 ADR 디렉터리에 ADR-NNN-slug.md 생성 (경로는 resolveAdrDir 이 결정:
  // `.artibot/adr/` → `docs/adr/` → `adr/`). **멱등이 아니다** — 같은 인자로 다시 부르면
  // 새 번호의 ADR 이 하나 더 생긴다(ADR 번호가 곧 정체성이라 설계상 그렇다).
  // 같은 결정을 두 번 기록하지 마라. 기존 결정을 바꿀 때는 supersede() 를 쓴다.
await syncTodo({ projectRoot, planMarkdown, planFile, sessionId, now }) → { ok, stateFile, progress }
  // .plan-state.json 기록 (내부적으로 PlanTracker 사용). progress = { total, completed, percentage }
```

문서 라이프사이클 관리(조회·인덱스·아카이브·승계)도 **같은 레이어**의 다음 함수로 수행한다 (직접 재구현 금지 — 호출만):

```
await listArtifacts({ projectRoot, kind, filter, now }) → { ok, items }
  // filter: active|done|stale|all. items = 각 문서의 slug/status/date/ageDays/progress/link
await indexArtifacts({ projectRoot, kind, now }) → { ok, indexPath, count }
  // docs/<KIND>/INDEX.md 생성·갱신. writePRD/ensureADR/archiveStale 이후 자동 호출
await archiveStale({ projectRoot, kind, olderThanDays, statuses, dryRun, now }) → { ok, moved, dryRun }
  // stale/done 문서를 docs/<KIND>/_archive/ 로 이동 (삭제 아님). dryRun:true 면 이동 예정만 반환
await supersede({ projectRoot, kind, oldSlug, newPath, now }) → { ok, oldPath }
  // 옛 문서(oldSlug)에 newPath 로의 superseded 표식
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
// 아래 8개는 **전부 async 함수**다. 구조분해에 await 를 빠뜨리면 Promise 를 분해해
// 전 필드가 조용히 undefined 가 된다 (throw 하지 않으므로 티가 안 난다).
const { writePRD, ensureADR, syncTodo, indexArtifacts, listArtifacts, archiveStale, supersede } =
  await import(toFileUrl(path.join(pluginRoot, 'lib/planning/artifacts.js')));
```

### 1. 기본 — TODO 추적 (`syncTodo`)

플랜 생성 직후 항상 호출. `.plan-state.json`에 태스크 목록·진행률·세션을 기록해 세션 간 추적을 가능케 한다.

```js
const { ok, stateFile, progress } = await syncTodo({   // async — await 필수
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
const { ok, prdPath } = await writePRD({   // async — await 필수
  projectRoot: process.cwd(),
  slug: '<feature-slug>',
  title: '<feature title>',
  sections: { 배경, 목표, 비목표, 설계, 산출물, 실행계획, 위험, 수락기준 },
  linkedAdrs: [],          // --adr 로 ADR 생성 시 ADR 번호/경로 연결
  now: new Date(),
});
```

`writePRD()` 호출 직후 항상 `indexArtifacts({ projectRoot, kind: 'prd', now })`를 호출해 `docs/PRD/INDEX.md`를 자동 갱신한다 (신규 PRD가 인덱스에 즉시 반영되도록). 마찬가지로 `ensureADR()` 직후 `indexArtifacts({ kind: 'adr' })`로 ADR 인덱스를 갱신한다.

### 5. `--adr` — 결정 기록 (옵트인 + 결정 존재 시에만)

`--adr` 플래그가 있고 플랜에 either/or 결정(2개 이상 실선택지 비교)이 실제로 있을 때만 호출한다. 결정이 없으면 ADR을 만들지 않는다.

```js
const { ok, adrPath, number } = await ensureADR({   // async — await 필수
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

### 6. `--list` — 문서 인덱스 조회 (조회 전용)

`listArtifacts({ filter })`로 PRD/플랜 문서를 나열한다. 플랜을 새로 만들지 않으며, 어떤 문서도 이동·삭제하지 않는다. `filter`는 `active`(진행중) | `done`(완료) | `stale`(오래됨) | `all`(기본).

```js
const { ok, items } = await listArtifacts({   // async — await 필수
  projectRoot: process.cwd(),
  kind: 'prd',
  filter: 'all',           // --list 인자 (기본 all)
  now: new Date(),
});
// items[i] = { slug, status, date, ageDays, progress, link }
```

출력 예시:

```
ARTIFACT INDEX (filter: all)
----------------------------
SLUG                 STATUS      DATE        AGE   PROGRESS  LINK
payment-system       active      2026-06-01    8d   5/12 42%  docs/PRD/payment-system-2026-06-01.md
auth-refresh         done        2026-05-10   30d  9/9 100%   docs/PRD/auth-refresh-2026-05-10.md
legacy-import        stale       2026-02-14  115d  0/6   0%   docs/PRD/legacy-import-2026-02-14.md

3 artifact(s). index: docs/PRD/INDEX.md
```

### 7. `--archive` — stale/done 문서 회전 (기본 dry-run, 비파괴)

기본 동작은 **미리보기**다. `archiveStale({ dryRun: true })`로 어떤 문서가 `_archive/`로 이동될지 목록만 보여주고 **아무것도 옮기지 않는다**. 사용자가 결과를 확인하고 `--apply`를 추가했을 때만 `dryRun: false`로 실제 이동한다.

```js
// 1단계 — 기본: 미리보기 (이동 없음)
const preview = await archiveStale({   // async — await 필수
  projectRoot: process.cwd(),
  kind: 'prd',
  olderThanDays: 90,       // --older-than <Nd> (기본 90)
  statuses: ['done', 'stale'],
  dryRun: true,            // 기본값 — --apply 없으면 항상 true
  now: new Date(),
});
// preview = { ok, moved: [{ from, to }], dryRun: true }

// 2단계 — --apply 가 있을 때만: 실제 이동 + 인덱스 갱신
if (userPassedApply) {
  const result = await archiveStale({ projectRoot: process.cwd(), kind: 'prd',
    olderThanDays: 90, statuses: ['done', 'stale'], dryRun: false, now: new Date() });
  await indexArtifacts({ projectRoot: process.cwd(), kind: 'prd', now: new Date() }); // INDEX.md 갱신
}
```

dry-run 출력 예시:

```
ARCHIVE PREVIEW (dry-run — 아무것도 이동되지 않았습니다)
-------------------------------------------------------
older-than: 90d   statuses: done, stale
WILL MOVE:
  docs/PRD/auth-refresh-2026-05-10.md   ->  docs/PRD/_archive/auth-refresh-2026-05-10.md
  docs/PRD/legacy-import-2026-02-14.md  ->  docs/PRD/_archive/legacy-import-2026-02-14.md

2 file(s) would move. 실제 이동하려면 --apply 를 추가하세요.
```

> **안전**: `--archive`는 기본 dry-run이라 명령만으로는 파일이 바뀌지 않는다. 실제 동작도 **삭제가 아니라 `_archive/`로 이동**이며, 문서가 git으로 추적되므로 언제든 `git mv`/`git checkout`으로 복구할 수 있다. 실이동은 사용자가 미리보기를 확인하고 `--apply`를 명시한 뒤에만 일어난다.

### 8. `--supersede` — 옛 문서 승계 표식

옛 문서(`oldSlug`)를 새 문서(`newPath`)로 승계됨(superseded)을 표시한다. 파일을 삭제하지 않고 승계 표식만 추가한다.

```js
const { ok, oldPath } = await supersede({   // async — await 필수
  projectRoot: process.cwd(),
  kind: 'prd',
  oldSlug: 'payment-system-v1',     // --supersede 첫 인자
  newPath: 'docs/PRD/payment-system-2026-06-01.md', // --supersede 둘째 인자
  now: new Date(),
});
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 계획 실행 | `/implement` | 계획된 기능 구현 시작 |
| 2 | 공수 산정 | `/estimate` | 계획 기반 공수 산정 |
| 3 | 작업 등록 | `/task` | 계획 항목 작업 목록 등록 |
