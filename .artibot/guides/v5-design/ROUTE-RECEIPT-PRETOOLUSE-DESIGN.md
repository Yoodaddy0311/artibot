# 라우팅 shadow receipt 의 PreToolUse(Agent) 이관 설계안 (ROUTE-RECEIPT-PRETOOLUSE)

> **오너 승인 전 구현 금지.** 설계안이다. 코드·테스트·config 변경 없음. 커밋 없음.

**결정 근거**: 오너 2026-09-03 — INCIDENT §6.2 선택지 중 **(B/c) PreToolUse(Agent) 이관 + `prompt_id` 브릿지, 설계안 먼저**.
**작성**: incident 팀원(fable, 설계 담당), 2026-09-03 16:4x. 리포 `master @ 3bcadb8e`. 라인 인용은 HEAD.
**선행**: `INCIDENT-2026-09-03-hook-payload-contract.md`(F10·F14, §3.1 세 번째 관측, §6.2), `HOOK-VISIBILITY-DESIGN.md` §3.3.

---

## 0. 요약

- SubagentStart payload 에는 액션 텍스트가 없다(2.1.259 스키마 3자 실측). 텍스트·`subagent_type` 이 실재하는 유일한 지점은 **PreToolUse 의 `tool_input`**(`tool_name === 'Agent'`).
- 기록을 PreToolUse 로 옮기고, SubagentStart 에서 `agent_id` 로 **묶는 행을 하나 더** 쓴다(2단계). PreToolUse 시점엔 실제 스폰 모델을 모르므로 1단계로는 `applied:false` shadow 의 "선택 vs 실제" 비교가 성립하지 않는다.
- 상관 키는 없다. `prompt_id`(1차) + Agent 입력 `name`(2차, 명명 스폰은 결정적) + `subagent_type`·순서(3차, 확률적)로 매칭하고, **오판을 탐지하는 불변식**을 원장에 함께 남긴다.
- PreToolUse 는 block 권한이 있는 지점이다 — receipt 경로는 **stdout 을 만지지 않고, 어떤 경우에도 throw 하지 않는다**(`event-writer` 계약). 행동 변화 0.
- 전제 2개가 **미확인**(§1.2 프로브): `tool_input` 실제 키, 팀 스폰에서 PreToolUse 발화. 프로브가 깨지면 (C) 로 간다.

---

## 1. 기록 지점 — PreToolUse, `tool_name === 'Agent'`

### 1.1 실측 전제
| 사실 | 값 | 등급 |
|---|---|---|
| PreToolUse 입력 스키마 | base + `{tool_name, tool_input: de(), tool_use_id}` (2.1.259 바이너리, 리더 16:2x) | 실측 |
| `tool_input` 내용 | 스키마상 `de()`(임의 객체) — **바이너리로는 못 잡는다** | 실측(부재) |
| Agent tool_use 입력(이 세션 부모 전사, 16:2x) | `{description, subagent_type, name, model, prompt}` | 실측(전사) — PreToolUse `tool_input` 이 같은 객체인지는 **추론** |
| 리포의 기존 가정 | `tool-tracker.js:352-355` 가 `case 'Task'` 에서 `input.subagent_type` 을 읽음 — 도구명이 `Task`→`Agent` 로 바뀐 뒤 이 분기는 `default`(`use:agent:tool`) 로 빠진다 | 실측(코드) — 라이브 도달 **미확인**. 같은 클래스의 낡은 키 |
| PreToolUse 훅 등록 | `hooks/hooks.json:20-106` 매처 = `Write\|Edit`·`Bash`·`WebFetch` 뿐. **`Agent` 매처 0** | 실측 |
| PreToolUse 가 Agent 도구(팀 스폰 포함)에 발화하는가 | `~/.claude/artibot/daily-experiences.json`·`learning-log.json` 에 `Agent` 도구 기록 0건 — 단 매처가 없으니 0 은 당연 | **미확인** |

