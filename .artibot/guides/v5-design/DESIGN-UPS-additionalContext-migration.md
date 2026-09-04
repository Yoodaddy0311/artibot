# DESIGN — UserPromptSubmit 출력을 `hookSpecificOutput.additionalContext` 로 이전

> **오너 승인 전 구현 금지.** 이 문서는 설계안이다. 코드·테스트·config·설치본은 건드리지 않았다.

- 작성: 2026-09-03 17:0x KST · team-v5-decisions-01sa2u-effortpath (Fable) · master @ 3bcadb8e (v4.53.0, 워킹트리 수리분 포함)
- 전제 측정: `PROBE-effort-directive-delivery.md` (같은 디렉터리) — 호스트 2.1.259 는 훅 stdout 최상위 `user_prompt`·`message` 를 "unrecognized keys (ignored)" 로 버린다(바이너리 B1–B6, 공식 문서 L1032). 본 문서는 그 판정을 다시 논하지 않는다.
- 관련 정본: `INCIDENT-2026-09-03-hook-payload-contract.md`(F11·F14) · `HOOK-VISIBILITY-DESIGN.md`(§6-4 "호스트가 출력을 무시하는 경우", §6-5 설치본 괴리)
- **재대조 2026-09-04** (architect, master @ `7cbb37b9`): 이 문서는 3bcadb8e 기준이고 그 뒤 `bc2e9e55`(2026-09-03 17:49 "호스트 페이로드 키 prompt 수리 + --no-team 옵트아웃 회귀 …") 가 착지했다. 본문의 낡은 문장은 지우지 않고 취소선 + **정정(2026-09-04)** 단락으로 표시했다. 정정 목록과 근거는 **§8** 에 모아 두었다. §8 을 먼저 읽고 본문을 읽어라.

## 0. 한 줄 요약

디스패처 stdout 을 **호스트 스키마 허용목록**으로만 조립하고, `runtime-prompt.js` 가 만들던 프롬프트 봉투(디렉티브·라우팅 힌트·메모리·가드레일)를 `hookSpecificOutput.additionalContext` 한 문자열로 옮긴다. 리라이터(`user-prompt-handler`)의 **원문 변형 기능은 호스트 계약상 불가능**하므로 `!rv` 는 additionalContext 지시문(권장, 즉시) → 장기적으로 `/rv` 커맨드(UserPromptExpansion 경로)로, `--no-team` 은 "제거"를 버리고 "원문에서 감지"로 바꾼다. 디스패처 내부 `payload.user_prompt` 전달 계약은 그대로 둔다.

## 1. stdout 형태: 현재 → 목표 (허용목록)

### 1.1 현재 (샌드박스 실측, PROBE §5)

```json
{"user_prompt":"[artibot:effort level=high command=team][artibot:task-budget max_tokens=64000]\n\nSystem 1 mode: …\nOriginal request:\n/team …\n\nRelevant memory context:\n- …\n\n⚠️ Guardrail: …",
 "message":"[runtime] lifecycle=setup | … | cmd=/team effort=high",
 "continue":true,
 "hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[auto-team-suggested] …"}}
```
호스트가 취하는 것: `continue`, `hookSpecificOutput.additionalContext`. 버리는 것: `user_prompt`, `message` (디버그 로그 1줄).

### 1.2 목표

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
  "additionalContext":"[artibot:effort level=high command=team][artibot:task-budget max_tokens=64000]\n[artibot:team runner=team teammates=N]\n\n[artibot:route system1] answer directly and keep it concise.\n\nRelevant memory context:\n- …\n\n⚠️ Guardrail: tools denied by policy — Agent\n\n[auto-team-suggested] reason: …"}}
```
`continue` 는 **기본값(true)이면 내보내지 않는다**(현재 `ambiguity-guard.js:109,111` 이 늘 `{continue:true}` 를 돌려주는데, 호스트 기본값과 같아 정보량 0).

### 1.3 허용목록 (호스트 2.1.259 스키마 B1/B2 그대로 — 부정 목록 아님)

| 수준 | 허용 키 | Artibot 이 실제로 쓸 키 |
|---|---|---|
| 최상위 | `continue` `suppressOutput` `stopReason` `decision` `reason` `systemMessage` `terminalSequence` `hookSpecificOutput` | `hookSpecificOutput` (+ 향후 `decision:"block"`+`reason` 을 ambiguity-guard 가 쓰고 싶다면 그때 추가) |
| `hookSpecificOutput` | `hookEventName` `additionalContext` `sessionTitle` `suppressOriginalPrompt` | `hookEventName`(고정 `"UserPromptSubmit"`), `additionalContext` |

허용목록은 **코드 상수 1곳**(`_userprompt-dispatcher.js` 상단, 예: `HOST_STDOUT_KEYS`, `HOST_UPS_KEYS`)에 두고, 스키마 출처(바이너리 오프셋·문서 L1325)를 주석으로 남긴다. 호스트 버전이 바뀌어 키가 늘면 상수만 늘린다. **금지 목록으로 쓰지 않는다** — `Lwe` 가 버릴 키를 애초에 만들지 않는 것이 목적이므로 "이 키만 통과" 가 맞다.

### 1.4 조립 규칙 (`_userprompt-dispatcher.js#mergeHookResults`, 현재 :155-186)

