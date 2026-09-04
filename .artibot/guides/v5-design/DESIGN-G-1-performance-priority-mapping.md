# 설계안 G-1 — `performance.priority` 5값 → 설계 어휘 매핑표

> **오너 승인 전 구현 금지.** 이 문서는 설계안이다. 코드·테스트·스키마·config 를 한 줄도 바꾸지 않았다.
> 작성 2026-09-03 15:4x KST · 기준 master @ `3bcadb8e` (v4.53.0) · 인용 경로는 전부 `plugins/artibot/` 기준(리더 브리프의 `lib/…`·`schemas/…` 는 리포 루트에 없다 — 실재 경로는 플러그인 하위).

---

## 0. 결론 먼저

| 값 | 매핑 | 근거 등급 | 한 줄 요약 |
|---|---|---|---|
| `fast` | **`maximum`** | **강**(문서 2홉, 코드 1곳 이미 같은 해석) | P02:72 "최대한 빨리 정확하게 → `autopilot --fast`" + DESIGN:129 "maximum(`autopilot --fast`)" |
| `speed_accuracy` | **`maximum`** | 중(토큰 구성 일치 — **추론**) | HARD:125 예시값 + policy:70 `autopilot_fast.optimization.primary: [time_to_verified_outcome, accuracy]` = DESIGN:129 maximum 의 목적함수 그대로 |
| `maximum_performance` | **`maximum`** | 중(산문 2홉 — **추론**) | P02:73 "토큰 아끼지 말고 → high-resource mode" + README:58/06:60 "large envelope 모드 = `autopilot --fast`·`split`" 중 split 은 토폴로지라 제외 |
| `quality` | **`balanced`** | 약(**판단**) | 설계에 "정확도만, 속도 무관" 가중치가 없다. policy:38-39 normal 목적함수에 `quality_constraint: no_quality_regression` 이 이미 붙어 있어 balanced 가 최근접 |
| `economy` | **`balanced`** | **근거 없음 — 판단**, **손실 매핑** | 설계에 "balanced 보다 싼" 가중치·예산 상한이 없다. 흡수하되 손실임을 reason 문자열과 문서에 남긴다 |

**스키마에서 빼야 할 값: 없다.** 다만 `economy` 는 "매핑 후에도 설계가 그 의도를 표현하지 못하는" 유일한 값이라, 흡수와 동시에 후속 결정(G-1b: economy 전용 directive 를 둘지)을 등록해야 한다.

**매핑을 미루면 안 되는 실측 이유(§1.5)**: 오늘 미해결 5값은 "중립"이 아니다. `directives:null` 로 떨어진 뒤 소비자 폴백 allowlist 가 `balanced` 하나뿐이라, **`economy` 를 쓴 미션이 폴백 경로에서 `maximum` 과 같은 행동(비용 가중치 0·하향 비활성)** 을 한다. 가장 아끼자는 값이 가장 쓰는 값처럼 돈다. 다만 현재 프로덕션 호출자 0 이라 **잠복 결함**이다(§1.4).

---

## 1. 실측 현재 상태

### 1.1 `DESIGN_PRIORITIES` 는 무엇인가 (코드 확정)

`plugins/artibot/lib/routing/execution-profile.js:70`
```js
export const DESIGN_PRIORITIES = Object.freeze(['balanced', 'maximum', 'split']);
```
출처 주석 `:68` "Source: ARTIBOT-5.0-DESIGN.md §3.2". 설계 원문은 `ARTIBOT-5.0-DESIGN.md:129`:

> balanced = `cost_per_accepted_outcome`(downgrade 활성) / maximum(`autopilot --fast`) = `time_to_verified_outcome`+accuracy, Cost 항 0, effort 하한 xhigh, downgrade 비활성 / split = maximum + ContextAffinity 0, 예산 상한 `split.dispatch.budget`(600k)

각 값이 라우팅에서 뜻하는 것 — 코드의 두 표를 그대로 옮긴다:

