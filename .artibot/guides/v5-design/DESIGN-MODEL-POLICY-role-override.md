# 설계안 — 모델 정책 역할 오버라이드 ("처리는 opus, 사고·판단·결정은 fable")

> **오너 승인 전 구현 금지.** 설계안이다. 코드·테스트·config·에이전트 frontmatter 무변경. 이 파일 1개만 신설했다.
> 작성: architect (team-handoff-9d6dc2, fable), 2026-09-04 13:5x KST · 기준 master @ `ca013e2c` (v4.54.0) · 경로는 `plugins/artibot/` 기준. 줄번호는 13:4x 워킹트리 측정값.
> 계기: 오너 12:0x 제기 — "처리는 opus, 사고·판단·결정은 fable". 정본 `ARTIBOT-5.0-DESIGN.md` 부록 0-2 후속(2)(`:899~`)와 2차 plan `.artibot/split/next-batch-plan.md` (D)-4 → 오너 13:3x "설계안 작성 지시".
> 상위 정본: `ARTIBOT-5.0-DESIGN.md` §0 OD-2(4티어 어휘, 실효 2티어) · §1-6(정책과 선택의 분리) · §3.2(라우팅 5개념) · 오너 결정 2026-09-02 "구현·테스트 = opus, 검수·설계 = fable"(`~/.claude/rules/artibot/agent-coordination.md`). `FABLE_DENYLIST`(security-reviewer)는 **이 설계의 범위 밖 — 건드리지 않는다.**

---

## 0. 한 줄 판정

현행 정책은 **에이전트 정의 이름**으로 티어를 정한다(`resolveModel(agentName)`). 조사·측정·감사 성격의 작업이 구현 에이전트(또는 `general-purpose`)에게 배정되면 opus 로 간다 — 오늘 doctor·followup 팀원이 그 사례다. 게다가 **`/team` 팀원 이름은 정책 키가 아니라서 드리프트 플래그가 눈을 감고 있다**(오늘 스폰 22/22 `canonicalModel: null`, §1.5). 해법은 한 에이전트 안의 모델 분리(불가 — Agent 도구는 스폰당 `model` 1개)가 아니라 **스폰 경계에서 "작업 성격"을 정책에 넘기는 것**이다. 대안 5개를 비교한 결과, 권장은 **B(리더 태깅, 문서·Observe) 지금 + D(조사·감사 전용 에이전트 정의 2종을 allowlist 에) 승인 시**, A(role 어휘 확장 + 게이트 의미 변경)는 **오너가 "역할이 이름을 이긴다"를 결정할 때만**, C(전 서브에이전트 fable)·E(액션 클래스 자동 승격)는 **불채택**. 어느 안이든 **효과 측정 없이는 착시**이므로 §4 측정 계획이 선행 조건이다 — 그 측정은 L2 D1(PreToolUse receipt) 없이는 분모를 얻을 수 없다.

---

## 1. 현행 실측

### 1.1 해석기 — `lib/core/model-policy.js#resolveModel` (611줄, 직접 읽음)

우선순위(`:266-296` JSDoc + 본문):
```
0. 별칭/티어 입력(frontier|deep-async|balanced|fast|티어명) → 카탈로그 즉시 해석, opts.advisor/role 무시. fable 이면 opts.agentType 으로 게이트
1. opts.advisor → advisorStrategy.advisorModel(현재 opus) 게이트
2. opts.role ∈ BUILD_ROLES{implementation,build,impl} | REVIEW_ROLES{review,inspect,crosscheck} → phaseRoles.{build,review} 게이트
3. 버킷(high/medium) 조회 → 없으면 DEFAULT_MODEL 'opus' → 게이트
```
**게이트 `gateFableTier(tier, agentType)`** (`:322-329`): tier 가 fable 이면 `isFableAllowed(agent)` = `fable.enabled ∧ allowlist.includes(agent) ∧ ¬FABLE_DENYLIST`. **role 은 티어를 고르지만 게이트를 넘지 못한다** — `resolveModel('backend-developer', {role:'review'})` = opus(JSDoc 예시 `:281`). 즉 오늘의 정책에서 "역할"은 allowlist 안의 8 에이전트에게만 의미가 있다. `allowedTiers`(`:436-459`)도 같은 규칙 — role 은 상한을 넓히지 못한다("A role … never widens the ceiling past the allowlist" `:429`).

