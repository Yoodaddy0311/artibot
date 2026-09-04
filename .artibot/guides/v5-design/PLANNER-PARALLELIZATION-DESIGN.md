# Planner 병렬화 설계안 — INTAKE/PLAN 분리 · 영역별 sub-planner · affectedPaths 자기선언

- 상태: **설계안 (오너 승인 대기) — 프로덕션 코드 변경 0, 커밋 0**
- 기준: `master @ 3bcadb8e` (v4.53.0), 2026-09-03 실측
- 발주: `CHANGELOG.md:104` "planner 병렬화 | Phase 0 범위 밖 — 오너 후속 요청으로 별도 단위 | 추후"
- 상위 정본: `ARTIBOT-5.0-DESIGN.md` (§3.1 Mission Compiler · §3.5 토폴로지 · §7.2 §7-8/§10/§16-17)
- 모든 경로는 `plugins/artibot/` 기준. 리포 루트 파일은 `<root>/` 로 표기.

---

## 0. 한 줄 판정

세 갈래 중 **하나는 이미 있고, 하나는 반만 있고, 하나는 없다.**

| 갈래 | 현재 | 판정 | 권고 |
|---|---|---|---|
| ③ affectedPaths 자기선언 | **있다** — `autopilot --fast` · `/split` 이 같은 술어(`fast-profile.js#areAffectedPathsConflicting`)를 쓰고, v5 Task Graph 스키마에 `file_ownership` 필드까지 있다 | 새로 만들지 않는다 | **승격만** — 선언은 있는데 *검증기*가 없다(산문 계약). 순수 검증기 1개 + Observe 계측 1개 |
| ① INTAKE/PLAN 분리 | **반** — autopilot 은 Phase 0/1 로 나뉘어 있으나 **같은 planner 를 같은 형태로 두 번 부른다**. `/plan`·`/team` 은 INTAKE 산출물이 없다 | 계약 분리 | 코드가 아니라 **입출력 계약** 분리. INTAKE 산출물 = 영역 선언, PLAN 산출물 = 작업 매니페스트 |
| ② 영역별 sub-planner | **없다** — 유일한 병렬 계획은 `/ultraplan` Phase 2 DIVERGE(렌즈 병렬, 영역 분할 아님) | **지금 하지 말자** | 단일 planner 가 병목이라는 측정치가 0건이다. ①·③ 착지 후 Observe 원장으로 판단. 설계는 접합점만 남긴다(§4.3) |

핵심 근거: 2026-09-02 v5 구축 세션(`runtime/autopilot/ap-20260902-062936-tyc5j4.json`)은 **단일 planner 가 52개 작업에 affectedPaths 를 자기선언**했고(129 경로, 글롭 19, 작업당 최대 6), 병렬 실패 원인은 planner 가 아니라 ① `not-independent` 34/52 (planner 의 정직한 선언) ② `no-integration-worktree`(`--worktree` 미지정) 였다. 그리고 그 세션에서 **affectedPaths 밖 착지가 최소 8건** 리더 승인으로 통과했다(`ARTIBOT-5.0-DESIGN.md:589,615,633`) — 자기선언은 되는데 **autopilot/team 경로에는 강제·계측이 0** 이라는 뜻이다. 문제는 "계획을 더 빨리 세우는 것"이 아니라 **"세운 계획이 지켜졌는지 재는 것"** 이 먼저다.

---

## 1. 현재 구조 (file:line — 전부 직접 열어 확인)

### 1.1 planner 는 어디서 불리나 — 호출 지점 10곳 / 7파일

`grep -rn "artibot:planner" commands/ skills/ agents/` (2026-09-03):

| 파일 | 건 | 어떤 역할로 |
|---|---|---|
| `commands/autopilot.md:311` | 1 | **Phase 0 INTAKE** — PRD 작성 (`[Autopilot Phase 0] 사용자 요청: {task} … PRD 템플릿`) |
| `commands/autopilot.md:316` | 1 | **Phase 1 PLAN** — `[Autopilot Phase 1] PRD: {prdPath} 분해 + 위험 식별 + 병렬 팀 구성 제안` |
| `commands/plan.md:44` | 1 | Step 3 Delegate — 리더가 Step 1~2(Parse·Context)를 한 뒤 planner 1회 |
| `commands/ultraplan.md:80` | 1 | Phase 2 DIVERGE — `lens-{sid}-mvp` (architect 2개와 **병렬**, 렌즈별) |
| `commands/team.md:435` | 1 | Agent Selection Guide 표 (Phase 1 DECOMPOSE 는 **리더 전용**, `team.md:95`) |
| `commands/implement.md` · `commands/adr.md` | 1+1 | 파이프라인 첫 단계 |
| `agents/orchestrator.md` | 3 | 위임 예시 |

**planner 에이전트 자체** (`agents/planner.md`):
- `:17` `model: fable` (allowlist 8종 — `artibot.config.json:65-78`), `:19-27` tools = Read/Grep/Glob + SendMessage/Task* — **`Agent` 도구 없음** → planner 는 sub-planner 를 스스로 스폰할 수 없다(architect 는 `Agent(Explore)` 보유, `agents/architect.md:24`). `:28` `permissionMode: plan`, `:29` `maxTurns: 25`.
- `:46-53` Process 표: 1 Discover(요구·컨텍스트) → 2 Decompose → 3 Risk → 4 Deliver — **요구 해석과 분해가 한 프롬프트·한 패스**다.
- `:55-83` Plan Template / `:86-97` Output Format — 전부 **산문**. `affectedPaths`·`independent`·`worktreeEligible` 라는 단어가 이 파일에 **0건**.