### 1.2 라이브 프로브 (구현 전 필수, 키 **이름만** 기록)
- 임시 훅 `scripts/dev/probe-hook-keys.js`: stdin JSON 을 파싱해 **최상위 키 이름 + `tool_input` 의 키 이름 + `tool_name` + `hook_event_name`** 만 `~/.claude/artibot/runtime/probe-keys.ndjson` 에 append. 값은 어떤 것도 쓰지 않는다(프롬프트·경로·id 포함). `prompt_id` 는 **존재 여부(boolean)** 만.
- 등록: 임시 settings(`--settings <file>`)에 `PreToolUse` 매처 `tool == "Agent"` + `SubagentStart` + `UserPromptSubmit`(출력 프로브는 INCIDENT §7 D2). 등록 방법 자체(워킹트리 훅을 호스트에 태우기)는 **미확인**.
- 시나리오 3: 단일 `Agent(...)` 1회 / `name` 있는 팀 스폰 병렬 3개 / 이름 없는 `Agent` 병렬 2개. 각 SubagentStart 와 짝이 맞는지 §2 규칙으로 손으로 대조.
- 산출 → `tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json`(INCIDENT §6.1 ① 형식, `host_version` 기록). **여기서 `prompt`·`description` 이 없으면 이 설계는 무효 → (C).**

### 1.3 추출 규칙(허용목록)
`tool_input` 에서 읽는 키 = `prompt`·`description`·`subagent_type`·`name`·`model` **5개만**(프로브로 확정된 것만 남긴다). 액션 텍스트 = `description` 우선(짧고 의도 요약), 없으면 `prompt` 앞 **2,000자**(복잡도 채점 입력 — 원장에는 텍스트를 쓰지 않고 `text_sha256` 앞 12자·`text_len` 만). 왜 `description` 우선인가: 이 세션 프롬프트는 수 KB 이고 `[artibot:effort …]` 접두가 붙어 분류기 키워드를 오염시킨다 — 근거는 전사 1건 관찰, **판단**.
`agentType`(분류기 입력) = `subagent_type`(`artibot:devops-engineer` → 접두 `artibot:` 제거 후 에이전트 표 조회). 이것이 INCIDENT §3.1 세 번째 관측(`actionClass:null` 19/19)을 함께 닫는다.

---

## 2. 상관 — PreToolUse `{tool_use_id, prompt_id}` ↔ SubagentStart `{agent_id, prompt_id}`

### 2.1 실측 전제
- 직접 키 없음. 부모 전사에 `agent_id` **0회**(1.6MB grep) → 전사 역추적 불가.
- `agent_id` 형태(설치 이후 19/19): 명명 스폰 `a<name>-<hex16>`, `agent_type = <name>`; 무명 스폰 `a<hex16>`, `agent_type = "teammate"`.
- `prompt_id`: base 에 optional, describe "한 프롬프트 이후 모든 이벤트에 같은 값" — 라이브 실림 **미확인**.

### 2.2 매칭 규칙 (순서 고정, 첫 성공에서 정지)
```
후보 = 같은 session_id 의 미결합 PreToolUse(Agent) receipt, 최근 N=32, 시간창 10분
1차: prompt_id 동일             (prompt_id 가 양쪽에 있을 때만; 없으면 이 단계 생략하고 confidence 강등)
2차: agent_type === tool_input.name  ← 명명 스폰은 여기서 결정적(동명 재스폰은 "가장 최근 미결합")
3차: agent_type === 'teammate' && 후보의 subagent_type 을 에이전트 표로 정규화한 값 === (없음 — SubagentStart 엔 subagent_type 이 없다)
     → 무명 스폰은 "같은 prompt_id 안 미결합 후보 중 가장 오래된 것"(FIFO 가정)
결합 실패: route_ledger = 'skipped:unbound'
```
| 단계 | 결정성 | 오판 조건 | 오판 시 잘못 기록되는 것 |
|---|---|---|---|
| 1차 `prompt_id` | 프롬프트 단위 분할 | 없음(같으면 같은 프롬프트) — 단 `prompt_id` 부재 시 2·3차가 세션 전체를 뒤진다 | — |
| 2차 `name` | 결정적 | 한 프롬프트 안 **같은 `name` 재스폰**(이 세션 `record` 3회 start, 다만 프롬프트가 달랐는지 미확인) | 이전 스폰의 텍스트·복잡도가 새 `agent_id` 에 붙음 — 같은 이름이면 대개 같은 역할이라 **피해 작음**, 그러나 `predicted`·`terms` 가 실제와 어긋남 |
| 3차 FIFO(무명) | 확률적 | 호스트가 SubagentStart 를 tool_use 순서로 보장하는지 **미확인**; 병렬 6개면 순열 오판 가능 | 다른 에이전트의 텍스트가 붙음 — `subagent_type` 이 다르면 `action.type`·`recommended` 가 **틀린 행이 원장에 남는다** |