### 1.2 정책 데이터 — `artibot.config.json#/agents/modelPolicy` (node 로 덤프)

| 키 | 값 | 비고 |
|---|---|---|
| `high` | `model: fable`, 21 에이전트 | 12개는 allowlist 밖 → 게이트가 opus 로 강등(의도, `fable.comment`) |
| `medium` | `model: opus`, 7(마케팅·문서) | |
| `low` | `model: sonnet`, **빈 목록** | 해석기가 읽지 않음(불활성 ×2, `low.comment`) |
| `fable.enabled` | `true` | 킬스위치 |
| `fable.allowlist` | 8: orchestrator·architect·planner·code-reviewer·spec-reviewer·quality-reviewer·llm-architect·repo-benchmarker | **유일한 fable 집합** |
| `phaseRoles` | `{ build: opus, review: fable }` | `resolveModel(agent,{role})` 경유 시 allowlist 대조 |
| `advisorStrategy` | `advisorModel: opus`, maxUses 3 | |

frontmatter(`agents/*.md` 28 + INDEX): `model: fable` **8**(allowlist 와 정확히 일치), `model: opus` **20**. `scripts/ci/validate-model-policy.js`(223줄)가 frontmatter ↔ `resolveModel(name,{},config)`(`:201`) 를 대조하는 드리프트 게이트 — role 축은 검사하지 않는다(에이전트 이름당 값 1개라는 전제).

### 1.3 강제 지점은 0, 관측 지점은 1(눈 감음)

- **Agent 도구**는 스폰당 `model`(sonnet|opus|haiku|fable) 1개를 받는다(도구 스키마). 오케스트레이터가 무엇을 적든 **정책은 조언**이고, 훅은 모델을 바꾸지 못한다(PreToolUse 는 block 가능·modify 불가 — 호스트 문서. block 으로 강제하면 Phase 0 "행동 변화 0" 위반이라 §3-F 불채택).
- **SubagentStart 훅** `scripts/hooks/subagent-handler.js#checkModelPolicy`(`:54-70`): `getPolicyModel(agentType) === null` 이면 `canonicalModel:null, modelMismatch:false` 로 **경고 억제**(`:62-64`, 의도된 오탐 방지). 그런데 SubagentStart 페이로드의 `agent_type` 은 **팀원 이름**(`team-handoff-9d6dc2-architect`) 또는 `teammate` 다(호스트 2.1.259/260 실측, INCIDENT F10 · `ROUTE-RECEIPT` §2.1) — 정책 키(정의 이름)가 아니므로 **항상 null**.
- **`lib/routing/adaptive-model-router.js:494`** 는 `resolveModel(src.agentType, {role})` 로 `models.selected` 를 계산하지만 관측 전용(`routing.observe:true`, 캐너리 빈 목록).

### 1.4 어휘 — `lib/routing/action-classifier.js`

`ACTION_CLASSES` 8종(`:55-64`): classify·status·explore·edit-routine·implement·complex-debug·architecture·review. `ACTION_CLASS_TIERS`(`:98-107`): **explore → sonnet**, review → fable, architecture → fable, implement → opus. lexicon(`:308-313`)은 `investigate·조사·탐색` 을 **explore(→sonnet)** 에, `audit·감사·검수` 를 **review(→fable)** 에 둔다. 즉 **설계 어휘는 "조사 = 싼 모델" 방향**이고, 오너 12:0x 는 "사고·판단 = fable" 방향이다 — 둘은 **"조사"를 어디까지 기계적 처리로 보느냐**에서 갈린다(§5 결정 1).

