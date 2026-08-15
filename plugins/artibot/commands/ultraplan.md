---
description: (Artibot) Maximal evidence-grounded planning — deep-research grounding + multi-lens council + adversarial review + execution handoff
argument-hint: '[task] e.g. "결제 시스템 v2 마이그레이션" [--no-research] [--lenses N]'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate, Skill]
toolset: team
lifecycle: plan
---

# /ultraplan

`/plan`의 **상위(ULTRA) 등급** 플래닝 모드. `/plan`이 단일 planner로 빠르게 단계를 분해한다면,
`/ultraplan`은 **근거 수집 → 다관점 의회(council) → 종합 → 적대적 검증 → 강화 → 실행 핸드오프**의
6단계로 "이름값 하는" 철두철미한 계획을 만든다.

> **언제 /plan, 언제 /ultraplan?**
> - **/plan** — 범위가 명확하고 빠른 단계 분해가 필요할 때 (단일 planner, 저비용).
> - **/ultraplan** — 위험·비용·장기부채가 큰 결정, 사전조사가 필요한 작업, 되돌리기 어려운 마이그레이션/아키텍처 변경.
> - **deep-research 스킬** — "무엇이 진실인가"(사실 조사) 자체가 목적일 때. /ultraplan은 이 스킬을 1단계 근거수집으로 **내부 호출**한다.

## Arguments

Parse $ARGUMENTS:
- `task`: 계획 대상 (필수)
- `--no-research`: 1단계(GROUND) 스킵 — 외부/코드 조사 없이 내부 지식만으로 계획 (토큰 절약)
- `--lenses N`: 2단계 council 관점 수 (기본 3, 범위 2~4)
- `--scope [file|module|project|system]`: 분석 범위 (기본 project)
- `--no-adversarial`: 4단계 적대적 검증 스킵 (비권장)
- `--size [quick|session|epic]`: 계획을 **autopilot 자율실행 풋프린트 밴드**에 맞춰 사이징. **기본 `session`** = 2~4h autopilot 밴드(토큰 쓰며 도는 시간 기준, 사람 공수 아님). `quick` = 가벼움(<2h), `epic` = 대형(>4h, 분할 권장)

## 6-Phase Pipeline

### Phase 0 — VALIDATE (문제 검증 게이트)  ·  발산 전 필수, null-result 가능
> **공유 규율**: 이 게이트는 `problem-validation` 스킬로 재사용됨 — `/team`, `/improve`, `/analyze`도 동일 체크리스트를 적용한다(DRY). 규율 변경 시 스킬 파일을 먼저 수정한다.

DIVERGE(발산) 엔진을 돌리기 **전에** "이 작업이 진짜 필요한가"부터 확정한다. 이 게이트가 없으면 발산 엔진이 **없는 문제도 만들어낸다** (2026-06 실증 — 트렌드 기반 v4.27.0 계획 전량이 코드 검증에서 불필요로 판명. 메모리 `audit-problem-first`).
- **입력 분류**:
  - **구체적 작업이 주어짐**("X 마이그레이션", "Y 구현", "이 버그 고쳐") → 문제는 사용자가 이미 준 것 → 통과(pass-through), Phase 1로.
  - **감사/열린 요청**("최신 트렌드 맞나", "보강할 기능·커맨드·훅", "전수조사", "개선점 찾아") → **반드시 문제-검증 먼저.**
- **검증 방법**: 후보 문제를 *트렌드가 아니라* **실제 코드·incident·실패 테스트·문서화된 통증**으로 깊게 대조한다. "이미 있는가? 이미 테스트되는가? 실제로 깨졌는가?"를 `file:line`으로 확인 (얕은 트렌드 추론 금지).
- **null-result 출구 (1급 결과)**: 검증을 통과한 문제가 **0개면 계획을 만들지 말고** "건강함 / 무변경 권장"으로 종료한다. 성숙한 코드의 정답은 흔히 "바꿀 것 없음"이며, 억지 계획은 부채다.
- 통과한 **검증된 문제만** Phase 1~6로 넘긴다. 트렌드는 "가능한 선택지"만 알려줄 뿐 — **절대 트리거가 아니다.**