1. 각 기여자 결과에서 `hookSpecificOutput.additionalContext` 만 모은다(현재 :162-163 유지).
2. 최상위 키는 **허용목록에 있는 것만** `out` 으로 복사한다(현재 :164-170 의 "나머지 전부 복사" 를 교체). `user_prompt`·`message` 는 여기서 걸러진다 — **삭제가 아니라 미복사**.
3. 걸러진 키가 있으면 stderr 1줄 `[artibot:_userprompt-dispatcher] dropped non-host keys: user_prompt,message` (HOOK-VISIBILITY §2.2 "1프로세스 1줄" 규칙 안). exit 0 stderr 는 디버그 로그에만 가지만(INCIDENT F13) 드리프트 흔적은 남긴다.
4. additionalContext 결합 순서는 **입력 배열 순서**다 — `Promise.allSettled` 는 결과를 입력 순서로 돌려주므로 현재 주석 :146 "fulfillment order" 는 틀렸다(실제로는 결정적). 디렉티브가 맨 앞에 오게 하려면 `main()` :212-218 의 배열에서 `runtimePrompt` 를 첫 번째로 옮긴다(현재 두 번째).
5. **크기 상한**: 호스트는 훅 stdout 전체가 **10,000 B 를 넘으면 파일로 스필하고 절단 폴백**한다(바이너리 `lnr=1e4`, `Kfe(e,n,r,{threshold:o=lnr})` @191307256 인근, 텔레메트리 `tengu_hook_output_persisted`). 이 절단이 additionalContext 에 어떻게 적용되는지는 **미확인**이므로 안전하게 additionalContext 를 **8,000 B 이하**로 캡하고 넘치면 메모리 블록부터 자른다(§2 표의 우선순위). 현재 실측 봉투는 ~600–1,000 B.

## 2. `user_prompt` 봉투 구성요소별 — additionalContext 로 옮기면 의미가 유지되는가

"프롬프트 치환(원문 앞뒤에 붙여 하나의 사용자 메시지)" → "원문 옆에 별도 meta 메시지 `UserPromptSubmit hook additional context: …`"(PROBE B8). 원문은 **항상 그대로** 모델에 간다. 이 차이가 각 요소에 미치는 영향:

| # | 구성요소 (생성 위치) | 원래 의미 | additionalContext 에서 | 판정 · 권장 | 절단 우선순위 |
|---|---|---|---|---|---|
| E1 | `[artibot:effort level= command=]` (`runtime-prompt.js#buildEffortDirective` :139) | 자문 텍스트. 모델의 실제 effort 는 호스트 설정(config 주석 그대로) | 동일 — 자문 텍스트는 어디 있든 자문 | **유지, 무손실**. 단 문서의 "프롬프트 맨 앞" 표현은 §5 로 정정 | 마지막(절대 안 자름) |
| E2 | `[artibot:task-budget max_tokens=]` (`resolveTaskBudgetDirective`) | 동상 | 동상 | **유지, 무손실** | 마지막 |
| E3 | `[artibot:team runner= teammates=]` (`buildTeamDirective` :158) | 스폰 신호("parallel-not-spawned" 방지) | 동상 | **유지, 무손실** | 마지막 |
| E4 | `[artibot:hint recommend=workflow\|split\|autopilot]`, `recommend=watch` (`:203`, `:225`) | advisory 힌트, 모델이 한 문장으로 제안 후 대기 (CLAUDE.md:64-72) | 동상 | **유지, 무손실** | 마지막 |
| E5 | `System 1/2 mode: …` + `Original request:` + 원문 (`lib/runtime/middleware/router.js:19-20, :78-82`) | 라우팅 결과를 프롬프트 접두사로 | `Original request:` 래퍼는 **무의미**(원문은 이미 옆에 있음). 모드 문장만 의미 있음 | **형태 변경**: `[artibot:route system1] answer directly and keep it concise.` 한 줄로. 래퍼 제거는 **훅 출력 조립 단계에서만**(`composePromptOutput`) — 미들웨어 `state.userPrompt` 는 `lib/runtime/evaluator.js:236` `prompt-rewritten` 단언(eval:runtime 게이트)이 보므로 건드리지 않는다 | 3순위 |
| E6 | `Relevant memory context:\n- …` (`lib/runtime/middleware/memory.js:116`, 상수 `decision-events.js:509 MEMORY_BLOCK_HEAD`) | 관련 기억 주입 | **본래 additionalContext 성격**. 오히려 더 정확 | **유지**. `measureMemoryInjection`(T-37 관측)은 `prepared.userPrompt` 를 재므로 영향 없음 — 단 "stdout 에 실렸는가" 관측은 추가 필요(§6 D1) | **1순위(가장 먼저 자름)** |
| E7 | `⚠️ Guardrail: tools denied by policy — X` (`guardrail.js:248`) | 정책 통지 | 동상 | **유지** | 2순위 |
| E8 | `message` (`[runtime] lifecycle=… \| route=… \| cmd=/team effort=high`) | 원래부터 호스트 필드가 아님. 레거시 `main()` 의 stdout 에 실렸을 뿐 | 갈 곳 없음. `systemMessage` 로 보내면 **매 프롬프트마다 사용자 경고 표시** — 소음 | **stdout 에서 제거**. 값은 이미 `persistTokenUsage`·decisions 관측(T-37)이 부분 기록 → 필요하면 `recordObserveOnlyDecisions` 에 `runtime.summary` 이벤트 1종 추가(별건) | — |
| E9 | `!rv` 재검증 프롬프트 (`user-prompt-handler.js:32-58`) | **원문을 통째로 교체** | 교체 불가. 원문 `!rv …` 가 그대로 가고 지시문이 옆에 붙음 | §2.1 | 마지막 |
| E10 | `--no-team` 제거 (`user-prompt-handler.js:78-85`) | 원문에서 플래그 삭제 + 메시지 | 삭제 불가. 플래그가 모델에 보임 | §2.2 | — |
| E11 | `[auto-team-suggested]`·`[autopilot-suggested]`·auto-command·ambiguity 리마인더 | 이미 additionalContext | 변화 없음 | **유지** | 4순위 |