### 1.5 오늘 데이터 (2026-09-04, 부모 리포 `.artibot/ledger/spawns.ndjson` 1,012행 중 오늘 22행, 13:4x `node` 집계)

| agentType(=팀원 이름) | 건 | requestedModel | canonicalModel |
|---|---|---|---|
| `team-handoff-9d6dc2-architect` | 7 | null | **null** |
| `teammate` | 4 | null | null |
| `…-record` | 3 | null | null |
| `…-doctor` · `…-followup` · `…-inspector` · `…-briefs` | 2·2·2·2 | null | null |

**22/22 `canonicalModel: null`** — 정책 드리프트 관측이 `/team` 스폰에는 구조적으로 0 이다. 어느 팀원이 opus 였고 어느 팀원이 fable 이었는지 **원장으로는 알 수 없다**(리더의 스폰 시 `model:` 지정은 트랜스크립트에만 있다). worktree 4개 스폰 원장(5·9·22·19행)도 같은 스키마.

**뒤집힌 주장(오늘, 정본 기록분)**: fable 리더의 "쓰기 주체 실측 확정"(`:814`)이 followup 팀원(opus 로 추정 — 미확인) 실측으로 **반증**(`:818~`, 등급 실측→추론 강등) **1건**. opus 팀원 보고가 검수에서 뒤집힌 건수 "0"은 **리더 보고값(미검증)** — 분모(오늘 팀원 보고 주장 수)를 아무도 세지 않았다. **n=1 은 근거가 아니다**(G2 와 같은 규율). 이것이 §4 가 먼저인 이유다.

### 1.6 문서 불일치 1건(코드 아님, 기록)

`commands/team.md:155` 주석 "구현/검토 역할 모두 frontier 티어 (fable 마이그레이션 이후)" 는 `:10`·`:47`·`:516`(구현 opus / 검수 fable)과 모순 — 2026-09-02 이전 문구 잔존. 이 설계안과 무관하게 정정 대상(문서 레인).

---

## 2. 제약 (리더 의견 대조)

| 리더 의견 | 대조 결과 |
|---|---|
| "한 에이전트 안에서 모델 분리 불가(Agent 도구 = 에이전트당 모델 1)" | **맞다.** Agent 도구 스키마 `model` 단일. 세션 중 서브에이전트 모델 전환은 정본 §5 D8 "호스트 지원 미확인" 그대로 |
| "경계에서만 가능" | **맞다** — 단 경계는 둘이다: ① **리더의 스폰 결정**(prompt 층, 강제 0) ② **정책 해석기 입력**(`agentName`·`role`·`alias`). ①은 문서로, ②는 코드로 바꿀 수 있다 |
| "(a) role 축에 investigate/audit/measure 추가해 allowlist 밖 에이전트도 review 티어로" | **현행 게이트로는 안 된다** — role 은 allowlist 를 넘지 못한다(§1.1). (a) 를 이루려면 **게이트 의미 변경**("REVIEW_ROLES 면 allowlist 우회, denylist 는 유지")이 필요하고 그것은 fail-open 방향의 확장이다(§3-A 위험) |
| "(b) Phase 1 리더 태깅" | 가능. 강제 0·비용 0·측정은 L2 receipt 의존(§4) |
| "(c) 전 서브에이전트 fable 반대 — 비용 계수 미검증, opus 보고 REFUTED 0 · fable 리더 반증 1" | 방향은 동의. 단 "REFUTED 0" 은 분모 없는 수치(§1.5) — **반대 근거로도 쓰지 않는다.** 비용은 `getCostFactor('fable')` = (10/5)×1.3 = **2.6**(카탈로그 `:226-231` 산식; 가격·계수 자체는 미검증 표기) |

---

## 3. 대안 비교