### 1.2 autopilot: INTAKE 와 PLAN 은 이미 별개 phase 다

- `lib/autopilot/engine.js:49-58` `PHASES = ['INTAKE','PLAN','EXECUTE',…]` (config 사본 `artibot.config.json:757-765`).
- **Phase 0** `engine.js:107-180 runPhase0Intake` — `generatePRD()` 로 **결정적 템플릿** PRD 를 쓴다(`lib/autopilot/prd-generator.js:120 renderPRD`, 순수 함수, LLM 호출 0 — `Agent(`·`fetch(`·`llm` grep 0건). 그 뒤 리더가 `autopilot.md:311` 대로 planner 에게 PRD 본문을 채우게 한다.
- **Phase 1** `engine.js:183-206 runPhase1Plan` — `agent: 'planner'`(`:196`) **문자열 하나**. 반환 지시는 `:198-203` 4줄 산문("작업 단위 분해, 위험 식별, 병렬화 가능 여부 표 … markdown 표").
- `--fast` 일 때만 planner 결과가 구조화된다: `autopilot.md:318` "planner 결과를 `state.fastTasks` 로 저장한다. 각 작업은 stable ID, `dependsOn`, `independent: true`, non-empty repo-relative `affectedPaths`, `risk`, `worktreeEligible`" — **이 변환을 하는 lib 코드는 0건**(`grep -rn fastTasks lib/` → 읽는 쪽 `fast-execution.js:18-22 getFastTasks` 뿐, 쓰는 쪽 없음). 즉 planner 산문 → JSON 은 **리더(모델)가 손으로** 한다.
- **Phase 2** `engine.js:319-372 runPhase2Execute` → `planFastExecution` → `fast-profile.js#buildFastFanoutPlan`.

**무엇이 순차이고 왜**:
| 구간 | 순차? | 진짜 의존인가 |
|---|---|---|
| INTAKE → PLAN | 순차 | **진짜 의존** — PLAN 지시가 `state.prdPath` 를 읽는다(`engine.js:200`) |
| PLAN 내부(planner 1인) | 순차 | **아니다** — `agent: 'planner'` 단일 문자열일 뿐, 엔진은 여러 위임을 금지하지 않는다. 그냥 그렇게 짠 것 |
| PLAN → EXECUTE | 순차 | 진짜 의존 — `fastTasks` 가 있어야 wave 를 만든다 |
| INTAKE 의 "요구 해석" 과 PLAN 의 "분해" | planner 프롬프트 안에서 섞임 | **아니다** — `planner.md:46-53` 4단계를 한 턴에 요구한다. v5 설계는 이미 둘을 갈랐다: `intent.md`(Mission Compiler, §3.1) → `plan.md`/Task Graph (`ARTIBOT-5.0-DESIGN.md:366` §47 파이프라인 `intent.md → Execution Profile → Plan → Task Graph`) |

### 1.3 `/plan` · `/team` · `/ultraplan`

- `/plan` (`commands/plan.md:38-48`): Step 1 Parse·Step 2 Context 는 **리더**, Step 3 에서 planner 1회. INTAKE 산출물 없음(PRD 는 `--prd` 옵트인, `:28`). Step 4 Validate 가 보는 것은 순환의존·테스트 누락·미참조 파일(`:49-52`) — 파일 소유권 겹침은 안 본다.
- `/team` (`commands/team.md:95-105` Phase 1 DECOMPOSE): 리더가 "by file, by domain, by concern" 으로 나눈다(`:103`). 파일 범위는 `TaskCreate(description="{scope, files, success criteria}")`(`:190`) 산문 안에만 있다. `affectedPaths` 0건. 크로스체크 표(`:300-301`)의 "변경 파일: {files}" 도 산문.
- `/ultraplan` (`commands/ultraplan.md:70-90`): Phase 2 DIVERGE 가 planner 1 + architect 2 를 **병렬** 스폰 — 이것이 리포 안의 유일한 "다중 planner" 선례다. 단, **렌즈(MVP/위험/장기)** 로 나누지 **영역** 으로 나누지 않고, Phase 3 종합은 리더가 best-of-all 합성(`:87-89`). 영역 분할 + 기계적 병합의 선례는 **아니다**.

### 1.4 affectedPaths — 이미 있는 것의 전체 목록