### Phase 1 — GROUND (근거 수집)  ·  `--no-research` 시 스킵
- 작업 도메인을 **deep-research 스킬**로 조사한다: `Skill(deep-research, args="<task> 관련 최신 모범사례·함정·선행사례·벤치마크")`.
  - deep-research가 없거나 실패하면 WebSearch + 코드베이스 Grep으로 폴백.
- 코드베이스 컨텍스트도 수집(`/plan` Phase 2와 동일): 기존 패턴·영향 파일·테스트 커버리지·의존 그래프.
- 산출: **근거 노트**(출처/사실/제약) — 이후 모든 단계의 입력.

### 보고 계약 (MANDATORY — 모든 스폰 프롬프트 말미에 삽입)

아래 블록을 `{보고 계약}` 자리에 그대로 넣는다. `{리더 이름}` 은 리더 자신의 이름으로 치환한다.
**`commands/team.md` 의 것과 문자 단위로 동일해야 한다** — /team 이 아닌 경로로 뜬 팀원이 더 약한
계약으로 일하면 표준이 후퇴 기준선이 된다. 드리프트는
`tests/commands/report-contract-parity.test.js` 가 잡는다.

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

### Phase 2 — DIVERGE (다관점 의회, 병렬)
서로 다른 렌즈의 planner/architect를 **병렬 소환**(`--lenses` 개, 기본 3). 각자 독립 계획 후보를 낸다:
- `Agent(subagent_type="artibot:planner", name="lens-mvp", prompt="[ULTRAPLAN 렌즈: MVP·최단경로] 근거:{ground}\n작업:{task}\n가장 빠르게 가치 내는 단계 계획\n\n{보고 계약}")`
  <!-- model: model-policy 해석 — 역할 `frontier`; fable opt-in 게이트 활성(현재 기본) 시 `deep-async` 별칭 선택 가능 -->
- `Agent(subagent_type="artibot:architect", name="lens-risk", prompt="[ULTRAPLAN 렌즈: 위험·견고성 우선] ... 실패모드·롤백·테스트를 최우선으로 한 계획\n\n{보고 계약}")`
  <!-- model: model-policy 해석 — 역할 `frontier`; fable opt-in 게이트 활성(현재 기본) 시 `deep-async` 별칭 선택 가능 -->
- `Agent(subagent_type="artibot:architect", name="lens-arch", prompt="[ULTRAPLAN 렌즈: 장기 아키텍처] ... 2년 뒤 유지보수·확장성·기술부채 최소화 계획\n\n{보고 계약}")`
  <!-- model: model-policy 해석 — 역할 `frontier`; fable opt-in 게이트 활성(현재 기본) 시 `deep-async` 별칭 선택 가능 -->

### Phase 3 — JUDGE & SYNTHESIZE (종합)
리더가 후보 N개를 비교·채점(가치/위험/비용/장기성)하고 **최선안으로 종합**하되 각 후보의 강점을 접목한다.
단일 후보 채택이 아니라 **best-of-all** 합성.

- **결정 기록 (조건부 — 스팸 방지)**: 이 단계에서 **2개 이상의 실선택지를 실제로 비교**해 하나를 채택한 경우에만 `ensureADR()`로 결정을 기록한다 (아래 "Artifacts Integration" 참조). 후보가 사실상 단일이거나 명백한 한 길뿐이면 ADR을 만들지 않는다. ADR은 ultraplan에서도 **기본 자동이 아니라 "결정 감지 시"만**이다.

### Phase 4 — ADVERSARIAL REVIEW (적대적 검증)  ·  `--no-adversarial` 시 스킵
공격자 관점 검증: `Agent(subagent_type="artibot:code-reviewer", name="plan-critic", prompt="[Plan 적대 검증] 이 계획의 순환 의존, 누락된 테스트 단계, 숨은 비용, 2년 뒤 기술부채, 실존하지 않는 파일 참조, 비현실적 의존 순서를 전부 찾아내라\n\n{보고 계약}")`
<!-- model: model-policy 해석 — 역할 `balanced`(검증·읽기 전용 작업) -->.
발견 항목은 종합안에 반영(재조정) 후 통과시킨다.