| 안 | 내용 | 변경 지점 | fail-open? | 비용 | 되돌리기 | 판정 |
|---|---|---|---|---|---|---|
| **A** role 어휘 확장 + 게이트 의미 변경 | `REVIEW_ROLES` 에 `investigate·audit·judge` 추가, `gateFableTier` 를 "role ∈ REVIEW_ROLES 이면 allowlist 우회, `FABLE_DENYLIST` 유지" 로 | `model-policy.js` REVIEW_ROLES(`:346`)·`resolveModel` 2단계(`:290-292`)·`gateFableTier`(`:322`) · `allowedTiers` JSDoc `:429` 문장 삭제 · `tests/core/model-policy*.test.js`·`tests/firewall/v5-config-firewall.test.js`(allowlist 8 핀 — 미열람) · `validate-model-policy.js` 는 role 축 미검사라 무변경 · `commands/team.md:47,:516` 문구 | **예, 부분** — role 문자열 하나로 20 에이전트가 fable 가능. 억제는 denylist(1개)뿐. 리더가 role 을 남발하면 비용 상한 없음 | 스폰당 ×2.6, 빈도는 리더 재량 → **상한 없음** | REVIEW_ROLES 원복 + 게이트 1분기 삭제 = revert 1커밋 | **보류** — "역할이 이름을 이긴다"는 2026-09-02 결정("이름 allowlist 가 유일한 fable 집합")의 **번복**이라 오너 결정 사항(§5-2). 채택 시 role 별 예산 상한(`phaseRoles.review.maxSpawnsPerRun` 류) 동반 필수 |
| **B** Phase 1 작업 성격 태깅(문서) | `team.md` Phase 1 DECOMPOSE 에 작업마다 `nature: process\|judge` 태그 → judge 작업은 **allowlist 8 중 하나**(architect·planner·*-reviewer·repo-benchmarker)에 배정, process 는 구현 에이전트. `PROMPT-TEMPLATE`·브리프 §1 에 같은 절 | `commands/team.md` §Phase 1·§Teammate Rules · `templates/split/PROMPT-TEMPLATE.md` · `~/.claude/rules/artibot/agent-coordination.md` 1줄 | 아니오 — 정책·게이트 무변경. 리더가 태깅을 잊으면 **오늘과 같음**(현상 유지, 악화 아님) | 0(코드) · fable 스폰 수는 리더 배정에 비례 | 문서 원복 | **지금(권장)** — Observe 단계 원칙("행동 변화 0, 기록") 안. 효과는 §4 로 잰다 |
| **C** 전 서브에이전트 fable | `fable.allowlist` 를 28 로 | config 1키 + frontmatter 20 | 아니오(전부 명시) | **×2.6 전면**, 편익 미측정 | config 원복 | **불채택** — 2026-09-02 결정 번복 + 미측정 지출. 리더 (c) 와 동일 판정 |
| **D** 조사·감사 전용 에이전트 정의 신설 | `agents/investigator.md`(조사·측정·정합성 대조 — "판정"까지)·`agents/auditor.md`(사후 감사·주장 반증) 를 `model: fable`·`fable.allowlist` +2·`high.agents` +2. 리더는 judge 성격 작업을 이 둘에 배정 | `agents/*.md` 2 신설 · `artibot.config.json` allowlist 8→10, high 21→23 · `scripts/validate.js` 로스터 **28 핀**(`fable.comment` "28-agent roster count" — 값 갱신) · `tests/firewall/v5-config-firewall.test.js`(allowlist 8·frontmatter 대응 핀 — 미열람, RED 예상) · `agents/INDEX.md` · rules 문서 "8/28"→"10/30" | 아니오 — 이름 allowlist 원칙 유지(**2026-09-02 결정과 정합**) | 스폰당 ×2.6, **이름으로 셀 수 있어 상한·집계 가능**(spawns.ndjson `agentType` 이 정의 이름일 때 — `/team` 이름 문제는 §4 참조) | 파일 2 삭제 + config 2줄 + 핀 원복 | **승인 시 채택(권장)** — 정책 구조 무변경, CI 드리프트 게이트가 그대로 덮는다. 단 "investigator 가 조사만 하고 판정은 안 한다"는 프롬프트 규율은 정의 파일 본문이 진다 |
| **E** 액션 클래스 자동 승격 | `subagent-handler`/라우터가 `explore`·`review` 클래스면 fable 추천(`ACTION_CLASS_TIERS.explore` 를 sonnet→fable) | `action-classifier.js:100`·라우터·`tests/routing/*` | **예** — 분류기 오탐이 곧 지출. 그리고 `explore→sonnet` 은 OD-2 4티어 방향(조사=싼 모델)의 자리라 **오너 의도와 정반대 축**을 건드린다 | 상한 없음 | 표 1줄 | **불채택** — 라우터는 Observe(관측 전용)이고, 자동 승격은 Canary 이후 결정(§4 D5) |
| **F** 훅 강제(PreToolUse block) | `route-observe-pre` 가 `tool_input.model` 이 정책과 다르면 `decision:"block"`+reason | L2 D1 훅 | — | — | — | **불채택** — 훅은 modify 불가, block 은 턴을 끊는다(Phase 0 위반). L2 설계 §4 "stdout 을 만지지 않는다" 와 충돌 |