| 값 | `OBJECTIVE_BY_PRIORITY` (`:110-114`) | `PERFORMANCE_DIRECTIVES` (`:145-170`) |
|---|---|---|
| `balanced` | `cost_per_accepted_outcome` (ATTESTED policy:38) | costWeight 1 · contextAffinityWeight 1 · downgradeEnabled **true** · effortFloor null · accuracySecondaryObjective false · budgetCeilingRef null |
| `maximum` | `time_to_verified_outcome` (ATTESTED policy:70) | costWeight **0** · contextAffinityWeight 1 · downgradeEnabled **false** · effortFloor **xhigh** · accuracySecondaryObjective true · budgetCeilingRef null |
| `split` | `wallclock_throughput` (**UNATTESTED** — `:129-130` 자체 표기) | costWeight 0 · contextAffinityWeight **0** · downgradeEnabled false · effortFloor xhigh · accuracySecondaryObjective true · budgetCeilingRef `split.dispatch.budget` |

소비처: `escalation-controller.js:283` (`directives.downgradeEnabled`), `route-hysteresis.js:457` (`directives.costWeight`) — 두 파일은 다른 팀원이 동시 편집 중이라 줄번호는 16:01 재측정값, `adaptive-model-router.js:224-235` (`costWeight`·`contextAffinityWeight` → scoring term). 셋 다 "directives 가 오면 그것이 이긴다, 없으면 폴백".

### 1.2 스키마 8값과 4개 어휘의 출처

`plugins/artibot/schemas/execution-profile.schema.json:65-76` enum 8값. `$comment :77` 과 `schemas/execution-profile.README.md:73-89` 가 출처를 나눈다(직접 열어 재확인):

| 어휘 | 값 | 출처(파일:줄) | 성격 |
|---|---|---|---|
| DESIGN | `balanced` `maximum` `split` | `ARTIBOT-5.0-DESIGN.md:129` | 라우팅 **가중치가 정의된** 유일한 어휘 |
| MC | `economy` `balanced` `quality` `fast` `maximum_performance` | `package/schemas/mission-contract.schema.yaml:37` | v1.0 미션 계약 enum — **정의문 없음**, 열거만 |
| HARD | `speed_accuracy` | `ADDENDUM-HARDENING.md:125` | 8키 프로필 **예시 블록의 예시값** 1회 |
| V11 | `maximum` | `package-v1.1/04_INTENT_MD_SPEC.md:35`, `06_STATE_YAML_SPEC.md:43`(`performance_profile: maximum`) | DESIGN 과 동일 값 |
| P03 | `balanced` | `package/03_INTENT_MISSION_COMPILER.md:33` | 계약 스켈레톤 기본값 |
| P02(산문) | `economy/balanced/high-quality/fast/maximum-performance` | `package/02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md:58` | 하이픈 철자. 스키마 **미수용**(README:86-89) |

`README.md:232-235` 가 G-1 을 "정규화 표를 어느 문서도 공급하지 않는다"로 등록했고, `execution-profile.js:40-57` 헤더가 같은 이유로 fail-closed 를 택했다. 리포 전역 grep(`.artibot/guides` 전체, `--include=*.md,*.yaml`)에서 `economy|speed_accuracy|maximum_performance` 의 **정의문**은 0건 — 위 표의 열거·예시가 전부다. 이 점은 브리프의 전제와 일치한다.

### 1.3 `normalizePerformancePriority` 현행 동작 (`:255-276`)

```
absent/null/''            → { normalized:'balanced', reason:'default: …' }
non-string                → { normalized:null, reason:'invalid: …' }
∈ DESIGN_PRIORITIES       → { normalized:v, reason:'design vocabulary (…)' }
∈ SCHEMA_PRIORITIES       → { normalized:null, reason:'G-1 unresolved' }      ← 5값
else                      → { normalized:null, reason:'unknown: …' }
```
`executionProfile()` `:486-488`: `normalized` 가 null 이면 `objective:null, directives:null`. `profile.performance.priority` 는 원문 그대로 보존(`:479` cloneJson 통과, 테스트 `:180` 이 고정).

### 1.4 호출자 — 프로덕션 0 (잠복)

- `executionProfile(` 호출: `lib/ scripts/ commands/ hooks/` 에서 **import 0건**(`grep -rn "from '.*execution-profile"` 2026-09-03 15:40). 언급은 주석뿐(`adaptive-model-router.js:225`, `escalation-controller.js:109`, `route-hysteresis.js:150`, `subagent-handler.js:163`).
- `interpretIntent(` 호출: `scripts/ lib/runtime/ commands/ hooks/` 에서 0건.
- 따라서 오늘 `economy` 를 쓴 미션이 실제로 잘못 라우팅된 사례는 **없다**(만들 수 없다). 결함은 Shadow/Canary 배선 시점에 발현한다.