### Phase 5 — HARDEN (강화)
- 리스크 매트릭스(심각도×확률) + 단계별 mitigation + rollback + phase gate(검증 기준).
- 되돌리기 어려운 단계는 `/migrate` 체크리스트 또는 `/adr` 기록을 권고.

### Phase 6 — HANDOFF (실행 인계)
- **autopilot 풋프린트 사이징 (기본)**: 종합된 최종 플랜의 태스크를 `{type,complexity}` 배열로 매핑해 공유 사이저 `sizePlan()`을 호출한다 (아래 "Artifacts Integration §0" 참조). 결과를 EXECUTION HANDOFF에 반영한다:
  - 한 줄 요약: **"예상 autopilot 풋프린트: ~X.XM tokens / ~Y.Yh (tier, confidence)"**.
  - `recommendation==='expand'`(밴드 미달): 품질축(엣지케이스·테스트·하드닝·관측·문서)으로 **확장 지시**. **기능 스코프 억지 확대 금지**.
  - `recommendation==='split'`(밴드 초과): `splitInto` 개 autopilot 세션으로 **분할** + 각 세션 goal 제시.
  - `recommendation==='ok'`: 그대로 진행. 기본 밴드는 `session`(2~4h), `--size`로 조정.
- **PRD 기본 생성 (ultraplan 기본 산출)**: `writePRD()`로 종합된 플랜을 PRD 문서(`docs/PRD/<slug>-<date>.md`)로 저장한다. ultraplan은 철저 모드이므로 PRD가 **기본 산출물**이다 (`/plan`과 달리 옵트인 아님). Phase 3에서 ADR을 만들었다면 그 번호/경로를 `linkedAdrs`로 PRD 헤더에 cross-link한다.
- **TODO 추적 기본**: `syncTodo()`로 `.plan-state.json` 저장 → 세션 간 추적. PRD 본문에 이 state 경로를 cross-link로 명시한다.
- 세 호출(`sizePlan`/`writePRD`/`syncTodo`) 모두 공유 레이어(`lib/planning/session-sizer.js` · `lib/planning/artifacts.js`)를 통해 수행한다 (아래 "Artifacts Integration" 참조 — 직접 재구현 금지).
- 실행 경로 추천(직교 2축):
  - **자리 비움/대형 무인작업** → `/autopilot "<task>" --goal "<검증가능 종료조건>" --max {autopilot.maxHint} --budget {autopilot.budgetHint}` (사이징 결과를 max/budget에 매칭)
  - **병렬 협업/교차검증** → `/team` (Operator-Waits DNA로 자동 발화되기도 함)
  - **단순/단일 파일** → 인라인 즉시 구현

## Artifacts Integration

### 0. autopilot 풋프린트 사이징 (`sizePlan`)

Phase 6에서 종합된 플랜의 태스크를 `{type,complexity}` 배열로 매핑해 공유 사이저 `lib/planning/session-sizer.js`를 호출한다 (재구현 금지 — 호출만). 정확한 시그니처:

```
sizePlan(tasks, opts) → { footprint:{tokens,hours,tier,confidence}, sizing:{band,recommendation,splitInto,target}, autopilot:{maxHint,budgetHint} }
estimateFootprint(tasks, opts) → { tokens, hours, tier, confidence, perTask }
classifySize(hours, opts) → { band, target, recommendation, splitInto }
// tasks = [{ type:'impl'|'test'|'review'|'docs'|'other', complexity?:'low'|'medium'|'high' }]
```

import은 `artifacts.js`와 **동일한 동적 import 패턴**(`CLAUDE_PLUGIN_ROOT` 기준 절대경로)으로 `session-sizer.js`에서 한다.

```js
const { sizePlan } = await import(toFileUrl(path.join(pluginRoot, 'lib/planning/session-sizer.js')));
const tasks = phases.flatMap((p) => p.tasks.map((t) => ({ type: t.kind, complexity: t.complexity })));
const { footprint, sizing, autopilot } = sizePlan(tasks, { size: sizeFlag /* quick|session|epic, 기본 session */ });
// autopilot.maxHint / autopilot.budgetHint → EXECUTION HANDOFF의 /autopilot --max / --budget
// sizing.recommendation: 'ok'(진행) | 'expand'(품질축 확장) | 'split'(splitInto 세션 분할)
```