**권장 조합**: **B 지금** → §4 측정 → **D 승인**(오너) → A 는 D 로 부족함이 측정으로 드러날 때만(§5-2). B·D 는 서로 독립이라 D 없이 B 만으로도 오늘의 사례(doctor·followup 을 구현 에이전트/`general-purpose` 에 배정)를 막는다 — 배정 대상이 allowlist 8 중 하나로 바뀌기 때문. D 는 "8 중 어느 것도 조사·감사에 맞지 않다(architect 가 감사를 하는 어색함)"를 해소하는 이름 정비다.

---

## 4. 측정 계획 — "검수에서 뒤집힌 주장 수"

### 4.1 지표 정의
- **분자** `claims_refuted`: 팀원 보고의 주장 중 검수(Phase 4/4.5, 리더 재측정, 후속 정정)에서 **반증된 수**(정정 각주가 정본에 남은 것 — 오늘 `:814→:818` 같은 형태).
- **분모** `claims_total`: 그 팀원 보고가 낸 **검증 가능한 주장 수**(file:line 인용·수치·판정). 분모 없는 분자는 쓰지 않는다(§1.5).
- **층화**: 팀원의 **실제 모델**(fable/opus) × 작업 성격(process/judge, B 태그) × 에이전트 정의.
- 비교 대상 가설: "judge 작업에서 opus 의 반증률 > fable 의 반증률". 이 가설이 기각되면 A·D 의 비용 근거가 없다.

### 4.2 어디에 누적하나 — 3안 비교

| 안 | 저장소 | 장점 | 단점 | 판정 |
|---|---|---|---|---|
| (i) 결정 원장 부록(문서, 수동) | `ARTIBOT-5.0-DESIGN.md` 부록 0-2 후속 표 | 지금 가능(오늘 1건은 이미 여기) | 분모를 사람이 세야 함, 모델 귀속은 리더 기억 | **임시**(Observe 동안) |
| (ii) `spawns.ndjson` 확장 | `lib/learning/ledger/spawn-ledger.js` 레코드에 `claims_total/refuted` 추가 | 스폰 단위 귀속 | 이 원장은 **SubagentStart 시점** 기록(`event:'start'`)이라 보고는 아직 없고, `agentType` 이 팀원 이름(§1.5)이라 모델 귀속 불가. 두 번째 진실원 문제(§3.6 "usage.receipt 단일 writer" 원칙) | 불채택 |
| **(iii) 중앙 원장 `ledger.jsonl` 이벤트** | `review.claim_audit`(신규 어휘, `schemas/ledger-events.allowlist.json` +1) — `{ subject_agent_id, subject_model, subject_agent_type, nature, claims_total, claims_refuted, evidence_refs[] }`. writer 는 Phase 4.5 inspector 의 구조화 verdict 를 `lib/review/independent-reviewer.js`(T-33 verdict 5종) 가 파싱해 `event-writer` 로 append | v5 원장 정본 · `subject_model` 은 **L2 D1 receipt+bind**(`route.selected{stage:'pre'}` 의 `tool_input.model` ↔ `route.bound` 의 `agent_id`) 에서 조인 · F-30 census 가 분모 무결성을 봄 | L2 D1·F-30 착지 전엔 `subject_model` 이 null → 그때까지 (i) 병행 | **채택(권장)** |