### 1.5 미해결 = 중립이 아니다 (이 설계안이 브리프에 더하는 실측)

`directives:null` 인 채로 프로필만 소비자에 넘기면 폴백이 돈다:

- `route-hysteresis.js:162` `COST_SAVING_PERFORMANCE = ['balanced']`, `:234-240` `resolveCostWeight`: directives 없음 → `performance === null || 목록 포함 ? 1 : 0`. **`economy` 는 목록 밖 → costWeight 0.** (줄번호 16:01 재측정 — 파일이 동시 편집 중)
- `escalation-controller.js:119` `DOWNGRADE_ENABLED_PERFORMANCE = ['balanced']`, `:217` `downgradeEnabled`: 목록 밖 → **하향 비활성**.

즉 폴백 경로에서 `economy`·`quality`·`fast`·`maximum_performance`·`speed_accuracy` 전부가 `maximum` 과 동일하게 취급된다. 이 중 `fast`·`speed_accuracy`·`maximum_performance` 는 우연히 옳고, **`economy` 는 정반대**, `quality` 는 판단 문제. 폴백 주석(`:110-117`)은 "absent 를 not-balanced 로 두는 이유"를 적었지 "G-1 5값이 여기로 온다"는 적지 않았다 — 두 모듈이 같은 입력을 다르게 해석하는 상태(브리프 §6 이 지목한 종류의 결함)다. 매핑표는 이 비대칭을 없앤다: 매핑 후 `directives` 가 항상 채워지므로 폴백에 도달하지 않는다.

### 1.6 `interpreter.js` 쪽 (브리프 인용 재확인)

- `plugins/artibot/lib/intent/interpreter.js:137-143` `PERFORMANCE_PRIORITIES` = MC 5값 정확히(`economy, balanced, quality, fast, maximum_performance`). `maximum`·`split`·`speed_accuracy` 는 **발행 불가**.
- `:150-153` `PERFORMANCE_PROSE_ALIASES` = `{'high-quality':'quality', 'maximum-performance':'maximum_performance'}` — P02 하이픈 → 스키마 언더스코어. 적용은 `:701` `applyExplicitPerformance` 의 **명시 설정 경로만**(prompt 추론 경로 `resolvePerformance :658-667` 는 lexicon `:307-330` 이 직접 스키마 철자를 낸다).
- `:170-176` `PERFORMANCE_PRECEDENCE` = `[maximum_performance, economy, fast, quality, balanced]`. `:158-167` 주석이 P02:70-77 표 두 행을 근거로 든다 — "'최대한 빨리 정확하게' → `autopilot --fast`, 그래서 `fast` 가 `quality` 를 이긴다". **인터프리터는 이미 `fast` 를 `autopilot --fast` 행으로 읽는다** — 매핑표 `fast → maximum` 의 코드 측 근거.
- `:383` `AXIS_DEFAULTS.performance = 'balanced'`.
- 제3의 사본: `lib/mission/contract.js:117-123` `PERFORMANCE_PRIORITIES`(MC 5값, `tests/mission/contract.test.js:66-67` 이 MC 스키마 enum 과 동일 고정). 매핑 대상이 아니라 계약 검증용이므로 이 설계안은 건드리지 않는다.

---

## 2. 매핑표 — 값별 근거

### 2.1 `fast → maximum` (근거 강)

1. `package/02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md:73` — "최대한 빨리 정확하게" → "consider `autopilot --fast`".
2. `ARTIBOT-5.0-DESIGN.md:129` — "maximum(`autopilot --fast`)" — 설계가 maximum 을 `autopilot --fast` 의 성능 의도로 **명명**.
3. `execution-profile.js:326` 플래그 어댑터 `{ flag:'fast', priority:'maximum' }` — 코드가 이미 `--fast` ≡ `maximum` 으로 쓴다.
4. `interpreter.js:158-163` — 인터프리터가 `fast` 축값을 P02:72 행(=`autopilot --fast`)으로 해석.

2홉(P02 산문 → 커맨드 → 설계 어휘)이지만 각 홉이 문서 원문이고 코드 2곳이 같은 해석을 이미 쓴다. `execution-profile.js:50-52` 가 "tempting synonym" 으로 경계한 것은 `maximum_performance`·`speed_accuracy` 이지 `fast` 가 아니다.