> **정직성**: 토큰→시간 환산은 밴드+confidence 기반 **휴리스틱 추정**이며 보장값이 아니다. 실제 하드스톱은 autopilot의 `--max`/`--budget`이다 (사이징은 그 값을 추천만 한다).

### 산출물 함수

문서 산출물(PRD / ADR / TODO 추적)은 **공유 산출물 레이어** `lib/planning/artifacts.js`를 호출해 생성한다 (직접 재구현 금지 — `/plan`과 동일 레이어 공유). 세 함수의 정확한 시그니처:

```
writePRD({ projectRoot, slug, title, sections, linkedAdrs, now }) → { ok, prdPath }
  // docs/PRD/<slug>-<date>.md 생성. linkedAdrs로 ADR 헤더 cross-link.
ensureADR({ projectRoot, title, options, decision, rationale, now }) → { ok, adrPath, number }
  // docs/adr/ADR-NNN-slug.md 생성 (멱등). options=비교한 실선택지(2개 이상).
syncTodo({ projectRoot, planMarkdown, planFile, sessionId, now }) → { ok, stateFile, progress }
  // .plan-state.json 기록. progress = { total, completed, percentage }
```

동적 import는 `CLAUDE_PLUGIN_ROOT` 기준 절대경로로 해석한다 (cwd 상대경로 금지 — `commands/autopilot.md` Step 1의 `toFileUrl`/`pluginRoot` 패턴 참고). `lib/planning/artifacts.js`를 후보 경로에서 찾아 `import()`한다.

### Phase 3 — 결정 기록 (조건부)

```js
// 2개 이상 실선택지를 비교해 채택한 경우에만
const { ok, adrPath, number } = ensureADR({
  projectRoot: process.cwd(),
  title: '<decision title>',
  options: ['렌즈-mvp 안', '렌즈-arch 안'],  // 비교한 실선택지 (2개 이상)
  decision: '<채택안>',
  rationale: '<근거 — EVIDENCE/LENS SYNTHESIS 인용>',
  now: new Date(),
});
const linkedAdrs = ok ? [{ number, adrPath }] : [];
```

### Phase 6 — PRD 생성 (기본) + TODO 추적 (기본)

```js
const { ok: prdOk, prdPath } = writePRD({
  projectRoot: process.cwd(),
  slug: '<feature-slug>',
  title: '<task title>',
  sections: { 배경, 목표, 비목표, 설계, 산출물, 실행계획, 위험, 수락기준, 근거 },
  linkedAdrs,              // Phase 3에서 ADR 생성 시 cross-link (없으면 [])
  now: new Date(),
});

const { stateFile, progress } = syncTodo({
  projectRoot: process.cwd(),
  planMarkdown,            // 종합된 최종 플랜 마크다운
  planFile: prdPath,       // PRD 경로를 plan 원본으로 연결
  sessionId: '<current-session>',
  now: new Date(),
});
// PRD 본문에 stateFile(.plan-state.json) 경로를 cross-link로 명시한다.
```

## 중계 계약 (MANDATORY — 리더가 사용자에게 보고할 때)

`[보고 계약]` 이 **팀원→리더** 방향을 규율한다면, 아래는 **리더→사용자** 방향의 대칭 계약이다.
스폰 프롬프트에 삽입하는 블록이 아니라 **리더가 아래 Output Format 을 작성할 때 자기 자신에게
적용**한다 — 특히 EVIDENCE / LENS SYNTHESIS / ADVERSARIAL FINDINGS 는 전부 남이 준 관측치의
중계다. **`commands/team.md` 의 것과 문자 단위로 동일해야 한다** — /ultraplan 만 실행한 리더는
team.md 를 읽지 않으므로, 여기 없으면 그 세션에는 이 계약이 없는 것이다. 드리프트는
`tests/commands/report-contract-parity.test.js` 가 잡는다.