**의존성(직렬)**: (iii) 의 `subject_model` 은 **L2 D1** 없이는 채울 수 없다(SubagentStart 에 model 없음 — §1.3). 따라서 순서는 **L2 D1 → `review.claim_audit` 어휘 +1 → inspector verdict 파서 확장**. 이 세 단계 중 뒤 둘은 별도 설계안(HOOK-VISIBILITY 와 같은 등급)이 아니라 **이 설계안의 구현 2단계**로 둔다(승인 시).

### 4.3 판정 임계
오너 미특정 → **`미확인`**. 제안: 층당 `claims_total ≥ 50` 이 쌓이기 전에는 어느 방향으로도 정책을 바꾸지 않는다(G2 "n=1 은 근거 아님" 준용). 50 은 제안값이며 근거 있는 수치가 아니다.

### 4.4 이 측정이 못 보는 것
1. **반증되지 않은 오류** — 검수가 못 잡은 주장은 분자에 안 들어간다(검수 품질 자체가 변수).
2. **주장 수 세기의 주관성** — "검증 가능한 주장"의 경계는 세는 사람마다 다르다. 규칙: file:line 인용 1 = 주장 1, 수치 1 = 주장 1, 판정 문장 1 = 주장 1.
3. **모델 외 변수** — 같은 fable 이라도 effort·프롬프트 길이·컨텍스트 오염(정본 `:814` 리더 자기 오염)이 결과를 바꾼다. 층화에 `effort` 를 넣지 않으면 착시.
4. **B 태그 미준수** — 리더가 태그를 안 달면 `nature` 가 비어 층이 무너진다. 빈 값은 `null` 로 남기고 분모에서 뺀다(추측으로 메우지 않음).

---

## 5. 오너 결정 필요 항목 (신규 방향만 — 정본에 답 있는 것은 뺐다)

| # | 질문 | 권장 | 근거 |
|---|---|---|---|
| 1 | **어휘**: "조사"를 process(기계적 grep·측정 → opus, 4티어 후 sonnet 후보)와 judge(정합성 판정·반증·결정 → fable)로 **분리**하는가, 아니면 "조사·측정·감사" 전부 judge 로 보는가 | **분리(권장)** — 설계 어휘 `explore→sonnet`(§1.4)과 오너 의도가 충돌하는 지점이 정확히 여기다. 분리하면 둘 다 참이 된다 | doctor 팀원의 오늘 작업은 "Check 7 pass 확인"(process) + "S5 오독 위험 판정"(judge) 이 섞여 있었다 — 한 작업 안에서도 갈린다 → 태깅은 **작업 단위**가 아니라 **산출물 단위**(보고서의 판정 문장)로 갈 수도 있음. 그 경우 B 의 태그는 "이 팀원의 보고는 판정을 포함한다 = judge" |
| 2 | **A(역할이 이름을 이긴다)를 허용하는가** — 2026-09-02 "이름 allowlist 가 유일한 fable 집합" 번복 | **지금은 아니오(권장)** — D 로 같은 목적을 이름 축 안에서 달성. §4 측정이 "D 로도 부족"을 보이면 재상정 | fail-open 방향 + 비용 상한 없음(§3-A) |
| 3 | **D 신설 허용** — 에이전트 정의 2종(`investigator`·`auditor`) + allowlist 8→10, 로스터 28→30 | **예(권장)**, 단 §4 측정 계획과 함께 | 정책 구조 무변경, CI 게이트 자동 적용 |
| 4 | 측정 저장소 (iii) `review.claim_audit` 어휘 +1 승인 | **예(권장)** | v5 단일 원장 원칙(§3.6). L2 D1 착지가 선행 |
| 5 | fable 스폰 **예산 상한**을 두는가(run 당 judge 스폰 수 또는 토큰) | 제안: 상한은 두지 않고 **집계만**(Observe). Canary 진입 시 재론 | 상한 근거 수치가 없다 — 없는 수치로 게이트를 만들면 다음 착시 |