### 2.2 `speed_accuracy → maximum` (근거 중 — 추론)

1. `ADDENDUM-HARDENING.md:125` — 8키 예시 블록 `performance: { priority: speed_accuracy, budget: generous }`. 정의문 없음.
2. `package/config/artibot-v5-policy.example.yaml:68-71` — `topology.autopilot_fast: { token_policy: generous, optimization: { primary: [time_to_verified_outcome, accuracy] } }`.
3. `ARTIBOT-5.0-DESIGN.md:129` — maximum = `time_to_verified_outcome` + accuracy.

"speed_accuracy" 라는 토큰의 두 구성어(speed·accuracy)가 `autopilot_fast` 의 primary 목적함수 쌍(time_to_verified_outcome·accuracy)과 1:1 이고, 같은 예시 블록의 `budget: generous` 도 `autopilot_fast.token_policy: generous` 와 일치한다. 그러나 **어느 문서도 "speed_accuracy 는 maximum 이다"라고 쓰지 않는다** — 토큰 구성으로부터의 추론이다. `execution-profile.js:50-51` 이 명시적으로 거부한 "obviously" 추론이 이것이므로, reason 문자열에 `inferred` 를 남긴다.

### 2.3 `maximum_performance → maximum` (근거 중 — 추론)

1. `package/02:74` — "토큰 아끼지 말고 제대로 처리해" → "high-resource mode". 이름 붙은 모드가 아니다.
2. `package/README.md:58` — "`autopilot --fast` and `split` are intentional exceptions to the ordinary 'minimum sufficient resource' principle … use a large token/resource envelope"; `package/06_MODEL_ROUTING_ECONOMICS.md:60` 동문.
3. `interpreter.js:325-329` `maximum_performance` cue 에 '토큰 아끼지 말고' 가 있고 `:162-165` 주석이 P02:73 행을 이 값의 근거로 든다.

체인: `maximum_performance` ≡ P02:73 "high-resource mode" ≡ README:58 "large envelope 모드" = {`autopilot --fast`, `split`}. 둘 중 `split` 은 토폴로지(창을 사람이 연다 — DESIGN:202)이고 `/split` 플래그 어댑터(`:325`)가 별도로 잡으므로, 성능 의도로서는 `maximum`. 산문 2홉이라 추론 등급.

### 2.4 `quality → balanced` (근거 약 — 판단)

- 설계 3값 중 "정확도를 올리되 속도·비용은 요구하지 않는" 값이 **없다**. `maximum` 은 정의상 `autopilot --fast`(속도) 이고, `quality` 의 P02 표 대응 행은 `:76` "중요한 작업이니 꼼꼼하게 검토해 → strict Fable review" — **review 축**이지 performance 축이 아니다.
- 최근접 근거: `policy.example.yaml:38-39` `routing.objective: { normal: cost_per_accepted_outcome, quality_constraint: no_quality_regression }` — normal(=balanced) 목적함수에 품질 제약이 **이미 내장**. 즉 "quality" 의도는 balanced 가 기본으로 보장하는 것을 명시한 것으로 읽을 수 있다.
- 반대안 `quality → maximum` 의 논거: maximum 만이 `downgradeEnabled:false`·`effortFloor:'xhigh'` 로 "깎지 않음"을 강제한다. 틀렸을 때 비용: `→balanced` 가 틀리면 중요 작업에서 하향이 발생할 수 있다(단 `no_quality_regression` 제약 하에서), `→maximum` 이 틀리면 과지출. 두 방향 모두 근거가 정의문이 아니므로 **판단**으로 표기. 권고는 `balanced`(설계 문서의 명시 제약에 기대는 쪽). 오너가 `maximum` 을 택해도 표 한 줄 교체로 끝난다.
- 인터프리터 `PERFORMANCE_PRECEDENCE` 에서 `quality > balanced` 인데 둘이 같은 곳으로 가면 우선순위 구분이 라우팅에서 사라진다 — 프로필 `performance.priority` 에는 원문이 남으므로 **기록은 보존**, 행동만 합쳐진다. §5 참조.

### 2.5 `economy → balanced` (근거 없음 — 판단, 손실 매핑)