### 2.1 `!rv` / `!재검증` — 원문 변형이 불가능해진 뒤의 선택지

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **A (권장, 즉시)** | 리라이터가 `{hookSpecificOutput:{additionalContext: <재검증 프로토콜 5단계>}}` 를 돌려주고 원문 `!rv …` 는 그대로 둔다. `payload.user_prompt` 에는 종전처럼 재작성문을 넣어 병렬 기여자(auto-team 등)가 "재검증" 의도로 분류하게 한다 | 코드 변경 최소, 모델은 원문+지시문 둘 다 본다 — 실질 의미 유지 | 원문에 `!rv` 라는 토큰이 남는다(모델이 무시하면 됨). 지시문이 meta 메시지라 "명령"의 무게가 약해질 수 있다 — 효과 **미측정** |
| **B (장기)** | `commands/rv.md`(또는 스킬)로 승격 — 사용자가 `/rv …` 를 치면 호스트가 **UserPromptExpansion** 경로로 커맨드 본문을 실제 프롬프트로 전개한다. 이것이 호스트가 제공하는 유일한 "프롬프트 치환" 수단(문서 L1360 UserPromptExpansion) | 진짜 치환. 호스트 계약과 정합 | 트리거 표기 변경(`!rv` → `/rv`). `!rv` 는 A 로 병행 유지하면 호환 |
| C | `decision:"block"` + `suppressOriginalPrompt:true` + `reason` 으로 원문을 지우고 사용자에게 재제시 요청 | — | block 은 **턴을 끝내고 프롬프트를 지운다**(문서 L856, L3504). 대체 프롬프트를 넣을 방법이 없다 → 사용자가 다시 쳐야 함. **불채택** |
| D | 기능 포기 | 단순 | 이미 죽어 있던 기능이라 손실은 0 이지만, 테스트 6곳이 이 기능을 단정하므로 어차피 손댄다. A 가 비용 거의 같음 |

권장: **A 지금, B 는 별건 백로그.** C 는 계약상 불가.

### 2.2 `--no-team`

플래그 "제거"는 목적이 아니라 수단이었다. 목적은 (i) auto-team 이 발화하지 않을 것, (ii) 모델이 팀을 만들지 않을 것. (ii) 는 원문에 `--no-team` 이 남아 있는 편이 **오히려 확실**하다(모델이 직접 본다). (i) 는 `auto-team-trigger.js:376` 이 원문을 보면 된다.

**발견(워킹트리, 미수정)**: 현재 순서가 (i) 를 깨뜨린다 — 리라이터가 `payload.user_prompt` 에 플래그 **제거본**을 넣고(:206-208), `auto-team-trigger` 는 `extractUserPromptText` 로 그 제거본을 먼저 읽으므로(hook-utils.js:287 `user_prompt` 1순위) `:376` 의 `NO_TEAM_FLAG.test` 가 **거짓**이 된다 → 옵트아웃이 무력화된다. HEAD 에선 두 훅 다 프롬프트를 못 읽어 잠복해 있었고, 워킹트리 수리로 **처음 도달 가능**해진 결함이다. ~~설계상 처리: 리라이터의 `--no-team` 분기를 **삭제**하고(제거 기능 자체를 버림), `auto-team-trigger` 는 `hookData.prompt`(호스트 원문)로 옵트아웃을 판정한다.~~ `[team] --no-team flag detected` 메시지는 E8 과 함께 stdout 에서 사라진다.

**정정(2026-09-04, 재대조 §8-1·§8-2)**:
- (i) 는 **이미 다른 방식으로 착지했다** — `bc2e9e55` 가 `lib/core/hook-utils.js#extractUserPromptFlagSurface`(`:319-329`, `user_prompt`·`prompt`·`content` 의 합집합을 개행으로 조인) 를 추가하고 `auto-team-trigger.js:379` 가 `NO_TEAM_FLAG.test(extractUserPromptFlagSurface(hookData))` 로 판정한다. `hookData.prompt` 단독이 아니라 **원문+리라이트본 합집합**이다. 위 "`:376` 을 `hookData.prompt` 로" 는 착지됨으로 닫는다. 회귀 테스트: `tests/hooks/userprompt-dispatcher.test.js:175-190`(체인 통과 후 `[auto-team-suggested]` 부재) + 대조군 `:192-200` + `tests/core/hook-utils.test.js:444-477`.
- **리라이터의 `--no-team` 분기(`user-prompt-handler.js:78-85`)는 삭제하지 않는다.** 이유 ① `userprompt-dispatcher.test.js:183` 이 "리라이터는 플래그를 제거한다(디스패처 계약 — 유지)" 로 핀했고 `user-prompt-handler.test.js:47-51, :95-105` 도 제거를 단언한다 — 삭제하면 §4.4 :141 의 "변경 없음" 과 모순(리더 지적). ② (i) 는 이미 flag-surface 로 달성됐으므로 삭제가 (i) 에 기여하는 바가 없다. ③ (ii) 는 호스트 계약상 원문이 항상 그대로 모델에 가므로 제거가 있든 없든 동일 — 제거는 stdout 경계(§1.4)에서 걸러지는 **내부 전용 부작용**이 된다. ④ 삭제는 테스트 3파일 갱신을 요구하고 호스트에 보이는 이득이 0 이다.
- (ii) 를 **명시적으로** 달성하려면 리라이터가 `--no-team` 감지 시 `hookSpecificOutput.additionalContext` 에 지시문 1줄(`[artibot:team opt-out] --no-team: do not spawn a team for this request`) 을 함께 돌려준다(§2.1 A 와 같은 형태 — `user_prompt` 는 종전처럼 제거본, `message` 는 E8 과 함께 stdout 에서 사라짐). 이것이 리더가 제시한 "additionalContext 지시문으로 (ii) 달성" 안이다.
- **`user_prompt` 단독 페이로드(레거시 stdin, `tests/e2e/runtime-flow.test.js:33` 형태)에서의 옵트아웃 — 실측(2026-09-04 11:47, 리라이터→`payload.user_prompt` 치환→auto-team 체인을 in-process 로 재현)**: `{prompt: '… --no-team'}` 은 auto-team **미발화**(옵트아웃 유지) / `{user_prompt: '… --no-team'}` 단독은 auto-team **발화**(옵트아웃 소실) / 대조군(플래그 없음) 발화. 원인: 리라이터가 `payload.user_prompt` 를 제거본으로 덮으면 flag-surface 가 읽을 원문 사본이 남지 않는다(`prompt` 키 없음). **라이브 도달 불가** — 호스트 2.1.259 는 `prompt` 를 보내고(PROBE), 개별 훅을 레거시 `main()` 으로 단독 실행하면 리라이터가 끼지 않는다. `runtime-flow.test.js:33` 은 체인에 auto-team-trigger 를 넣지 않으므로 이 사례를 검사하지 않는다. 처리: **고치지 않고 문서화** — `auto-team-trigger.test.js` 에 "user_prompt 단독 + 디스패처 치환 = 옵트아웃 미보장(레거시, 라이브 미도달)" 을 있는 그대로 핀하는 케이스 1개를 §4.4 에 추가한다(거짓 그린 방지). 고치려면 디스패처가 원문 사본을 별도 내부 키로 보존해야 하는데 그것은 내부 키 추가 = 이 문서가 피하는 드리프트라 별건.