### 2.3 오판 탐지 불변식 (원장에 함께 남긴다 — 없으면 오판은 영원히 "ok" 로 보인다)
1. **1:1** — 한 `tool_use_id` 는 최대 한 `agent_id` 에, 한 `agent_id` 는 최대 한 `tool_use_id` 에 결합. 위반 = `bind.conflict`.
2. **보존** — 결합 행의 `subagent_type`(정규화) 이 스폰 후 `canonicalModel` 을 낸 `resolveModel(agentType)` 의 입력과 일치해야 한다(무명 스폰은 검사 불가 → `confidence:'fifo'`).
3. **잔여** — 세션 종료 시 미결합 PreToolUse receipt 수와 `skipped:unbound` SubagentStart 수를 `/doctor` Check 10 이 **나란히** 보고. 둘 다 0 이 아니면서 서로 다르면 매칭이 어딘가에서 어긋난 것(규칙 §5 정합성).
4. 모든 결합 행에 `correlation:{method:'prompt_id+name'|'prompt_id+fifo'|'name-only'|'fifo-only', confidence:'exact'|'inferred'}` — **`exact` 는 2차까지 통과한 명명 스폰뿐.** KPI 는 `exact` 만 분자로 쓰고 `inferred` 는 따로 센다.

---

## 3. 1단계인가 2단계인가 — **2단계**

| | 1단계(PreToolUse 행 하나) | **2단계(PreToolUse receipt + SubagentStart bind)** |
|---|---|---|
| `models.selected` | 모름(스폰 전). `applied:false` shadow 의 "추천 vs 실제" 비교 불가 → receipt 의 존재 이유 절반 상실 | SubagentStart 의 `canonicalModel`(`subagent-handler.js:493`) 로 bind 행에 기록 |
| `routing_epoch_id` | `tool_use_id` 로 바꿔야 함 — G1 "스폰 단위(agentId)" 오너 결정과 충돌 | receipt 는 `tool_use_id` 를 임시 epoch 로, bind 에서 `agent_id` 로 확정 — G1 유지 |
| 스키마 | `route-receipt.schema.json` required 15 중 `models.selected` 를 "미정" 으로 쓰면 T-31 "없는 값은 안 쓴다" 위반 | receipt 에 `models.selected` 는 **`resolveModel(subagent_type)` 예측값**을 `predicted_selected` 로, 실제는 bind 행에 |
| 원장 어휘 | `route.selected` 그대로 | `route.selected`(PreToolUse, `source:'hook'`, `data.stage:'pre'`) + **신규 `route.bound`**(SubagentStart) — `schemas/ledger-events.allowlist.json` 36종에 1개 추가 커밋이 먼저 |
| `spawns.ndjson` 봉투 | 무변경 | `route_ledger` 어휘에 `ok:bound`·`skipped:unbound` 추가(허용목록). `recommendedModel`·`actionClass` 컬럼은 bind 결과로 채움(지금 null 19/19) |
| append-only | — | receipt 를 **갱신하지 않는다**; bind 는 별도 행. 읽기 모델(`lib/replay`)이 `tool_use_id` 로 조인 |