- 정의문 0건. `06:52` "Token economy hierarchy — normal mode" 절 제목이 "economy" 를 normal 모드와 나란히 두지만 값의 정의는 아니다.
- 설계 3값 중 balanced 보다 **싼** 것은 없다(costWeight 최대 1, normal 에 예산 상한 없음 — `PERFORMANCE_DIRECTIVES.balanced.budgetCeilingRef: null`). 따라서 어디로 보내도 "아끼라"는 의도는 라우팅에 반영되지 않는다. **손실 매핑**이다.
- 그래도 `balanced` 로 흡수해야 하는 이유: §1.5 — 미매핑 상태의 폴백이 `economy` 를 `maximum` 처럼 다룬다. `balanced` 로 보내면 최소한 "가장 싼 설계값"이 되고 하향이 활성화된다. null 보다 항상 낫다.
- 남는 문제는 **후속 결정 G-1b** 로 등록: economy 전용 directive(예: `costWeight` > 1 또는 `budgetCeilingRef: 'routing.economy.budget'`)를 둘지. 지금 만들면 설계 어휘가 4값이 되어 오너 결정("3값으로 흡수")과 어긋나므로 이 설계안 범위 밖.
- `interpreter.js:166-167` "economy sits above fast because an explicit budget ceiling constrains how fast the runtime is allowed to be" — 인터프리터 우선순위 근거가 **economy 에 예산 상한이 있다는 전제**인데 설계에는 없다. 매핑 후 economy+fast 동시 cue 프롬프트는 인터프리터 → `economy` → 라우터 `balanced` 로 가며, 그 순간 `fast`(→maximum) 신호가 버려진다. 이것은 매핑표가 만든 결함이 아니라 인터프리터 우선순위와 설계 가중치의 기존 불일치가 매핑으로 **가시화**되는 것. §5 에 기록, G-1b 와 함께 다룬다.

---

## 3. 변경 지점 (파일·함수) — 구현 시

**단일 진실원: `plugins/artibot/lib/routing/execution-profile.js` 한 파일.** 스키마·인터프리터·계약은 무변경.

### 3.1 별칭 표 신설 (allowlist)

```js
/**
 * G-1 resolution (owner decision 2026-09-03): the five schema-legal,
 * design-unmapped priorities are ABSORBED into the three design priorities.
 * Each row carries its evidence grade; see
 * .artibot/guides/v5-design/DESIGN-G-1-performance-priority-mapping.md §2.
 * A value absent from this table AND from DESIGN_PRIORITIES still normalizes
 * to null ('G-1 unresolved') — the fail-closed branch is kept for any future
 * enum addition, so adding a ninth schema value without a row here is loud.
 */
export const PRIORITY_ALIASES = Object.freeze({
  fast:                { to: 'maximum',  grade: 'attested',  cite: 'P02:72 + DESIGN:129' },
  speed_accuracy:      { to: 'maximum',  grade: 'inferred',  cite: 'HARD:125 + policy.example.yaml:70' },
  maximum_performance: { to: 'maximum',  grade: 'inferred',  cite: 'P02:73 + package/README.md:58' },
  quality:             { to: 'balanced', grade: 'judgment',  cite: 'policy.example.yaml:39 quality_constraint' },
  economy:             { to: 'balanced', grade: 'judgment',  cite: 'no source — LOSSY, see G-1b', lossy: true },
});
```

### 3.2 `normalizePerformancePriority` 분기 순서 (`:255-276`)

```
absent → 'balanced' (변경 없음)
non-string → null (변경 없음)
∈ DESIGN_PRIORITIES → 그대로 (변경 없음)
∈ PRIORITY_ALIASES  → { normalized: row.to,
                        reason: `alias: ${value} -> ${row.to} (${row.grade}${row.lossy ? ', lossy' : ''}; ${row.cite})` }   ← 신설
∈ SCHEMA_PRIORITIES → { normalized:null, reason:'G-1 unresolved' }   ← 유지(미래 enum 추가 시 fail-closed)
else → unknown (변경 없음)
```
반환 형태 `{normalized, reason}` 2키 유지 — 기존 `toEqual` 단언과 소비자를 깨지 않기 위해 새 키를 넣지 않는다. 원문 값은 `result.profile.performance.priority` 에 이미 보존된다(`:479`, 테스트 `:180`).

### 3.3 헤더 주석 `:40-57` "Open gap G-1" 절 → "G-1 resolved (2026-09-03)" 로 교체. `:50-52` "tempting synonyms … refuses to write" 문장은 삭제하고 "왜 지금은 쓰는가 + 등급" 으로 대체.