## 3. 디스패처 내부 계약은 유지 — 호스트 출력과 내부 전달의 분리 지점

| 단계 | 파일:행 (워킹트리) | 역할 | 변경 |
|---|---|---|---|
| 리라이터 실행 | `_userprompt-dispatcher.js:203` | `user-prompt-handler` 가 `{user_prompt?, message?, hookSpecificOutput?}` 반환 | 반환 형태에 `hookSpecificOutput.additionalContext` 추가(§2.1 A). `user_prompt` 는 **내부용으로 계속 반환** |
| 내부 전달 | `_userprompt-dispatcher.js:206-208` `payload.user_prompt = rewriterResult.user_prompt` | 병렬 기여자가 재작성문을 분류하게 함 | **유지**. `typeof === 'string'` 검사(빈 문자열 보존)도 유지 — `tests/hooks/userprompt-dispatcher-resilience.test.js:42-44` 가 소스 문자열로 이를 고정 |
| 기여자 읽기 | `lib/core/hook-utils.js:285-292 extractUserPromptText` (`user_prompt → prompt → content`) | 내부키 우선, 호스트키 폴백 | **유지**. JSDoc 이 이미 "user_prompt 는 호스트 키가 아니라 디스패처 내부 키"라고 적었다(워킹트리 diff) — 이 문서와 정합 |
| **분리 지점** | `_userprompt-dispatcher.js:164-170` (`mergeHookResults` 의 최상위 키 복사 루프) | 여기서부터가 "호스트에 보이는 것" | **허용목록 복사로 교체**(§1.4-2). 위 세 단계는 이 루프 앞에 있어 영향 없음 |
| stdout | `_userprompt-dispatcher.js:222-225` | `JSON.stringify(merged)` | 유지 |

즉 `user_prompt` 라는 이름은 **디스패처 프로세스 안에서만 사는 키**로 격하되고, stdout 경계에서 끝난다. 이름을 바꾸지 않는 이유: 테스트 23파일과 `extractUserPromptText` 의 계약이 이 이름에 걸려 있고, 이름 변경은 이 마이그레이션의 목적(호스트 도달)과 무관하다.

`runtime-prompt.js#composePromptOutput` :707-733 은 `{ hookSpecificOutput:{hookEventName, additionalContext} }` 를 돌려주도록 바꾸되, **`user_prompt` 도 함께 돌려준다**(값 = 종전 봉투). 이유: `runtime-prompt` 는 병렬 기여자라 `payload.user_prompt` 에 영향이 없지만, 테스트·eval 이 `prepared.userPrompt`/`output.user_prompt` 로 봉투를 검사하므로 내부 관측 표면으로 남긴다. stdout 에는 §1.4 가 막는다.

## 4. 영향 범위 · 되돌리기 · 못 보는 것 · 완료 판정

### 4.1 영향 파일

| 파일 | 변경 성격 |
|---|---|
| `scripts/hooks/_userprompt-dispatcher.js` | 허용목록 상수 + `mergeHookResults` 복사 루프(:164-170) + 배열 순서(:212-218) + 주석 :143-149 정정 + stderr 1줄 |
| `scripts/hooks/runtime-prompt.js` | `composePromptOutput` :707-733 → additionalContext 조립(E5 래퍼 제거, E8 제거, 8 KB 캡) ; 헤더 :4-12 문구 |
| `scripts/hooks/user-prompt-handler.js` | `!rv` → additionalContext(§2.1 A); ~~`--no-team` 분기 삭제(§2.2)~~ **정정(2026-09-04)**: 분기 **유지** + `--no-team` 감지 시 additionalContext 지시문 1줄 추가(§2.2 정정); JSDoc :68-71 |
| `scripts/hooks/auto-team-trigger.js` | ~~`:376` 옵트아웃 판정을 `hookData.prompt` 로~~ **착지됨(bc2e9e55)** — `:379` `extractUserPromptFlagSurface(hookData)`. 이 문서의 잔여 변경 **없음** |
| `scripts/hooks/ambiguity-guard.js` | `{continue:true}` 반환 → `null`(정보량 0) — 선택 |
| `artibot.config.json` | `runtime.effort.comment` 문구(§5) + 되돌리기 키(§4.2). **소유권(2026-09-04 확정): L1(이 설계) 이 이 파일을 소유한다.** L2(`ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` §6) 의 `routing.observe.receiptStage` 키는 L2 D1 착수 시 **통합 단계에서 리더가 추가**한다 — L2 D0 프로브 줄기(`l2-probe`)는 이 파일을 건드리지 않는다 |
| 문서 5곳 | §5 |
| 테스트 | §4.4 |