| 층 | 위치 | 하는 일 |
|---|---|---|
| 선언 형태 | `commands/autopilot.md:80-81, :318` · `commands/split.md:63` | 작업 메타 6필드 `{id, dependsOn, independent, affectedPaths, risk, worktreeEligible}` — 두 커맨드가 **같은 형태**를 쓴다(`split.md:63` "autopilot Phase 1 planner 와 같은 형태") |
| 겹침 술어 | `lib/autopilot/fast-profile.js:114-118 areAffectedPathsConflicting` ← `:98-105 pathsOverlap` ← `:88-96 pathBase` | 글롭은 첫 와일드카드 앞 디렉터리로 **보수적** 후퇴(`:90-95`); 빈 base 는 무조건 충돌(`:101`) |
| 자격 판정 | `fast-profile.js:142-158 assessTask` | **허용목록형** — id·독립·안전경로·비어있지 않음·risk 알려짐·risk≤maxRisk·worktreeEligible 을 **전부** 만족해야 병렬 적격. 사유 10종(`missing-id`…`worktree-ineligible`, `dependency-cycle`, `dependency-not-fast`) |
| 경로 안전 | `fast-profile.js:57-82 isUnsafeRepoPath/inspectPath` | 절대·드라이브·`~`·`..`·비문자열 → `unsafe` → 직렬(`:70-76` 주석: 조용히 버리면 fail-open 이었던 실사고) |
| 스케줄 | `fast-profile.js:258-296 buildConflictGroups/buildWaves` | union-find 충돌군 + 위상 wave. 감사(`conflictGroups`)와 스케줄(`buildWaves`)이 **한 술어** `tasksConflict`(`:253-256`) |
| 소비자 1 | `lib/autopilot/fast-execution.js` → `engine.js:326` | autopilot `--fast` |
| 소비자 2 | `commands/split.md:65-79` → `.artibot/split/plan.json.limbs[].affectedPaths` | `/split plan` |
| 소비자 3 | `lib/topology/topology-router.js:258-274 computeMergeRisk` | v5 라우터의 mergeRisk 항(읽기만, 행동 0) |
| **강제(랜딩)** | `lib/git/limb-landing-check.js:293-307 ownershipCheck` ← `scripts/split/land.mjs:125 allowlist: entry.affectedPaths` | `git diff --name-only base...branch ⊆ affectedPaths ∪ .artibot/split/<limb>/**` — **`/split` 전용**. autopilot·team 경로에는 이 검사가 **없다** |
| v5 정본 | `schemas/task-graph.schema.json:85-89 file_ownership` · `lib/project-state/projection.js:111-112 owns` · `lib/supervisor/contracts.js:390-394 ownedPaths` · `lib/topology/split-state.js:91 owns` | 설계 §7-8 "`affectedPaths → file_ownership`"(`ARTIBOT-5.0-DESIGN.md:369`), §10 "**이미 일치** — 선언 위치만 Task Graph 로"(`:371`) |

**술어가 둘이라는 사실**(설계에 영향): `limb-landing-check.js:112-114` 주석 — "`fast-profile.js` has an overlap heuristic for globs, not a **matcher**, so nothing there was reusable". 즉
- *겹침*(두 선언이 같은 영역을 만질 수 있는가) = `areAffectedPathsConflicting` — 소문자화(`fast-profile.js:80`), 글롭은 디렉터리로 후퇴.
- *포함*(실제 변경 파일이 선언 안에 있는가) = `matchesAllowlist`(`limb-landing-check.js:150-156`) ← `allowlistEntryToRegExp`(`:118-141`) — 대소문자 보존, `**`/`*`/`?` 를 정규식으로.
두 술어는 서로 다른 질문에 답하고 **둘 다 필요**하다. 이 설계는 둘을 합치지 않고 그대로 부른다(§3).

### 1.5 실측 — 자기선언이 실제로 어떻게 쓰였나 (n=1 세션, 2026-09-03 08:xx 측정)

`node -e` 로 `runtime/autopilot/ap-20260902-062936-tyc5j4.json` 판독 (maxdepth 1 세션 JSON 2,249개 중 `fastTasks` 보유 **2개**; 다른 하나 `ap-20260826-020404-ft9t2b.json` 은 3개 작업):

| 항목 | 값 |
|---|---|
| fastTasks | **52** (`options.fast=true`, phase COMPLETED) |
| affectedPaths 총 / 글롭 / 작업당 최대 | 129 / 19 / 6 |
| `independent:true` / `worktreeEligible:true` | 18 / 48 |
| risk | low 19 · medium 33 |
| fastProfile | `profile:'fast', enabled:false, fallbackReason:'no-integration-worktree'`, requested 52 · eligible 18 · **planned 12** · conflictGroups **0** · estimatedSpeedup 1.44 |
| serial 사유 | `not-independent` 34 (전부) |
| 선언 위반 | `ARTIBOT-5.0-DESIGN.md:589` T-07·T-11·T-20·T-37·T-40·T-46·T-32 "affectedPaths 밖 착지 … 전부 리더 승인", `:615` T-37·T-52 2차, `:633` T-37 3차 |

읽는 법: 단일 planner 가 52개를 한 번에 선언했고 적격 18개 사이 충돌은 0 이었다. **계획 수립 병렬화로 얻을 것이 이 세션엔 없었다.** 반면 선언 밖 착지가 ≥8 건인데 이를 잡은 것은 게이트가 아니라 리더의 수동 대조(T-49)였다.

### 1.6 테스트가 보는 범위