### 3.4 문서
- `plugins/artibot/schemas/execution-profile.README.md:232-235` G-1 항목 → "해결됨: 매핑표는 `execution-profile.js#PRIORITY_ALIASES`, 근거는 본 설계안 §2. 잔여 G-1b(economy directive)". **스키마 enum 은 무변경**이므로 README 의 허용값 표(`:73-89`)와 `tests/schemas/execution-profile.test.js:97-106` 는 그대로.
- `ARTIBOT-5.0-DESIGN.md` — §8.x 결정 표에 G-1 행 1줄. **이 파일은 다른 팀원이 편집 중**(git status `M`, 15:34 mtime) — 리더가 그 레인에 위임할 것. 이 설계안은 파일을 열어 읽기만 했다.
- ADR: record 레인 소관. 제목 제안 "ADR: execution_profile.performance.priority 5값 흡수(G-1)".

### 3.5 테스트 (RED → GREEN 목록은 §6)

---

## 4. 영향 범위

| 영역 | 영향 | 근거 |
|---|---|---|
| 프로덕션 라우팅 | **0** — 호출자 0(§1.4). Observe 단계 `observe:true`, canary 빈 목록(`execution-profile.js:24-27`) | 실측 |
| `PERFORMANCE_DIRECTIVES`·`OBJECTIVE_BY_PRIORITY` | 무변경 — 3값 표 그대로. `escalation.test.js:318-322`·`hysteresis.test.js:432-438` 의 표 순회 테스트 GREEN 유지 | 표에 키를 추가하지 않는다 |
| 스키마 | 무변경 | enum 8값 유지 |
| `interpreter.js` | 무변경 | §5 |
| `lib/mission/contract.js` | 무변경 | MC 계약 검증용 사본 |
| 원장 기록 | `objective_reason` 문자열이 5값에 대해 `'G-1 unresolved'` → `'alias: …'` 로 바뀐다. 이 문자열을 파싱하는 소비자: **0건**(grep `objective_reason` lib/ scripts/ — execution-profile.js 와 그 테스트뿐) | 실측 |

## 5. `interpreter.js` 별칭과의 일관성 판정

두 곳은 **서로 다른 층의 매핑**이고 충돌하지 않는다:

```
P02 산문(하이픈)  ──interpreter PERFORMANCE_PROSE_ALIASES──▶  스키마 철자(MC 5값)  ──execution-profile PRIORITY_ALIASES──▶  설계 3값
 'high-quality'                                              'quality'                                                     'balanced'
 'maximum-performance'                                       'maximum_performance'                                         'maximum'
```

- 층 1 은 철자 정규화(의미 보존), 층 2 는 의미 흡수(손실 가능). 층 1 이 층 2 의 입력 전체를 덮는다: `interpreter.test.js:94-97` 이 "인터프리터 발행값 ⊂ 스키마 enum" 을 고정하고, 매핑 후에는 "스키마 enum 전체 → non-null" 이 되므로 **인터프리터가 낼 수 있는 모든 값이 directives 를 얻는다.** 지금은 5값 중 4값(`balanced` 제외)이 null 로 떨어진다 — 이것이 브리프 §6 이 물은 "같은 입력을 다르게 처리" 의 실체이고, 매핑이 해소한다.
- **추가할 교차 드리프트 테스트**(`tests/routing/execution-profile.test.js` 신설 describe): `for v of interpreter.PERFORMANCE_PRIORITIES: expect(normalizePerformancePriority(v).normalized).not.toBeNull()` + `for v of SCHEMA_PRIORITIES: 동일`. 인터프리터 어휘가 늘거나 스키마 enum 이 늘면 매핑 없는 값이 즉시 RED.
- **남는 불일치 1건(코드 결함 아님, 기록)**: `PERFORMANCE_PRECEDENCE :170-176` 이 `economy > fast` 인 근거(`:166-167` "예산 상한이 속도를 제약")가 설계에 없는 economy 예산 상한을 전제한다. 매핑 후 economy+fast 프롬프트는 balanced 로 간다(fast 신호 소실). G-1b 에서 economy directive 를 만들면 자연히 해소되고, 안 만들면 우선순위에서 `economy` 를 `fast` 아래로 내리는 것이 정답일 수 있다 — 이 설계안은 그 결정을 내리지 않는다.