### 4.2 되돌리기 — config 1키

`runtime.hooks.userPromptSubmit.legacyStdout` (boolean, 기본 `false`). `true` 면 `mergeHookResults` 가 종전대로 모든 키를 복사한다(허용목록 우회). **주의를 문서에 명시**: 되돌린 상태는 "예전과 같은 상태"이지 "동작하는 상태"가 아니다 — 최상위 `user_prompt` 는 호스트가 어차피 버린다(PROBE). 이 키의 유일한 용도는 병렬 기여자 회귀를 이분할 때 stdout 형태만 되돌려 보는 것. 키 위치를 `runtime.effort` 아래 두지 않는 이유: 봉투 전체(E5–E8)가 대상이라 effort 만의 스위치가 아니다.

### 4.3 이 설계가 못 보는 것

1. **호스트 버전 드리프트** — 허용목록은 2.1.259 실측이다. 호스트가 키를 추가·삭제하면 상수가 뒤처진다. 완화: `tests/firewall/` 에 "설치된 호스트 바이너리에서 스키마 문자열을 grep 해 상수와 대조"하는 자기검증 테스트(바이너리 부재 시 skip 이 아니라 **fail** — verification-discipline §10).
2. **meta 메시지의 무게** — additionalContext 는 프롬프트 접두사보다 모델이 가볍게 볼 수 있다. 특히 E9(`!rv`)의 "명령성". **효과 미측정**; D4 는 도달만 본다.
3. **10 KB 스필**(§1.4-5) — 절단 방식 미확인. 8 KB 캡은 추정 안전마진.
4. **훅 미실행** — 등록 누락·`${CLAUDE_PLUGIN_ROOT}` 괴리·설치본 미갱신이면 stdout 형태와 무관하게 아무것도 안 간다(HOOK-VISIBILITY §6-2, §6-5). D4 가 유일한 검출.
5. **`hooks.json:169` `"timeout": 15000`** — 문서 L428 은 `timeout` 단위가 **초**라고 한다. 15,000 초(4.2 h)는 사실상 무한이다. 이 설계의 범위 밖이지만 같은 파일을 만질 때 확인할 것(의도가 ms 였다면 `15`).
6. **eval:runtime 게이트**(`lib/runtime/evaluator.js:236 prompt-rewritten`)는 파이프라인 내부 `state.userPrompt` 를 보므로 stdout 이전과 무관 — 즉 **이 게이트는 이전을 검증하지 못한다**. D1 의 파이어월 테스트가 대신한다.

### 4.4 테스트 (PROBE §7 P3 → 단정 내용 확인 완료)

| 파일 | 현재 단정 | 변경 |
|---|---|---|
| `tests/hooks/runtime-prompt-effort-inject.test.js:152-180` | `output.user_prompt` 가 디렉티브 접두사·원문 포함 | 디렉티브는 `output.hookSpecificOutput.additionalContext` 로, 원문 포함 단정은 **삭제**(원문은 호스트가 보냄) |
| `runtime-prompt-team-inject.test.js:127-131` | `[artibot:team …]` 접두사 + `Original request: …$` | additionalContext 로; `Original request` 단정 삭제(E5) |
| `runtime-prompt-watch-inject.test.js:73-89` | 힌트 접두사 | additionalContext 로 |
| `runtime-prompt-native-effort.test.js:42-78` | `^\[artibot:effort level=…` | additionalContext 첫 줄 정규식으로 |
| `runtime-prompt.test.js:107-154` | `!rv` 재작성문·원문 포함 | §2.1 A 형태로 |
| `runtime-prompt-decision-wiring.test.js:348`, `runtime-prompt-memory-instrumentation.test.js:139` | `out.user_prompt` 내용 | `out.user_prompt` 는 내부 관측용으로 남기므로 **그대로 통과**(§3 마지막 단락) — 확인만 |
| `userprompt-dispatcher.test.js:124-149` | 최상위 `out.user_prompt` 존재/부재 | 허용목록 기준으로 뒤집음: `user_prompt` **없음**이 정답 |
| `dispatcher/dispatcher-merge-proto.test.js:155-172` | `merged` 가 `{user_prompt:'hi'}` 와 동일 | 프로토타입 오염 방지 취지는 유지, 기대값을 허용목록 결과로 |
| `userprompt-dispatcher-resilience.test.js:33-44` | `merged.user_prompt === ''` + 소스 문자열 고정 | :33 은 내부 전달(`payload.user_prompt`) 검사로 옮김; :42-44 유지 |
| `e2e/runtime-flow.test.js:116-125` | `System 1 mode`·`Original request:`·`!rv` | E5·E9 새 형태로 |
| `user-prompt-handler.test.js`, `auto-command-suggest.test.js:428-438`, `auto-team-trigger*.test.js`, `ambiguity-guard.test.js:107-112`, `core/hook-utils.test.js:411-438` | 입력 페이로드로 `user_prompt` 사용 | **변경 없음**(내부 계약 유지) — **정정(2026-09-04)**: 이 "변경 없음" 은 §2.2 의 `--no-team` 분기 **유지** 결정과 함께 참이 된다(삭제했다면 `user-prompt-handler.test.js:47-51, :95-105`·`userprompt-dispatcher.test.js:183-184` 가 RED). `user-prompt-handler.test.js` 는 `!rv` 케이스도 A 안(`user_prompt` 에 재작성문 유지)이라 그대로 GREEN. ~~단 `auto-team-trigger.test.js` 에 §2.2 케이스 추가: `{prompt:'… --no-team', user_prompt:'…'}` → null~~ **착지됨(bc2e9e55)**: `userprompt-dispatcher.test.js:175-200` + `core/hook-utils.test.js:444-477`. **추가할 것 1건**: `user_prompt` 단독 페이로드가 디스패처 치환을 거치면 옵트아웃이 **보장되지 않음**(§2.2 정정 실측)을 있는 그대로 핀하는 케이스 — 레거시·라이브 미도달임을 이름에 적는다 |
| **신규** `tests/firewall/ups-stdout-allowlist.test.js` | — | 실제 디스패처를 `prompt` 키 페이로드 2종(슬래시/비슬래시)으로 실행해 stdout 키 ⊆ 허용목록, `additionalContext` 에 `[artibot:effort` 포함(슬래시 케이스), 총 바이트 < 10,000. 파일이 없으면 red(fail-closed) |
| **신규** `tests/firewall/ups-host-schema-drift.test.js` | — | §4.3-1 |