**중간 상태 저장**: PreToolUse receipt 의 미결합 목록은 원장 자체에서 읽는다(최근 N 행 역방향 스캔, `tool_use_id` 가 아직 `route.bound` 에 없는 것). 별도 상태 파일을 두지 않는다 — 두 번째 진실원 금지. 스캔 비용은 스폰당 원장 꼬리 읽기(4KB×32 = 128KB 상한), **미측정**.

---

## 4. Phase 0 "행동 변화 0" — PreToolUse 는 block 지점이다

- 새 훅 `scripts/hooks/route-observe-pre.js`(가칭)는 **stdout 에 아무것도 쓰지 않는다.** `pre-bash.js` 처럼 `writeHookResult` 를 쓰는 훅과 같은 파일에 넣지 않는다 — 분리된 프로세스, 분리된 등록(`hooks.json` PreToolUse 에 매처 `tool == "Agent"` 항목 1개 추가, timeout 3000).
- 본문 전체가 `try { … } catch { /* 삼킴 */ }` + `process.exitCode = 0` 고정. 원장 쓰기는 `appendLedgerEvent`(`event-writer.js#writeEvent` catch-all `{ok:false}` 계약) 경유. **어떤 경로도 exit 2 를 내지 않는다** — exit 2 는 도구 실행을 막는다(호스트 문서).
- 파이어월 테스트: 픽스처 payload 8형태(정상·`tool_input` 없음·`prompt_id` 없음·원장 쓰기 불가·순환 객체·64KB 프롬프트·`tool_name !== 'Agent'`·JSON 아님) 전부에서 **stdout 바이트 0·exit 0**. 그리고 `tool_name !== 'Agent'` 는 첫 줄에서 반환(다른 도구 호출에 비용 0 — 매처가 있어도 이중 방어).
- 타임아웃 3s 안에 끝나지 않으면 호스트가 SIGTERM — receipt 만 잃고 도구 실행은 진행(호스트 문서: 타임아웃은 non-blocking). 확인은 프로브.
- 기존 `subagent-handler.js` 의 stdout 리터럴(`{message:'[team] Agent registered: …'}`) 은 바이트 불변 — 테스트 `:335-344` 가 이미 핀.

---

## 5. 기존 SubagentStart 경로 처분

| 대상 | 처분 | 근거 |
|---|---|---|
| `extractActionText`(`:200-209`) + `skipped:no-action-text`(`:338`) | **제거.** 대신 `buildRouteReceipt` 는 호출되지 않고 `observeRoute` 는 **bind 만** 수행 | 호스트가 텍스트를 보내지 않으므로 이 경로는 영구 `null`. payload 팀원 워킹트리 주석("DO NOT fix by adding key spellings")과 일치. 남겨두면 "언젠가 키가 생길지도"라는 두 번째 진실원 |
| `skipped:no-action-text` 어휘 | 허용목록에서 **삭제**, `skipped:unbound` 로 대체 | 과거 원장 행(14/14~)은 그대로 남고 읽기 모델이 "구 어휘 = Phase 0 설계 결함 시기" 로 해석. CHANGELOG 4.53.0 절에 정정 1줄 |
| `extractDepth`·`extractTaskId`·`resolveMissionId` | 유지 | payload 에 있을 수 있는 키(depth 는 forward-looking 이라 문서화됨) |
| `getActionClassForAgent(agentType)`(`:380`) | bind 시 `subagent_type` 정규화 값으로 교체 | `actionClass:null` 19/19 해소 |
| 테스트 `subagent-handler-routing-fields.test.js` `basePayload` | `tool_input.prompt`·`name` **삭제**, 호스트 동결 픽스처(INCIDENT §6.1 ①) 로 교체. `:296-306` 케이스는 `skipped:unbound` 로 | 존재하지 않는 키를 핀하지 않는다 |

---

## 6. 되돌리기 · 못 보는 것 · 완료 판정