**이미 결정된 것(묻지 않음)**: 2티어 정책 자체(2026-09-02) · `FABLE_DENYLIST` 유지(refusal 오탐률 미측정 전 해제 금지) · 4티어 어휘 도입은 shadow 측정 후(OD-2) · 비용 계수 2.6× 는 미검증 표기 유지.

---

## 6. 구현 순서 (승인 후) · 되돌리기 · 완료 판정

1. **B**(문서): `team.md` Phase 1 에 `nature` 태그 절 + §Teammate Rules "judge 작업은 allowlist 8 에 배정" + `:155` 낡은 주석 정정(§1.6) · `PROMPT-TEMPLATE.md` 줄기 내부 팬아웃 절에 같은 규칙(2차 `test-git-sandbox` (4) 와 같은 파일 — **그 줄기에 위임**) · rules 문서 1줄. 코드 0.
2. **D**(승인 시): 정의 2파일 → config 2줄 → 핀 갱신(`validate.js` 28 → 30, `v5-config-firewall`) → `npm run ci`(`validate-model-policy` GREEN 이 곧 드리프트 0 증명).
3. **측정 (iii)**: L2 D1 착지 확인 → `ledger-events.allowlist.json` +1 → `independent-reviewer.js` verdict 파서에 `claims_total/refuted` 추출 → `/scorecard --routing` 에 층화 표 1개(분모·시각 병기).
4. 교차검수 3점: (a) allowlist 가 부정 목록으로 바뀌지 않았는가 (b) `FABLE_DENYLIST` 무변경 (c) `explore→sonnet` 표 무변경.

**되돌리기**: B = 문서 원복 · D = 파일 2 삭제 + config 2줄 + 핀 원복(단일 커밋) · (iii) = 어휘 1항 + 파서 분기 삭제(원장 행은 잔존, 읽기 모델이 무시).

**완료 판정**
| | 기준 | 증거 |
|---|---|---|
| D1 | B 문구 착지 + `team.md:155` 정정 | `git diff --stat` + file:line |
| D2 | (D 승인 시) `validate-model-policy` GREEN · 로스터 30/30 · allowlist 10 = frontmatter fable 10 | CI 출력 |
| D3 | (iii) 첫 `review.claim_audit` 행 1건 with `subject_model` 非null | `ledger.jsonl` grep(값 아닌 키·카운트) |
| D4 | 층당 `claims_total ≥ 50`(제안값) 후 반증률 표 | `/scorecard` 출력, 분모·시각 |

---

## 7. 이 설계가 못 보는 것
1. **효과의 인과** — fable 이 "덜 틀린다"는 것은 오늘 n=1 로 알 수 없고, §4 가 잰 뒤에도 effort·컨텍스트 변수를 층화하지 않으면 상관에 그친다.
2. **리더 자신** — 리더(오케스트레이터, fable)의 판정 오류는 팀원 검수로만 잡힌다(`:814` 사례). 이 설계는 팀원 배정만 다룬다.
3. **`/team` 밖 경로** — `/autopilot`·`/split` 창 안 스폰은 `team.md` 규율을 읽지 않는다. B 는 `PROMPT-TEMPLATE` 로 split 만 덮고 autopilot 은 별도.
4. **호스트 변경** — Agent 도구 `model` 파라미터 의미·SubagentStart 스키마가 바뀌면 §1.3 전제가 무너진다(L2 동결 픽스처 diff 가 유일한 검출).
5. **비용 실측 0** — ×2.6 은 카탈로그 산식이고 실제 청구·토큰 계수(`tokenizerCoeff 1.3`)는 미검증.