### 4.5 완료 판정

| | 기준 | 증거 형식 |
|---|---|---|
| **D1** | 샌드박스: 워킹트리 디스패처 stdout 이 §1.3 허용목록만 포함하고, `/team …` 페이로드에서 `hookSpecificOutput.additionalContext` 첫 줄이 `[artibot:effort …][artibot:task-budget …]`, 비슬래시 페이로드에서 auto-team 힌트가 같은 필드에 이어짐. 두 케이스 모두 stdout < 10,000 B | `probe.mjs` 재실행 출력 + 파이어월 테스트 green |
| **D2** | §4.4 전 항목 반영, **리포 전체 vitest** 숫자 기록(files/pass/skip/fail), `npm run ci` 통과 | 명령 출력 그대로 |
| **D3** | §5 문구 5곳 반영 + config comment | `git diff --stat` + 각 file:line |
| **D4** | **라이브**: 릴리스 + `plugin update` 후 새 세션을 `claude --debug-file <path>` 로 열고 `/team …` 1회 → (a) 트랜스크립트에 `hook_additional_context` 첨부 `hookName:"UserPromptSubmit"` ≥ 1 이고 내용에 `[artibot:effort` 포함, (b) 디버그 파일에 `unrecognized keys` 0건, (c) `tengu_hook_output_persisted` 0건 | 트랜스크립트 grep + 디버그 파일 grep, 세션 ID·시각 명기. **리포 수정만으로는 D4 불가**(설치본 갱신 필요, HOOK-VISIBILITY §6-5) |

**정정(2026-09-04) — D4 분리**: D4(라이브 도달 판정)는 L1 구현 줄기의 완료 기준이 **아니다**. L1 줄기의 완료 = **D1·D2·D3**(샌드박스·테스트·문구). D4 는 **"릴리스 + `plugin update` 후 통합 단계"** 에서 리더가 별도로 판정하고 그 결과를 이 문서 §8 에 추기한다. 이유: D4 는 설치본 갱신을 전제하므로 worktree 안에서 증명할 수 없고(§4.3-4), 줄기 완료(`Split-Limb: done`) 를 D4 에 걸면 줄기가 영원히 미완이 된다.

## 5. 문구 정정안 (P2) — 새 문구 그대로

### 5.1 `commands/team.md:74`

현재: "> **두 값이 팀원에게 닿는 경로는 프롬프트 디렉티브 하나뿐이다.** `Agent` 도구에는 effort·budget 파라미터가 **없다** — 아래 "Auto-Effort Pre-injection" 이 `[artibot:effort level=…][artibot:task-budget max_tokens=…]` 를 팀원 프롬프트 맨 앞에 붙이는 것이 유일한 실경로다(값의 출처는 `runtime/current-effort.json`·`runtime/current-task-budget.json`). 실측 근거는 `lib/cognitive/effort-policy.js:20-22` …"

새 문구:
> **두 값이 팀원에게 닿는 경로는 오케스트레이터(모델)가 쓰는 프롬프트 디렉티브뿐이다.** `Agent` 도구에는 effort·budget 파라미터가 **없다** — 아래 "Auto-Effort Pre-injection" 대로 오케스트레이터가 `[artibot:effort level=…][artibot:task-budget max_tokens=…]` 를 팀원 프롬프트 맨 앞에 **직접 써 넣는다**(값의 출처는 `runtime/current-effort.json`·`runtime/current-task-budget.json`; 파일이 없으면 기본값 xhigh/128000 이 쓰이므로 **설치본에 파일이 있어야 측정값이 반영된다**). 훅(`scripts/hooks/runtime-prompt.js`)은 이 값을 **리더 세션**에는 `UserPromptSubmit` 의 `additionalContext` 로 알릴 뿐이고, 팀원 프롬프트를 직접 만들지 않는다 — 호스트는 훅이 프롬프트를 치환하는 것을 허용하지 않는다(공식 hooks 문서 "UserPromptSubmit: can't replace the prompt", 2.1.259 실측 `PROBE-effort-directive-delivery.md`). 실측 근거는 `lib/cognitive/effort-policy.js:20-30`.

### 5.2 `lib/cognitive/effort-policy.js:20-26`

현재: `//   1. scripts/hooks/runtime-prompt.js resolves EFFORT_POLICY (via effort-resolver.js) on UserPromptSubmit and injects the prose directive \`[artibot:effort level=X command=Y]\` at the top of the user prompt, and persists it to runtime/current-effort.json.`

새 문구:
```
//   1. scripts/hooks/runtime-prompt.js resolves EFFORT_POLICY (via
//      effort-resolver.js) on UserPromptSubmit, persists it to
//      runtime/current-effort.json, and emits the prose directive
//      `[artibot:effort level=X command=Y]` as
//      hookSpecificOutput.additionalContext. The host delivers that as a
//      separate meta message ("UserPromptSubmit hook additional context: …")
//      NEXT TO the user's prompt — a hook cannot rewrite or prefix the prompt
//      itself (measured 2026-09-03 on 2.1.259; see
//      .artibot/guides/v5-design/PROBE-effort-directive-delivery.md).
//      Teammates get the directive only because the orchestrator writes it
//      into each Agent() prompt (commands/team.md "Auto-Effort Pre-injection").
```