- `tests/autopilot/fast-profile.test.js`: it 17건, 픽스처 최대 **10 작업**(라이브 52 의 1/5). 글롭·불안전 경로·순환·중복 케이스는 있다.
- `tests/autopilot/engine.test.js:219-221`: `runPhase1Plan` 단언은 **`typeof inst.type === 'string'` 하나**. PLAN 지시 형태를 바꿔도 이 테스트는 안 깨진다.
- `tests/topology/topology-router.test.js`: it 76건(mergeRisk 언급 18). `tests/git/limb-landing-check.test.js`: it 26건.
- `tests/firewall/split-limits-applied.test.js:15-18`: "픽스처가 cap 과 같은 크기면 아무것도 증명 못 한다" 를 이미 명문화한 선례 — 이 설계의 게이트도 같은 규칙을 따른다(§5).

---

## 2. 리더 전제 대조 (지시 §"먼저 할 일")

| 리더 전제 | 판정 |
|---|---|
| 정본 경로 `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` | **맞다** (647줄, 실재) |
| "`/split` 의 파일 소유권 판정이 이미 리포에 있다 — `skills/split/`·`lib/` 계열" | **맞다, 위치 정정** — 판정 코드는 `skills/split/` 이 아니라 `lib/autopilot/fast-profile.js`(autopilot `--fast` 와 공유) + `lib/git/limb-landing-check.js`(랜딩 강제). `skills/split/` 은 언제 쓰는지와 안전 규약만(`skills/split/SKILL.md:26`) |
| "보고서 §5 원문" | **출처 미확인** — 리포 전역 grep 에서 "planner 병렬화" 는 `CHANGELOG.md:104` 한 곳뿐. 별도 보고서 §5 는 찾지 못했다(문구는 동일하므로 내용상 문제 없음) |
| "현재가 단일 패스인지" | **autopilot 은 2-phase / planner 프롬프트는 단일 패스** (§1.2). `/plan`·`/team` 은 단일 패스 |

---

## 3. 겹침 판정 알고리즘 (허용목록 — 새 술어를 만들지 않는다)

### 3.1 원칙

1. **술어는 기존 2개를 그대로 호출한다.** 겹침 = `areAffectedPathsConflicting`, 포함 = `matchesAllowlist`. 세 번째 술어를 만들면 `topology-router.js:240-249` 가 경계한 "측정처럼 보이는 0" 이 생긴다.
2. **허용목록**: 어떤 단위(작업이든 영역이든)가 병렬로 가려면 아래 조건을 **전부** 만족해야 한다. 하나라도 판정 불가면 그 단위는 직렬(또는 단일 planner)이다. 새 조건이 추가되면 기본은 "불통과" 다.
3. **미지 = 축소**: `fast-profile.js:4-6` 헤더 규칙("Missing or ambiguous metadata always reduces concurrency instead of guessing") 을 계획 단계에도 그대로 적용.

### 3.2 작업 단위 (③ 승격 — 지금 있는 것을 계약으로)

```
PlanTaskManifest = { schema_version: 1, tasks: PlanTask[] }
PlanTask = { id, title, dependsOn[], independent, affectedPaths[], risk, worktreeEligible, verification, agentType?, tier? }
```
(= 라이브 세션이 이미 쓰는 형태 §1.5 — 필드를 **추가하지 않는다**. `file_ownership` 으로의 사상은 §7-8 이 정한 대로 어댑터에서.)

검증기 `validatePlanManifest(manifest, { profile })` (순수, L2) 의 판정 = `fast-profile.js#assessTask` 를 **재사용**해 얻은 `eligible/reason` 그대로 + 매니페스트 층 조건 2개:

| # | 조건 | 통과 실패 시 |
|---|---|---|
| M1 | JSON 파싱 성공, `tasks` 배열 | 매니페스트 전체 **거부** → 리더가 planner 에 재요청(산문 폴백 없음 — 폴백을 두면 다시 산문으로 돌아간다) |
| M2 | `id` 전건 유일·비어있지 않음 | `assessTask` 의 `missing-id`/`duplicate-id` 그대로 |
| M3~ | `assessTask` 10종 사유 | 해당 작업 `serial` — 이미 있는 동작 |

즉 **새 판정 로직은 M1 뿐**이다. 나머지는 `buildFastFanoutPlan` 이 하던 일을 PLAN 종료 시점으로 **앞당겨** 리더에게 보여주는 것이다(지금은 EXECUTE 에 들어가서야 `serial` 사유가 나온다 — `engine.js:357`).

### 3.3 영역 단위 (② 접합점 — config OFF 상태로만 설계)

INTAKE 가 `domains[] = [{ id, scopePaths[], rationale }]` 를 선언했을 때, sub-planner 병렬이 허용되는 조건(**전부** 만족):