**되돌리기 — config 1키**: `artibot.config.json#/routing/observe`(`:852`, 현재 `true`) 아래 `receiptStage: "pre" | "start" | "off"`(기본 `"pre"`). `"off"` 면 두 훅 모두 원장을 쓰지 않고 `route_ledger:'skipped:observe-off'`; `"start"` 는 **되돌리기용이 아니라 존재하지 않는 과거**(텍스트가 없으므로)라 허용값에서 제외 — 즉 `"pre" | "off"` 2값. 코드 revert 는 신규 훅 1파일 + `subagent-handler.js` bind 부분 + `hooks.json` 항목 1개 + allowlist 1항.

**못 보는 것(게이트 옆에 적는다)**
1. `prompt_id` 가 라이브에 없으면 1차가 사라지고 무명 스폰은 세션 전체 FIFO — `confidence:'inferred'` 가 대부분이 되고 KPI 분자가 비어 보인다(정직한 결과).
2. SDK·schedule·loop 경로(`source` 필드)로 들어온 스폰은 Agent 도구를 거치지 않을 수 있다 — PreToolUse receipt 없음 → `skipped:unbound` 가 정상인 스폰이 섞인다. 분모에서 빼려면 `source` 를 UserPromptSubmit 에서 세션 상태로 넘겨야 하는데 그 배선은 범위 밖.
3. 호스트가 `tool_input` 을 마스킹·절단해 넘기는 경우(대형 프롬프트) — 프로브 시나리오에 64KB 케이스 포함.
4. 호스트 버전이 바뀌어 `tool_input` 키가 바뀌면 동결 픽스처 diff 로만 잡힌다(INCIDENT §6.1 ④).
5. 오판 불변식은 **명명 스폰**에서만 강하다. 무명 병렬 스폰의 오판은 사후 탐지 불가 — `confidence` 로 격리할 뿐.
6. 이 설계는 텍스트를 **얻는** 것이지 채점이 **맞는** 것이 아니다 — `route-scorer` 미보정(G4·G5 UNCALIBRATED) 그대로.

**완료 판정**
| 단계 | 판정 | 확인 |
|---|---|---|
| D0 프로브 | §1.2 시나리오 3 통과: `tool_input` 키 5개 중 `prompt`·`description`·`subagent_type` 실재, SubagentStart 와 손대조 일치 | `probe-keys.ndjson` + 동결 픽스처 커밋 |
| D1 코드 | 신규 훅 + bind + allowlist + 파이어월 8형태 stdout 0·exit 0 + 동결 픽스처만 사용 | `npx vitest run tests/hooks/route-observe-pre* tests/firewall/host-payload-contract*` |
| D2 워킹트리 라이브 | 임시 settings 로 1회 태워 receipt+bind 쌍 1건, `confidence:'exact'` | 원장 2행 |
| D3 릴리스+update | `installed_plugins.json.lastUpdated` ≥ 릴리스 시각 | 파일 |
| **D4 라이브 원장** | 설치 이후 **PreToolUse(Agent) ≥10** 에서 receipt 비율, 그리고 **bind 비율**(`exact` / `inferred` / `unbound` 를 분모·시각과 함께). `receipt 10/10, bound exact 7/10, inferred 2/10, unbound 1/10` 형식. 불변식 1·3 위반 0 | `awk` on `.artibot/runtime/ledger.jsonl` + `spawns.ndjson` |

D4 의 "ok" 는 **쌍**이다 — receipt 만 10/10 이고 bind 0/10 이면 미완(텍스트는 얻었으나 실제 모델과 비교 못 함).

---

## 7. 미확인
- 라이브 PreToolUse `tool_input` 의 실제 키(스키마 `de()`).
- PreToolUse 가 Agent 도구·팀 스폰에 발화하는지, 타임아웃이 non-blocking 인지(문서 기술만).
- `prompt_id` 가 라이브 payload 에 실리는지.
- 병렬 스폰의 SubagentStart 순서가 tool_use 순서를 따르는지(3차 FIFO 전제).
- 이 세션 `record` 3회 start 가 같은 프롬프트 안이었는지(2차 오판 조건의 실빈도).
- 워킹트리 훅을 호스트에 태우는 공식 방법.
- 원장 꼬리 스캔(128KB 상한) 비용.