### 5.3 `scripts/hooks/runtime-prompt.js:1-13` 헤더

`*   4. the enriched prompt is returned to Claude Code via stdout` →
```
 *   4. the runtime envelope (effort/team/hint directives, route hint, memory
 *      context, guardrail notice) is returned as
 *      hookSpecificOutput.additionalContext — the only UserPromptSubmit
 *      channel the host reads. stdout carries no `user_prompt`: the host
 *      never rewrites the prompt from a hook (2.1.259 measured).
```

### 5.4 `plugins/artibot/CLAUDE.md:64, :68`

:64 "`scripts/hooks/runtime-prompt.js` injects advisory directives (e.g. `[artibot:hint recommend=X]`) into the prompt." → "… emits advisory directives (e.g. `[artibot:hint recommend=X]`) as `UserPromptSubmit` `additionalContext`, which the host places **next to** the prompt as a hook-context message."
:68 "(injected by `scripts/hooks/runtime-prompt.js`)" → "(emitted by `scripts/hooks/runtime-prompt.js` as hook additional context)".

### 5.5 `artibot.config.json` `runtime.effort.comment`

"injectPrompt=true: scripts/hooks/runtime-prompt.js prepends the prose directive … to the user prompt on UserPromptSubmit" → "injectPrompt=true: scripts/hooks/runtime-prompt.js emits the prose directive … as UserPromptSubmit hookSpecificOutput.additionalContext (a hook cannot prepend to the prompt; measured 2026-09-03)". 나머지 문장 유지.

## 6. 구현 순서 (승인 후)

1. 파이어월 테스트 2종 먼저(red 확인) → 2. 디스패처 허용목록 → 3. `runtime-prompt` 조립 → 4. ~~리라이터·auto-team~~ 리라이터(`!rv` A 안 + `--no-team` additionalContext 지시문; auto-team 은 bc2e9e55 로 착지 — 변경 없음) → 5. 기존 테스트 갱신 → 6. 문서 5곳 → 7. D1·D2·D3 **= 줄기 완료** ‖ 8. 릴리스·`plugin update` → 9. D4 (**통합 단계, 리더** — §4.5 정정).
교차검수: 구현자 ≠ 검수자(verification-discipline §11). 검수자는 "허용목록이 부정 목록으로 바뀌지 않았는가", "`payload.user_prompt` 내부 전달이 살아 있는가", ~~"`--no-team` 이 `hookData.prompt` 로 판정되는가"~~ "`--no-team` 이 `extractUserPromptFlagSurface` 로 판정되고 리라이터 제거 분기가 유지되는가(`userprompt-dispatcher.test.js:175-200` GREEN)" 3점을 본다.

미확인: (1) 호스트 10 KB 스필이 additionalContext 를 절단하는지 통째로 버리는지(`Kfe` 의 `truncatedFallback` 경로 미열람); (2) additionalContext 로 옮긴 `!rv` 지시문이 프롬프트 접두사만큼 모델 행동을 바꾸는지(효과 미측정, §4.3-2); (3) `hooks.json:169` timeout 15000 의 단위 의도(§4.3-5); (4) `Lwe` 로그가 디버그 파일 외에 UI 에도 표시되는지(PROBE 와 동일); (5) `tests/hooks/runtime-prompt-decision-wiring.test.js`·`memory-instrumentation.test.js` 가 `out.user_prompt` 외에 stdout 형태를 단정하는 부분이 있는지(해당 행만 확인, 파일 전문 미열람); (6) `ambiguity-guard` 의 `{continue:true}` 를 `null` 로 바꿀 때 `tests/hooks/ambiguity-guard.test.js` 가 그 값을 단정하는지(미열람).

---

## 8. 재대조 2026-09-04 (architect, team-handoff-9d6dc2 · master @ `7cbb37b9` 워킹트리 · 11:3x–12:0x KST)

> 3bcadb8e 기준 본문을 `bc2e9e55`(2026-09-03 17:49) 착지 이후 코드·테스트와 다시 대조했다. 본문은 지우지 않고 취소선 + "정정(2026-09-04)" 단락으로 표시했다(정본 관례). 아래는 무엇을 왜 바꿨는지의 목록이다. 인용 줄번호는 이 시각 워킹트리 측정값 — `_userprompt-dispatcher.js`·`runtime-prompt.js` 는 이 문서의 나머지 항목이 아직 미착지라 §1.4·§3 의 인용은 재측정하지 않았다(미확인, 아래 8-6).

### 8-1. auto-team-trigger 옵트아웃 — "착지됨" 으로 갱신 (§2.2, §4.1 :108, §4.4 :141, §6-4)
- **무엇**: "`auto-team-trigger.js:376` 을 `hookData.prompt` 로" → 착지됨. 실제 착지 형태는 `hookData.prompt` 단독이 아니라 `lib/core/hook-utils.js:319-329 extractUserPromptFlagSurface`(`user_prompt`·`prompt`·`content` 합집합) 이고 호출은 `scripts/hooks/auto-team-trigger.js:379` `if (NO_TEAM_FLAG.test(extractUserPromptFlagSurface(hookData))) return null;`.
- **왜**: `git show --stat bc2e9e55` 에 `auto-team-trigger.js`·`hook-utils.js`·`hook-utils.test.js`·`userprompt-dispatcher.test.js` 포함, 커밋 메시지 2번째 항목이 이 회귀를 명시. 회귀 테스트 `tests/hooks/userprompt-dispatcher.test.js:175-190`(체인 통과 후 `[auto-team-suggested]` 부재) + 대조군 `:192-200` + `tests/core/hook-utils.test.js:444-477`.