| # | 조건 | 술어 | 실패 시 |
|---|---|---|---|
| D1 | `domains.length ≥ 2` 이고 `≤ planning.subPlanners.maxDomains` | 길이 | 단일 planner |
| D2 | 모든 `scopePaths` 가 `inspectPath` 로 **안전**(`unsafe:false`) 하고 비어 있지 않음 | `fast-profile.js:66-82` (export 필요 — 현재 모듈 내부) | **전체** 단일 planner (한 영역이 불안전하면 나머지도 병렬 금지 — `inspectServerEntryPaths` `:237-241` 와 같은 fail-closed) |
| D3 | 모든 쌍 `(a,b)` 에 대해 `areAffectedPathsConflicting(a.scopePaths, b.scopePaths) === false` | `:114-118` | 단일 planner (충돌 쌍만 합치는 최적화는 **하지 않는다** — 영역 병합 규칙이 또 하나의 술어가 된다) |
| D4 | sub-planner 가 낸 각 작업의 `affectedPaths` 전건이 자기 영역 `scopePaths` 에 **포함** | `matchesAllowlist(path, scopePaths)` (`limb-landing-check.js:150`) — 글롭 선언은 매칭 대상이 아니라 allowlist 쪽이므로 `path` 가 글롭이면 **불포함**으로 본다 | 그 작업 `reason:'scope-escape'` → **직렬** (버리지 않는다 — 계획에서 사라지면 fail-open) |
| D5 | 병합 후 `id` 유일 (sub-planner 에 `{domainId}-` 접두 강제) | M2 | 접두 없는 id 는 `missing-id` 직렬 |
| D6 | 병합 후 `dependsOn` 이 다른 영역 id 를 가리키면 | `assessTask` `unresolved-dependency` (기존) | 직렬 — 교차 영역 의존은 병렬 계획이 못 보는 것이므로 잃는 것이 맞다 |

병합 = 매니페스트 union → §3.2 검증기 → `buildFastFanoutPlan` (이미 교차 영역 충돌을 union-find 로 잡는다). **새 병합 알고리즘 없음.**

### 3.4 이 알고리즘이 부정 목록이 아닌 이유

- 작업이 병렬로 가는 유일한 길은 `eligible === true` 이고, `eligible` 은 조건 전건 AND 다(`assessTask` `reason === null` 일 때만). 새 필드·새 상태가 생겨도 검사에 없으면 `reason` 이 붙지 않으니 통과하는 것이 아니라 — **새 조건은 반드시 `reason` 을 하나 추가하는 형태로만 들어온다**는 규칙을 `tests/firewall/` 에 고정한다(§5 게이트 G3).
- 영역은 D1~D6 전건 AND. "이런 경우는 병렬 금지" 목록이 아니라 "이 여섯을 다 만족할 때만 허용".

---

## 4. 변경 지점 (갈래별 · 파일·함수)

### 4.1 갈래 ③ 승격 — "선언 검증기 + 이탈 계측" (권고: **1단계**, 행동 변화 0)