```
[중계 계약]
- 팀원 보고의 `미확인:` 항목은 삭제하지 않고 최종 사용자 보고까지 그대로 전파한다. 요약은 유보를 지우는 자리가 아니다.
- 팀원이 "미확인" 이라 적은 것을 확정 사실로 승격하려면 리더가 직접 재측정한 출력이 있어야 한다. 없으면 미확인인 채로 올린다.
- 수치를 중계할 때 측정 주체와 측정 시각을 함께 적는다: "9,895 pass"(X) → "9,895 pass, {측정자} 측정, {측정시각} 기준"(O). 누가 쟀는지가 신뢰도다.
- 팀원 보고·핸드오프·이전 세션 기록에서 온 file:line 은 사용자 보고에 쓰기 전에 직접 연다. 남에게 들은 줄번호를 옮기는 것은 인용이 아니라 중계다.
- 관측치 3건 이상을 한 블록으로 보고할 때 상호 모순을 점검한다. 모순이면 숨기지 말고 "A 와 B 가 동시에 참이려면 C 가 필요한데 C 는 미확인" 형태로 그대로 올린다.
- 검증은 구현이 아니다. 리더가 파일을 열어 확인하는 것은 위임 원칙 위반이 아니다 — 위임 금지 대상은 구현이다.
```

## Output Format

`/plan`의 IMPLEMENTATION PLAN 포맷을 그대로 쓰되 다음 섹션을 **추가**한다:

```
ULTRAPLAN
=========
Task:       [description]
Grounding:  [N sources, M facts]   (--no-research 시 "skipped")
Lenses:     mvp · risk · arch      (N candidates synthesized)
Adversarial:[X issues found → resolved]

[... /plan 의 PHASE 1..N 표준 출력 ...]

EVIDENCE (근거)
---------------
- [fact] — [source/file:line]

LENS SYNTHESIS (관점 종합)
--------------------------
| 렌즈 | 핵심 제안 | 채택 |
|------|-----------|------|
| mvp  | ...       | ✅ 부분 |
| risk | ...       | ✅ 전체 |
| arch | ...       | ✅ 부분 |

ADVERSARIAL FINDINGS (적대 검증)
--------------------------------
| 발견 | 심각도 | 반영 |
|------|--------|------|

RISKS / ROLLBACK
----------------
[severity] [risk] -> [mitigation] -> [rollback]

EXECUTION HANDOFF
-----------------
> 풋프린트: ~X.XM tokens / ~Y.Yh (tier, confidence)  ·  밴드: [quick|session|epic]  ·  추천: [ok|expand|split(→N 세션)]
> 추천 경로: /autopilot | /team | inline  +  근거
> 자율실행: /autopilot "<task>" --goal "<검증가능 종료조건>" --max {autopilot.maxHint} --budget {autopilot.budgetHint}
> (split 시) 세션 1: <goal> · 세션 2: <goal> · …
> PRD: docs/PRD/<slug>-<date>.md · ADR: docs/adr/ADR-NNN-slug.md|none · TODO: .plan-state.json (N tasks)
```

> **정직성**: 토큰→시간은 휴리스틱 추정(밴드+confidence)이며 보장 아님. autopilot의 `--max`/`--budget`이 실제 하드스톱이다.

## Anti-Patterns

- 리더가 직접 후보 계획을 다 쓰기 — Phase 2는 반드시 병렬 에이전트 위임
- Phase 4(적대 검증) 스킵을 기본으로 — 되돌리기 어려운 작업에서 특히 금지
- deep-research를 재구현 — 빌트인/설치된 스킬을 **호출**만 (Artibot 자체 딥리서치 스킬 없음)
- `/plan`과 동일하게 동작 — ultraplan은 ground+council+adversarial가 본질. 빠른 계획은 `/plan` 사용

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 자율 실행 | `/autopilot` | Goal Contract로 무인 실행 |
| 2 | 병렬 구현 | `/team` | 교차검증 병렬 팀 |
| 3 | 공수 산정 | `/estimate` | 계획 기반 산정 |
| 4 | 결정 기록 | `/adr` | 되돌리기 어려운 선택 ADR 기록 |