### 8-2. §2.2 "리라이터 `--no-team` 분기 삭제" ↔ §4.4 :141 "`user-prompt-handler.test.js` 변경 없음" 모순 — **유지** 쪽으로 해소
- **리더 인용 정정**: 리더가 "§4.1 :141" 이라 적었으나 `:141` 은 **§4.4 테스트 표**의 행이다. §4.1 에서 같은 주장은 `:107`(`user-prompt-handler.js` 행 "`--no-team` 분기 삭제") 이고, 원 주장은 `:83`(§2.2). 모순 자체는 리더 지적대로 실재한다: `:83`/`:107` 삭제 ↔ `:141` 변경 없음 은 동시에 참일 수 없다(`user-prompt-handler.test.js:47-51, :95-105` 가 제거를 단언, `userprompt-dispatcher.test.js:183` 이 "디스패처 계약 — 유지" 로 핀).
- **선택: 분기 유지 + additionalContext 지시문으로 (ii) 달성.** 근거 ① (i) 는 8-1 로 이미 달성 — 삭제가 (i) 에 기여 0. ② 호스트 계약상 원문은 항상 그대로 모델에 가므로(PROBE B8) 제거는 stdout 경계에서 걸러지는 내부 부작용 — (ii) 에도 기여 0. ③ 삭제하면 테스트 3파일 RED 를 고쳐야 하고 호스트에 보이는 이득이 없다. ④ 핀된 계약(`:183` "유지")을 존중하는 쪽이 드리프트가 적다. 반대안(삭제)을 택하려면 §4.4 :141 을 "변경" 으로 바꾸고 `user-prompt-handler.test.js:47-51, :95-105` + `userprompt-dispatcher.test.js:161-167, :183-184` 를 열거해야 한다 — 이 문서는 그 길을 택하지 않았다.
- **본문 갱신 위치**: §2.2 취소선 + 정정 단락, §4.1 :107 행, §4.4 :141 행, §6 4단계·교차검수 3점.

### 8-3. `user_prompt` 단독 페이로드에서의 옵트아웃 — 실측 후 명시 (§2.2 정정 마지막 항)
- **측정(2026-09-04 11:47)**: 스크래치 스크립트로 리라이터 `handleUserPromptSubmit` → `payload.user_prompt` 치환(디스패처 `:206-208` 과 같은 규칙) → auto-team `handleUserPromptSubmit` 을 in-process 로 돌렸다(`CLAUDE_PLUGIN_ROOT`=플러그인 루트, 두 훅은 디스크에 쓰지 않음 — grep 으로 확인). 결과 3행:
  - `{prompt: '<3도메인 프롬프트> --no-team'}` → 리라이터 제거, auto-team **미발화**(옵트아웃 유지)
  - `{user_prompt: '<같은 프롬프트> --no-team'}` 단독 → 리라이터 제거, auto-team **발화**(옵트아웃 소실)
  - 대조군 `{user_prompt: '<같은 프롬프트>'}`(플래그 없음) → 발화
- **판정**: 레거시 단독 키 페이로드가 **디스패처 체인**을 통과하면 옵트아웃이 보장되지 않는다. 라이브 도달 불가(호스트는 `prompt` 를 보냄; 개별 훅 레거시 `main()` 은 리라이터를 거치지 않음). `tests/e2e/runtime-flow.test.js:33` 은 체인에 auto-team 을 넣지 않아 이 사례를 보지 않는다. **고치지 않고 문서화** + 있는 그대로 핀하는 테스트 1건을 §4.4 에 추가(거짓 그린 방지). 실제 디스패처 서브프로세스로는 재현하지 않았다(in-process 재현 — 추론 아님, 실측이되 경로가 동형이라는 것은 `_userprompt-dispatcher.js:203-208` 코드 읽기에 근거).

### 8-4. `artibot.config.json` 소유권 — L1 로 확정 (§4.1 :110)
- L1(이 설계) 이 `artibot.config.json` 을 소유한다(`runtime.effort.comment` + `runtime.hooks.userPromptSubmit.legacyStdout`). L2 `ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` §6 의 `routing.observe.receiptStage` 는 **L2 D1 착수 시 통합 단계에서 리더가 추가**한다. 현재 split 계획(`.artibot/split/plan.json`, run `split-9d6dc2`)의 `l2-probe` 줄기는 `scripts/dev/probe-hook-keys.js`·`tests/hooks/fixtures/host-payloads/` 2경로만 소유하고 config 를 건드리지 않는다. 확인: `grep -n "receiptStage\|legacyStdout" artibot.config.json` 0건(11:4x) — 두 키 모두 아직 없다.

### 8-5. D4 분리 (§4.5, §6)
- D4(라이브 도달)는 "릴리스 + `plugin update` 후 통합 단계" 로 분리. L1 줄기 완료 = D1·D2·D3. 이유는 §4.5 정정 단락.

### 8-6. 재대조에서 확인하지 않은 것(미확인)
- `_userprompt-dispatcher.js` `mergeHookResults`(`:155-186`) 는 아직 "나머지 전부 복사" 그대로(11:4x `grep HOST_` 0건) — §1.4·§3 의 변경은 미착지이며 그 인용 줄번호는 재측정하지 않았다.
- `runtime-prompt.js#composePromptOutput` 은 `:706` 에서 시작(문서 `:707` 과 1줄 차) — 본문은 고치지 않았다(구현 시 재측정).
- `ambiguity-guard.test.js` 가 `{continue:true}` 를 단정하는지 — 여전히 미열람.
- 8-3 을 실제 디스패처 서브프로세스(`runDispatcher` 헬퍼)로 재현하지 않았다.