## 미확인
- doctor·followup 팀원의 **실제 모델**(리더 스폰 시 `model:` 지정값) — spawns.ndjson 에 없다(§1.5). 리더 트랜스크립트만 안다.
- "opus 보고 REFUTED 0" 의 분모(오늘 팀원 보고 주장 수) — 아무도 세지 않음.
- `tests/firewall/v5-config-firewall.test.js`·`tests/core/model-policy.test.js` 가 allowlist **개수 8** 과 REVIEW_ROLES 집합을 문자 그대로 핀하는지 — 파일명만 확인, 본문 미열람(D·A 의 RED 목록은 구현 시 재측정).
- `scripts/validate.js` 의 "28-agent roster" 핀 위치 — `fable.comment` 문구로만 확인, 코드 줄 미열람.
- Agent 도구 `model` 이 tier alias(`fable`)를 그대로 받는지 — 정본 §6 첫 항목 "미확인" 그대로(오늘 리더가 팀원을 fable 로 띄웠다면 참이겠으나 원장에 증거 없음).
- ACTION_CLASS_TIERS `explore→sonnet` 이 설계 저자(OD-2)의 "조사=싼 모델" 의도인지, 자리표시자인지 — 문서 정의문 미확인.

## 정정 — 3차 배치 model-d 실측 (2026-09-05, master 4fc75c8a)

| 설계 문구 | 실측 | 정정 |
|---|---|---|
| §1.6 `team.md:155` "구현/검토 역할 모두 frontier 티어" | base 에 그 문구 없음(155~157 은 2티어 주석). 잔존 낡은 표기는 `frontier 티어` 7곳 | 정정 대상은 `frontier 티어` 7곳(착지) |
| 미확인 1 `validate.js` "28-agent roster" 핀 | 숫자 핀 없음(집계 파생). 문구는 `low.comment` 에 있었고 JSDoc 1줄뿐 | 핀은 `tests/core/agent-registry.test.js` · `tests/mcp/server.test.js` · `tests/ci/validate-model-policy.test.js` · `marketplace.json#entryPoints.agents.count` — 전부 30 으로 |
| §6 D2 "실스폰 canonicalModel = fable 확인" | 호스트 2.1.260 SubagentStart 페이로드에 `model` 키가 없어 `canonicalModel` 0/30 non-null. `route-observe-pre` 는 `tool_input.model` 을 allowlist 에 두고도 소비 0 | **구조적으로 측정 불가 → 미확인 확정.** 후속: `route-observe-pre` 가 `tool_input.model` 을 `route.selected.models.current` 로 소비 |
| 미확인 2 "Agent `model` 이 tier alias 를 받는지" | `artibot:auditor`·`artibot:investigator` 스폰은 Agent 도구가 수용(3회) — 정의 로드는 실증, 실효 모델은 원장으로 판별 불가 | 로드 = 실측, 모델 = 미확인 |
| §6 (iii) D3 "첫 claim_audit 행 1건" | 파서(`parseClaimAudit`, 펜스·bare 수용)와 어휘까지 착지, **writer 배선 0** — 첫 실출력이 bare 한 줄이라 파서 E2E 결함을 잡았다 | D3 는 writer 배선 후속. `effort` 필드 없음(§4.4 #3 층화 착시 경고 유지) |
| 부수 | auditor 첫 실스폰이 팀원 보고 28건 중 2건 반증(README 표 orchestrator 행) | D안의 첫 라이브 효과 |