| 변경 | 파일 | 내용 |
|---|---|---|
| 신설 | `lib/planning/plan-manifest.js` | `parsePlanManifest(text) → {ok, manifest|null, error}` (`` ```json `` 펜스 1개 추출) · `validatePlanManifest(manifest, {profile}) → {ok, tasks, rejected[{id,reason}], summary}` — `assessTask` 는 비공개(`fast-profile.js:142`)이므로 **`buildFastFanoutPlan({fast:true, tasks, limits})` 를 호출해 `serial[].reason` 을 읽는다**(export 추가 없이 재사용. `fast:true` 는 판정용이지 실행 아님 — `cpuCount` 는 미지정) |
| 신설 | `lib/planning/plan-ownership-audit.js` | `auditOwnership({ changedFiles, tasks }) → { escaped[{file}], coveredBy[{file, taskIds}] }` — `matchesAllowlist` 재사용. 순수; `changedFiles` 는 호출자가 `git diff --name-only <checkpointSha>...HEAD` 로 넘긴다 |
| 배선(산문) | `commands/autopilot.md:316-318` | Phase 1 프롬프트 말미에 "출력은 반드시 ```json PlanTaskManifest``` 1블록" · 리더는 `validatePlanManifest` 후 `state.fastTasks` 저장 · `rejected` 는 진행률 박스 아래 표로 출력 |
| 배선(산문) | `commands/autopilot.md` Phase 3 CROSS_CHECK 직전 | `auditOwnership` 결과 `escaped` 를 **표로 출력만** (PAUSE 아님 — Observe) |
| 배선(산문) | `agents/planner.md` "Output Format" | 매니페스트 블록 형식 1절 추가 (Plan Template 산문은 유지 — 사람용) |
| 계측 | `schemas/ledger-events.allowlist.json` | 이벤트 2개 등록: `plan.manifest.validated {total, eligible, rejectedByReason}` · `plan.ownership.audited {changed, escaped, coverage}` — allowlist 에 없으면 `ledger.rejected` 로 떨어진다(스키마 설명문) |
| 게이트 | `tests/firewall/plan-manifest-contract.test.js` | §5 G1·G3 |
| config | `artibot.config.json#planning` (신설 최상위) | `{ "manifest": { "mode": "observe" } }` — `observe`(기록만)·`off`(파싱 생략, 현행) 두 값만. `block` 은 Canary 단계에서 값 추가 |

**영향 파일 목록(③)**: 신설 2 + 산문 3 + 스키마 1 + 테스트 1 + config 1 = 8. `lib/autopilot/*` **무수정**.

### 4.2 갈래 ① INTAKE/PLAN 계약 분리 (권고: **2단계**)

무엇을 나누나: planner 에게 **두 종류의 프롬프트**를 준다. 코드 phase 는 그대로(autopilot 은 이미 둘).

| 변경 | 파일 | 내용 |
|---|---|---|
| INTAKE 계약 | `agents/planner.md` 신규 절 `## Intake Output` | `IntakeManifest = { goal, explicit_requests[], domains[{id, scopePaths[], rationale}], open_questions[], assumptions[] }` — `goal`·`explicit_requests` 는 v5 `compileMission()` 출력 필드명과 **동일**(`lib/mission/compiler.js` 헤더 — verbatim 규칙). planner 가 새로 짓지 않고 **compileMission 결과를 프롬프트로 받아 채운다**(Observe 단계에서 이미 매 프롬프트마다 계산된다 — `ARTIBOT-5.0-DESIGN.md:255`) |
| PLAN 계약 | 동 파일 | 입력 = IntakeManifest + PRD, 출력 = PlanTaskManifest(§4.1). Process 표 `:46-53` 의 1 Discover 는 INTAKE 로, 2~4 는 PLAN 으로 **문장만** 이동 |
| autopilot | `commands/autopilot.md:311` Phase 0 | 프롬프트에 "PRD + IntakeManifest 블록" 요구. `engine.js` 무수정 — `runPhase0Intake` 가 만든 DRAFT PRD 는 그대로, 리더가 IntakeManifest 를 `state.intake` 에 저장(새 키; `session-store.js` 는 미지 키를 거부하지 않는다 — `schemaVersion` 만 본다 `:133-134`) |
| `/plan` | `commands/plan.md:38-44` | Step 1~2 를 **planner INTAKE 호출**로 대체할지, 리더가 계속 할지 — **리더 유지 권고**(planner 는 `permissionMode: plan` 이라 Bash 가 없고 `/plan` Step 2 는 Grep 중심이라 리더가 더 싸다). IntakeManifest 는 리더가 채운다 |
| `/team` | `commands/team.md:95-105` Phase 1 | DECOMPOSE 산출을 PlanTaskManifest 형태로 — `TaskCreate description` 산문(`:190`) 옆에 `affectedPaths` 를 **명시 필드**로. 크로스체크 표 `:300-301` "변경 파일" 은 `auditOwnership` 결과로 채움 |
| 질문 게이트 | `lib/planning/question-gate.js` | `open_questions[]` 가 있으면 `requiresQuestion` 4조건 판정 → 필요 시 `AskUserQuestion`. **새 코드 0** — 이미 순수 판정기 |
| config | `artibot.config.json#planning.intake.enabled` | `false` 기본. `true` 면 두 프롬프트, `false` 면 오늘의 단일 프롬프트 |

**진짜 의존 확인**: INTAKE → PLAN 은 순차가 맞고 그대로 둔다(§1.2). 나누는 이득은 병렬이 아니라 **② 의 입력(`domains[]`)이 생기는 것**과 `explicit_requests` 가 verbatim 으로 PLAN 에 들어가 스코프 치환(Intent Fidelity)을 잡을 수 있는 것.

### 4.3 갈래 ② 영역별 sub-planner (권고: **지금 하지 말자** — 접합점만)

**근거가 약한 이유** (없는 것을 고치지 않는다):
1. 병목 측정치 0. `runtime/autopilot/` 에서 PLAN phase 소요 시간·planner 턴 수 분포를 잰 기록이 없다(세션 JSON `phases[]` 에 duration 은 있으나 v5 세션 1건뿐이고 `runtime/autopilot/` 은 vitest 잔재로 오염 — `ARTIBOT-5.0-DESIGN.md:209` "autopilot 기준선은 오염").
2. n=1 실측(§1.5)에서 단일 planner 는 52 작업을 처리했고 적격 작업 간 충돌 0. 계획이 느려서 병렬이 막힌 것이 아니다.
3. 비용은 확실히 오른다: planner 는 fable 티어(`config:65-78`), N 영역 = N 배 + 병합 라운드. 계수 2.6× 는 미검증(agent-coordination 규칙).
4. planner 가 `Agent` 도구가 없어(§1.1) 스폰은 리더가 해야 하고, 리더 컨텍스트 소모는 `/split` 실측에서 이미 사고 원인이었다(`skills/split/references/operations.md:24` "리더가 2.5KB 프롬프트를 창마다 복제").

**그래도 남겨 둘 접합점** (①·③ 착지 후 Observe 수치로 켤 수 있게):
| 항목 | 위치 |
|---|---|
| 켜는 조건(측정) | Observe 원장에서 `plan.manifest.validated.total ≥ 30` 인 세션의 PLAN phase 소요가 EXECUTE 첫 wave 소요보다 긴 비율 — 이 수치가 있어야 논의 시작. 임계는 **미정** |
| 스폰 주체 | 리더(`/team` Phase 2 와 같은 `Agent(name="plan-{sid}-{domainId}", subagent_type="artibot:planner")`). planner 에 `Agent` 도구를 주지 **않는다** (설계 §16 "Planner = 제안 가능" `ADDENDUM-HARDENING.md:627` — 위임 깊이 증가는 §36 cap 대상) |
| 입력 | IntakeManifest.domains (§4.2) + §3.3 D1~D3 통과 |
| 병합 | §3.3 D4~D6 → `validatePlanManifest` → `buildFastFanoutPlan` |
| config | `planning.subPlanners: { enabled: false, maxDomains: 4 }` — `maxDomains` 는 `split.maxWindows` 와 **다른 개념**(창 수 ≠ 계획 영역 수)이라 `*Ref` 로 묶지 않는다. 같다고 판단되면 그때 `maxDomainsRef` 로 바꾼다 |

---

## 5. 이 설계가 못 보는 것 (게이트·테스트가 구조적으로 못 잡는 영역)

| # | 못 보는 것 | 왜 | 대신 무엇으로 |
|---|---|---|---|
| B1 | **선언의 진실성** — planner 가 `affectedPaths` 를 좁게 쓰거나 `independent:true` 를 후하게 쓰는 것 | 검증기는 형태만 본다. 라이브 34/52 `not-independent` 가 정직한 값인지 보수적인 값인지 알 수 없다 | `plan.ownership.audited.escaped` 실측(§4.1). 이것이 0 이 아니면 자기선언은 계약이 아니라 희망이다 |
| B2 | **픽스처 크기** — `fast-profile.test.js` 최대 10 작업, 라이브 52·경로 129·글롭 19 | 10 으로 그린이면 52 에서 union-find·wave 가 어떻게 되는지 아무것도 증명 못 한다(이 리포 실사고: 접기 테스트 픽스처 수백 B vs 실제 31,900B) | G2: 라이브 세션 JSON 을 **동결 픽스처**로 복사(`tests/fixtures/plan-manifest/ap-20260902-52tasks.json`)해 `validatePlanManifest` 가 `eligible 18 / serial 34` 를 그대로 재현하는지 |
| B3 | **두 술어의 불일치** — `areAffectedPathsConflicting` 은 소문자화(`fast-profile.js:80`), `matchesAllowlist` 는 대소문자 보존 | `Lib/A.js` vs `lib/a.js`: 겹침은 "충돌", 포함은 "불포함" — 둘 다 **안전한 방향**이지만 Windows(대소문자 무시 FS)에서 같은 파일이 두 이름으로 선언되면 포함 검사가 오탐한다 | 문서화만. 통일은 별도 단위(둘 다 테스트 26·17건이 형태를 고정하고 있다) |
| B4 | **LLM 비결정성** — INTAKE 의 `domains[]` 분할은 같은 요청에 다른 답이 나올 수 있다 | 순수 함수 게이트가 잡을 수 없다 | Shadow: 같은 PRD 로 2회 INTAKE → `domains` 일치율. 임계 미정 |
| B5 | **교차 영역 의존 손실**(② 켰을 때) | D6 이 직렬화하므로 안전하지만 병렬 이득이 조용히 사라진다 | `rejectedByReason.unresolved-dependency` 비율 계측 |
| B6 | **`runPhase1Plan` 형태 회귀** | 기존 단언 1개(`engine.test.js:221`) | ③ 에서 엔진을 안 건드리므로 이번엔 해당 없음. ② 에서 지시 형태를 바꾸면 그때 단언 추가 |
| B7 | **autopilot 비-worktree 경로의 이탈 측정 기준점** | 작업별 브랜치가 없어 `git diff` 를 작업 단위로 못 자른다 — `auditOwnership` 은 **세션 전체** 변경 ⊆ 전체 선언 union 만 본다. 어느 작업이 이탈했는지는 못 가른다 | 작업별 귀속은 `/split`(브랜치 있음) 에서만. autopilot 은 union 수준 계측으로 시작 |
| B8 | **config 파이어월 범위** | `tests/firewall/v5-config-firewall.test.js` 는 최상위 키 5종만 allowlist — 신설 `planning` 은 그 사정권 밖 | G4: 같은 파일에 `planning` 행 추가(하위 키 allowlist) |

게이트 목록(전부 `tests/firewall/` vitest — 스크립트형 금지):
- **G1** `plan-manifest-contract.test.js`: 라이브 동결 픽스처 52 작업 → `eligible 18 / serial 34 / not-independent 34` 재현(B2). 픽스처는 cap(12)보다 커야 한다.
- **G2** 동 파일: `validatePlanManifest` 의 모든 `rejected.reason` 값이 `assessTask` 사유 10종 ∪ {`manifest-unparseable`, `scope-escape`} **allowlist 안**에만 있다 — 새 사유가 생기면 RED(부정 목록 fail-open 봉쇄).
- **G3** 동 파일: 스캐너 자기검증 — 필드 하나를 지운 변형 픽스처가 반드시 `eligible` 을 **줄이거나 같게** 한다(미지 = 축소). 늘어나면 RED.
- **G4** `v5-config-firewall.test.js`: `planning` 하위 키 allowlist + `manifest.mode ∈ {off, observe}`.
- **G5** `ledger` 어휘: `plan.manifest.validated`·`plan.ownership.audited` 가 allowlist 에 등록돼 `ledger.rejected` 로 떨어지지 않는다(기존 `ledger-append-survival` 계열이 이미 검사하는 형태).

**게이트 옆에 적는 것**: G1~G5 그린은 "검증기가 설계대로 판정한다" 이지 "planner 가 정직하다"(B1) 도 "병렬이 빨라진다"(② 미측정) 도 아니다.

---

## 6. 되돌리기 경로

| 갈래 | 끄는 법 | 남는 것 |
|---|---|---|
| ③ 검증기·계측 | `artibot.config.json#planning.manifest.mode = "off"` **1줄** → 리더가 파싱·감사 단계를 건너뛰고 오늘처럼 산문→`fastTasks` 수동 변환 | `lib/planning/plan-manifest.js`·`plan-ownership-audit.js` 는 순수 모듈이라 남아도 호출 0. 원장 이벤트 2종은 발화 0 |
| ① 계약 분리 | `planning.intake.enabled = false` **1줄** → 단일 프롬프트 | `agents/planner.md` 의 Intake 절은 남는다(문서). `state.intake` 키는 세션에 남아도 소비자 0 |
| ② sub-planner | `planning.subPlanners.enabled = false` (**기본값**) | 켠 적이 없으면 되돌릴 것도 없다 |
| 전부 | `planning` 블록 삭제 → G4 RED → 테스트도 같이 삭제 | 산문 3파일 diff revert |

엔진(`lib/autopilot/engine.js`)·`fast-profile.js`·`limb-landing-check.js` 는 **어느 단계에서도 수정하지 않는다** — 되돌리기가 config 와 산문에만 걸리게 하기 위해서다.

---

## 7. 단계 분할

| 단계 | 내용 | 독립 착지 | 행동 변화 | v5 로드맵 대응(`ARTIBOT-5.0-DESIGN.md:252-258`) |
|---|---|---|---|---|
| **S1** ③ 승격 | `plan-manifest.js` + `plan-ownership-audit.js` + 원장 이벤트 2 + 산문 3 + G1~G5 | **가능** — 다른 단계 불필요 | **0** (`mode: observe` — 표 출력과 원장 기록만) | Observe |
| **S2** ① 계약 분리 | planner Intake/Plan 절 + `state.intake` + `/team` `affectedPaths` 명시 + `question-gate` 연결 | S1 필요(PlanTaskManifest 형식) | 0 (`intake.enabled=false` 출하) → 켜면 프롬프트 2회 | Shadow (`intent.md` 생성 시작과 같은 단계 — `goal/explicit_requests` 필드 공유) |
| **S3** ② sub-planner | 접합점 §4.3 | S1+S2 필요 + **측정 조건 충족** | 있음 (config 1키) | Canary |
| — | `manifest.mode: block` (이탈 시 PAUSE) | S1 후 Observe 수치 확인 | 있음 | Canary |

S1 만으로 완결되는 산출: "선언이 지켜졌는가" 의 **분모 있는 수치**(`escaped / changed`) — 오너가 요청한 세 갈래 모두의 전제다.

---

## 8. 하지 않기로 하는 것

1. **② 영역별 sub-planner 구현** — §4.3. 측정 전에 만들면 "빠르다" 를 증명할 방법이 없고, 비용은 확실히 든다.
2. **planner 에 `Agent` 도구 부여** — 위임 깊이 증가, §16 권한표(제안만) 위반, 리더 밖 스폰은 원장 계측이 안 된다.
3. **세 번째 겹침/포함 술어** — 둘을 합치거나 새로 쓰지 않는다(B3 는 문서화).
4. **`fastTasks` 를 엔진이 파싱** — `engine.js` 는 "에이전트를 부르지 않는다" 계약(`:4-6`)이라 planner 출력을 볼 수 없다. 파싱은 리더 단계에 두고 lib 는 순수 검증기만.
5. **`.plan-state.json` 확장** — 의존성 필드가 없고(`task-graph.schema.json:78` "this is where dependency truth now lives") NR1 파생 파일이라 설계가 이미 강등했다.
6. **`file_ownership` 으로 필드명 변경** — 소비자 4파일(`projection.js` 등)이 Task Graph 쪽 이름이고, 선언 쪽 `affectedPaths` 는 소비자 20+ 파일. 사상은 §7-8 대로 어댑터 1곳.

---

## 9. 오너 결정 요청

| # | 결정 | 권고 |
|---|---|---|
| P1 | S1 만 먼저 착지 vs S1+S2 동시 | **S1 만** — S2 는 S1 의 Observe 수치를 보고 |
| P2 | ② 를 "하지 않음" 으로 확정 vs "측정 후 재론" 으로 보류 | **측정 후 재론** (§4.3 조건) — 지금 확정 거부는 근거가 없기는 마찬가지 |
| P3 | `auditOwnership` 이탈 시 S1 부터 PAUSE 할지 | **아니오** — Observe 는 기록만. 라이브 8건 이탈 전부가 리더 승인 확장이었다(정당한 이탈이 있다) |
| P4 | `planning` 을 최상위 키로 vs `autopilot.planning` 아래로 | **최상위** — `/team`·`/plan` 도 소비한다 |

---

## 미확인

- "보고서 §5" 의 원 문서 — `CHANGELOG.md:104` 외 출처 미발견.
- PLAN phase 소요 시간·planner 턴 수의 라이브 분포 — `runtime/autopilot/` 오염(설계 `:209`)으로 측정 안 함. ② 판단의 전제 수치가 **없다**.
- fable 티어 비용 계수(2.6×) — 미검증(agent-coordination 규칙 그대로).
- Windows 대소문자 무시 FS 에서 B3 오탐이 실제로 난 적이 있는지 — 사례 0건 확인, 없다는 뜻은 아님.
- `session-store.js` 가 `state.intake` 같은 신규 키를 resume 마이그레이션에서 보존하는지 — `:133-134` `schemaVersion` 스탬프만 확인, 마이그레이션 함수 본문 미열람.