## 6. RED 가 되는 기존 테스트 (`tests/routing/execution-profile.test.js`, 직접 읽음)

| 줄 | 테스트 | 왜 RED | 처치 |
|---|---|---|---|
| `:121-126` | `it.each(unmapped)('refuses to guess a mapping for %s')` ×5 | `normalized:null, reason:'G-1 unresolved'` 기대 → alias 반환 | 삭제하고 §3.2 별칭 표 순회 테스트로 교체: `expect(normalizePerformancePriority(v)).toEqual({ normalized: PRIORITY_ALIASES[v].to, reason: expect.stringMatching(/^alias: /) })` |
| `:128-133` | `does not treat maximum_performance or speed_accuracy as maximum` | 둘 다 `maximum` 이 된다 | 반전: "treats … as maximum, with an `inferred` grade in the reason" |
| `:170-181` | `emits no objective and no directives when the priority is G-1 unmapped` (`quality`) | `objective`·`directives` 가 balanced 값으로 채워진다 | 반전: `objective === 'cost_per_accepted_outcome'`, `objective_reason` 이 `alias: quality -> balanced (judgment…)`, `profile.performance.priority === 'quality'` 보존 단언은 **유지** |
| `:109-119` | `leaves exactly five schema values unmapped` | GREEN 유지(DESIGN_PRIORITIES 불변 → 집합 동일) — 그러나 이름이 거짓이 된다 | 이름을 `aliases exactly the five non-design schema values` 로 바꾸고 `Object.keys(PRIORITY_ALIASES).sort()` 와 동일 단언 추가 |
| `:4-10` 헤더 (a) | 문서 주장 | 코드 주석이라 RED 아님 | "G-1 fail-closed for UNLISTED values; five listed aliases resolve" 로 갱신 |
| 나머지(`:99-105, :135-149, :152-168, :184-249, :251-493`) | — | GREEN 예상 | 무변경 |

합계: **RED 단언 7건(3 describe 블록)**, 다른 파일 RED **0** 예상(`tests/schemas/execution-profile.test.js` 스키마 무변경, `tests/intent/interpreter.test.js` 인터프리터 무변경, `escalation/hysteresis` 표 무변경). "예상" 표기 — 실행하지 않았다(코드 변경 금지).

## 7. 되돌리기

`PRIORITY_ALIASES` 상수 삭제 + `normalizePerformancePriority` 의 alias 분기 1개 삭제 + 테스트 3블록 원복 = 단일 커밋 revert. 원장에 남은 `objective_reason: 'alias: …'` 문자열은 파서 0건이라 데이터 마이그레이션 불요.

## 8. 이 설계안이 못 보는 것

- **매핑이 옳은지의 행동 증거는 없다.** RouteBench/Shadow 이전이라 `fast→maximum` 이 실제 수락률·비용에서 옳은지 실측 0. 등급은 문서 근거의 등급이지 결과의 등급이 아니다.
- **`economy` 의도는 매핑 후에도 라우팅에 반영되지 않는다**(§2.5). 이 표가 "5값 다 해결" 로 읽히면 착시다 — G-1b 가 열려 있다고 표 옆에 적어야 한다.
- 인터프리터 lexicon 이 `quality` 와 `fast` 에 '정확하게' 를 각각 어떻게 배분하는지(`:317-323`)는 매핑과 무관한 분류 품질 문제 — 미검토.

## 미확인
- `speed_accuracy`·`maximum_performance` 를 maximum 으로 읽는 것이 설계 저자의 의도인지 — 문서상 정의문 부재, 저자 확인 없음.
- `route-hysteresis.js`·`escalation-controller.js` 는 다른 팀원이 동시 편집 중(git status `M`) — 본문 줄번호는 16:01 재측정값이며 그 뒤의 변경은 반영하지 않았다. 심볼명(`COST_SAVING_PERFORMANCE`·`resolveCostWeight`·`DOWNGRADE_ENABLED_PERFORMANCE`·`downgradeEnabled`)으로 찾을 것.
- `ARTIBOT-5.0-DESIGN.md` 를 편집 중인 팀원이 §8 표에 G-1 행을 이미 넣었는지 — 15:34 mtime 워킹트리에서 `G-1` grep 시 `:564` 행(T-24 하이픈 별칭) 외 결정 행 없음, 그 이후 변경 미확인.
